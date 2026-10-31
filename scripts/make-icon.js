// Draws the app icon (rainbow glow ring around a white core) into src/assets/icon.png.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SIZE = 256;

function pixel(x, y) {
  const c = (SIZE - 1) / 2;
  const d = Math.hypot(x - c, y - c) / (SIZE / 2);
  const alpha = d < 0.62 ? 1 : d < 1 ? Math.pow(1 - (d - 0.62) / 0.38, 2) : 0;
  const hue = Math.atan2(y - c, x - c) / (2 * Math.PI) + 0.5;
  const core = d < 0.62 ? 1 - d / 0.62 : 0;
  const rgb = [0, 1 / 3, 2 / 3].map((o) =>
    Math.min(255, Math.round(255 * (0.55 + 0.45 * Math.cos(2 * Math.PI * (hue + o))) + 200 * core))
  );
  return [...rgb, Math.round(255 * alpha)];
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  for (let x = 0; x < SIZE; x++) Buffer.from(pixel(x, y)).copy(raw, y * (SIZE * 4 + 1) + 1 + x * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr.set([8, 6, 0, 0, 0], 8);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = path.join(__dirname, "..", "src", "assets", "icon.png");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log("icon:", out, png.length, "bytes");
