// Software light effects, static color and the shared output stage (gamma, brightness, power limit).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("../shared/presets"));
  else root.Effects = factory(root.Presets);
})(typeof self !== "undefined" ? self : this, function (Presets) {
  "use strict";

  const POWER_LIMIT = 255;

  function hexToRgb(hex) {
    const v = parseInt(String(hex).replace("#", ""), 16) || 0;
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }

  const paletteStops = (id) => (Presets.PALETTES[id] || Presets.PALETTES.rainbow).stops.map(hexToRgb);

  // x wraps around, so palettes can scroll forever.
  function samplePalette(stops, x) {
    x = ((x % 1) + 1) % 1;
    const f = x * (stops.length - 1);
    const i = Math.floor(f), t = f - i;
    const a = stops[i], b = stops[Math.min(i + 1, stops.length - 1)];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }

  // sRGB colors (0..255 floats) → bytes for the strip: gamma, brightness, white balance, power limit.
  // Matches Ambilight.Processor.colorize so every mode looks consistent.
  function finalize(rgb, s) {
    const out = new Uint8Array(rgb.length);
    const gain = s.brightness / 100, wb = s.whiteBalance;
    const k = [gain * (wb.r / 255), gain * (wb.g / 255), gain * (wb.b / 255)];
    for (let i = 0; i < rgb.length; i += 3) {
      const c = [0, 1, 2].map((j) => Math.pow(Math.max(0, Math.min(255, rgb[i + j])) / 255, s.gamma) * 255 * k[j]);
      const total = c[0] + c[1] + c[2];
      const lim = total > POWER_LIMIT ? POWER_LIMIT / total : 1;
      // Rounding up could push a limited color to 256+, so limited colors round down.
      const rnd = lim < 1 ? Math.floor : Math.round;
      for (let j = 0; j < 3; j++) out[i + j] = rnd(c[j] * lim);
    }
    return out;
  }

  function solid(n, hex) {
    const c = hexToRgb(hex);
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) out.set(c, i * 3);
    return out;
  }

  // Smooth 1D/2D value noise for organic effects.
  const hash = (i) => {
    const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  const fade = (t) => t * t * (3 - 2 * t);
  function noise1(x) {
    const i = Math.floor(x), u = fade(x - i);
    return hash(i) * (1 - u) + hash(i + 1) * u;
  }
  function noise2(x, y) {
    const j = Math.floor(y), v = fade(y - j);
    return noise1(x + j * 57.13) * (1 - v) + noise1(x + (j + 1) * 57.13) * v;
  }

  const CANDLE_DEEP = [255, 70, 0];
  const CANDLE_BRIGHT = [255, 160, 40];
  const AURORA = ["#00ff88", "#00c8ff", "#7a3cff", "#ff3cc8", "#00ff88"].map(hexToRgb);

  class EffectRenderer {
    constructor() {
      this.t = 0;
    }

    configure(s, n) {
      this.s = s;
      this.n = n;
      this.palette = paletteStops(s.effect.palette);
      this.color = hexToRgb(s.effect.color);
    }

    // Returns sRGB floats (n * 3).
    step(dtMs) {
      const { n } = this;
      const e = this.s.effect;
      this.t += (dtMs / 1000) * e.speed;
      const t = this.t;
      const out = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const x = n > 1 ? i / (n - 1) : 0;
        let c;
        switch (e.type) {
          case "breathe": {
            const k = 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / 5);
            const level = 0.04 + 0.96 * k * k;
            c = this.color.map((v) => v * level);
            break;
          }
          case "candle": {
            const flicker = 0.55 * noise1(t * 2.2 + i * 0.25) + 0.3 * noise1(t * 7 + i * 0.9 + 50) + 0.15;
            const mix = noise1(t * 0.8 + i * 0.15 + 99);
            c = CANDLE_DEEP.map((v, j) => (v + (CANDLE_BRIGHT[j] - v) * mix) * flicker);
            break;
          }
          case "aurora": {
            const hue = noise2(x * 2.5, t * 0.12);
            const curtain = fade(Math.min(1, Math.max(0, noise2(x * 5 - t * 0.35, t * 0.2 + 10) * 1.6 - 0.3)));
            c = samplePalette(AURORA, hue).map((v) => v * (0.15 + 0.85 * curtain));
            break;
          }
          default: // flow
            c = samplePalette(this.palette, x - t / 12);
        }
        out[i * 3] = c[0];
        out[i * 3 + 1] = c[1];
        out[i * 3 + 2] = c[2];
      }
      return out;
    }
  }

  return { hexToRgb, paletteStops, samplePalette, finalize, solid, noise1, EffectRenderer };
});
