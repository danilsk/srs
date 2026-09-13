import { db } from './db.js';
import { parseStep } from './schedule.js';
import { uid, now, todayKey, clamp } from './util.js';

const OLD_DEFAULT_PROMPT =
`You are a {{target}} → {{native}} dictionary for a language learner. Entry: "{{front}}".
Fix typos. Put verbs in the infinitive and nouns in their canonical dictionary form (with article where the language has one); if that differs from the entry, return it as front_suggestion. Give the senses most common first. Synonyms and examples must belong to their own sense. Keep HTML minimal.`;

export const DEFAULT_PROMPT =
`You are a {{target}} → {{native}} dictionary for a language learner. Entry: "{{front}}".
Fix typos. Put verbs in the infinitive and nouns in their canonical dictionary form; if that differs from the entry, return it as front_suggestion, including when only an article is missing.
For Spanish common nouns, include the appropriate definite article (el/la; los/las for nouns normally used in the plural). Examples: palillo → el palillo, mesa → la mesa, hada → el hada. Do not add articles to verbs, ordinary adjectives, or proper names. Use lo only for substantivized adjectives or expressions that require it, never as a generic noun article. Preserve established phrases.
Give distinct senses most common first. Keep each translation concise and natural: usually one equivalent, or two complementary equivalents if useful. Add a short qualifier only when needed to distinguish the meaning. Do not repeat a translation as a longer definition or split paraphrases into separate senses. For the chopstick sense of el palillo in Russian, use "палочка для еды", without repeating it as "палочка для еды в китайской или японской кухне". Synonyms and examples must belong to their own sense.
Grammar notes should cover only non-obvious facts worth learning, with explanations in {{native}} and word forms in {{target}}. Omit gender already clear from the article and predictable plurals or regular conjugations. Return an empty grammar string if nothing is notable. For el hada, explain the feminine gender despite el before stressed a, with la hermosa hada / las hadas as useful contrasts.
Keep useful irregular verb forms. Put each tense or form group on its own line using HTML <br>, with a short label; keep forms within that group comma-separated. For oír with Russian explanations: "Настоящее: oigo, oyes, oye, oyen<br>Герундий: oyendo<br>Причастие: oído". Use minimal HTML in descriptive fields; translations and front_suggestion are plain text.`;

const OLD_GRAMMAR_HINT = 'gender, plural, irregular forms, register; empty string if nothing notable';
const GRAMMAR_HINT = 'Only non-obvious grammar or register worth learning; explanations in the native language, forms in the target language. Omit gender obvious from the article, predictable plurals, and regular conjugations. Include useful irregular forms and exceptional gender/article usage. Each tense or form group on a separate line using <br>, with a short label and comma-separated forms within the group. Empty string if nothing notable.';

export const synonymsHint = (targetLang) => `1-3 ${targetLang} synonyms for this sense, separated by " · " — ${targetLang} words only, no translations`;
const OLD_SYNONYMS_HINT = /^1-3 synonyms in .+ for this sense, separated by " · "$/;

export function newDeck(name, targetLang, nativeLang) {
  const t = now();
  return {
    id: uid(), name, targetLang, nativeLang,
    steps: ['1h', '1d', '3d', '7d', '30d', '3m', '6m', '12m'],
    jitter: 0.15, newPerDay: 10,
    direction: 'alt-front', newOrder: 'added', reviewOrder: 'due', mix: 'mixed', showLabels: false,
    sensesMin: 1, sensesMax: 5, examplesMin: 1, examplesMax: 1,
    senseFields: [
      { key: 'synonyms', label: 'Synonyms', hint: synonymsHint(targetLang) },
      { key: 'examples', label: 'Examples', hint: `example sentences for this sense, each as HTML: <i>${targetLang} sentence</i><br>${nativeLang} translation, sentences separated by <br><br>` },
    ],
    cardFields: [
      { key: 'grammar', label: 'Grammar', hint: GRAMMAR_HINT },
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

// Every record that did not come from newDeck/newCard in this tab (IndexedDB, a Drive pull,
// an import) goes through these: one missing field otherwise throws mid-render.
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const numOr = (v, dflt) => (Number.isFinite(v) ? v : dflt);
const strOr = (v, dflt) => (typeof v === 'string' && v.trim() ? v : dflt);

export function normDeck(d = {}) {
  const base = newDeck(strOr(d.name, 'Deck'), strOr(d.targetLang, ''), strOr(d.nativeLang, ''));
  const steps = (Array.isArray(d.steps) ? d.steps : []).filter((s) => parseStep(s) > 0);
  const fields = (v, dflt) => (Array.isArray(v) ? v : dflt).filter((f) => isObj(f) && f.key);
  return {
    ...base, ...d,
    id: strOr(d.id, base.id),
    name: base.name, targetLang: base.targetLang, nativeLang: base.nativeLang,
    steps: steps.length ? steps : base.steps,
    senseFields: fields(d.senseFields, base.senseFields),
    cardFields: fields(d.cardFields, base.cardFields).map((f) =>
      f.key === 'grammar' && f.hint === OLD_GRAMMAR_HINT ? { ...f, hint: GRAMMAR_HINT } : f),
    tts: { ...base.tts, ...(isObj(d.tts) ? d.tts : null) },
    day: isObj(d.day) && d.day.date ? d.day : base.day,
    prompt: d.prompt === OLD_DEFAULT_PROMPT ? DEFAULT_PROMPT : strOr(d.prompt, base.prompt),
    jitter: clamp(numOr(d.jitter, base.jitter), 0, 0.9),
    newPerDay: Math.max(0, numOr(d.newPerDay, base.newPerDay)),
    sensesMin: numOr(d.sensesMin, base.sensesMin), sensesMax: numOr(d.sensesMax, base.sensesMax),
    examplesMin: numOr(d.examplesMin, base.examplesMin), examplesMax: numOr(d.examplesMax, base.examplesMax),
    created: numOr(d.created, base.created), updated: numOr(d.updated, base.updated),
  };
}

export function normCard(c = {}, deckId) {
  const base = newCard(deckId || c.deckId || '');
  const senses = (Array.isArray(c.senses) ? c.senses : []).map((s) => ({
    ...(isObj(s) ? s : null),
    translation: typeof s?.translation === 'string' ? s.translation : '',
    fields: isObj(s?.fields) ? s.fields : {},
  }));
  return {
    ...base, ...c,
    id: strOr(c.id, base.id),
    deckId: base.deckId,
    front: typeof c.front === 'string' ? c.front : '',
    senses: senses.length ? senses : base.senses,
    fields: isObj(c.fields) ? c.fields : {},
    audio: isObj(c.audio) && c.audio.key ? c.audio : null,
    step: Number.isInteger(c.step) ? c.step : -1,
    due: numOr(c.due, null), lastReview: numOr(c.lastReview, null),
    reviews: Math.max(0, numOr(c.reviews, 0)), lapses: Math.max(0, numOr(c.lapses, 0)),
    created: numOr(c.created, base.created), updated: numOr(c.updated, base.updated),
  };
}

const listeners = new Set();
const emit = () => { for (const fn of listeners) fn(); };

export const store = {
  decks: [], cards: [], ready: false,
  dirty: new Set(), deleted: new Set(), revs: new Map(),
  onDirty: null, onAudioDeleted: null,

  async load() {
    const savedDecks = await db.all('decks');
    this.decks = savedDecks.map((d) => normDeck(d)).sort((a, b) => a.created - b.created);
    this.cards = (await db.all('cards')).map((c) => normCard(c));
    this.dirty = new Set(await db.meta.get('dirty', []));
    this.deleted = new Set(await db.meta.get('deleted', []));
    for (const d of this.decks) {
      const saved = savedDecks.find((s) => s.id === d.id);
      const defaultsChanged = saved?.prompt !== d.prompt || JSON.stringify(saved?.cardFields) !== JSON.stringify(d.cardFields);
      const f = d.senseFields.find((f) => OLD_SYNONYMS_HINT.test(f.hint));
      if (f) f.hint = synonymsHint(d.targetLang);
      if (f || defaultsChanged) await this.saveDeck(d);
    }
    this.ready = true;
    emit();
  },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  deck: (id) => store.decks.find((d) => d.id === id),
  card: (id) => store.cards.find((c) => c.id === id),
  cardsOf: (deckId) => store.cards.filter((c) => c.deckId === deckId),

  rev(deckId) { return this.revs.get(deckId) || 0; },
  async markDirty(deckId) {
    this.revs.set(deckId, this.rev(deckId) + 1);
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
    deck = normDeck(deck);
    cards = (Array.isArray(cards) ? cards : []).map((c) => normCard(c, deck.id));
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
    for (const d of data.decks) await this.saveDeck(normDeck(d));
    const byDeck = new Map();
    for (const c of data.cards) {
      if (!this.deck(c.deckId)) continue;
      if (!byDeck.has(c.deckId)) byDeck.set(c.deckId, []);
      byDeck.get(c.deckId).push(normCard(c));
    }
    for (const cards of byDeck.values()) await this.saveCards(cards);
    return { decks: data.decks.length, cards: data.cards.length };
  },
};
