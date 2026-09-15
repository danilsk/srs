import { html, useState, useEffect, Tabs, Q } from '../ui.js';
import { store, DEFAULT_PROMPT } from '../store.js';
import { parseSteps } from '../schedule.js';
import { clone, clamp, download, bus, modKey } from '../util.js';

const VOICES = ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'];

function FieldList({ items, onChange, addLabel }) {
  const set = (i, patch) => onChange(items.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const add = () => onChange([...items, { key: '', label: '', hint: '' }]);
  return html`<div class="schema">
    <div class="srow hd"><span>key</span><span>label</span><span>generation hint</span><span></span></div>
    ${items.map((f, i) => html`<div class="srow" key=${i}>
      <input value=${f.key} placeholder="key" onInput=${(e) => set(i, { key: e.target.value })} />
      <input value=${f.label} placeholder="Label" onInput=${(e) => set(i, { label: e.target.value })} />
      <input value=${f.hint} placeholder="what the LLM should put here" onInput=${(e) => set(i, { hint: e.target.value })} />
      <button class="ghost sm" onClick=${() => onChange(items.filter((_, j) => j !== i))}>✕</button>
    </div>`)}
  </div>
  <button class="ghost sm" style="margin-top:6px" onClick=${add}>${addLabel}</button>`;
}

const fromDeck = (deck) => ({ ...clone(deck), stepsText: deck.steps.join(' '), jitterPct: Math.round(deck.jitter * 100) });

export function DeckSettings({ deck, onAdd }) {
  const [d, setD] = useState(() => fromDeck(deck));
  useEffect(() => setD(fromDeck(deck)), [deck.id]);
  const up = (patch) => setD((x) => ({ ...x, ...patch }));
  const upTts = (patch) => up({ tts: { ...d.tts, ...patch } });

  const save = async () => {
    try {
      const steps = parseSteps(d.stepsText);
      const { stepsText, jitterPct, ...rest } = d;
      const fields = (list, what) => list.map((f) => ({ key: f.key.trim(), label: f.label.trim() || f.key.trim(), hint: f.hint.trim() })).filter((f) => f.key);
      const senseFields = fields(d.senseFields), cardFields = fields(d.cardFields);
      const keys = [...senseFields, ...cardFields].map((f) => f.key);
      for (const k of keys) if (!/^[a-z][a-z0-9_]*$/.test(k)) throw new Error(`field key "${k}" must be lowercase letters, digits, _`);
      if (new Set(keys).size !== keys.length || keys.includes('translation')) throw new Error('field keys must be unique and not "translation"');
      const num = (v, lo, hi, dflt) => { const n = parseInt(v); return clamp(Number.isFinite(n) ? n : dflt, lo, hi); };
      const out = {
        ...rest, steps, senseFields, cardFields,
        name: d.name.trim() || deck.name, targetLang: d.targetLang.trim() || deck.targetLang, nativeLang: d.nativeLang.trim() || deck.nativeLang,
        jitter: clamp((parseFloat(jitterPct) || 0) / 100, 0, 0.9),
        newPerDay: num(d.newPerDay, 0, 999, 10),
        sensesMin: num(d.sensesMin, 1, 10, 1), sensesMax: num(d.sensesMax, 1, 10, 5),
        examplesMin: num(d.examplesMin, 0, 10, 1), examplesMax: num(d.examplesMax, 1, 10, 1),
        prompt: d.prompt.trim() || DEFAULT_PROMPT,
      };
      if (out.sensesMax < out.sensesMin) out.sensesMax = out.sensesMin;
      if (out.examplesMax < out.examplesMin) out.examplesMax = out.examplesMin;
      await store.saveDeck(out);
      const over = store.cardsOf(deck.id).filter((c) => c.step >= steps.length);
      if (over.length) await store.saveCards(over.map((c) => ({ ...c, step: steps.length - 1 })));
      setD(fromDeck(out));
      bus.toast('saved');
    } catch (e) { bus.error(e); }
  };
  const del = async () => {
    if (prompt(`Type the deck name to delete it with all ${store.cardsOf(deck.id).length} cards:`) !== deck.name) return;
    await store.deleteDeck(deck.id);
    location.hash = '#/';
  };
  const onKey = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); } };
  const inp = (key, extra = {}) => html`<input value=${d[key]} onInput=${(e) => up({ [key]: e.target.value })} ...${extra} />`;
  const selectOpt = (key, opts) => html`<select value=${d[key]} onChange=${(e) => up({ [key]: e.target.value })}>${opts.map(([v, l]) => html`<option key=${v} value=${v}>${l}</option>`)}</select>`;

  return html`<${Tabs} deck=${deck} active="settings" onAdd=${() => onAdd()} />
  <div class="form" onKeyDown=${onKey}>
    <h3>Deck</h3>
    <div class="g3">
      <div class="f"><label>name</label>${inp('name')}</div>
      <div class="f"><label>target language</label>${inp('targetLang')}</div>
      <div class="f"><label>native language</label>${inp('nativeLang')}</div>
    </div>

    <h3>Schedule</h3>
    <div class="f"><label>steps · last one repeats forever<${Q} text="Units: min h d w m y. Again puts the card back into the last 30 % of the queue and resets it to the first step." /></label>${inp('stepsText', { spellcheck: false })}</div>
    <div class="g2">
      <div class="f"><label>jitter, %</label>${inp('jitterPct', { type: 'number', min: 0, max: 90 })}</div>
      <div class="f"><label>new cards / day</label>${inp('newPerDay', { type: 'number', min: 0 })}</div>
    </div>

    <h3>Learning</h3>
    <div class="g3">
      <div class="f"><label>direction</label>${selectOpt('direction', [['front', 'front'], ['back', 'back'], ['alt-front', 'alternate, front first'], ['alt-back', 'alternate, back first']])}</div>
      <div class="f"><label>new cards order</label>${selectOpt('newOrder', [['added', 'as added'], ['random', 'random'], ['newest', 'newest first']])}</div>
      <div class="f"><label>reviews order</label>${selectOpt('reviewOrder', [['due', 'most overdue first'], ['random', 'random']])}</div>
    </div>
    <div class="g2">
      <div class="f"><label>mixing</label>${selectOpt('mix', [['reviews-first', 'reviews first, then new'], ['mixed', 'mixed'], ['new-first', 'new first, then reviews']])}</div>
      <div class="f"><label>field labels on the card</label><select value=${d.showLabels ? '1' : ''} onChange=${(e) => up({ showLabels: e.target.value === '1' })}>
        <option value="">hidden · label on hover</option><option value="1">shown</option></select></div>
    </div>

    <h3>Senses <span class="muted">· ordered, each with its own translation</span></h3>
    <div class="g2">
      <div class="f"><label>senses per card</label><div class="row" style="flex-wrap:nowrap">${inp('sensesMin', { type: 'number', min: 1, max: 10 })}<span class="muted">–</span>${inp('sensesMax', { type: 'number', min: 1, max: 10 })}</div></div>
      <div class="f"><label>examples per sense</label><div class="row" style="flex-wrap:nowrap">${inp('examplesMin', { type: 'number', min: 0, max: 10 })}<span class="muted">–</span>${inp('examplesMax', { type: 'number', min: 1, max: 10 })}</div></div>
    </div>
    <${FieldList} items=${d.senseFields} onChange=${(v) => up({ senseFields: v })} addLabel="+ sense field" />

    <h3>Card fields <span class="muted">· once per card, shown after the senses</span></h3>
    <${FieldList} items=${d.cardFields} onChange=${(v) => up({ cardFields: v })} addLabel="+ card field" />

    <h3>Generation</h3>
    <div class="f"><label>prompt · {{target}} {{native}} {{front}} · the JSON structure is appended automatically</label>
      <textarea style="min-height:110px" value=${d.prompt} onInput=${(e) => up({ prompt: e.target.value })} /></div>
    <div class="g2">
      <div class="f"><label>audio</label>${selectOpt('audioFor', [['front', 'generate for the front'], ['off', 'off']])}</div>
      <div class="f"><label>TTS voice</label><input list="voices" value=${d.tts.voice} onInput=${(e) => upTts({ voice: e.target.value })} />
        <datalist id="voices">${VOICES.map((v) => html`<option key=${v} value=${v} />`)}</datalist></div>
    </div>
    <div class="f"><label>TTS instructions · placed before the word; accent and style go here</label>
      <textarea style="min-height:70px" value=${d.tts.instructions} onInput=${(e) => upTts({ instructions: e.target.value })} /></div>

    <hr />
    <div class="row">
      <button class="primary" onClick=${save}>Save <kbd>${modKey}↩</kbd></button>
      <button onClick=${() => download(`${deck.name}.json`, store.exportDeck(deck.id))}>Export deck .json</button>
      <span class="spacer"></span>
      <button class="ghost danger" onClick=${del}>Delete deck</button>
    </div>
  </div>`;
}
