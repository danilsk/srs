import { sync } from './drive.js';
import { generateAudio } from './llm.js';
import { pcmToWav } from './util.js';

const urls = new Map();
const said = new Map();
const SAID_MAX = 60;
let el = null, unlocked = false, seq = 0;

export function urlFor(key, blob) {
  if (!urls.has(key)) urls.set(key, URL.createObjectURL(blob));
  return urls.get(key);
}

const player = () => (el ||= new Audio());

function play(url) {
  const a = player();
  a.pause();
  a.src = url;
  return a.play().catch(() => {});
}

// iOS lets an audio element play later without a tap only if a tap started it once.
function unlock() {
  if (unlocked) return;
  unlocked = true;
  const a = player();
  a.src = URL.createObjectURL(pcmToWav(new Uint8Array(3200), 16000));
  a.play().catch(() => {});
}

export async function playCard(card) {
  const n = ++seq;
  const blob = await sync.ensureAudio(card);
  if (!blob || n !== seq) return false;
  await play(urlFor(card.audio.key, blob));
  return true;
}

export function playBlob(blob) {
  ++seq;
  const url = URL.createObjectURL(blob);
  play(url);
  setTimeout(() => URL.revokeObjectURL(url), 60e3);
}

export async function say(deck, text) {
  const n = ++seq;
  unlock();
  const k = [deck.targetLang, deck.tts?.voice, deck.tts?.instructions, text].join('\n');
  if (!said.has(k)) {
    const p = generateAudio(deck, text).then((blob) => URL.createObjectURL(blob));
    said.set(k, p);
    p.catch(() => said.delete(k));
    if (said.size > SAID_MAX) {
      const [old, url] = said.entries().next().value;
      said.delete(old);
      url.then(URL.revokeObjectURL, () => {});
    }
  }
  const url = await said.get(k);
  if (n === seq) await play(url);
}
