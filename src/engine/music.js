// Music mode: turns the system audio spectrum into LED colors.
// Layout is mirrored around the middle of the strip (top center of the monitor):
// the strip ends (bottom of the sides) get the bass, the middle gets the highs.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./effects"));
  else root.Music = factory(root.Effects);
})(typeof self !== "undefined" ? self : this, function (Effects) {
  "use strict";

  const F_MIN = 40;
  const F_MAX = 10000;
  // Music gets quieter towards the highs; lift upper bands (in 0..1 dB-scaled units).
  const TILT = 0.22;
  const ATTACK_MS = 25;
  const AGC_DECAY = 0.996; // per update; the loudness reference falls ~2x in ~3 s
  const AGC_FLOOR = 0.12;
  const NOISE_GATE = 0.22;
  const BEAT_RATIO = 1.3;
  const BEAT_MIN_GAP_MS = 180;
  const WAVE_SPEED = 22; // LEDs per second

  class MusicProcessor {
    constructor() {
      this.half = 0;
      this.peak = AGC_FLOOR;
      this.hue = 0;
      this.flash = 0;
      this.bassAvg = 0;
      this.lastBeat = 0;
      this.energy = 0;
      this.centroid = 0;
      this.clock = 0;
      this.waveShift = 0;
    }

    configure(s, n) {
      this.s = s;
      this.n = n;
      const half = Math.max(1, Math.ceil(n / 2));
      if (half !== this.half) {
        this.half = half;
        this.target = new Float32Array(half);
        this.levels = new Float32Array(half);
        this.wave = new Float32Array(half * 3);
      }
      this.palette = Effects.paletteStops(s.music.palette);
    }

    // spec: byte frequency data (0..255, log-scaled dB) from an AnalyserNode.
    update(spec, sampleRate) {
      const half = this.half, bins = spec.length, nyq = sampleRate / 2;
      let frameMax = 0;
      const raw = new Float32Array(half);
      for (let b = 0; b < half; b++) {
        const f0 = F_MIN * Math.pow(F_MAX / F_MIN, b / half);
        const f1 = F_MIN * Math.pow(F_MAX / F_MIN, (b + 1) / half);
        const i0 = Math.min(bins - 1, Math.floor((f0 / nyq) * bins));
        const i1 = Math.min(bins, Math.max(i0 + 1, Math.ceil((f1 / nyq) * bins)));
        let sum = 0;
        for (let i = i0; i < i1; i++) sum += spec[i];
        const v = sum / (i1 - i0) / 255;
        raw[b] = v > 0 ? v + (TILT * b) / half : 0;
        if (raw[b] > frameMax) frameMax = raw[b];
      }

      // Automatic gain: quiet and loud tracks both use the full range.
      this.peak = Math.max(frameMax, this.peak * AGC_DECAY, AGC_FLOOR);
      const sens = this.s.music.sensitivity;
      let energy = 0, weighted = 0;
      for (let b = 0; b < half; b++) {
        const v = Math.min(1, Math.max(0, ((raw[b] / this.peak) * sens - NOISE_GATE) / (1 - NOISE_GATE)));
        this.target[b] = v;
        energy += v;
        weighted += v * b;
      }
      this.energy = energy / half;
      this.centroid = energy > 0 ? weighted / energy / half : this.centroid;

      // Beat = bass jumping well above its recent average.
      const bassBands = Math.max(1, Math.round(half * 0.15));
      let bass = 0;
      for (let b = 0; b < bassBands; b++) bass += this.target[b];
      bass /= bassBands;
      if (bass > 0.3 && bass > this.bassAvg * BEAT_RATIO && this.clock - this.lastBeat > BEAT_MIN_GAP_MS) {
        this.lastBeat = this.clock;
        this.flash = 1;
        this.hue += 0.17;
      }
      this.bassAvg = this.bassAvg * 0.92 + bass * 0.08;
      this.bass = bass;
    }

    // Returns sRGB floats (n * 3).
    step(dtMs) {
      const { n, half } = this;
      const m = this.s.music;
      this.clock += dtMs;
      this.hue += (dtMs / 1000) * 0.02;
      this.flash *= Math.exp(-dtMs / Math.max(60, m.decay * 0.6));

      const up = 1 - Math.exp(-dtMs / ATTACK_MS);
      const down = 1 - Math.exp(-dtMs / Math.max(30, m.decay));
      for (let b = 0; b < half; b++) {
        const d = this.target[b] - this.levels[b];
        this.levels[b] += d * (d > 0 ? up : down);
      }

      const out = new Float32Array(n * 3);
      const center = (n - 1) / 2;
      const color = (x, level) => Effects.samplePalette(this.palette, x).map((v) => v * level);

      if (m.style === "wave") {
        // Emit the current sound color at the center; the history runs outwards.
        const emit = color(this.hue + this.centroid * 0.5, Math.min(1, this.energy * 1.6 + this.flash * 0.5));
        this.waveShift += (dtMs / 1000) * WAVE_SPEED;
        while (this.waveShift >= 1) {
          this.wave.copyWithin(3, 0, (half - 1) * 3);
          for (let j = 3; j < half * 3; j++) this.wave[j] *= 0.97;
          this.waveShift -= 1;
        }
        this.wave.set(emit, 0);
        for (let i = 0; i < n; i++) {
          const pos = Math.abs(i - center) - this.waveShift;
          const k = Math.max(0, Math.min(half - 1, Math.floor(pos)));
          const k2 = Math.min(half - 1, k + 1), t = Math.max(0, Math.min(1, pos - k));
          for (let c = 0; c < 3; c++) out[i * 3 + c] = this.wave[k * 3 + c] * (1 - t) + this.wave[k2 * 3 + c] * t;
        }
      } else if (m.style === "pulse") {
        const level = Math.min(1, Math.max(this.flash, this.bass * 0.5) * 0.9 + this.energy * 0.25);
        for (let i = 0; i < n; i++) {
          const x = Math.abs(i - center) / Math.max(1, center);
          out.set(color(this.hue + x * 0.12, level), i * 3);
        }
      } else {
        // Spectrum: distance from the center picks the band (ends = bass).
        for (let i = 0; i < n; i++) {
          const d = Math.abs(i - center) / Math.max(1, center);
          const f = (1 - d) * (half - 1);
          const b = Math.floor(f), t = f - b;
          const lv = this.levels[b] * (1 - t) + this.levels[Math.min(half - 1, b + 1)] * t;
          out.set(color(this.hue + (1 - d) * 0.6, Math.pow(lv, 1.3)), i * 3);
        }
      }
      return out;
    }
  }

  return { MusicProcessor };
});
