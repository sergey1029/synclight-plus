// Ambilight core: turns a downscaled screen image into smooth per-LED colors.
// Shared by the capture window (browser), the main process and tests (Node).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Ambilight = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const TO_LINEAR = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  // Strip order viewed from the front: clockwise from the bottom-left corner.
  // left: bottom→top, top: left→right, right: top→bottom, bottom: right→left.
  const SIDE_ORDER = ["left", "top", "right", "bottom"];

  // Each LED gets `t` — its position along its side (0 = top/left end, 1 = bottom/right end).
  function buildLeds(layout) {
    const leds = [];
    for (const side of SIDE_ORDER) {
      const n = layout[side] || 0;
      for (let i = 0; i < n; i++) {
        const along = (i + 0.5) / n;
        const t = side === "left" || side === "bottom" ? 1 - along : along;
        leds.push({ side, t, span: 1 / n });
      }
    }
    if (layout.reverse) leds.reverse();
    return leds;
  }

  // Splits `total` LEDs between sides proportionally to the screen edges.
  function autoLayout(total, aspect, sides) {
    const lens = { left: 1, right: 1, top: aspect, bottom: aspect };
    const sum = sides.reduce((a, s) => a + lens[s], 0);
    const layout = { left: 0, top: 0, right: 0, bottom: 0 };
    let used = 0;
    for (const s of sides) {
      layout[s] = Math.floor((total * lens[s]) / sum);
      used += layout[s];
    }
    // Leftovers go to the long edges first.
    const order = [...sides].sort((a, b) => lens[b] - lens[a]);
    for (let i = 0; used < total; i++, used++) layout[order[i % order.length]]++;
    return layout;
  }

  function gaussianKernel(sigma) {
    if (!(sigma > 0)) return [1];
    const radius = Math.ceil(sigma * 2.5);
    const k = [];
    let sum = 0;
    for (let i = -radius; i <= radius; i++) {
      const v = Math.exp(-(i * i) / (2 * sigma * sigma));
      k.push(v);
      sum += v;
    }
    return k.map((v) => v / sum);
  }

  const smoothstep = (a, b, x) => {
    if (x <= a) return 0;
    if (x >= b) return 1;
    const t = (x - a) / (b - a);
    return t * t * (3 - 2 * t);
  };

  // Overlap between neighbouring LED sample areas (1 = touching, 1.6 = 60% wider).
  const SPREAD = 1.6;
  // A row/column counts as letterbox if fewer than this share of its pixels is bright.
  const BAR_BRIGHT_SHARE = 0.04;
  const BAR_LEVEL = 28;
  const BAR_TAU_MS = 800;
  const POWER_LIMIT = 255;

  class Processor {
    constructor() {
      this.n = 0;
      this.leds = [];
      this.raw = new Float32Array(0);
      this.target = new Float32Array(0);
      this.state = null;
      this.hasTarget = false;
      this.integral = null;
      this.size = "";
      this.bars = { x: 0, y: 0 };
      this.lastAnalyze = 0;
    }

    configure(settings) {
      this.s = settings;
      this.leds = buildLeds(settings.layout);
      if (this.leds.length !== this.n) {
        this.n = this.leds.length;
        this.raw = new Float32Array(this.n * 3);
        this.target = new Float32Array(this.n * 3);
        this.state = null;
        this.hasTarget = false;
      }
      this.kernel = gaussianKernel(settings.blur);
      this.closed = settings.layout.bottom > 0 && settings.layout.top > 0;
    }

    detectBars(rgba, w, h) {
      const bright = (p) => Math.max(rgba[p], rgba[p + 1], rgba[p + 2]) > BAR_LEVEL;
      const rowDark = (y) => {
        let n = 0;
        for (let x = 0; x < w; x++) if (bright((y * w + x) * 4)) n++;
        return n <= w * BAR_BRIGHT_SHARE;
      };
      const colDark = (x) => {
        let n = 0;
        for (let y = 0; y < h; y++) if (bright((y * w + x) * 4)) n++;
        return n <= h * BAR_BRIGHT_SHARE;
      };
      const maxY = Math.floor(h * 0.3);
      const maxX = Math.floor(w * 0.3);
      let top = 0, bottom = 0, left = 0, right = 0;
      while (top < maxY && rowDark(top)) top++;
      while (bottom < maxY && rowDark(h - 1 - bottom)) bottom++;
      while (left < maxX && colDark(left)) left++;
      while (right < maxX && colDark(w - 1 - right)) right++;
      // Fully dark frame: keep previous bars instead of jumping.
      if (top >= maxY && bottom >= maxY) return null;
      // Real letterbox/pillarbox is symmetric; a dark sky on one side is not a bar.
      return { x: Math.min(left, right), y: Math.min(top, bottom) };
    }

    analyze(rgba, w, h, now = Date.now()) {
      if (!this.n) return;
      const s = this.s;
      const W = w + 1;
      const key = w + "x" + h;
      if (this.size !== key) {
        this.size = key;
        this.integral = new Float64Array(W * (h + 1) * 3);
        this.bars = { x: 0, y: 0 };
      }
      const I = this.integral;
      for (let y = 0; y < h; y++) {
        let sr = 0, sg = 0, sb = 0;
        for (let x = 0; x < w; x++) {
          const p = (y * w + x) * 4;
          sr += TO_LINEAR[rgba[p]];
          sg += TO_LINEAR[rgba[p + 1]];
          sb += TO_LINEAR[rgba[p + 2]];
          const o = ((y + 1) * W + x + 1) * 3;
          const u = (y * W + x + 1) * 3;
          I[o] = I[u] + sr;
          I[o + 1] = I[u + 1] + sg;
          I[o + 2] = I[u + 2] + sb;
        }
      }

      if (s.letterbox) {
        const found = this.detectBars(rgba, w, h);
        if (found) {
          const dt = this.lastAnalyze ? now - this.lastAnalyze : 1000;
          const a = 1 - Math.exp(-dt / BAR_TAU_MS);
          this.bars.x += (found.x - this.bars.x) * a;
          this.bars.y += (found.y - this.bars.y) * a;
        }
      } else {
        this.bars.x = this.bars.y = 0;
      }
      this.lastAnalyze = now;

      const x0 = Math.round(this.bars.x), x1 = w - x0;
      const y0 = Math.round(this.bars.y), y1 = h - y0;
      const cw = x1 - x0, ch = y1 - y0;
      const depth = Math.max(1, Math.round((s.depth / 100) * Math.min(cw, ch)));

      const sum = (ax, ay, bx, by, out, k) => {
        ax = Math.max(x0, Math.min(x1 - 1, Math.round(ax)));
        ay = Math.max(y0, Math.min(y1 - 1, Math.round(ay)));
        bx = Math.max(ax + 1, Math.min(x1, Math.round(bx)));
        by = Math.max(ay + 1, Math.min(y1, Math.round(by)));
        const area = (bx - ax) * (by - ay);
        const A = (ay * W + ax) * 3, B = (ay * W + bx) * 3;
        const C = (by * W + ax) * 3, D = (by * W + bx) * 3;
        for (let c = 0; c < 3; c++) out[k + c] = (I[D + c] - I[B + c] - I[C + c] + I[A + c]) / area;
      };

      const raw = this.raw;
      this.leds.forEach((led, i) => {
        const k = i * 3;
        if (led.side === "top" || led.side === "bottom") {
          const cx = x0 + led.t * cw;
          const half = (led.span * cw * SPREAD) / 2;
          const ya = led.side === "top" ? y0 : y1 - depth;
          sum(cx - half, ya, cx + half, ya + depth, raw, k);
        } else {
          const cy = y0 + led.t * ch;
          const half = (led.span * ch * SPREAD) / 2;
          const xa = led.side === "left" ? x0 : x1 - depth;
          sum(xa, cy - half, xa + depth, cy + half, raw, k);
        }
      });

      // Gaussian blur along the strip so neighbouring LEDs blend into each other.
      const K = this.kernel, r = (K.length - 1) / 2, n = this.n;
      for (let i = 0; i < n; i++) {
        let R = 0, G = 0, B = 0;
        for (let j = -r; j <= r; j++) {
          let idx = i + j;
          if (this.closed) idx = (idx + n) % n;
          else idx = Math.max(0, Math.min(n - 1, idx));
          const wgt = K[j + r];
          R += raw[idx * 3] * wgt;
          G += raw[idx * 3 + 1] * wgt;
          B += raw[idx * 3 + 2] * wgt;
        }
        this.target[i * 3] = R;
        this.target[i * 3 + 1] = G;
        this.target[i * 3 + 2] = B;
      }
      this.hasTarget = true;
    }

    // Advances smoothing by dtMs and returns the 8-bit colors to send (n * 3 bytes).
    // Smoothing runs on final (color-corrected, power-limited) values, so fades
    // last the full smoothing time and never overshoot the power limit.
    step(dtMs) {
      const n = this.n, s = this.s;
      const out = new Uint8Array(n * 3);
      if (!this.hasTarget) return out;
      const tg = this.colorize(this.target);
      if (!this.state) this.state = tg;
      const st = this.state;

      let tau = s.smoothing;
      if (s.sceneReact && tau > 0) {
        // A scene cut (big change across the whole strip) is followed faster.
        let d = 0;
        for (let i = 0; i < st.length; i++) d += Math.abs(tg[i] - st[i]);
        d /= st.length * 85;
        tau /= 1 + 12 * d;
      }
      const a = tau > 0 ? 1 - Math.exp(-dtMs / tau) : 1;
      for (let i = 0; i < st.length; i++) st[i] += (tg[i] - st[i]) * a;
      for (let i = 0; i < st.length; i += 3) {
        // Rounding up could push a color at the power limit to 256+; round down then.
        const rnd = st[i] + st[i + 1] + st[i + 2] > POWER_LIMIT - 1.5 ? Math.floor : Math.round;
        out[i] = rnd(st[i]);
        out[i + 1] = rnd(st[i + 1]);
        out[i + 2] = rnd(st[i + 2]);
      }
      return out;
    }

    // Linear light → corrected 0..255 output values (floats).
    colorize(lin) {
      const n = this.n, s = this.s;
      const res = new Float32Array(n * 3);
      const sat = s.saturation;
      const gain = s.brightness / 100;
      const exp = s.gamma / 2.2;
      const thr = Math.pow(s.darkThreshold / 100, 2.2);
      const wb = s.whiteBalance;
      for (let i = 0; i < n; i++) {
        let r = lin[i * 3], g = lin[i * 3 + 1], b = lin[i * 3 + 2];
        const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        r = Math.max(0, L + (r - L) * sat);
        g = Math.max(0, L + (g - L) * sat);
        b = Math.max(0, L + (b - L) * sat);
        const fade = thr > 0 ? smoothstep(thr * 0.5, thr, L) : 1;
        r = Math.pow(Math.min(1, r * fade), exp) * 255 * gain * (wb.r / 255);
        g = Math.pow(Math.min(1, g * fade), exp) * 255 * gain * (wb.g / 255);
        b = Math.pow(Math.min(1, b * fade), exp) * 255 * gain * (wb.b / 255);
        // Power limit kept from SyncLight: the USB-powered strip must stay at R+G+B <= 255.
        const total = r + g + b;
        if (total > POWER_LIMIT) {
          const k = POWER_LIMIT / total;
          r *= k;
          g *= k;
          b *= k;
        }
        res[i * 3] = r;
        res[i * 3 + 1] = g;
        res[i * 3 + 2] = b;
      }
      return res;
    }
  }

  // Calibration pattern: each side its own color, white LED at the start of each side.
  const SIDE_COLORS = { left: [200, 0, 0], top: [0, 200, 0], right: [0, 0, 200], bottom: [150, 100, 0] };

  function testPattern(layout) {
    const leds = buildLeds(layout);
    const out = new Uint8Array(leds.length * 3);
    leds.forEach((led, i) => {
      const first = i === 0 || leds[i - 1].side !== led.side;
      const c = first ? [85, 85, 85] : SIDE_COLORS[led.side];
      out.set(c, i * 3);
    });
    return out;
  }

  return { buildLeds, autoLayout, Processor, testPattern, SIDE_ORDER, SIDE_COLORS };
});
