// Checks the phone remote server end-to-end on localhost (no Electron, no hardware).
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { RemoteServer, sanitize } = require("../src/remote");
const { DEFAULTS, merge } = require("../src/settings");

const PORT = 18765;
const base = `http://127.0.0.1:${PORT}`;

(async () => {
  // 1. Sanitizer: only remote-safe keys, values clamped.
  const clean = sanitize({
    brightness: 500, mode: "music", layout: { left: 99 }, hotkeys: {}, profiles: [],
    music: { sensitivity: -3, style: "hack" }, color: "#FFAA00", effect: { color: "red" },
  });
  assert.deepStrictEqual(clean, { brightness: 100, mode: "music", music: { sensitivity: 0.5 }, color: "#ffaa00" });
  console.log("ok  фильтр: раскладку/профили/клавиши с телефона менять нельзя, значения обрезаются");

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "slp-remote-"));
  let settings = merge(DEFAULTS, {});
  const applied = [];
  const server = new RemoteServer({
    dataDir,
    getSettings: () => settings,
    getState: () => ({ connected: true, lampsAmount: 71, fps: 60, activeProfile: null, aspect: 2.39 }),
    applyPatch: (p) => {
      applied.push(p);
      settings = merge(settings, p);
    },
    onChange: () => {},
  });
  await server.start(PORT, "127.0.0.1");
  const pin = server.pin;

  // 2. Page and scripts are served; unknown paths are not.
  const page = await fetch(base + "/");
  assert.strictEqual(page.status, 200);
  assert.ok((await page.text()).includes("SyncLight Plus"));
  assert.strictEqual((await fetch(base + "/../main.js")).status, 404);
  assert.strictEqual((await fetch(base + "/settings.json")).status, 404);
  console.log("ok  страница пульта отдаётся, остальные файлы недоступны");

  // 3. Pairing.
  const pair = (p) => fetch(base + "/api/pair", { method: "POST", body: JSON.stringify({ pin: p }) });
  const wrong = String((Number(pin) + 1) % 10000).padStart(4, "0");
  assert.strictEqual((await pair(wrong)).status, 403);
  const ok = await pair(pin);
  assert.strictEqual(ok.status, 200);
  const { token } = await ok.json();
  assert.strictEqual((await fetch(`${base}/api/check?token=${token}`)).status, 200);
  assert.strictEqual((await fetch(`${base}/api/check?token=bad`)).status, 401);
  const stored = fs.readFileSync(path.join(dataDir, "remote-devices.json"), "utf8");
  assert.ok(!stored.includes(token), "token itself is not stored on disk");
  console.log("ok  привязка: верный PIN даёт токен, неверный — нет; на диске только хеш токена");

  // 4. WebSocket: rejected without token, works with it.
  const open = (t) =>
    new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${t}`);
      ws.binaryType = "arraybuffer";
      const inbox = [];
      ws.onmessage = (e) => inbox.push(e.data);
      ws.onopen = () => resolve({ ws, inbox });
      ws.onerror = () => resolve(null);
    });
  assert.strictEqual(await open("bad"), null);
  const { ws, inbox } = await open(token);
  await new Promise((r) => setTimeout(r, 100));
  const hello = JSON.parse(inbox[0]);
  assert.strictEqual(hello.type, "hello");
  assert.strictEqual(hello.settings.hotkeys, undefined, "phone doesn't see hotkeys/profiles");
  assert.strictEqual(hello.state.aspect, 2.39);
  console.log("ok  связь: без токена не пускает, с токеном присылает настройки (без лишнего)");

  ws.send(JSON.stringify({ type: "set", patch: { brightness: 40, autostart: true } }));
  await new Promise((r) => setTimeout(r, 100));
  assert.deepStrictEqual(applied.at(-1), { brightness: 40 });
  server.broadcastFrame(new Uint8Array([1, 2, 3]));
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(inbox.some((m) => m instanceof ArrayBuffer && new Uint8Array(m)[2] === 3), "frame arrives as binary");
  console.log("ok  команды с телефона применяются, превью ленты доходит");

  // 5. Brute force protection: 5 wrong PINs lock pairing for a minute.
  for (let i = 0; i < 5; i++) await pair(wrong);
  assert.strictEqual((await pair(pin)).status, 429);
  console.log("ok  защита: после 5 неверных PIN привязка заблокирована на минуту");

  // 6. Forgetting devices disconnects them.
  const closed = new Promise((r) => (ws.onclose = (e) => r(e.code)));
  server.forgetDevices();
  assert.strictEqual(await closed, 4001);
  assert.strictEqual((await fetch(`${base}/api/check?token=${token}`)).status, 401);
  console.log("ok  «отвязать все» отключает телефоны и аннулирует их токены");

  server.stop();
  fs.rmSync(dataDir, { recursive: true });
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
