import { db } from './db.js';
import { uid, now, todayKey } from './util.js';

export const DEFAULT_PROMPT =
`You are a {{target}} → {{native}} dictionary for a language learner. Entry: "{{front}}".
Fix typos. Put verbs in the infinitive and nouns in their canonical dictionary form (with article where the language has one); if that differs from the entry, return it as front_suggestion. Give the senses most common first. Synonyms and examples must belong to their own sense. Keep HTML minimal.`;

export const synonymsHint = (targetLang) => `1-3 ${targetLang} synonyms for this sense, separated by " · " — ${targetLang} words only, no translations`;
const OLD_SYNONYMS_HINT = /^1-3 synonyms in .+ for this sense, separated by " · "$/;

export function newDeck(name, targetLang, nativeLang) {
  const t = now();
  return {
    id: uid(), name, targetLang, nativeLang,
    steps: ['1h', '1d', '3d', '7d', '30d', '3m', '6m', '12m'],
    jitter: 0.15, newPerDay: 10,
    direction: 'alt-front', newOrder: 'added', reviewOrder: 'due', mix: 'mixed', showLabels: false,
    sensesMin: 1, sensesMax: 5, examplesMin: 1, examplesMax: 2,
    senseFields: [
      { key: 'synonyms', label: 'Synonyms', hint: synonymsHint(targetLang) },
      { key: 'examples', label: 'Examples', hint: `example sentences for this sense, each as HTML: <i>${targetLang} sentence</i><br>${nativeLang} translation, sentences separated by <br><br>` },
    ],
    cardFields: [
      { key: 'grammar', label: 'Grammar', hint: 'gender, plural, irregular forms, register; empty string if nothing notable' },
    ],
    prompt: DEFAULT_PROMPT,
    tts: { voice: 'Iapetus', instructions: `Speak as a native ${targetLang} speaker, reading standard ${targetLang} naturally and clearly. Read only the text below, exactly once, without a preamble, translation, or commentary.` },
    audioFor: 'front',
    day: { date: todayKey(t), count: 0 },
    created: t, updated: t,
  };
}

export function newCard(deckId, front = '') {
  const t = now();
  return {
    id: uid(), deckId, front,
    senses: [{ translation: '', fields: {} }], fields: {},
    audio: null,
    step: -1, due: null, lastSide: null, reviews: 0, lapses: 0, lastReview: null,
    created: t, updated: t,
  };
}

export const cardBack = (card) => card.senses.map((s) => s.translation).filter(Boolean).join(' · ');

const listeners = new Set();
const emit = () => { for (const fn of listeners) fn(); };

export const store = {
  decks: [], cards: [], ready: false,
  dirty: new Set(), deleted: new Set(),
  onDirty: null, onAudioDeleted: null,

  async load() {
    this.decks = (await db.all('decks')).sort((a, b) => a.created - b.created);
    this.cards = await db.all('cards');
    this.dirty = new Set(await db.meta.get('dirty', []));
    this.deleted = new Set(await db.meta.get('deleted', []));
    for (const d of this.decks) {
      const f = d.senseFields.find((f) => OLD_SYNONYMS_HINT.test(f.hint));
      if (f) { f.hint = synonymsHint(d.targetLang); await this.saveDeck(d); }
    }
    this.ready = true;
    emit();
  },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  deck: (id) => store.decks.find((d) => d.id === id),
  card: (id) => store.cards.find((c) => c.id === id),
  cardsOf: (deckId) => store.cards.filter((c) => c.deckId === deckId),

  async markDirty(deckId) {
    this.dirty.add(deckId);
    await db.meta.set('dirty', [...this.dirty]);
    this.onDirty?.();
  },
  async clearDirty(deckId) {
    this.dirty.delete(deckId);
    await db.meta.set('dirty', [...this.dirty]);
  },
  async clearDeleted(deckId) {
    this.deleted.delete(deckId);
    await db.meta.set('deleted', [...this.deleted]);
  },

  async saveDeck(deck, { silent = false } = {}) {
    if (!silent) deck.updated = now();
    const i = this.decks.findIndex((d) => d.id === deck.id);
    if (i < 0) this.decks.push(deck); else this.decks[i] = deck;
    await db.put('decks', deck);
    if (!silent) await this.markDirty(deck.id);
    emit();
  },
  async deleteDeck(id) {
    const cards = this.cardsOf(id);
    this.decks = this.decks.filter((d) => d.id !== id);
    this.cards = this.cards.filter((c) => c.deckId !== id);
    await db.del('decks', id);
    await db.delMany('cards', cards.map((c) => c.id));
    await db.delMany('audio', cards.filter((c) => c.audio).map((c) => c.audio.key));
    this.onAudioDeleted?.(cards.map((c) => c.audio?.driveId).filter(Boolean));
    this.dirty.delete(id);
    this.deleted.add(id);
    await db.meta.set('dirty', [...this.dirty]);
    await db.meta.set('deleted', [...this.deleted]);
    this.onDirty?.();
    emit();
  },

  async saveCard(card, { silent = false } = {}) {
    if (!silent) card.updated = now();
    const i = this.cards.findIndex((c) => c.id === card.id);
    if (i < 0) this.cards.push(card); else this.cards[i] = card;
    await db.put('cards', card);
    if (!silent) await this.markDirty(card.deckId);
    emit();
  },
  async saveCards(cards) {
    const t = now();
    for (const card of cards) {
      card.updated = t;
      const i = this.cards.findIndex((c) => c.id === card.id);
      if (i < 0) this.cards.push(card); else this.cards[i] = card;
    }
    await db.putMany('cards', cards);
    for (const d of new Set(cards.map((c) => c.deckId))) await this.markDirty(d);
    emit();
  },
  async deleteCards(ids) {
    const gone = this.cards.filter((c) => ids.includes(c.id));
    this.cards = this.cards.filter((c) => !ids.includes(c.id));
    await db.delMany('cards', ids);
    await db.delMany('audio', gone.filter((c) => c.audio).map((c) => c.audio.key));
    this.onAudioDeleted?.(gone.map((c) => c.audio?.driveId).filter(Boolean));
    for (const d of new Set(gone.map((c) => c.deckId))) await this.markDirty(d);
    emit();
  },

  saveAudio: (key, blob) => db.put('audio', blob, key),
  getAudio: (key) => db.get('audio', key),
  deleteAudio: (key) => db.del('audio', key),

  // From sync: replace a deck and its cards wholesale without marking dirty.
  async replaceDeck(deck, cards) {
    const old = this.cardsOf(deck.id);
    this.decks = this.decks.filter((d) => d.id !== deck.id).concat(deck).sort((a, b) => a.created - b.created);
    this.cards = this.cards.filter((c) => c.deckId !== deck.id).concat(cards);
    await db.put('decks', deck);
    await db.delMany('cards', old.map((c) => c.id));
    await db.putMany('cards', cards);
    emit();
  },
  async removeDeckLocal(id) {
    const cards = this.cardsOf(id);
    this.decks = this.decks.filter((d) => d.id !== id);
    this.cards = this.cards.filter((c) => c.deckId !== id);
    await db.del('decks', id);
    await db.delMany('cards', cards.map((c) => c.id));
    emit();
  },

  exportAll() {
    return JSON.stringify({ version: 1, exported: now(), decks: this.decks, cards: this.cards }, null, 1);
  },
  exportDeck(id) {
    return JSON.stringify({ version: 1, exported: now(), decks: [this.deck(id)], cards: this.cardsOf(id) }, null, 1);
  },
  async importJson(text) {
    const data = JSON.parse(text);
    if (!Array.isArray(data.decks) || !Array.isArray(data.cards)) throw new Error('not an srs export');
    for (const d of data.decks) await this.saveDeck({ ...newDeck(d.name, d.targetLang, d.nativeLang), ...d });
    const byDeck = new Map();
    for (const c of data.cards) {
      if (!this.deck(c.deckId)) continue;
      if (!byDeck.has(c.deckId)) byDeck.set(c.deckId, []);
      byDeck.get(c.deckId).push({ ...newCard(c.deckId), ...c });
    }
    for (const cards of byDeck.values()) await this.saveCards(cards);
    return { decks: data.decks.length, cards: data.cards.length };
  },
};
