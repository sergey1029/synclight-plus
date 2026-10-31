// Read-only check: find the strip and print its device info.
const { LedStrip } = require("../src/device");

(async () => {
  const strip = new LedStrip();
  const hid = await strip.open();
  console.log("Найдено:", hid.manufacturer, hid.product, hid.path);
  console.log(await strip.getInfo());
  await strip.close();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
