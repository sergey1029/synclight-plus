// Checks the ambilight core on synthetic frames (no hardware needed).
const assert = require("assert");
const { Processor, buildLeds, autoLayout } = require("../src/engine/ambilight");

const settings = {
  layout: { left: 16, top: 39, right: 16, bottom: 0, reverse: false },
  smoothing: 300, blur: 0, depth: 12, sceneReact: false, letterbox: true,
  brightness: 100, saturation: 1, gamma: 2.2, darkThreshold: 0,
  whiteBalance: { r: 255, g: 255, b: 255 },
};

const W = 160, H = 67;
function frame(fill, barRows = 0) {
  const img = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      const inBar = y < barRows || y >= H - barRows;
      img.set(inBar ? [0, 0, 0] : fill(x, y - barRows, H - 2 * barRows), p);
      img[p + 3] = 255;
    }
  return img;
}
const edges = (x, y, h) =>
  x < W * 0.1 ? [255, 0, 0] : x >= W * 0.9 ? [0, 0, 255] : y < h * 0.15 ? [0, 255, 0] : [40, 40, 40];

const ledColor = (out, i) => [out[i * 3], out[i * 3 + 1], out[i * 3 + 2]];
const dominant = (c) => ["R", "G", "B"][c.indexOf(Math.max(...c))];

// 1. Sides map to the right LEDs.
let p = new Processor();
p.configure(settings);
p.analyze(frame(edges), W, H, 0);
let out = p.step(16);
const leds = buildLeds(settings.layout);
assert.strictEqual(leds.length, 71);
assert.strictEqual(dominant(ledColor(out, 3)), "R", "left side should be red");
assert.strictEqual(dominant(ledColor(out, 35)), "G", "top middle should be green");
assert.strictEqual(dominant(ledColor(out, 66)), "B", "right side should be blue");
assert.ok(out.every((v, i) => i % 3 || v + out[i + 1] + out[i + 2] <= 255), "power limit");
console.log("ok  стороны: слева красный, сверху зелёный, справа синий; лимит R+G+B<=255");

// 2. Smoothing: after a cut to white, color moves gradually, ~63% after one tau.
p = new Processor();
p.configure(settings);
p.analyze(frame(() => [0, 0, 0]), W, H, 0);
p.step(16);
p.analyze(frame(() => [255, 255, 255]), W, H, 16);
const series = [];
for (let t = 0; t < 1200; t += 20) series.push(p.step(20)[35 * 3]);
assert.ok(series[0] > 0 && series[0] < 20, "first step is small: " + series[0]);
for (let i = 1; i < series.length; i++) assert.ok(series[i] >= series[i - 1], "monotonic fade");
const reach = (v) => series.findIndex((x) => x >= v) * 20;
assert.ok(reach(80) > 250, "fade must not stall early at the power limit");
console.log("ok  плавность: переход в белый (каждые 100 мс):", series.filter((_, i) => i % 5 === 0).join(" → "));

// 3. Letterbox: black bars must not darken the top LEDs.
p = new Processor();
p.configure({ ...settings, smoothing: 0 });
for (let t = 0; t < 5000; t += 100) p.analyze(frame(edges, 12), W, H, t);
out = p.step(16);
assert.strictEqual(dominant(ledColor(out, 35)), "G", "top must see picture under the bar");
console.log("ok  чёрные полосы игнорируются, верх берёт цвет из картинки:", ledColor(out, 35).join(","));

// 4. Blur removes hard steps between neighbours.
const stepFill = (x) => (x < W / 2 ? [255, 0, 0] : [0, 0, 255]);
const jump = (s) => {
  const q = new Processor();
  q.configure({ ...s, smoothing: 0 });
  q.analyze(frame(stepFill), W, H, 0);
  const o = q.step(16);
  let max = 0;
  for (let i = 17; i < 54; i++) max = Math.max(max, Math.abs(o[i * 3] - o[(i + 1) * 3]));
  return max;
};
const sharp = jump(settings), soft = jump({ ...settings, blur: 3 });
assert.ok(soft < sharp, `blur should soften: ${soft} < ${sharp}`);
console.log(`ok  размытие: max скачок между соседями ${sharp} → ${soft}`);

console.log("    авто-раскладка 71 LED для 3440x1440, 3 стороны:", autoLayout(71, 3440 / 1440, ["left", "top", "right"]));
