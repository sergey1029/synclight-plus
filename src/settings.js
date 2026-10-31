// User settings: defaults, load/save as JSON in the app data folder.
const fs = require("fs");

const DEFAULTS = {
  enabled: true,
  mode: "ambilight",
  displayId: null,
  fps: 60,
  smoothing: 300,
  blur: 1.5,
  depth: 12,
  sceneReact: true,
  letterbox: true,
  brightness: 100,
  saturation: 1.2,
  gamma: 1.6,
  darkThreshold: 3,
  whiteBalance: { r: 255, g: 255, b: 255 },
  // ZX strip starts at the bottom-right corner (viewed from the front) and runs counter-clockwise.
  layout: { left: 16, top: 39, right: 16, bottom: 0, reverse: true },
  layoutTouched: false,
  music: { style: "spectrum", sensitivity: 1, decay: 300, palette: "rainbow" },
  effect: { type: "flow", speed: 1, palette: "rainbow", color: "#7c5cff" },
  color: "#ff8a3d",
  profiles: [], // [{ id, exe, scene }]
  hotkeys: {
    toggle: "Control+Alt+L",
    nextMode: "Control+Alt+M",
    brightnessUp: "Control+Alt+Up",
    brightnessDown: "Control+Alt+Down",
  },
  remote: { enabled: true, port: 8765 },
  autostart: false,
};

const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);

function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = isObject(v) && isObject(base[k]) ? merge(base[k], v) : v;
  }
  return out;
}

function load(file) {
  try {
    return merge(DEFAULTS, JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return structuredClone(DEFAULTS);
  }
}

let timer = null;
function save(file, settings) {
  clearTimeout(timer);
  timer = setTimeout(() => fs.writeFileSync(file, JSON.stringify(settings, null, 2)), 300);
}

module.exports = { DEFAULTS, merge, load, save };
