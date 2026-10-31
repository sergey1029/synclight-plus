// Modes, presets, palettes and profile scenes shared by the main process, engine and UI.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Presets = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MODES = [
    { id: "ambilight", name: "Экран" },
    { id: "music", name: "Музыка" },
    { id: "effect", name: "Эффекты" },
    { id: "color", name: "Цвет" },
  ];

  const AMBILIGHT_PRESETS = [
    { id: "cinema", name: "Кино", note: "мягко и глубоко", values: { smoothing: 450, blur: 2, depth: 12, sceneReact: true, saturation: 1.15, gamma: 1.7 } },
    { id: "games", name: "Игры", note: "быстрая реакция", values: { smoothing: 90, blur: 1, depth: 10, sceneReact: true, saturation: 1.25, gamma: 1.6 } },
    { id: "calm", name: "Спокойно", note: "медленные переливы", values: { smoothing: 1200, blur: 3.5, depth: 18, sceneReact: false, saturation: 1.0, gamma: 1.6 } },
    { id: "vivid", name: "Ярко", note: "сочные цвета", values: { smoothing: 200, blur: 1.5, depth: 10, sceneReact: true, saturation: 1.5, gamma: 1.4 } },
  ];

  const MUSIC_STYLES = [
    { id: "spectrum", name: "Спектр", note: "басы снизу, высокие сверху" },
    { id: "pulse", name: "Пульс", note: "вспышки в такт басам" },
    { id: "wave", name: "Волны", note: "звук бежит от центра" },
  ];

  const EFFECTS = [
    { id: "flow", name: "Переливы", note: "палитра плывёт по ленте" },
    { id: "breathe", name: "Дыхание", note: "один цвет плавно дышит" },
    { id: "candle", name: "Свеча", note: "тёплое живое мерцание" },
    { id: "aurora", name: "Сияние", note: "северное сияние" },
  ];

  // Cyclic palettes (first stop == last stop) so moving gradients loop seamlessly.
  const PALETTES = {
    rainbow: { name: "Радуга", stops: ["#ff0000", "#ffaa00", "#ffff00", "#00ff00", "#00ffff", "#0040ff", "#ff00ff", "#ff0000"] },
    sunset: { name: "Закат", stops: ["#ff0040", "#ff5a00", "#ffb000", "#ff5a00", "#ff0040"] },
    ocean: { name: "Океан", stops: ["#00e1ff", "#0050ff", "#6a00ff", "#0050ff", "#00e1ff"] },
    neon: { name: "Неон", stops: ["#ff00c8", "#7000ff", "#00f0ff", "#7000ff", "#ff00c8"] },
    forest: { name: "Лес", stops: ["#00ff6a", "#a0ff00", "#00c8a0", "#00ff6a"] },
  };

  const COLOR_SWATCHES = ["#ff8a3d", "#ffd27a", "#ffffff", "#ff3b3b", "#ff2fa0", "#9b5cff", "#3b6bff", "#00d5ff", "#2bff88"];

  // What a profile can switch to while its application is in front.
  const SCENES = [
    ...AMBILIGHT_PRESETS.map((p) => ({ id: "ambilight:" + p.id, name: "Экран — " + p.name })),
    { id: "ambilight", name: "Экран (мои настройки)" },
    { id: "music", name: "Музыка" },
    { id: "effect", name: "Эффекты" },
    { id: "color", name: "Статичный цвет" },
    { id: "off", name: "Выключить подсветку" },
  ];

  function sceneToPatch(id) {
    if (id === "off") return { enabled: false };
    if (id.startsWith("ambilight:")) {
      const preset = AMBILIGHT_PRESETS.find((p) => "ambilight:" + p.id === id);
      return { enabled: true, mode: "ambilight", ...(preset ? preset.values : {}) };
    }
    return { enabled: true, mode: id };
  }

  return { MODES, AMBILIGHT_PRESETS, MUSIC_STYLES, EFFECTS, PALETTES, COLOR_SWATCHES, SCENES, sceneToPatch };
});
