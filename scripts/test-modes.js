// Checks music, effects and the shared output stage on synthetic input (no hardware needed).
const assert = require("assert");
const Effects = require("../src/engine/effects");
const { MusicProcessor } = require("../src/engine/music");
const { DEFAULTS, merge } = require("../src/settings");
const Presets = require("../src/shared/presets");

const N = 71;
const s = merge(DEFAULTS, {});
const lum = (arr, i) => arr[i * 3] + arr[i * 3 + 1] + arr[i * 3 + 2];

// 1. Output stage: power limit and brightness.
let out = Effects.finalize(Effects.solid(N, "#ffffff"), s);
assert.ok(lum(out, 0) <= 255 && lum(out, 0) >= 250, "white is limited to R+G+B<=255: " + lum(out, 0));
out = Effects.finalize(Effects.solid(N, "#ff0000"), merge(s, { brightness: 50 }));
assert.deepStrictEqual([out[0], out[1], out[2]], [128, 0, 0]);
console.log("ok  выход: белый ограничен по питанию, яркость 50% → красный 128");

// 2. Every effect renders valid, changing frames.
for (const e of Presets.EFFECTS) {
  const r = new Effects.EffectRenderer();
  r.configure(merge(s, { effect: { type: e.id } }), N);
  const a = Effects.finalize(r.step(16), s);
  let b;
  for (let i = 0; i < 60; i++) b = Effects.finalize(r.step(16), s);
  assert.strictEqual(a.length, N * 3);
  assert.ok(a.some((v) => v > 0), e.id + " is not black");
  assert.ok(a.some((v, i) => v !== b[i]), e.id + " animates");
  for (let i = 0; i < N; i++) assert.ok(lum(b, i) <= 255);
}
console.log("ok  эффекты:", Presets.EFFECTS.map((e) => e.name).join(", "), "— рисуют и анимируются");

// 3. Music, spectrum style: bass lights the strip ends, highs light the middle.
function spectrum(lowLevel, highLevel) {
  const spec = new Uint8Array(1024); // 48 kHz → 23.4 Hz per bin
  for (let i = 0; i < spec.length; i++) {
    const f = (i * 24000) / spec.length;
    spec[i] = f < 200 ? lowLevel : f > 3000 && f < 10000 ? highLevel : 20;
  }
  return spec;
}
const m = new MusicProcessor();
m.configure(s, N);
for (let i = 0; i < 30; i++) {
  m.update(spectrum(230, 20), 48000);
  out = m.step(16);
}
const ends = lum(out, 0) + lum(out, N - 1), middle = lum(out, 35);
assert.ok(ends > 200 && middle < 30, `bass → ends (${ends.toFixed(0)}), middle dark (${middle.toFixed(0)})`);
for (let i = 0; i < 30; i++) {
  m.update(spectrum(20, 230), 48000);
  out = m.step(16);
}
assert.ok(lum(out, 35) > lum(out, 0), "highs → middle");
console.log("ok  музыка/спектр: басы на концах ленты, высокие в центре");

// 4. Silence fades to dark.
for (let i = 0; i < 120; i++) {
  m.update(new Uint8Array(1024), 48000);
  out = m.step(16);
}
assert.ok(out.every((v) => v < 3), "silence → dark");
console.log("ok  музыка: тишина → лента плавно гаснет");

// 5. Pulse style: a bass hit after quiet triggers a flash.
const p = new MusicProcessor();
p.configure(merge(s, { music: { style: "pulse" } }), N);
for (let i = 0; i < 60; i++) {
  p.update(spectrum(60, 60), 48000);
  p.step(16);
}
const before = lum(p.step(16), 10);
p.update(spectrum(255, 60), 48000);
const after = lum(p.step(16), 10);
assert.ok(after > before + 50, `beat flash: ${before.toFixed(0)} → ${after.toFixed(0)}`);
console.log(`ok  музыка/пульс: удар баса даёт вспышку (${before.toFixed(0)} → ${after.toFixed(0)})`);

// 6. Wave style: sound starts at the center and travels to the ends.
const w = new MusicProcessor();
w.configure(merge(s, { music: { style: "wave" } }), N);
w.update(spectrum(230, 230), 48000);
out = w.step(16);
assert.ok(lum(out, 35) > 0 && lum(out, 0) === 0, "wave starts at the center");
for (let i = 0; i < 120; i++) {
  w.update(spectrum(230, 230), 48000);
  out = w.step(16);
}
assert.ok(lum(out, 0) > 0, "wave reaches the ends");
console.log("ok  музыка/волны: звук стартует в центре и доходит до краёв");

// 7. Profile scenes.
assert.deepStrictEqual(Presets.sceneToPatch("off"), { enabled: false });
assert.strictEqual(Presets.sceneToPatch("ambilight:games").smoothing, 90);
assert.deepStrictEqual(Presets.sceneToPatch("music"), { enabled: true, mode: "music" });
console.log("ok  профили: сцены превращаются в нужные настройки");
