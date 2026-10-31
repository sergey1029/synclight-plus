// Visual test: shows where LED #1 is and which way numbering goes.
// LED 1-5 white, then the rest split into red / green / blue / yellow quarters.
const { LedStrip } = require("../src/device");

const SECONDS = 15;

(async () => {
  const strip = new LedStrip();
  await strip.open();
  const n = (await strip.getInfo()).lampsAmount;
  const q = Math.floor((n - 5) / 4);
  const segments = [
    { start: 1, end: 5, r: 255, g: 255, b: 255 },
    { start: 6, end: 5 + q, r: 255, g: 0, b: 0 },
    { start: 6 + q, end: 5 + 2 * q, r: 0, g: 255, b: 0 },
    { start: 6 + 2 * q, end: 5 + 3 * q, r: 0, g: 0, b: 255 },
    { start: 6 + 3 * q, end: n, r: 255, g: 200, b: 0 },
  ];
  console.log(`Светодиодов: ${n}. Тест идёт ${SECONDS} с...`);
  const until = Date.now() + SECONDS * 1000;
  while (Date.now() < until) {
    await strip.setFrame(segments);
    await new Promise((r) => setTimeout(r, 100));
  }
  await strip.close();
  console.log("Готово.");
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
