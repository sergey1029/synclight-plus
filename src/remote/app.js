// Phone remote: pairs with the PC by PIN, then mirrors and changes settings over WebSocket.
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const getPath = (obj, path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
const patchFor = (path, value) => path.split(".").reduceRight((acc, k) => ({ [k]: acc }), value);
const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);
function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = isObject(v) && isObject(base[k]) ? merge(base[k], v) : v;
  return out;
}

const TOKEN_KEY = "slp-token";
let token = localStorage.getItem(TOKEN_KEY);
let settings = null;
let state = null;
let colors = null;
let ws = null;
let reconnectTimer = null;

// ---------- Pairing ----------

async function pair(pin) {
  try {
    const res = await fetch("/api/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
    if (res.ok) {
      token = (await res.json()).token;
      localStorage.setItem(TOKEN_KEY, token);
      return true;
    }
    $("pairError").textContent = res.status === 429 ? "Слишком много попыток — подождите минуту" : "Неверный PIN";
  } catch {
    $("pairError").textContent = "Компьютер не отвечает";
  }
  return false;
}

// true = token valid (or PC unreachable, so keep it and retry later); false = token rejected.
async function tokenValid() {
  if (!token) return false;
  try {
    const res = await fetch("/api/check?token=" + encodeURIComponent(token));
    if (res.status === 401) {
      token = null;
      localStorage.removeItem(TOKEN_KEY);
      return false;
    }
  } catch {}
  return true;
}

function showPair() {
  if (ws) ws.onclose = null;
  $("app").hidden = true;
  $("pair").hidden = false;
  $("pin").value = "";
  $("pin").focus();
}

$("pin").addEventListener("input", async (e) => {
  const v = e.target.value.replace(/\D/g, "").slice(0, 4);
  e.target.value = v;
  $("pairError").textContent = "";
  if (v.length === 4) {
    if (await pair(v)) start();
    else e.target.value = "";
  }
});

// ---------- Connection ----------

function start() {
  $("pair").hidden = true;
  $("app").hidden = false;
  connect();
}

function connect() {
  clearTimeout(reconnectTimer);
  if (ws && ws.readyState <= 1) return;
  ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(token)}`);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => setOnline(true);
  ws.onmessage = (e) => {
    if (typeof e.data !== "string") {
      colors = new Uint8Array(e.data);
      return;
    }
    const msg = JSON.parse(e.data);
    if (msg.settings) settings = pending ? merge(msg.settings, pending) : msg.settings;
    if (msg.state) state = msg.state;
    render();
  };
  ws.onclose = (e) => {
    setOnline(false);
    if (e.code === 4001) {
      token = null;
      localStorage.removeItem(TOKEN_KEY);
      return showPair();
    }
    reconnectTimer = setTimeout(async () => ((await tokenValid()) ? connect() : showPair()), 1500);
  };
}

function setOnline(on) {
  $("dot").classList.toggle("ok", on);
  $("offline").hidden = on || !settings;
}

// A phone that slept has a dead socket: reconnect right away when it wakes up.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && token && !$("app").hidden) connect();
});

// ---------- Sending changes ----------

let pending = null;
let flushTimer = null;

function send(patch) {
  settings = merge(settings, patch);
  pending = merge(pending || {}, patch);
  if (!flushTimer) flushTimer = setTimeout(flush, 60);
  render();
}

function flush() {
  flushTimer = null;
  if (pending && ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "set", patch: pending }));
  pending = null;
}

const set = (path, value) => send(patchFor(path, value));

// ---------- Controls ----------

const dragging = new Set();
let refreshers = [];

function slider(path, label, min, max, step, fmt) {
  const wrap = el("div", "sub");
  const head = el("div", "label");
  const value = el("b");
  head.append(el("span", null, label), value);
  const input = el("input");
  Object.assign(input, { type: "range", min, max, step });
  const release = () => dragging.delete(path);
  input.addEventListener("pointerdown", () => dragging.add(path));
  input.addEventListener("pointerup", release);
  input.addEventListener("pointercancel", release);
  input.addEventListener("change", release);
  input.addEventListener("input", () => {
    value.textContent = fmt(Number(input.value));
    set(path, Number(input.value));
  });
  wrap.append(head, input);
  refreshers.push(() => {
    const v = getPath(settings, path);
    if (!dragging.has(path)) input.value = v;
    value.textContent = fmt(Number(v));
  });
  return wrap;
}

function choices(items, cls, isActive, onPick) {
  const grid = el("div", "grid " + (cls || ""));
  for (const item of items) {
    const b = el("button", "choice");
    b.append(el("b", null, item.name), el("span", null, item.note || ""));
    b.addEventListener("click", () => onPick(item));
    refreshers.push(() => b.classList.toggle("active", isActive(item)));
    grid.append(b);
  }
  return grid;
}

function palettes(path) {
  const row = el("div", "palettes");
  for (const [id, p] of Object.entries(Presets.PALETTES)) {
    const b = el("button", "palette");
    const bar = el("i");
    bar.style.background = `linear-gradient(90deg, ${p.stops.join(",")})`;
    b.append(bar, p.name);
    b.addEventListener("click", () => set(path, id));
    refreshers.push(() => b.classList.toggle("active", getPath(settings, path) === id));
    row.append(b);
  }
  return row;
}

function swatches(path) {
  const row = el("div", "swatches");
  for (const hex of Presets.COLOR_SWATCHES) {
    const b = el("button", "swatch");
    b.style.background = hex;
    b.addEventListener("click", () => set(path, hex));
    refreshers.push(() => b.classList.toggle("active", String(getPath(settings, path)).toLowerCase() === hex));
    row.append(b);
  }
  const custom = el("label", "custom");
  const input = el("input");
  input.type = "color";
  input.addEventListener("input", () => set(path, input.value));
  custom.append(input, el("span", null, "+"));
  refreshers.push(() => (input.value = getPath(settings, path)));
  row.append(custom);
  return row;
}

function block(title, ...children) {
  const b = el("div", "block");
  if (title) b.append(el("h2", null, title));
  b.append(...children);
  return b;
}

function showWhen(elem, fn) {
  refreshers.push(() => (elem.hidden = !fn()));
  return elem;
}

// ---------- Mode panels ----------

const PANELS = {
  ambilight: () => [
    block(
      "Готовые режимы",
      choices(
        Presets.AMBILIGHT_PRESETS,
        "",
        (p) => Object.entries(p.values).every(([k, v]) => settings[k] === v),
        (p) => send(p.values)
      )
    ),
    block(
      "Тонкая настройка",
      slider("smoothing", "Плавность", 0, 1500, 10, (v) => (v ? `${v} мс` : "выкл")),
      slider("blur", "Смешивание", 0, 6, 0.5, (v) => (v ? v.toFixed(1) : "выкл")),
      slider("saturation", "Насыщенность", 0, 2, 0.05, (v) => `×${v.toFixed(2)}`)
    ),
  ],
  music: () => [
    block(
      "Стиль",
      choices(Presets.MUSIC_STYLES, "three", (s) => settings.music.style === s.id, (s) => set("music.style", s.id)),
      palettes("music.palette")
    ),
    block(
      "Настройка",
      slider("music.sensitivity", "Чувствительность", 0.5, 2, 0.05, (v) => `×${v.toFixed(2)}`),
      slider("music.decay", "Затухание", 80, 1200, 10, (v) => `${v} мс`)
    ),
  ],
  effect: () => [
    block(
      "Эффект",
      choices(Presets.EFFECTS, "", (e) => settings.effect.type === e.id, (e) => set("effect.type", e.id)),
      showWhen(palettes("effect.palette"), () => settings.effect.type === "flow"),
      showWhen(swatches("effect.color"), () => settings.effect.type === "breathe")
    ),
    block(null, slider("effect.speed", "Скорость", 0.1, 4, 0.1, (v) => `×${v.toFixed(1)}`)),
  ],
  color: () => [block("Цвет подсветки", swatches("color"))],
};

let builtMode = null;
function buildPanel() {
  refreshers = [];
  builtMode = settings.mode;
  $("modePanel").replaceChildren(...PANELS[settings.mode]());
}

// ---------- Static UI ----------

const modeButtons = Presets.MODES.map((m) => {
  const b = el("button", null, m.name);
  b.addEventListener("click", () => send({ mode: m.id, enabled: true }));
  $("modes").append(b);
  return [m.id, b];
});

$("power").addEventListener("click", () => send({ enabled: !settings.enabled }));

const brightness = $("brightness");
brightness.addEventListener("pointerdown", () => dragging.add("brightness"));
["pointerup", "pointercancel", "change"].forEach((ev) => brightness.addEventListener(ev, () => dragging.delete("brightness")));
brightness.addEventListener("input", () => set("brightness", Number(brightness.value)));

const standalone = matchMedia("(display-mode: standalone)").matches || matchMedia("(display-mode: fullscreen)").matches;
$("fullscreen").hidden = standalone || !document.fullscreenEnabled;
$("fullscreen").addEventListener("click", () =>
  document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {})
);

function render() {
  if (!settings) return;
  if (builtMode !== settings.mode) buildPanel();
  $("power").classList.toggle("on", settings.enabled);
  if (!dragging.has("brightness")) brightness.value = settings.brightness;
  $("brightnessValue").textContent = settings.brightness + " %";
  modeButtons.forEach(([id, b]) => b.classList.toggle("active", settings.mode === id));
  for (const fn of refreshers) fn();

  const ap = state && state.activeProfile;
  $("profile").hidden = !ap;
  if (ap) {
    const scene = Presets.SCENES.find((s) => s.id === ap.scene);
    $("profile").textContent = `Сейчас действует профиль для ${ap.exe}: «${scene ? scene.name : ap.scene}»`;
  }
  if (state && !state.connected) {
    $("profile").hidden = false;
    $("profile").textContent = "Лента не подключена к компьютеру";
  }
}

// ---------- Preview ----------

const canvas = $("preview");
const g2 = canvas.getContext("2d");

function drawPreview() {
  requestAnimationFrame(drawPreview);
  if (!settings || $("app").hidden) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  g2.setTransform(dpr, 0, 0, dpr, 0, 0);
  g2.clearRect(0, 0, W, H);

  const aspect = (state && state.aspect) || 16 / 9;
  const pad = 30;
  let mw = W - pad * 2, mh = mw / aspect;
  if (mh > H - pad * 2) {
    mh = H - pad * 2;
    mw = mh * aspect;
  }
  const mx = (W - mw) / 2, my = (H - mh) / 2;
  const leds = Ambilight.buildLeds(settings.layout);
  const on = colors && colors.length === leds.length * 3;

  const pos = leds.map((led) => {
    if (led.side === "top") return [mx + led.t * mw, my];
    if (led.side === "bottom") return [mx + led.t * mw, my + mh];
    if (led.side === "left") return [mx, my + led.t * mh];
    return [mx + mw, my + led.t * mh];
  });

  g2.globalCompositeOperation = "lighter";
  const glow = Math.max(20, Math.min(mw, mh) * 0.2);
  pos.forEach(([x, y], i) => {
    if (!on) return;
    const c = [colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]];
    if (c[0] + c[1] + c[2] < 4) return;
    const k = Math.min(3, 255 / Math.max(1, ...c));
    const [r, g, b] = c.map((v) => Math.round(v * k));
    const grad = g2.createRadialGradient(x, y, 0, x, y, glow);
    grad.addColorStop(0, `rgba(${r},${g},${b},0.6)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    g2.fillStyle = grad;
    g2.fillRect(x - glow, y - glow, glow * 2, glow * 2);
  });
  g2.globalCompositeOperation = "source-over";
  g2.fillStyle = "#0b0d11";
  g2.strokeStyle = "#2f3542";
  g2.lineWidth = 1.5;
  g2.beginPath();
  g2.roundRect(mx, my, mw, mh, 6);
  g2.fill();
  g2.stroke();
}

// ---------- Boot ----------

(async () => {
  const pin = new URLSearchParams(location.search).get("pin");
  if (pin) {
    // Opened from the QR code: the PIN is inside, pair silently.
    history.replaceState(null, "", "/");
    if (await pair(pin)) return start();
  }
  if (await tokenValid()) return start();
  showPair();
})();
requestAnimationFrame(drawPreview);
