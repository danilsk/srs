export const RATE = 16000;

const WORKLET = `registerProcessor('tap', class extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process([input]) {
    const ch = input[0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) { this.port.postMessage(this.buf); this.buf = new Float32Array(2048); this.n = 0; }
    }
    return true;
  }
});`;

function downsample(buf, rate) {
  if (rate === RATE) return buf;
  const ratio = rate / RATE, out = new Float32Array(Math.floor(buf.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio), b = Math.min(buf.length, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = a; j < b; j++) s += buf[j];
    out[i] = s / Math.max(1, b - a);
  }
  return out;
}

export const rmsOf = (buf) => {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / (buf.length || 1));
};

export class Mic {
  constructor(onChunk) { this.onChunk = onChunk; }
  get live() { return !!this.stream?.getAudioTracks().some((t) => t.readyState === 'live'); }
  start() {
    // Created before any await: iOS only lets an AudioContext start inside the tap.
    if (!this.ctx || this.ctx.state === 'closed') this.ctx = new AudioContext();
    this.ctx.resume().catch(() => {});
    if (this.live) return Promise.resolve();
    return (this.opening ||= this.open(this.ctx).finally(() => { this.opening = null; }));
  }
  async open(ctx) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    if (this.ctx !== ctx) { stream.getTracks().forEach((t) => t.stop()); return; }
    this.stream = stream;
    if (this.moduleCtx !== ctx) {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      this.moduleCtx = ctx;
    }
    if (this.ctx !== ctx) return;
    this.node?.disconnect();
    this.node = new AudioWorkletNode(ctx, 'tap');
    this.node.port.onmessage = (e) => this.onChunk(downsample(e.data, ctx.sampleRate));
    ctx.createMediaStreamSource(stream).connect(this.node).connect(ctx.destination);
  }
  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.node?.disconnect();
    this.ctx?.close().catch(() => {});
    this.stream = this.node = this.ctx = null;
  }
}

const PRE = 0.4, HANG = 0.8, MIN_VOICED = 0.3, MAX_LEN = 25, WINDOW = 3;

const threshold = (levels) => {
  const s = [...levels].sort((a, b) => a - b);
  return Math.max(0.006, (s[Math.floor(s.length / 10)] ?? 0) * 4);
};

export function hasSpeech(samples) {
  const n = RATE / 50, levels = [];
  for (let i = 0; i + n <= samples.length; i += n) levels.push(rmsOf(samples.subarray(i, i + n)));
  const thr = threshold(levels);
  return levels.filter((l) => l > thr).length / 50 >= MIN_VOICED;
}

export class Segmenter {
  constructor(onUtterance) { this.onUtterance = onUtterance; this.levels = []; this.reset(); }
  reset() { this.pre = []; this.cur = null; this.loud = 0; }
  get threshold() { return threshold(this.levels); }
  push(chunk, rms = rmsOf(chunk)) {
    const dur = chunk.length / RATE;
    this.levels.push(rms);
    if (this.levels.length > WINDOW / dur) this.levels.shift();
    if (!this.cur) {
      const thr = this.threshold;
      this.pre.push(chunk);
      while (this.pre.length > 1 && seconds(this.pre) - this.pre[0].length / RATE >= PRE) this.pre.shift();
      if (rms > thr && ++this.loud >= 2) this.cur = { chunks: this.pre, thr, voiced: this.loud * dur, quiet: 0, len: seconds(this.pre) };
      else if (rms <= thr) this.loud = 0;
      return;
    }
    const c = this.cur;
    c.chunks.push(chunk);
    c.len += dur;
    if (rms > c.thr * 0.7) { c.voiced += dur; c.quiet = 0; } else c.quiet += dur;
    if (c.quiet >= HANG || c.len >= MAX_LEN) this.flush();
  }
  flush() {
    const c = this.cur;
    this.reset();
    if (c && c.voiced >= MIN_VOICED) this.onUtterance(concat(c.chunks));
  }
}

const seconds = (chunks) => chunks.reduce((s, c) => s + c.length, 0) / RATE;

export function concat(chunks) {
  const out = new Float32Array(chunks.reduce((s, c) => s + c.length, 0));
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export function toWav(samples) {
  const buf = new ArrayBuffer(44 + samples.length * 2), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return new Uint8Array(buf);
}
