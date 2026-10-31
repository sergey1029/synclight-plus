// Phone remote: serves a mobile control page on the home network and keeps it in sync over WebSocket.
// Access: a 4-digit PIN (shown on the PC, regenerated every start) pairs a phone once; the phone then
// keeps a random token. Only tokens' hashes are stored on disk.
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { WebSocketServer } = require("ws");
const QRCode = require("qrcode");
const Presets = require("./shared/presets");

const SRC = __dirname;
const STATIC = {
  "/": ["remote/index.html", "text/html; charset=utf-8"],
  "/app.js": ["remote/app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["remote/style.css", "text/css; charset=utf-8"],
  "/manifest.json": ["remote/manifest.json", "application/manifest+json"],
  "/icon.png": ["assets/icon.png", "image/png"],
  "/presets.js": ["shared/presets.js", "text/javascript; charset=utf-8"],
  "/ambilight.js": ["engine/ambilight.js", "text/javascript; charset=utf-8"],
};

const FRAME_INTERVAL_MS = 66;
const MAX_PIN_FAILS = 5;
const PIN_LOCK_MS = 60000;

// ---------- What a phone may change ----------

const NUM = (min, max) => (v) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined);
const BOOL = (v) => (typeof v === "boolean" ? v : undefined);
const ONE_OF = (list) => (v) => (list.includes(v) ? v : undefined);
const COLOR = (v) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : undefined);
const ids = (list) => list.map((x) => x.id);
const PALETTE = ONE_OF(Object.keys(Presets.PALETTES));

const SCHEMA = {
  enabled: BOOL,
  mode: ONE_OF(ids(Presets.MODES)),
  brightness: NUM(5, 100),
  smoothing: NUM(0, 1500),
  blur: NUM(0, 6),
  depth: NUM(3, 40),
  sceneReact: BOOL,
  saturation: NUM(0, 2),
  gamma: NUM(1, 2.8),
  darkThreshold: NUM(0, 15),
  color: COLOR,
  music: { style: ONE_OF(ids(Presets.MUSIC_STYLES)), sensitivity: NUM(0.5, 2), decay: NUM(80, 1200), palette: PALETTE },
  effect: { type: ONE_OF(ids(Presets.EFFECTS)), speed: NUM(0.1, 4), palette: PALETTE, color: COLOR },
};

function sanitize(patch, schema = SCHEMA) {
  const out = {};
  if (!patch || typeof patch !== "object") return out;
  for (const [key, value] of Object.entries(patch)) {
    const rule = schema[key];
    if (!rule) continue;
    if (typeof rule === "function") {
      const v = rule(value);
      if (v !== undefined) out[key] = v;
    } else {
      const sub = sanitize(value, rule);
      if (Object.keys(sub).length) out[key] = sub;
    }
  }
  return out;
}

// Settings the phone sees: the controllable ones plus the layout for the preview.
const PUBLIC_KEYS = [...Object.keys(SCHEMA), "layout"];
const publicSettings = (s) => Object.fromEntries(PUBLIC_KEYS.map((k) => [k, s[k]]));
const publicState = (st) => ({
  connected: st.connected,
  lampsAmount: st.lampsAmount,
  fps: st.fps,
  activeProfile: st.activeProfile,
  aspect: st.aspect,
});

// ---------- Network helpers ----------

const VIRTUAL_ADAPTER = /vEthernet|VirtualBox|VMware|WSL|Hyper-V|Loopback|Tailscale|ZeroTier|Radmin|Hamachi|VPN/i;
const PRIVATE_IP = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_ADAPTER.test(name)) continue;
    for (const a of list || []) {
      if (a.family === "IPv4" && !a.internal && PRIVATE_IP.test(a.address)) out.push(a.address);
    }
  }
  return out;
}

// Windows blocks incoming connections on networks marked "Public".
function checkPublicNetwork() {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "(Get-NetConnectionProfile | Where-Object NetworkCategory -eq 'Public' | Measure-Object).Count"],
      { windowsHide: true },
      (err, out) => resolve(!err && Number(out.trim()) > 0)
    );
  });
}

const hash = (token) => crypto.createHash("sha256").update(token).digest("hex");

function deviceName(ua = "") {
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  const m = ua.match(/Android [\d.]+; ([^;)]+)/);
  if (m) return m[1].replace(/ Build.*/, "").trim() || "Android";
  if (/Android/i.test(ua)) return "Android";
  if (/Windows/i.test(ua)) return "Компьютер Windows";
  return "Устройство";
}

// ---------- Server ----------

class RemoteServer {
  constructor({ dataDir, getSettings, getState, applyPatch, onChange }) {
    this.devicesFile = path.join(dataDir, "remote-devices.json");
    this.getSettings = getSettings;
    this.getState = getState;
    this.applyPatch = applyPatch;
    this.onChange = onChange;
    this.devices = this.loadDevices();
    this.pin = String(crypto.randomInt(0, 10000)).padStart(4, "0");
    this.fails = 0;
    this.lockedUntil = 0;
    this.server = null;
    this.wss = null;
    this.port = 0;
    this.error = "";
    this.qr = "";
    this.urls = [];
    this.publicNetwork = false;
    this.lastFrame = 0;
  }

  loadDevices() {
    try {
      return JSON.parse(fs.readFileSync(this.devicesFile, "utf8"));
    } catch {
      return [];
    }
  }

  saveDevices() {
    fs.writeFileSync(this.devicesFile, JSON.stringify(this.devices, null, 2));
  }

  isPaired(token) {
    if (!token || typeof token !== "string") return null;
    const h = hash(token);
    return this.devices.find((d) => d.hash === h) || null;
  }

  info() {
    return {
      running: Boolean(this.server),
      port: this.port,
      urls: this.urls,
      pin: this.pin,
      qr: this.qr,
      clients: this.wss ? this.wss.clients.size : 0,
      devices: this.devices.map((d) => ({ name: d.name, added: d.added })),
      error: this.error,
      publicNetwork: this.publicNetwork,
    };
  }

  // host: "0.0.0.0" = whole home network; tests use "127.0.0.1" (this PC only).
  async start(port, host = "0.0.0.0") {
    this.stop();
    this.error = "";
    this.port = port;
    this.server = http.createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    this.server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));
    this.wss.on("connection", (ws) => this.handleSocket(ws));
    this.heartbeat = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (ws.alive === false) ws.terminate();
        else {
          ws.alive = false;
          ws.ping();
        }
      }
    }, 15000);

    await new Promise((resolve) => {
      this.server.once("error", (e) => {
        this.error = e.code === "EADDRINUSE" ? `Порт ${port} занят другой программой` : e.message;
        this.stop(true);
        resolve();
      });
      this.server.listen(port, host, resolve);
    });
    await this.refreshNetwork();
    this.onChange();
  }

  stop(keepError = false) {
    clearInterval(this.heartbeat);
    if (this.wss) for (const ws of this.wss.clients) ws.terminate();
    if (this.server) this.server.close();
    this.server = null;
    this.wss = null;
    if (!keepError) this.error = "";
  }

  async refreshNetwork() {
    const urls = this.server ? lanAddresses().map((ip) => `http://${ip}:${this.port}`) : [];
    if (urls.join() !== this.urls.join()) {
      this.urls = urls;
      this.qr = urls.length
        ? await QRCode.toDataURL(`${urls[0]}/?pin=${this.pin}`, { margin: 1, width: 220, color: { dark: "#0f1115", light: "#ffffff" } })
        : "";
    }
    this.publicNetwork = this.server ? await checkPublicNetwork() : false;
  }

  forgetDevices() {
    this.devices = [];
    this.saveDevices();
    if (this.wss) for (const ws of this.wss.clients) ws.close(4001, "unpaired");
    this.onChange();
  }

  // ---------- HTTP ----------

  handleHttp(req, res) {
    const url = new URL(req.url, "http://x");
    const send = (code, body, type = "application/json; charset=utf-8") => {
      res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(body);
    };

    if (req.method === "GET" && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      return fs.readFile(path.join(SRC, file), (err, data) => (err ? send(404, "{}") : send(200, data, type)));
    }
    if (req.method === "GET" && url.pathname === "/api/check") {
      return send(this.isPaired(url.searchParams.get("token")) ? 200 : 401, "{}");
    }
    if (req.method === "POST" && url.pathname === "/api/pair") {
      let body = "";
      req.on("data", (c) => {
        body += c;
        if (body.length > 1024) req.destroy();
      });
      req.on("end", () => {
        if (Date.now() < this.lockedUntil) return send(429, JSON.stringify({ error: "locked" }));
        let pin = "";
        try {
          pin = String(JSON.parse(body).pin || "");
        } catch {}
        const ok = pin.length === 4 && crypto.timingSafeEqual(Buffer.from(pin.padEnd(4)), Buffer.from(this.pin));
        if (!ok) {
          if (++this.fails >= MAX_PIN_FAILS) {
            this.fails = 0;
            this.lockedUntil = Date.now() + PIN_LOCK_MS;
          }
          return send(403, JSON.stringify({ error: "wrong pin" }));
        }
        this.fails = 0;
        const token = crypto.randomBytes(32).toString("hex");
        this.devices.push({ hash: hash(token), name: deviceName(req.headers["user-agent"]), added: new Date().toISOString() });
        this.saveDevices();
        this.onChange();
        send(200, JSON.stringify({ token }));
      });
      return;
    }
    send(404, "{}");
  }

  // ---------- WebSocket ----------

  handleUpgrade(req, socket, head) {
    const url = new URL(req.url, "http://x");
    if (url.pathname !== "/ws" || !this.isPaired(url.searchParams.get("token"))) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return socket.destroy();
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit("connection", ws));
  }

  handleSocket(ws) {
    ws.alive = true;
    ws.on("pong", () => (ws.alive = true));
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }
      if (msg.type === "set") {
        const patch = sanitize(msg.patch);
        if (Object.keys(patch).length) this.applyPatch(patch);
      }
    });
    ws.on("close", () => this.onChange());
    ws.send(JSON.stringify({ type: "hello", settings: publicSettings(this.getSettings()), state: publicState(this.getState()) }));
    this.onChange();
  }

  broadcast(msg) {
    if (!this.wss || !this.wss.clients.size) return;
    const data = typeof msg === "string" || Buffer.isBuffer(msg) ? msg : JSON.stringify(msg);
    for (const ws of this.wss.clients) if (ws.readyState === ws.OPEN) ws.send(data);
  }

  broadcastSettings(s) {
    this.broadcast({ type: "settings", settings: publicSettings(s) });
  }

  broadcastState(st) {
    this.broadcast({ type: "state", state: publicState(st) });
  }

  broadcastFrame(colors) {
    const now = Date.now();
    if (now - this.lastFrame < FRAME_INTERVAL_MS) return;
    this.lastFrame = now;
    this.broadcast(Buffer.from(colors.buffer, colors.byteOffset, colors.byteLength));
  }
}

module.exports = { RemoteServer, sanitize };
