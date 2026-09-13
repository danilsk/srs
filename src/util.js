export const uid = () => crypto.randomUUID();
export const now = () => Date.now();
export const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
export const clone = (o) => JSON.parse(JSON.stringify(o));
export const norm = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');

const pad = (n) => String(n).padStart(2, '0');
export function todayKey(t = now()) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const MIN = 60e3, H = 3600e3, D = 86400e3;
export function fmtDur(ms) {
  const a = Math.abs(ms);
  if (a < H) return `${Math.max(1, Math.round(a / MIN))} min`;
  if (a < D) return `${Math.round(a / H)} h`;
  if (a < 30 * D) return `${Math.round(a / D)} d`;
  if (a < 365 * D) return `${Math.round(a / (30 * D))} mo`;
  const y = a / (365 * D);
  return `${y < 10 ? Math.round(y * 10) / 10 : Math.round(y)} y`;
}

export function fmtRel(ts, base = now()) {
  if (ts == null) return '–';
  const d = ts - base;
  if (Math.abs(d) < MIN) return 'now';
  return d > 0 ? `in ${fmtDur(d)}` : `${fmtDur(d)} ago`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(ts, base = now()) {
  if (ts == null) return '–';
  if (todayKey(ts) === todayKey(base)) return 'today';
  const d = new Date(ts), b = new Date(base);
  if (d.getFullYear() !== b.getFullYear()) return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

export function fmtTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function sanitize(html) {
  return String(html || '')
    .replace(/<\s*(script|style|iframe|object|embed)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*("|')?\s*javascript:[^"'>\s]*/gi, '$1=$2#');
}

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export function download(filename, text, type = 'application/json') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const listeners = new Set();
export const bus = {
  on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  toast(msg, kind = 'info') { for (const fn of listeners) fn({ msg, kind }); },
  error(msg) { console.error(msg); bus.toast(String(msg?.message || msg), 'error'); },
};

export function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function pcmToWav(pcm, sampleRate = 24000, channels = 1) {
  const header = new ArrayBuffer(44), v = new DataView(header);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + pcm.byteLength, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * channels * 2, true);
  v.setUint16(32, channels * 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, pcm.byteLength, true);
  return new Blob([header, pcm], { type: 'audio/wav' });
}

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
export const modKey = isMac ? '⌘' : 'Ctrl';
