import { sync } from './drive.js';

const urls = new Map();
let current = null;

export function urlFor(key, blob) {
  if (!urls.has(key)) urls.set(key, URL.createObjectURL(blob));
  return urls.get(key);
}

function play(url) {
  current?.pause();
  current = new Audio(url);
  return current.play().catch(() => {});
}

export async function playCard(card) {
  const blob = await sync.ensureAudio(card);
  if (!blob) return false;
  await play(urlFor(card.audio.key, blob));
  return true;
}

export function playBlob(blob) {
  const url = URL.createObjectURL(blob);
  play(url);
  setTimeout(() => URL.revokeObjectURL(url), 60e3);
}
