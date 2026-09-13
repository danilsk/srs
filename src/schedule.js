import { now, todayKey, shuffle } from './util.js';

const UNIT = { min: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3, m: 30 * 86400e3, mo: 30 * 86400e3, y: 365 * 86400e3 };

export function parseStep(s) {
  const m = /^(\d+(?:\.\d+)?)\s*(min|mo|m|h|d|w|y)$/i.exec(String(s).trim());
  if (!m) return NaN;
  return parseFloat(m[1]) * UNIT[m[2].toLowerCase()];
}

export function parseSteps(str) {
  const parts = String(str).trim().split(/[\s,]+/).filter(Boolean);
  if (!parts.length) throw new Error('at least one step is required');
  for (const p of parts) if (!(parseStep(p) > 0)) throw new Error(`bad step "${p}" (units: min h d w m y)`);
  return parts;
}

export const GRADES = ['again', 'stay', 'next', 'skip'];
export const GRADE_LABEL = { again: 'Again', stay: 'Stay', next: 'Next', skip: 'Skip' };

export const lastStep = (deck) => deck.steps.length - 1;
export const isNew = (card) => card.step < 0;
export const isDue = (card, t = now()) => card.step >= 0 && card.due != null && card.due <= t;
export const isMature = (deck, card) => card.step >= lastStep(deck);
export const stepLabel = (deck, i) => (i < 0 ? 'new' : deck.steps[Math.min(i, lastStep(deck))]);

export function stepMs(deck, i) {
  return parseStep(deck.steps[Math.max(0, Math.min(i, lastStep(deck)))]);
}

export function jittered(ms, pct) {
  return Math.round(ms * (1 + (Math.random() * 2 - 1) * (pct || 0)));
}

export function scheduleAt(deck, step, t = now()) {
  if (step < 0) return { step: -1, due: null };
  step = Math.min(step, lastStep(deck));
  return { step, due: t + jittered(stepMs(deck, step), deck.jitter) };
}

export function gradeStep(deck, card, grade) {
  const s = card.step;
  switch (grade) {
    case 'again': return s < 0 ? -1 : 0;
    case 'stay': return Math.max(s, 0);
    case 'next': return Math.min(s + 1, lastStep(deck));
    case 'skip': return Math.min(s + 2, lastStep(deck));
  }
}

export function applyGrade(deck, card, grade, side, t = now()) {
  const target = gradeStep(deck, card, grade);
  const patch = { reviews: card.reviews + 1, lastReview: t, updated: t };
  if (grade === 'again') {
    Object.assign(patch, { step: target, lapses: card.lapses + (card.step > 0 ? 1 : 0) });
  } else {
    Object.assign(patch, scheduleAt(deck, target, t), { lastSide: side });
  }
  return patch;
}

export function moveTo(deck, card, step, t = now()) {
  return { ...scheduleAt(deck, step, t), updated: t };
}

export function sideFor(deck, card) {
  switch (deck.direction) {
    case 'front': return 'front';
    case 'back': return 'back';
    case 'alt-back': return card.lastSide ? (card.lastSide === 'front' ? 'back' : 'front') : 'back';
    default: return card.lastSide ? (card.lastSide === 'front' ? 'back' : 'front') : 'front';
  }
}

export function dayCount(deck, t = now()) {
  return deck.day && deck.day.date === todayKey(t) ? deck.day.count : 0;
}

export function deckStats(deck, cards, t = now()) {
  const newAvail = cards.filter(isNew).length;
  const due = cards.filter((c) => isDue(c, t)).length;
  const newLeft = Math.min(newAvail, Math.max(0, deck.newPerDay - dayCount(deck, t)));
  return { newAvail, newLeft, due, total: cards.length };
}

export function buildQueue(deck, cards, t = now()) {
  let reviews = cards.filter((c) => isDue(c, t));
  reviews = deck.reviewOrder === 'random' ? shuffle(reviews) : reviews.sort((a, b) => a.due - b.due);

  let fresh = cards.filter(isNew);
  if (deck.newOrder === 'random') shuffle(fresh);
  else fresh.sort((a, b) => (deck.newOrder === 'newest' ? b.created - a.created : a.created - b.created));
  fresh = fresh.slice(0, Math.max(0, deck.newPerDay - dayCount(deck, t)));

  const r = reviews.map((c) => c.id), n = fresh.map((c) => c.id);
  if (deck.mix === 'new-first') return [...n, ...r];
  if (deck.mix === 'reviews-first') return [...r, ...n];
  const q = [...r];
  for (const id of n) q.splice(Math.floor(Math.random() * (q.length + 1)), 0, id);
  return q;
}

// Reinsert within the last 30 % of the queue, at least 3 cards back.
export function requeue(queue, id) {
  const n = queue.length;
  const lo = Math.max(Math.min(3, n), Math.floor(n * 0.7));
  const pos = lo + Math.floor(Math.random() * (n - lo + 1));
  queue.splice(pos, 0, id);
}
