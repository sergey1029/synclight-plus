const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, desktopCapturer, session, screen, globalShortcut, shell } = require("electron");
const path = require("path");
const { execFile } = require("child_process");
const { LedStrip } = require("./device");
const Settings = require("./settings");
const Presets = require("./shared/presets");
const { testPattern, autoLayout } = require("./engine/ambilight");
const { watchForeground, listWindowApps } = require("./apps");
const { RemoteServer } = require("./remote");

// The engine window is hidden: keep Chromium from throttling it, and let it play audio without a click.
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const SETTINGS_FILE = path.join(app.getPath("userData"), "settings.json");
const ICON = path.join(__dirname, "assets", "icon.png");
const PREVIEW_INTERVAL_MS = 33;
const SELF_EXE = path.basename(process.execPath).toLowerCase();

// `settings` is what the user chose (saved to disk); an active profile adds a temporary `override`.
let settings = Settings.load(SETTINGS_FILE);
let override = {};
const effective = () => Settings.merge(settings, override);

const state = {
  connected: false,
  lampsAmount: 0,
  firmware: "",
  syncLightRunning: false,
  testMode: false,
  fps: 0,
  foreground: "",
  activeProfile: null,
  hotkeyErrors: [],
  remote: null,
};

const strip = new LedStrip();
let remote = null;
let engineWin = null;
let uiWin = null;
let tray = null;
let quitting = false;

// ---------- LED strip ----------

let writing = false;
let framesSent = 0;
let lastPreview = 0;

const toSegments = (colors) => {
  const segs = [];
  for (let i = 0; i < colors.length / 3; i++) {
    segs.push({ start: i + 1, end: i + 1, r: colors[i * 3], g: colors[i * 3 + 1], b: colors[i * 3 + 2] });
  }
  return segs;
};

async function writeColors(colors) {
  if (!strip.device || writing) return false;
  writing = true;
  try {
    await strip.setFrame(toSegments(colors));
    framesSent++;
    return true;
  } catch {
    await strip.close().catch(() => {});
    setConnected(false);
    return false;
  } finally {
    writing = false;
  }
}

async function writeColorsWhenFree(colors) {
  for (let i = 0; i < 20 && writing; i++) await new Promise((r) => setTimeout(r, 15));
  return writeColors(colors);
}

const totalLeds = () => {
  const l = settings.layout;
  return l.left + l.top + l.right + l.bottom;
};
const blackFrame = () => new Uint8Array(totalLeds() * 3);

function setConnected(on, info) {
  state.connected = on;
  if (info) {
    state.lampsAmount = info.lampsAmount;
    state.firmware = info.version;
  }
  publishState();
}

async function ensureConnected() {
  if (state.connected && !strip.device) setConnected(false);
  if (strip.device) return;
  try {
    await strip.open();
    const info = await strip.getInfo();
    setConnected(true, info);
  } catch {
    await strip.close().catch(() => {});
    if (state.connected) setConnected(false);
  }
}

// ---------- SyncLight conflict ----------

function checkSyncLight() {
  execFile("tasklist", ["/FI", "IMAGENAME eq SyncLight.exe", "/NH"], { windowsHide: true }, (err, out) => {
    const running = !err && /SyncLight\.exe/i.test(out);
    if (running !== state.syncLightRunning) {
      state.syncLightRunning = running;
      publishState();
    }
  });
}

// ---------- Test pattern ----------

let testTimer = null;
function setTestMode(on) {
  state.testMode = on;
  clearInterval(testTimer);
  if (on) {
    const send = () => {
      const colors = testPattern(settings.layout);
      writeColors(colors);
      sendToUi("frame", colors);
    };
    send();
    testTimer = setInterval(send, 100);
  } else if (!effective().enabled) {
    writeColorsWhenFree(blackFrame());
  }
  publishState();
}

// ---------- Settings ----------

function pushSettings() {
  const eff = effective();
  state.aspect = displayAspect();
  if (engineWin) engineWin.webContents.send("settings", eff);
  sendToUi("settings", eff);
  if (remote) remote.broadcastSettings(eff);
  updateTray();
}

function applySettings(patch) {
  const remoteBefore = JSON.stringify(settings.remote);
  settings = Settings.merge(settings, patch);
  // What the user just changed wins over the active profile.
  for (const key of Object.keys(patch)) delete override[key];
  Settings.save(SETTINGS_FILE, settings);
  if (patch.autostart !== undefined) applyAutostart();
  if (patch.hotkeys) registerHotkeys();
  if (patch.profiles) evaluateProfiles(state.foreground, true);
  if (JSON.stringify(settings.remote) !== remoteBefore) applyRemote();
  pushSettings();
}

// ---------- Phone remote ----------

async function applyRemote() {
  // SLP_REMOTE_HOST=127.0.0.1 keeps the server local for development (no firewall prompt).
  if (settings.remote.enabled) await remote.start(settings.remote.port, process.env.SLP_REMOTE_HOST);
  else remote.stop();
  publishState();
}

// Only the installed app registers itself; dev runs (npm start) would leave stale entries.
function applyAutostart() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: settings.autostart, path: process.execPath, args: ["--hidden"] });
}

const displays = () =>
  screen.getAllDisplays().map((d, i) => ({
    id: String(d.id),
    label: `Монитор ${i + 1} — ${Math.round(d.size.width * d.scaleFactor)}×${Math.round(d.size.height * d.scaleFactor)}${d.id === screen.getPrimaryDisplay().id ? " (основной)" : ""}`,
    aspect: d.size.width / d.size.height,
  }));

function displayAspect() {
  const list = displays();
  const d = list.find((x) => x.id === effective().displayId) || list[0];
  return d ? d.aspect : 16 / 9;
}

// ---------- Profiles ----------

function evaluateProfiles(exe, force = false) {
  const rule = settings.profiles.find((p) => p.exe && p.exe.toLowerCase() === exe);
  const was = state.activeProfile && state.activeProfile.id;
  if (!force && (rule ? rule.id : null) === was) return;
  override = rule ? Presets.sceneToPatch(rule.scene) : {};
  state.activeProfile = rule ? { id: rule.id, exe: rule.exe, scene: rule.scene } : null;
  pushSettings();
  publishState();
}

function onForeground(exe) {
  // Ignore our own window, so opening settings doesn't drop the active profile.
  if (!exe || exe === SELF_EXE) return;
  state.foreground = exe;
  evaluateProfiles(exe);
  sendToUi("state", state);
}

// ---------- Hotkeys ----------

function cycleMode() {
  const ids = Presets.MODES.map((m) => m.id);
  const eff = effective();
  const next = ids[(ids.indexOf(eff.mode) + 1) % ids.length];
  applySettings({ mode: next, enabled: true });
}

const HOTKEY_ACTIONS = {
  toggle: () => applySettings({ enabled: !effective().enabled }),
  nextMode: cycleMode,
  brightnessUp: () => applySettings({ brightness: Math.min(100, effective().brightness + 10) }),
  brightnessDown: () => applySettings({ brightness: Math.max(5, effective().brightness - 10) }),
};

let hotkeysPaused = false;
function registerHotkeys() {
  globalShortcut.unregisterAll();
  state.hotkeyErrors = [];
  if (!hotkeysPaused) {
    for (const [action, accel] of Object.entries(settings.hotkeys)) {
      if (!accel || !HOTKEY_ACTIONS[action]) continue;
      let ok = false;
      try {
        ok = globalShortcut.register(accel, HOTKEY_ACTIONS[action]);
      } catch {}
      if (!ok) state.hotkeyErrors.push(action);
    }
  }
  publishState();
}

// ---------- Windows & IPC ----------

function sendToUi(channel, data) {
  if (uiWin && !uiWin.isDestroyed() && uiWin.isVisible()) uiWin.webContents.send(channel, data);
}

function publishState() {
  if (remote) state.remote = remote.info();
  sendToUi("state", state);
  if (remote) remote.broadcastState(state);
  updateTray();
}

const webPreferences = {
  preload: path.join(__dirname, "preload.js"),
  backgroundThrottling: false,
};

function createEngine() {
  engineWin = new BrowserWindow({ show: false, webPreferences });
  engineWin.loadFile(path.join(__dirname, "engine", "engine.html"));
  engineWin.webContents.on("render-process-gone", () => setTimeout(createEngine, 1000));
}

function showUi() {
  if (uiWin && !uiWin.isDestroyed()) {
    uiWin.show();
    uiWin.focus();
    return;
  }
  uiWin = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 960,
    minHeight: 660,
    title: "SyncLight Plus",
    icon: ICON,
    backgroundColor: "#0f1115",
    autoHideMenuBar: true,
    webPreferences,
  });
  uiWin.loadFile(path.join(__dirname, "ui", "index.html"));
  uiWin.on("close", (e) => {
    if (!quitting) {
      e.preventDefault();
      uiWin.hide();
      if (state.testMode) setTestMode(false);
    }
  });
  uiWin.on("show", () => publishState());
}

ipcMain.handle("ui:get", () => ({ settings: effective(), state, displays: displays() }));
ipcMain.handle("ui:listApps", async () => (await listWindowApps()).filter((a) => a.exe !== SELF_EXE));
ipcMain.on("ui:set", (_e, patch) => applySettings(patch));
ipcMain.on("ui:reset", () =>
  applySettings({
    ...structuredClone(Settings.DEFAULTS),
    layout: settings.layout,
    layoutTouched: settings.layoutTouched,
    profiles: settings.profiles,
    hotkeys: settings.hotkeys,
    remote: settings.remote,
    autostart: settings.autostart,
  })
);
ipcMain.on("ui:test", (_e, on) => setTestMode(Boolean(on)));
ipcMain.on("ui:pauseHotkeys", (_e, paused) => {
  hotkeysPaused = Boolean(paused);
  registerHotkeys();
});
ipcMain.on("ui:closeSyncLight", () => {
  execFile("taskkill", ["/IM", "SyncLight.exe", "/F"], { windowsHide: true }, () => checkSyncLight());
});
ipcMain.on("ui:forgetDevices", () => remote.forgetDevices());
ipcMain.on("ui:openNetworkSettings", () => shell.openExternal("ms-settings:network-status"));
ipcMain.on("engine:frame", (_e, colors) => {
  if (state.testMode) return;
  writeColors(colors);
  remote.broadcastFrame(colors);
  const now = Date.now();
  if (now - lastPreview >= PREVIEW_INTERVAL_MS) {
    lastPreview = now;
    sendToUi("frame", colors);
  }
});

// ---------- Tray ----------

function updateTray() {
  if (!tray) return;
  const eff = effective();
  const modeName = Presets.MODES.find((m) => m.id === eff.mode)?.name || "";
  const status = !state.connected ? "лента не подключена" : eff.enabled ? `режим «${modeName}»` : "выключено";
  tray.setToolTip(`SyncLight Plus — ${status}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Открыть настройки", click: showUi },
      { type: "separator" },
      { label: "Подсветка", type: "checkbox", checked: eff.enabled, accelerator: settings.hotkeys.toggle || undefined, click: (i) => applySettings({ enabled: i.checked }) },
      {
        label: "Режим",
        submenu: Presets.MODES.map((m) => ({
          label: m.name,
          type: "radio",
          checked: eff.mode === m.id,
          click: () => applySettings({ mode: m.id, enabled: true }),
        })),
      },
      {
        label: "Яркость",
        submenu: [100, 75, 50, 25].map((v) => ({
          label: `${v} %`,
          type: "radio",
          checked: eff.brightness === v,
          click: () => applySettings({ brightness: v }),
        })),
      },
      { type: "separator" },
      { label: "Выход", click: () => app.quit() },
    ])
  );
}

// ---------- App lifecycle ----------

let stopForeground = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showUi);

  app.whenReady().then(async () => {
    session.defaultSession.setDisplayMediaRequestHandler(async (req, callback) => {
      const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
      const want = effective().displayId || String(screen.getPrimaryDisplay().id);
      const video = sources.find((s) => s.display_id === want) || sources[0];
      // Music mode asks for audio: give it the Windows loopback (everything the PC plays).
      callback(req.audioRequested ? { video, audio: "loopback" } : { video });
    });

    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 32, height: 32 }));
    tray.on("click", showUi);

    await ensureConnected();
    // First run on a strip with a different LED count: split LEDs to fit it.
    if (state.lampsAmount && totalLeds() !== state.lampsAmount && !settings.layoutTouched) {
      const d = screen.getPrimaryDisplay().size;
      applySettings({ layout: { ...autoLayout(state.lampsAmount, d.width / d.height, ["left", "top", "right"]), reverse: true } });
    }
    applyAutostart();
    registerHotkeys();
    state.aspect = displayAspect();
    remote = new RemoteServer({
      dataDir: app.getPath("userData"),
      getSettings: effective,
      getState: () => state,
      applyPatch: applySettings,
      onChange: publishState,
    });
    applyRemote();
    // Wi-Fi address and network type can change (router reboot, Windows settings).
    setInterval(() => settings.remote.enabled && remote.refreshNetwork().then(publishState), 30000);
    createEngine();
    if (!process.argv.includes("--hidden")) showUi();
    updateTray();

    stopForeground = watchForeground(onForeground);
    setInterval(ensureConnected, 2000);
    checkSyncLight();
    setInterval(checkSyncLight, 5000);
    setInterval(() => {
      state.fps = framesSent;
      framesSent = 0;
      if (process.env.SLP_DEBUG) console.log("fps", state.fps, "mode", effective().mode, "fg", state.foreground, "profile", state.activeProfile?.exe || "-", "hotkeyErrors", state.hotkeyErrors.join(",") || "-");
      // Not publishState(): rebuilding the tray menu every second would close it while open.
      state.remote = remote.info();
      sendToUi("state", state);
      remote.broadcastState(state);
    }, 1000);
  });

  app.on("window-all-closed", (e) => e.preventDefault());

  app.on("before-quit", async (e) => {
    if (quitting) return;
    quitting = true;
    e.preventDefault();
    clearInterval(testTimer);
    globalShortcut.unregisterAll();
    if (stopForeground) stopForeground();
    if (remote) remote.stop();
    await writeColorsWhenFree(blackFrame()).catch(() => {});
    await strip.close().catch(() => {});
    app.exit(0);
  });
}
