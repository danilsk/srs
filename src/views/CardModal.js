import { html, useState, useEffect, useRef, Modal, Ruler, AudioLine, HtmlField, CardBody, Q } from '../ui.js';
import { store, newCard, cardBack } from '../store.js';
import { moveTo, stepLabel } from '../schedule.js';
import { generateCard, generateAudio } from '../llm.js';
import { sync } from '../drive.js';
import { prefs } from '../prefs.js';
import { norm, clone, uid, fmtRel, fmtDate, bus, modKey } from '../util.js';
import { playCard } from '../audio.js';

const IDLE = { text: false, audio: false, textMs: null, audioMs: null };

export function CardModal({ deckId, cardId, view: startView = false, ids = [], onClose }) {
  const deck = store.deck(deckId);
  const [editId, setEditId] = useState(cardId || null);
  const [view, setView] = useState(!!cardId && startView);
  const [viewSide, setViewSide] = useState('front');
  const existing = editId ? store.card(editId) : null;
  const [draft, setDraft] = useState(() => (existing ? clone(existing) : newCard(deckId)));
  const [blob, setBlob] = useState(null);
  const [gen, setGen] = useState(IDLE);
  const [sug, setSug] = useState(null);
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);
  const frontRef = useRef();
  const boxRef = useRef();
  const abort = useRef(null);
  const mode = editId ? 'edit' : 'add';
  const canGen = !!prefs.get('orKey');

  useEffect(() => { (view ? boxRef : frontRef).current?.focus(); }, [editId, view]);
  useEffect(() => () => abort.current?.abort(), []);

  const up = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const upSense = (i, patch) => setDraft((d) => ({ ...d, senses: d.senses.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const upSenseField = (i, key, val) => setDraft((d) => ({ ...d, senses: d.senses.map((s, j) => (j === i ? { ...s, fields: { ...s.fields, [key]: val } } : s)) }));
  const addSense = () => up({ senses: [...draft.senses, { translation: '', fields: {} }] });
  const rmSense = (i) => up({ senses: draft.senses.filter((_, j) => j !== i) });
  const mvSense = (i, dir) => {
    const s = [...draft.senses], j = i + dir;
    if (j < 0 || j >= s.length) return;
    [s[i], s[j]] = [s[j], s[i]];
    up({ senses: s });
  };

  const nf = norm(draft.front);
  const others = mode === 'add' && nf ? store.cardsOf(deckId) : [];
  const exact = others.find((c) => norm(c.front) === nf);
  const similar = others.filter((c) => c !== exact && (norm(c.front).includes(nf) || (nf.length > 3 && nf.includes(norm(c.front))))).slice(0, 6);

  const reset = (card) => {
    abort.current?.abort();
    setDraft(card); setBlob(null); setSug(null); setErr(null); setGen(IDLE);
  };
  const openExisting = (c) => { setEditId(c.id); reset(clone(c)); };

  const genText = async (front, signal) => {
    const t0 = performance.now();
    setGen((g) => ({ ...g, text: true }));
    try {
      const r = await generateCard(deck, front, signal);
      if (signal.aborted) return;
      setDraft((d) => ({ ...d, senses: r.senses, fields: r.fields }));
      setSug(r.front_suggestion);
      setGen((g) => ({ ...g, text: false, textMs: performance.now() - t0 }));
    } catch (e) {
      if (!signal.aborted) setErr(e.message);
      setGen((g) => ({ ...g, text: false }));
    }
  };
  const genAudio = async (front, signal) => {
    if (deck.audioFor === 'off') return;
    const t0 = performance.now();
    setGen((g) => ({ ...g, audio: true }));
    try {
      const b = await generateAudio(deck, front, signal);
      if (signal.aborted) return;
      setBlob(b);
      setGen((g) => ({ ...g, audio: false, audioMs: performance.now() - t0 }));
    } catch (e) {
      if (!signal.aborted) setErr(e.message);
      setGen((g) => ({ ...g, audio: false }));
    }
  };
  const controller = () => { abort.current?.abort(); const ac = new AbortController(); abort.current = ac; return ac.signal; };
  const generate = () => {
    const front = draft.front.trim();
    if (!front) return;
    if (mode === 'add' && exact) return openExisting(exact);
    if (!canGen) return setErr('OpenRouter key is not set — see settings');
    setErr(null); setSug(null);
    const signal = controller();
    genText(front, signal);
    genAudio(front, signal);
  };
  const regenAudio = () => { const front = draft.front.trim(); if (!front || !canGen) return; setErr(null); genAudio(front, controller()); };
  const applySug = () => { up({ front: sug }); setSug(null); if (canGen) genAudio(sug, controller()); };
  const removeAudio = () => { abort.current?.abort(); setGen((g) => ({ ...g, audio: false })); setBlob(null); up({ audio: null }); };

  const save = async () => {
    const front = draft.front.trim();
    if (!front) return setErr('front is empty');
    if (mode === 'add' && exact) { openExisting(exact); return bus.toast(`already in deck — opened “${exact.front}”`); }
    const senses = draft.senses.map((s) => ({ ...s, translation: s.translation.trim() }))
      .filter((s) => s.translation || Object.values(s.fields || {}).some((v) => v && v.trim()));
    if (!senses.length) return setErr('add at least one translation');
    if (gen.text || gen.audio) return setErr('still generating…');
    setSaving(true);
    try {
      let audio = draft.audio;
      if (blob) {
        const key = uid();
        await store.saveAudio(key, blob);
        audio = { key, driveId: null, mime: blob.type };
      }
      if (existing?.audio && existing.audio.key !== audio?.key) {
        store.deleteAudio(existing.audio.key);
        sync.deleteRemoteAudio(deckId, existing.audio.driveId);
      }
      const saved = { ...draft, front, senses, audio };
      await store.saveCard(saved);
      if (mode === 'add') {
        bus.toast(`added “${front}”`);
        reset(newCard(deckId));
        frontRef.current?.focus();
      } else if (startView) { reset(clone(saved)); setView(true); }
      else onClose();
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  };
  const del = async () => {
    if (!confirm(`Delete “${existing.front}”?`)) return;
    await store.deleteCards([existing.id]);
    onClose();
  };
  const moveStep = async (i) => {
    const patch = moveTo(deck, draft, i);
    up(patch);
    const cur = store.card(editId);
    if (cur) await store.saveCard({ ...cur, ...patch });
  };

  const idx = ids.indexOf(editId);
  const nav = (d) => {
    for (let i = idx + d; i >= 0 && i < ids.length; i += d) {
      const c = store.card(ids[i]);
      if (c) { openExisting(c); setView(true); return; }
    }
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    else if (view) {
      if (e.key === 'ArrowLeft') nav(-1);
      else if (e.key === 'ArrowRight') nav(1);
      else if (e.key.toLowerCase() === 'e') setView(false);
      else if (e.key.toLowerCase() === 'b') setViewSide((v) => (v === 'front' ? 'back' : 'front'));
      else if (e.key.toLowerCase() === 'a' && existing?.audio) playCard(existing);
      else return;
      e.preventDefault();
    }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); }
    else if (e.key === 'Enter' && e.target === frontRef.current) { e.preventDefault(); generate(); }
  };

  const sec = (ms) => (ms / 1000).toFixed(1) + ' s';
  const meta = existing && html`<span class="small">· ${stepLabel(deck, existing.step)} · due ${fmtRel(existing.due)} · ${existing.reviews} reviews · ${existing.lapses} lapses · added ${fmtDate(existing.created)}</span>`;

  if (view && existing) return html`<${Modal} onClose=${onClose}><div class="viewbox" ref=${boxRef} tabIndex="-1" onKeyDown=${onKey}>
    <div class="mhead">
      <b>Card</b><span>· ${deck.name}</span>${meta}
      <span class="spacer"></span>
      <button class="ghost" onClick=${onClose}>✕ <kbd>esc</kbd></button>
    </div>
    <div class="row" style="margin-bottom:8px">
      <div class="sideswitch">${['front', 'back'].map((sd) => html`<button key=${sd} class=${viewSide === sd ? 'on' : ''} onClick=${() => setViewSide(sd)}>${sd}</button>`)}<kbd>B</kbd></div></div>
    <div class="card mini">
      <span class="side-tag">${viewSide}</span>
      ${existing.audio && html`<button class="ghost audio" onClick=${() => playCard(existing)} title="play (A)">▶</button>`}
      <${CardBody} deck=${deck} card=${existing} side=${viewSide} />
    </div>
    <div class="f" style="margin-top:14px"><label>position · due ${fmtRel(existing.due)}<${Q} text="Click a step to move the card there now; its next review is scheduled from this moment." /></label>
      <${Ruler} compact deck=${deck} step=${existing.step} onPick=${moveStep} /></div>
    <div class="mfoot">
      ${ids.length > 1 && html`<button class="ghost" disabled=${idx <= 0} onClick=${() => nav(-1)}>‹ <kbd>←</kbd></button>
        <span class="muted small">${idx + 1} / ${ids.length}</span>
        <button class="ghost" disabled=${idx >= ids.length - 1} onClick=${() => nav(1)}><kbd>→</kbd> ›</button>`}
      <span class="spacer"></span>
      <button class="ghost danger" onClick=${del}>Delete</button>
      <button class="primary" onClick=${() => setView(false)}>Edit <kbd>E</kbd></button>
    </div>
  </div><//>`;

  return html`<${Modal} onClose=${onClose}><div onKeyDown=${onKey}>
    <div class="mhead">
      <b>${mode === 'add' ? 'New card' : 'Edit card'}</b><span>· ${deck.name}</span>${meta}
      <span class="spacer"></span>
      <button class="ghost" onClick=${onClose}>✕ <kbd>esc</kbd></button>
    </div>

    <div class="front-line">
      <input ref=${frontRef} class="front-input" placeholder="Word or phrase…" value=${draft.front} onInput=${(e) => up({ front: e.target.value })} autocomplete="off" />
      <button class="primary" disabled=${gen.text || !draft.front.trim()} onClick=${generate} title=${canGen ? 'generate with the LLM' : 'set the OpenRouter key in settings'}>
        ${mode === 'add' && exact ? 'Open' : gen.text ? '…' : 'Generate ⚡'} <kbd>↩</kbd></button>
    </div>
    ${mode === 'add' && html`<div class="dict">
      ${exact ? html`already in deck: <span class="link" onClick=${() => openExisting(exact)}>${exact.front}</span><span class="muted"> · ${cardBack(exact)} · ${stepLabel(deck, exact.step)}</span>`
        : nf ? html`${similar.length ? 'similar: ' : 'not in deck'}${similar.map((c) => html`<span class="link" key=${c.id} onClick=${() => openExisting(c)} title=${cardBack(c)}>${c.front}</span>`)}` : ''}
    </div>`}

    <div class="gen-state">
      ${gen.text ? html`<span class="busy">● text…</span>` : gen.textMs && html`<span><span class="dot">●</span> text ${sec(gen.textMs)}</span>`}
      ${gen.audio ? html`<span class="busy">● audio…</span>` : gen.audioMs && html`<span><span class="dot">●</span> audio ${sec(gen.audioMs)}</span>`}
      ${err && html`<span class="err">${err}</span>`}
      <span class="spacer"></span>
      ${sug && html`<span>suggested: <b>${sug}</b> <span class="link" onClick=${applySug}>apply</span></span>`}
    </div>

    ${deck.audioFor !== 'off' && html`<div class="f"><label>audio</label>
      <${AudioLine} card=${!blob && draft.audio ? draft : null} blob=${blob} busy=${gen.audio} canGenerate=${canGen && !!draft.front.trim()} onRegenerate=${regenAudio} onRemove=${removeAudio} />
    </div>`}

    <h4 class="msec">Senses</h4>
    ${draft.senses.map((s, i) => html`<div class="sense" key=${i}>
      <div class="shead">
        <b>${i + 1}</b>
        <input placeholder="translation" value=${s.translation} onInput=${(e) => upSense(i, { translation: e.target.value })} />
        <button class="ghost sm" disabled=${i === 0} onClick=${() => mvSense(i, -1)} title="move up">↑</button>
        <button class="ghost sm" disabled=${i === draft.senses.length - 1} onClick=${() => mvSense(i, 1)} title="move down">↓</button>
        <button class="ghost sm" disabled=${draft.senses.length === 1} onClick=${() => rmSense(i)} title="remove sense">✕</button>
      </div>
      <div class="sfields">${deck.senseFields.map((f) => html`<div class="f" key=${f.key}><label>${f.label}</label>
        <${HtmlField} value=${s.fields?.[f.key] || ''} onInput=${(e) => upSenseField(i, f.key, e.target.value)} /></div>`)}</div>
    </div>`)}
    <button class="ghost sm" onClick=${addSense}>+ sense</button>

    ${deck.cardFields.length > 0 && html`<h4 class="msec">Card</h4>
      ${deck.cardFields.map((f) => html`<div class="f" key=${f.key}><label>${f.label}</label>
        <${HtmlField} value=${draft.fields?.[f.key] || ''} onInput=${(e) => up({ fields: { ...draft.fields, [f.key]: e.target.value } })} /></div>`)}`}

    ${mode === 'edit' && html`<div class="f" style="margin-top:14px"><label>position · due ${fmtRel(draft.due)}<${Q} text="Click a step to move the card there now; its next review is scheduled from this moment." /></label>
      <${Ruler} compact deck=${deck} step=${draft.step} onPick=${moveStep} /></div>`}

    <div class="mfoot">
      ${mode === 'edit' && html`<button class="ghost danger" onClick=${del}>Delete</button>
        <button class="ghost" disabled=${!canGen || gen.text} onClick=${generate}>Regenerate all ⚡</button>`}
      <span class="spacer"></span>
      ${mode === 'add' && html`<${Q} text="Enter generates, ⌘/Ctrl-Enter adds. The window stays open for the next word; typing a word already in the deck opens that card instead." />`}
      <button class="ghost" onClick=${() => (startView ? (reset(clone(existing)), setView(true)) : onClose())}>${mode === 'add' ? 'Discard' : 'Cancel'}</button>
      <button class="primary" disabled=${saving} onClick=${save}>${mode === 'add' ? 'Add to deck' : 'Save'} <kbd>${modKey}↩</kbd></button>
    </div>
  </div><//>`;
}
