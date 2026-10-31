// Driver for the ZX Sync LED strip (Robobloq SyncLight protocol). See docs/PROTOCOL.md.
const HID = require("node-hid");

const VID = 0x1a86;
const PID = 0xfe07;
const CHUNK = 64;

const ACTION = {
  setSyncScreen: 0x80,
  readDeviceInfo: 0x82,
  readDeviceUUID: 0x83,
  setLedEffect: 0x85,
  setSectionLED: 0x86,
  setBrightness: 0x87,
  turnOffLight: 0x97,
};

const checksum = (buf, len) => {
  let sum = 0;
  for (let i = 0; i < len; i++) sum += buf[i];
  return sum % 256;
};

class LedStrip {
  constructor() {
    this.device = null;
    this.packetId = 1;
    this.pending = new Map();
  }

  static find() {
    return HID.devices().find(
      (d) => d.vendorId === VID && d.productId === PID && d.interface === 0
    );
  }

  async open() {
    const info = LedStrip.find();
    if (!info) throw new Error("Лента не найдена (VID 1A86 / PID FE07)");
    this.device = await HID.HIDAsync.open(info.path);
    this.device.on("data", (data) => this.onData(data));
    this.device.on("error", () => (this.device = null));
    return info;
  }

  async close() {
    if (this.device) await this.device.close();
    this.device = null;
  }

  nextId() {
    this.packetId = this.packetId >= 254 ? 1 : this.packetId + 1;
    return this.packetId;
  }

  onData(data) {
    const tag = data.toString("latin1", 0, 2);
    if (tag !== "RB" && tag !== "SC") return;
    const resolve = this.pending.get(data[3]);
    if (resolve) {
      this.pending.delete(data[3]);
      resolve(data);
    }
  }

  async send(packet) {
    if (!this.device) throw new Error("Лента не подключена");
    for (let off = 0; off < packet.length; off += CHUNK) {
      const chunk = packet.subarray(off, off + CHUNK);
      await this.device.write(Buffer.concat([Buffer.from([0]), chunk]));
    }
  }

  async request(packet, timeoutMs = 500) {
    const id = packet[3];
    const reply = new Promise((resolve) => {
      this.pending.set(id, resolve);
      setTimeout(() => {
        if (this.pending.delete(id)) resolve(null);
      }, timeoutMs);
    });
    await this.send(packet);
    return reply;
  }

  rb(action, payload = []) {
    const len = 6 + payload.length;
    const buf = Buffer.alloc(len);
    buf.write("RB", 0, "latin1");
    buf[2] = len;
    buf[3] = this.nextId();
    buf[4] = action;
    Buffer.from(payload).copy(buf, 5);
    buf[len - 1] = checksum(buf, len - 1);
    return buf;
  }

  async getInfo() {
    const r = await this.request(this.rb(ACTION.readDeviceInfo));
    if (!r) throw new Error("Лента не ответила на запрос информации");
    return {
      id: r.subarray(5, 8).toString("hex"),
      displaySize: r[8],
      lampsAmount: r[11],
      uuid: r.subarray(12, 20).toString("hex"),
      version: [r[21], r[22], r[23]].join("."),
      raw: r.toString("hex"),
    };
  }

  setBrightness(percent) {
    const v = Math.max(0, Math.min(100, Math.round(percent)));
    return this.request(this.rb(ACTION.setBrightness, [v]));
  }

  turnOff() {
    return this.request(this.rb(ACTION.turnOffLight));
  }

  // segments: [{ start, end, r, g, b }], LED indices are 1-based and inclusive.
  setFrame(segments) {
    const len = 7 + segments.length * 5;
    const buf = Buffer.alloc(len);
    buf.write("SC", 0, "latin1");
    buf.writeUInt16BE(len, 2);
    buf[4] = this.nextId();
    buf[5] = ACTION.setSyncScreen;
    segments.forEach((s, i) => {
      const o = 6 + i * 5;
      buf[o] = s.start;
      buf[o + 1] = s.r;
      buf[o + 2] = s.g;
      buf[o + 3] = s.b;
      buf[o + 4] = s.end;
    });
    buf[len - 1] = checksum(buf, len - 1);
    return this.send(buf);
  }
}

module.exports = { LedStrip, VID, PID };
