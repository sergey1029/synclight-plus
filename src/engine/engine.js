// Hidden engine window: renders the active mode (screen / music / effect / color) into LED frames.
const SAMPLE_WIDTH = 192;
const CROSSFADE_MS = 600;

const processor = new Ambilight.Processor();
const effects = new Effects.EffectRenderer();
const music = new Music.MusicProcessor();

let settings = null;
let video = null; // { track, reader }
let audio = null; // { stream, ctx, analyser, data }
let starting = { video: false, audio: false };
let fade = null; // { from, start }
let lastOut = null;

const ledCount = (s) => s.layout.left + s.layout.top + s.layout.right + s.layout.bottom;
const activeMode = () => (settings && settings.enabled ? settings.mode : null);

function applySettings(s) {
  const displayChanged = settings && settings.displayId !== s.displayId;
  const before = activeMode();
  settings = s;
  const n = ledCount(s);
  processor.configure(s);
  effects.configure(s, n);
  music.configure(s, n);

  const mode = activeMode();
  if (mode !== "ambilight" || displayChanged) stopVideo();
  if (mode === "ambilight") startVideo();
  if (mode !== "music") stopAudio();
  else startAudio();
  if (before !== mode && lastOut) fade = { from: lastOut, start: performance.now() };
}

// ---------- Screen capture ----------

function stopVideo() {
  if (!video) return;
  video.reader.cancel().catch(() => {});
  video.track.stop();
  video = null;
}

async function startVideo() {
  if (video || starting.video) return;
  starting.video = true;
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 60 }, width: { max: 1280 } },
      audio: false,
    });
    const track = stream.getVideoTracks()[0];
    if (activeMode() !== "ambilight") return track.stop();
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    video = { track, reader };
    readLoop(video);
  } catch (e) {
    console.error("screen capture failed", e);
    setTimeout(() => activeMode() === "ambilight" && startVideo(), 2000);
  } finally {
    starting.video = false;
  }
}

let analyzing = false;
let lastAnalyze = 0;
async function readLoop(cap) {
  while (video === cap) {
    const { value: frame, done } = await cap.reader.read().catch(() => ({ done: true }));
    if (done) break;
    const now = performance.now();
    // Analyze at most at the output rate; extra frames are dropped.
    if (analyzing || now - lastAnalyze < 1000 / settings.fps - 2) {
      frame.close();
      continue;
    }
    analyzing = true;
    lastAnalyze = now;
    analyze(frame).finally(() => (analyzing = false));
  }
  if (video === cap) {
    video = null;
    setTimeout(() => activeMode() === "ambilight" && startVideo(), 1000);
  }
}

let canvas = null;
let ctx = null;
async function analyze(frame) {
  try {
    const w = SAMPLE_WIDTH;
    const h = Math.max(8, Math.round((SAMPLE_WIDTH * frame.displayHeight) / frame.displayWidth));
    const bitmap = await createImageBitmap(frame, { resizeWidth: w, resizeHeight: h, resizeQuality: "high" });
    if (!canvas || canvas.width !== w || canvas.height !== h) {
      canvas = new OffscreenCanvas(w, h);
      ctx = canvas.getContext("2d", { willReadFrequently: true });
    }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    processor.analyze(ctx.getImageData(0, 0, w, h).data, w, h, Date.now());
  } finally {
    frame.close();
  }
}

// ---------- System audio ----------

function stopAudio() {
  if (!audio) return;
  audio.stream.getTracks().forEach((t) => t.stop());
  audio.ctx.close().catch(() => {});
  audio = null;
}

async function startAudio() {
  if (audio || starting.audio) return;
  starting.audio = true;
  try {
    // Electron answers with the screen + Windows loopback audio; only the audio is used.
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    stream.getVideoTracks().forEach((t) => t.stop());
    if (activeMode() !== "music" || !stream.getAudioTracks().length) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const ac = new AudioContext();
    const analyser = ac.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.5;
    analyser.minDecibels = -85;
    analyser.maxDecibels = -20;
    ac.createMediaStreamSource(stream).connect(analyser);
    audio = { stream, ctx: ac, analyser, data: new Uint8Array(analyser.frequencyBinCount) };    stream.getAudioTracks()[0].addEventListener("ended", () => {
      stopAudio();
      setTimeout(() => activeMode() === "music" && startAudio(), 1000);
    });
  } catch (e) {
    console.error("audio capture failed", e);
    setTimeout(() => activeMode() === "music" && startAudio(), 2000);
  } finally {
    starting.audio = false;
  }
}

// ---------- Output ----------

function render(dt, n) {
  switch (settings.mode) {
    case "ambilight":
      return processor.hasTarget ? processor.step(dt) : null;
    case "music":
      if (audio) {
        audio.analyser.getByteFrequencyData(audio.data);
        music.update(audio.data, audio.ctx.sampleRate);
      }
      return Effects.finalize(music.step(dt), settings);
    case "effect":
      return Effects.finalize(effects.step(dt), settings);
    case "color":
      return Effects.finalize(Effects.solid(n, settings.color), settings);
  }
  return null;
}

// Windows timers tick every ~15.6 ms, so we schedule against an ideal timeline
// (late ticks make the next delay shorter) instead of a fixed delay.
let lastTick = performance.now();
let nextTick = lastTick;
function tick() {
  const now = performance.now();
  const dt = Math.min(200, now - lastTick);
  lastTick = now;

  if (settings) {
    const n = ledCount(settings);
    let frame = null;
    if (settings.enabled) frame = render(dt, n);
    else if (fade || (lastOut && lastOut.some((v) => v))) frame = new Uint8Array(n * 3);

    if (frame) {
      // Smooth hand-over between modes and on switching on/off.
      if (fade) {
        const k = Math.min(1, (now - fade.start) / CROSSFADE_MS);
        if (k >= 1 || fade.from.length !== frame.length) fade = null;
        else {
          const e = k * k * (3 - 2 * k);
          for (let i = 0; i < frame.length; i++) frame[i] = Math.round(fade.from[i] + (frame[i] - fade.from[i]) * e);
        }
      }
      lastOut = frame;
      window.api.sendFrame(frame);
    }
  }

  const interval = settings ? 1000 / settings.fps : 100;
  nextTick = Math.max(nextTick + interval, now);
  setTimeout(tick, Math.max(0, nextTick - performance.now()));
}

window.api.on("settings", applySettings);
window.api.get().then(({ settings: s }) => {
  applySettings(s);
  tick();
});
