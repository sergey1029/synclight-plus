// Settings window: builds controls, shows live LED preview, talks to the main process.
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const getPath = (obj, path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
const patchFor = (path, value) => path.split(".").reduceRight((acc, k) => ({ [k]: acc }), value);
const set = (path, value) => window.api.set(patchFor(path, value));

let settings = null;
let state = null;
let displays = [];
let colors = null;
let tab = "mode";

const refreshers = []; // [path, fn(value)] — re-run when settings change
const visibility = []; // [element, fn(settings) -> visible]
const onRender = []; // extra render hooks
const bind = (path, fn) => refreshers.push([path, fn]);
const showIf = (elem, fn) => visibility.push([elem, fn]);

// ---------- Generic controls ----------

function head(label, valueEl) {
  const h = el("div", "control-head");
  h.append(el("label", null, label));
  if (valueEl) h.append(valueEl);
  return h;
}

function range({ path, label, min, max, step, fmt, hint }) {
  const wrap = el("div", "control");
  const value = el("span", "value");
  const input = el("input");
  Object.assign(input, { type: "range", min, max, step });
  input.addEventListener("input", () => {
    value.textContent = fmt(Number(input.value));
    set(path, Number(input.value));
  });
  wrap.append(head(label, value), input);
  if (hint) wrap.append(el("div", "hint", hint));
  bind(path, (v) => {
    input.value = v;
    value.textContent = fmt(Number(v));
  });
  return wrap;
}

function toggle({ path, label, hint, onChange }) {
  const wrap = el("div", "control");
  const row = el("label", "switch");
  const input = el("input");
  input.type = "checkbox";
  const track = el("span", "track");
  track.append(el("span", "thumb"));
  row.append(input, track, el("span", null, label));
  input.addEventListener("change", () => (onChange ? onChange(input.checked) : set(path, input.checked)));
  wrap.append(row);
  if (hint) wrap.append(el("div", "hint", hint));
  if (path) bind(path, (v) => (input.checked = Boolean(v)));
  return { wrap, input };
}

function card(title, ...children) {
  const c = el("div", "card");
  if (title) c.append(el("h2", null, title));
  c.append(...children);
  return c;
}

// Grid of big buttons; the one matching the current value is highlighted.
function choices(items, path, onPick) {
  const grid = el("div", "choices");
  const buttons = items.map((item) => {
    const b = el("button", "choice");
    b.append(el("b", null, item.name), el("span", null, item.note || ""));
    b.addEventListener("click", () => (onPick ? onPick(item) : set(path, item.id)));
    grid.append(b);
    return [item, b];
  });
  onRender.push(() => {
    for (const [item, b] of buttons) {
      const active = item.isActive ? item.isActive(settings) : getPath(settings, path) === item.id;
      b.classList.toggle("active", active);
    }
  });
  return grid;
}

function palettePicker(path) {
  const row = el("div", "palettes");
  const buttons = Object.entries(Presets.PALETTES).map(([id, p]) => {
    const b = el("button", "palette");
    const bar = el("i");
    bar.style.background = `linear-gradient(90deg, ${p.stops.join(",")})`;
    b.append(bar, p.name);
    b.addEventListener("click", () => set(path, id));
    row.append(b);
    return [id, b];
  });
  bind(path, (v) => buttons.forEach(([id, b]) => b.classList.toggle("active", id === v)));
  return row;
}

function colorPicker(path) {
  const row = el("div", "swatches");
  const swatches = Presets.COLOR_SWATCHES.map((hex) => {
    const b = el("button", "swatch");
    b.style.background = hex;
    b.title = hex;
    b.addEventListener("click", () => set(path, hex));
    row.append(b);
    return [hex, b];
  });
  const custom = el("input");
  custom.type = "color";
  custom.title = "Свой цвет";
  custom.addEventListener("input", () => set(path, custom.value));
  row.append(custom);
  bind(path, (v) => {
    custom.value = v;
    swatches.forEach(([hex, b]) => b.classList.toggle("active", hex.toLowerCase() === String(v).toLowerCase()));
  });
  return row;
}

// ---------- Header ----------

function buildHeader() {
  const modes = $("modes");
  const buttons = Presets.MODES.map((m) => {
    const b = el("button", null, m.name);
    b.addEventListener("click", () => window.api.set({ mode: m.id, enabled: true }));
    modes.append(b);
    return [m.id, b];
  });
  onRender.push(() => buttons.forEach(([id, b]) => b.classList.toggle("active", settings.mode === id)));
  $("enabled").addEventListener("change", (e) => window.api.set({ enabled: e.target.checked }));
  $("closeSyncLight").addEventListener("click", () => window.api.closeSyncLight());
}

// ---------- Quick card (left, under the preview) ----------

function buildQuick() {
  const quick = $("quick");

  const presets = Presets.AMBILIGHT_PRESETS.map((p) => ({
    ...p,
    isActive: (s) => Object.entries(p.values).every(([k, v]) => s[k] === v),
  }));
  const ambi = el("div");
  ambi.append(
    el("h2", null, "Готовые режимы"),
    choices(presets, null, (p) => window.api.set(p.values)),
    el("p", "muted", "Выберите режим как отправную точку и подстройте ползунки справа.")
  );
  showIf(ambi, (s) => s.mode === "ambilight");

  const music = el("div");
  music.append(el("h2", null, "Стиль"), choices(Presets.MUSIC_STYLES, "music.style"), palettePicker("music.palette"));
  showIf(music, (s) => s.mode === "music");

  const effect = el("div");
  const effPalette = palettePicker("effect.palette");
  const effColor = colorPicker("effect.color");
  effect.append(el("h2", null, "Эффект"), choices(Presets.EFFECTS, "effect.type"), effPalette, effColor);
  showIf(effect, (s) => s.mode === "effect");
  showIf(effPalette, (s) => s.effect.type === "flow");
  showIf(effColor, (s) => s.effect.type === "breathe");

  const color = el("div");
  color.append(el("h2", null, "Цвет подсветки"), colorPicker("color"));
  showIf(color, (s) => s.mode === "color");

  quick.append(ambi, music, effect, color);
}

// ---------- Tab: mode settings ----------

function buildModeTab() {
  const panel = el("div");

  const smooth = card(
    "Плавность",
    range({ path: "smoothing", label: "Плавность переходов", min: 0, max: 1500, step: 10, fmt: (v) => (v ? `${v} мс` : "выкл"),
      hint: "За сколько цвет перетекает к новому. Больше — мягче, меньше — быстрее реакция." }),
    range({ path: "blur", label: "Смешивание соседних светодиодов", min: 0, max: 6, step: 0.5, fmt: (v) => (v ? v.toFixed(1) : "выкл"),
      hint: "Размывает границы между светодиодами — свет идёт единым градиентом, без кусков." }),
    toggle({ path: "sceneReact", label: "Быстрее реагировать на смену сцены",
      hint: "При резкой смене картинки лента догоняет быстрее, мелкие изменения остаются плавными." }).wrap
  );

  const screenColor = card(
    "Цвет с экрана",
    range({ path: "saturation", label: "Насыщенность", min: 0, max: 2, step: 0.05, fmt: (v) => `×${v.toFixed(2)}`,
      hint: "Больше 1 — цвета сочнее, меньше 1 — спокойнее и ближе к белому." }),
    range({ path: "darkThreshold", label: "Порог темноты", min: 0, max: 15, step: 0.5, fmt: (v) => (v ? `${v} %` : "выкл"),
      hint: "Если у края экрана почти чёрное — лента плавно гаснет, а не светит тусклым мусором." })
  );

  const displaySelect = el("select");
  displaySelect.addEventListener("change", () => set("displayId", displaySelect.value || null));
  bind("displayId", (v) => {
    if (displaySelect.options.length !== displays.length) {
      displaySelect.replaceChildren(...displays.map((d) => Object.assign(el("option", null, d.label), { value: d.id })));
    }
    displaySelect.value = v || displays[0]?.id || "";
  });
  const displayControl = el("div", "control");
  displayControl.append(head("Монитор"), displaySelect);

  const capture = card(
    "Захват экрана",
    displayControl,
    range({ path: "depth", label: "Глубина захвата", min: 3, max: 40, step: 1, fmt: (v) => `${v} %`,
      hint: "Какую полосу у края экрана учитывать. Больше — спокойнее, меньше — точнее к краю." }),
    toggle({ path: "letterbox", label: "Игнорировать чёрные полосы в фильмах",
      hint: "Берёт цвет с картинки, а не с чёрных полос сверху/снизу и по бокам." }).wrap
  );
  [smooth, screenColor, capture].forEach((c) => showIf(c, (s) => s.mode === "ambilight"));

  const music = card(
    "Музыка",
    range({ path: "music.sensitivity", label: "Чувствительность", min: 0.5, max: 2, step: 0.05, fmt: (v) => `×${v.toFixed(2)}`,
      hint: "Громкость подстраивается сама; здесь — насколько охотно лента реагирует на тихие звуки." }),
    range({ path: "music.decay", label: "Затухание", min: 80, max: 1200, step: 10, fmt: (v) => `${v} мс`,
      hint: "Как быстро свет гаснет после звука. Меньше — резкие вспышки, больше — плавные волны." }),
    el("p", "muted", "Лента слушает всё, что играет на компьютере: музыку, фильмы, игры. Микрофон не используется.")
  );
  showIf(music, (s) => s.mode === "music");

  const effect = card(
    "Эффект",
    range({ path: "effect.speed", label: "Скорость", min: 0.1, max: 4, step: 0.1, fmt: (v) => `×${v.toFixed(1)}` })
  );
  showIf(effect, (s) => s.mode === "effect");

  const colorInfo = card("Статичный цвет", el("p", "muted", "Выберите цвет слева. Яркость и баланс белого — ниже."));
  showIf(colorInfo, (s) => s.mode === "color");

  const wbRows = {};
  const wb = el("div", "control");
  wb.append(head("Баланс белого"));
  for (const [ch, tint] of [["r", "#ff6b6b"], ["g", "#3ccf8e"], ["b", "#5aa8ff"]]) {
    const row = el("div", "wb");
    const label = el("span", null, ch.toUpperCase());
    label.style.color = tint;
    const input = el("input");
    Object.assign(input, { type: "range", min: 100, max: 255, step: 1 });
    const value = el("span", "value");
    input.addEventListener("input", () => {
      value.textContent = input.value;
      set("whiteBalance." + ch, Number(input.value));
    });
    row.append(label, input, value);
    wb.append(row);
    wbRows[ch] = { input, value };
  }
  wb.append(el("div", "hint", "Если белый на ленте отдаёт в синеву или зелень — уменьшите этот канал."));
  bind("whiteBalance", (v) => {
    for (const ch in wbRows) {
      wbRows[ch].input.value = v[ch];
      wbRows[ch].value.textContent = v[ch];
    }
  });

  const common = card(
    "Яркость и цвет",
    range({ path: "brightness", label: "Яркость", min: 5, max: 100, step: 1, fmt: (v) => `${v} %` }),
    range({ path: "gamma", label: "Контраст (гамма)", min: 1, max: 2.8, step: 0.1, fmt: (v) => v.toFixed(1),
      hint: "Больше — глубже тёмные тона и ярче акценты, меньше — полутона светлее." }),
    wb,
    range({ path: "fps", label: "Частота обновления", min: 20, max: 60, step: 5, fmt: (v) => `${v} к/с`,
      hint: "Выше — плавнее движение, ниже — меньше нагрузка." })
  );

  panel.append(smooth, music, effect, colorInfo, screenColor, common, capture);
  return panel;
}

// ---------- Tab: profiles ----------

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function buildProfilesTab() {
  const panel = el("div");

  const current = el("div", "row");
  const currentText = el("span", "grow");
  const addCurrent = el("button", null, "Добавить правило для него");
  addCurrent.addEventListener("click", () => addRule(state.foreground));
  current.append(currentText, addCurrent);
  onRender.push(() => {
    const fg = state.foreground;
    currentText.textContent = fg ? `Последнее активное приложение: ${fg}` : "Активное приложение ещё не определено";
    addCurrent.disabled = !fg || settings.profiles.some((p) => p.exe === fg);
  });

  const rules = el("div", "rules");
  const renderRules = () => {
    if (rules.contains(document.activeElement)) return; // don't clobber typing
    const list = settings.profiles;
    if (!list.length) {
      rules.replaceChildren(el("div", "empty", "Правил пока нет."));
      return;
    }
    rules.replaceChildren(
      ...list.map((rule) => {
        const row = el("div", "rule");
        row.classList.toggle("live", state.activeProfile && state.activeProfile.id === rule.id);
        const exe = el("input");
        Object.assign(exe, { type: "text", value: rule.exe, placeholder: "например, cs2.exe" });
        exe.addEventListener("change", () => updateRule(rule.id, { exe: normalizeExe(exe.value) }));
        const scene = el("select");
        scene.append(...Presets.SCENES.map((sc) => Object.assign(el("option", null, sc.name), { value: sc.id })));
        scene.value = rule.scene;
        scene.addEventListener("change", () => updateRule(rule.id, { scene: scene.value }));
        const del = el("button", "icon", "✕");
        del.title = "Удалить правило";
        del.addEventListener("click", () => window.api.set({ profiles: settings.profiles.filter((p) => p.id !== rule.id) }));
        row.append(exe, scene, del);
        return row;
      })
    );
  };
  onRender.push(renderRules);

  const pickRow = el("div", "row");
  const pick = el("select");
  pick.className = "grow";
  const loadApps = el("button", null, "Обновить список");
  const addPicked = el("button", null, "Добавить");
  const refreshApps = async () => {
    const apps = await window.api.listApps();
    pick.replaceChildren(
      Object.assign(el("option", null, "— выберите запущенное приложение —"), { value: "" }),
      ...apps.map((a) => Object.assign(el("option", null, `${a.exe} — ${a.title}`.slice(0, 90)), { value: a.exe }))
    );
  };
  loadApps.addEventListener("click", refreshApps);
  addPicked.addEventListener("click", () => pick.value && addRule(pick.value));
  pickRow.append(pick, loadApps, addPicked);
  refreshApps();

  panel.append(
    card(
      "Профили приложений",
      el("p", "muted", "Когда выбранное приложение на переднем плане, подсветка сама переключается в нужный режим. Ушли из него — вернутся ваши обычные настройки."),
      current,
      pickRow
    ),
    card("Правила", rules, el("p", "muted", "Если поменять настройку вручную, пока профиль активен, — ваш выбор важнее профиля."))
  );
  return panel;
}

const normalizeExe = (v) => {
  const s = v.trim().toLowerCase();
  return s && !s.endsWith(".exe") ? s + ".exe" : s;
};

function addRule(exe) {
  if (!exe || settings.profiles.some((p) => p.exe === exe)) return;
  window.api.set({ profiles: [...settings.profiles, { id: newId(), exe, scene: "ambilight:games" }] });
}

function updateRule(id, patch) {
  window.api.set({ profiles: settings.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
}

// ---------- Tab: hotkeys ----------

const HOTKEYS = [
  { id: "toggle", name: "Включить / выключить подсветку" },
  { id: "nextMode", name: "Следующий режим" },
  { id: "brightnessUp", name: "Ярче на 10 %" },
  { id: "brightnessDown", name: "Тусклее на 10 %" },
];

// KeyboardEvent.code → Electron accelerator key (layout-independent, works with Russian layout).
function codeToKey(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^F\d{1,2}$/.test(code)) return code;
  if (/^Numpad\d$/.test(code)) return "num" + code.slice(6);
  const map = {
    ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Space: "Space",
    PageUp: "PageUp", PageDown: "PageDown", Home: "Home", End: "End", Insert: "Insert", Delete: "Delete",
    Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Comma: ",", Period: ".", Slash: "/",
    Semicolon: ";", Quote: "'", Backquote: "`", Backslash: "\\", NumpadAdd: "numadd", NumpadSubtract: "numsub",
  };
  return map[code] || null;
}

const prettyAccel = (a) =>
  a
    ? a.split("+").map((k) => ({ Control: "Ctrl", Super: "Win", Up: "↑", Down: "↓", Left: "←", Right: "→" })[k] || k).join(" + ")
    : "не задано";

function buildHotkeysTab() {
  const c = card("Горячие клавиши", el("p", "muted", "Работают везде, даже когда окно свёрнуто. Нажмите на поле и затем нужное сочетание; Esc — отмена."));
  for (const hk of HOTKEYS) {
    const row = el("div", "hotkey");
    const label = el("div");
    const error = el("div", "error", "Сочетание занято другой программой");
    label.append(el("div", null, hk.name), error);
    const input = el("input");
    Object.assign(input, { type: "text", readOnly: true });
    const clear = el("button", "icon", "✕");
    clear.title = "Убрать сочетание";
    clear.addEventListener("click", () => set("hotkeys." + hk.id, ""));

    input.addEventListener("focus", () => {
      window.api.pauseHotkeys(true);
      input.classList.add("recording");
      input.value = "Нажмите сочетание…";
    });
    input.addEventListener("blur", () => {
      window.api.pauseHotkeys(false);
      input.classList.remove("recording");
      input.value = prettyAccel(settings.hotkeys[hk.id]);
    });
    input.addEventListener("keydown", (e) => {
      e.preventDefault();
      if (e.code === "Escape") return input.blur();
      const mods = [e.ctrlKey && "Control", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean);
      const key = codeToKey(e.code);
      if (!key) {
        input.value = mods.length ? prettyAccel(mods.join("+")) + " + …" : "Нажмите сочетание…";
        return;
      }
      if (!mods.length && !/^F\d+$/.test(key)) {
        input.value = "Нужен Ctrl, Alt, Shift или Win";
        return;
      }
      set("hotkeys." + hk.id, [...mods, key].join("+"));
      input.blur();
    });

    bind("hotkeys", (v) => {
      if (document.activeElement !== input) input.value = prettyAccel(v[hk.id]);
    });
    onRender.push(() => (error.hidden = !state.hotkeyErrors.includes(hk.id)));
    row.append(label, input, clear);
    c.append(row);
  }
  return c;
}

// ---------- Tab: strip & system ----------

function buildDeviceTab() {
  const panel = el("div");

  const layoutCard = card("Раскладка ленты");
  layoutCard.append(el("div", "hint", "Сколько светодиодов на каждой стороне (вид спереди)."));
  const grid = el("div", "layout-grid");
  const inputs = {};
  for (const [side, label] of [["left", "Слева"], ["top", "Сверху"], ["right", "Справа"], ["bottom", "Снизу"]]) {
    const l = el("label", null, label);
    const input = el("input");
    Object.assign(input, { type: "number", min: 0, max: 200 });
    input.addEventListener("change", () => {
      const v = Math.max(0, Math.min(200, Math.round(Number(input.value) || 0)));
      window.api.set({ layout: { [side]: v }, layoutTouched: true });
    });
    l.append(input);
    grid.append(l);
    inputs[side] = input;
  }
  const reverse = toggle({
    path: "layout.reverse",
    label: "Обратное направление (от правого нижнего угла, против часовой)",
    onChange: (on) => window.api.set({ layout: { reverse: on }, layoutTouched: true }),
  });

  const sum = el("div", "hint");
  const row = el("div", "row");
  const auto = el("button", null, "Распределить автоматически");
  auto.addEventListener("click", () => {
    const sides = ["left", "top", "right"].concat(settings.layout.bottom ? ["bottom"] : []);
    const d = displays.find((x) => x.id === settings.displayId) || displays[0];
    const total = state.lampsAmount || sides.reduce((a, s) => a + settings.layout[s], 0);
    window.api.set({ layout: Ambilight.autoLayout(total, d ? d.aspect : 16 / 9, sides), layoutTouched: true });
  });
  const test = el("button", null, "Проверить раскладку");
  test.addEventListener("click", () => window.api.test(!state.testMode));
  row.append(auto, test);

  const legend = el("div", "legend");
  const names = { left: "левая сторона", top: "верх", right: "правая сторона", bottom: "низ" };
  for (const side of Ambilight.SIDE_ORDER) {
    const s = el("span");
    const i = el("i");
    i.style.background = `rgb(${Ambilight.SIDE_COLORS[side].join(",")})`;
    s.append(i, names[side]);
    legend.append(s);
  }
  const w = el("span");
  const wi = el("i");
  wi.style.background = "#fff";
  w.append(wi, "начало каждой стороны");
  legend.append(w);

  layoutCard.append(grid, reverse.wrap, sum, row, legend);
  bind("layout", (layout) => {
    for (const side in inputs) inputs[side].value = layout[side];
    const total = layout.left + layout.top + layout.right + layout.bottom;
    sum.textContent = `Всего в раскладке: ${total}` + (state.lampsAmount ? ` из ${state.lampsAmount} у ленты` : "");
  });
  onRender.push(() => {
    test.textContent = state.testMode ? "Завершить проверку" : "Проверить раскладку";
    test.classList.toggle("testing", state.testMode);
    legend.hidden = !state.testMode;
  });

  const reset = el("button", null, "Сбросить настройки");
  reset.addEventListener("click", () => window.api.resetSettings());
  const resetRow = el("div", "row");
  resetRow.append(reset, el("span", "hint grow", "Раскладка, профили и горячие клавиши при сбросе сохраняются."));
  const system = card(
    "Система",
    toggle({ path: "autostart", label: "Запускать вместе с Windows (свёрнуто в трей)" }).wrap,
    resetRow
  );

  panel.append(layoutCard, system);
  return panel;
}

// ---------- Tab: phone remote ----------

function buildPhoneTab() {
  const panel = el("div");

  const enable = toggle({ path: "remote.enabled", label: "Разрешить управление с телефона по Wi-Fi" });

  const qr = el("img", "qr");
  qr.alt = "QR-код";
  const pin = el("div", "pin");
  const urls = el("div", "hint");
  const clients = el("div", "hint");
  const steps = el("div", "steps");
  steps.append(
    el("div", null, "1. Подключите телефон к той же сети, что и компьютер."),
    el("div", null, "2. Наведите камеру телефона на QR-код и откройте ссылку — телефон привяжется сам."),
    el("div", null, "Или откройте адрес ниже в браузере телефона и введите PIN:"),
    pin,
    urls,
    clients
  );
  const grid = el("div", "phone-grid");
  grid.append(qr, steps);

  const warn = el("div", "banner warn inline");
  const warnText = el("span", null, "Сеть Windows отмечена как «Общедоступная» — в такой сети Windows не пускает телефон к компьютеру. Сделайте её «Частной»: Параметры → Сеть и Интернет → ваше подключение → Тип профиля сети → Частная.");
  const openNet = el("button", null, "Открыть параметры");
  openNet.addEventListener("click", () => window.api.openNetworkSettings());
  warn.append(warnText, openNet);
  const error = el("div", "error");

  const main = card("Пульт на телефоне", enable.wrap, warn, error, grid);
  onRender.push(() => {
    const r = state.remote;
    const on = settings.remote.enabled && r && r.running;
    grid.hidden = !on || !r.urls.length;
    warn.hidden = !on || !r.publicNetwork;
    error.hidden = !r || !r.error;
    error.textContent = r && r.error ? "Не удалось запустить: " + r.error : "";
    if (!on) return;
    if (qr.src !== r.qr) qr.src = r.qr;
    pin.textContent = r.pin;
    urls.textContent = r.urls.join("   ");
    clients.textContent = r.clients ? `Сейчас подключено: ${r.clients}` : "Сейчас ни один телефон не подключён";
  });

  const list = el("div", "devices");
  const forget = el("button", null, "Отвязать все устройства");
  forget.addEventListener("click", () => window.api.forgetDevices());
  const devices = card("Привязанные устройства", list, forget);
  onRender.push(() => {
    const d = (state.remote && state.remote.devices) || [];
    list.replaceChildren(
      ...(d.length
        ? d.map((x) => el("div", "device", `${x.name} — с ${new Date(x.added).toLocaleDateString("ru-RU")}`))
        : [el("div", "empty", "Пока ни одного.")])
    );
    forget.hidden = !d.length;
  });

  const tips = card(
    "Как сделать иконку на телефоне",
    el("p", "muted", "Откройте пульт в Chrome → меню ⋮ → «Добавить на главный экран». Пульт появится среди приложений со своей иконкой."),
    el("p", "muted", "PIN меняется при каждом запуске программы, но уже привязанным телефонам он больше не нужен.")
  );

  panel.append(main, devices, tips);
  return panel;
}

// ---------- Tabs ----------

function buildTabs() {
  const tabs = [
    { id: "mode", name: "Режим", build: buildModeTab },
    { id: "profiles", name: "Профили", build: buildProfilesTab },
    { id: "hotkeys", name: "Клавиши", build: buildHotkeysTab },
    { id: "phone", name: "Телефон", build: buildPhoneTab },
    { id: "device", name: "Лента и система", build: buildDeviceTab },
  ];
  const nav = $("tabs");
  const panel = $("panel");
  for (const t of tabs) {
    const b = el("button", null, t.name);
    const content = t.build();
    content.classList.add("tab-content");
    b.addEventListener("click", () => {
      tab = t.id;
      render();
    });
    nav.append(b);
    panel.append(content);
    onRender.push(() => {
      b.classList.toggle("active", tab === t.id);
      content.hidden = tab !== t.id;
    });
  }
}

// ---------- Render ----------

function render() {
  if (!settings || !state) return;
  for (const [path, fn] of refreshers) fn(getPath(settings, path));
  for (const [elem, fn] of visibility) elem.hidden = !fn(settings);
  for (const fn of onRender) fn();
  $("enabled").checked = settings.enabled;
  renderStatus();
}

function renderStatus() {
  const pills = [];
  const pill = (text, cls) => pills.push(el("span", "pill " + (cls || ""), text));
  if (state.connected) {
    pill("Лента подключена", "ok");
    pill(`${state.lampsAmount} светодиодов`);
    if (state.testMode) pill("проверка раскладки");
    else if (settings.enabled) pill(`${state.fps} к/с`);
  } else {
    pill("Лента не найдена — проверьте USB", "bad");
  }
  $("status").replaceChildren(...pills);
  $("syncLightBanner").hidden = !state.syncLightRunning;

  const l = settings.layout;
  const total = l.left + l.top + l.right + l.bottom;
  const layoutBanner = $("layoutBanner");
  layoutBanner.hidden = !state.lampsAmount || total === state.lampsAmount;
  layoutBanner.textContent = `В раскладке ${total} светодиодов, а у ленты ${state.lampsAmount}. Поправьте числа на вкладке «Лента и система».`;

  const profileBanner = $("profileBanner");
  const ap = state.activeProfile;
  profileBanner.hidden = !ap;
  if (ap) {
    const scene = Presets.SCENES.find((s) => s.id === ap.scene);
    profileBanner.textContent = `Активен профиль для ${ap.exe}: «${scene ? scene.name : ap.scene}».`;
  }

  const modeName = Presets.MODES.find((m) => m.id === settings.mode)?.name;
  $("previewHint").textContent = state.testMode
    ? "Сравните с лентой: цвета должны совпасть со сторонами монитора"
    : settings.enabled
      ? `Так сейчас светится лента — режим «${modeName}»`
      : "Подсветка выключена";
}

// ---------- Preview ----------

const canvas = $("preview");
const g2 = canvas.getContext("2d");

function drawPreview() {
  requestAnimationFrame(drawPreview);
  if (!settings) return;
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  g2.setTransform(dpr, 0, 0, dpr, 0, 0);
  g2.clearRect(0, 0, W, H);

  const d = displays.find((x) => x.id === settings.displayId) || displays[0];
  const aspect = d ? d.aspect : 16 / 9;
  const pad = 46;
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
  const rgb = leds.map((_, i) => {
    if (!on) return [0, 0, 0];
    const c = [colors[i * 3], colors[i * 3 + 1], colors[i * 3 + 2]];
    // The strip is power-limited (R+G+B <= 255); boost so the preview shows the hue clearly.
    const k = Math.min(3, 255 / Math.max(1, ...c));
    return c.map((v) => Math.round(v * k));
  });

  g2.globalCompositeOperation = "lighter";
  const glow = Math.max(28, Math.min(mw, mh) * 0.16);
  pos.forEach(([x, y], i) => {
    const [r, g, b] = rgb[i];
    if (r + g + b < 6) return;
    const grad = g2.createRadialGradient(x, y, 0, x, y, glow);
    grad.addColorStop(0, `rgba(${r},${g},${b},0.55)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    g2.fillStyle = grad;
    g2.fillRect(x - glow, y - glow, glow * 2, glow * 2);
  });
  g2.globalCompositeOperation = "source-over";

  g2.fillStyle = "#0b0d11";
  g2.strokeStyle = "#2f3542";
  g2.lineWidth = 1.5;
  g2.beginPath();
  g2.roundRect(mx, my, mw, mh, 8);
  g2.fill();
  g2.stroke();

  pos.forEach(([x, y], i) => {
    const [r, g, b] = rgb[i];
    g2.fillStyle = on && r + g + b > 0 ? `rgb(${r},${g},${b})` : "#3a404d";
    g2.beginPath();
    g2.arc(x, y, 2.6, 0, Math.PI * 2);
    g2.fill();
  });
  if (pos.length) {
    const [x, y] = pos[0];
    const side = leds[0].side;
    g2.fillStyle = "#8b92a3";
    g2.font = "11px Segoe UI";
    g2.textAlign = "center";
    const dx = side === "left" ? -16 : side === "right" ? 16 : 0;
    const dy = side === "top" ? -12 : side === "bottom" ? 18 : 4;
    g2.fillText("№1", x + dx, y + dy);
  }
}

// ---------- Boot ----------

buildHeader();
buildQuick();
buildTabs();
window.api.on("settings", (s) => {
  settings = s;
  render();
});
window.api.on("state", (s) => {
  state = s;
  render();
});
window.api.on("frame", (c) => (colors = c));
window.api.get().then((data) => {
  settings = data.settings;
  state = data.state;
  displays = data.displays;
  render();
  requestAnimationFrame(drawPreview);
});
