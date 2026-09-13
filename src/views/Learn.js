import { html, useState, useEffect, Ruler, CardBody, isEditing } from '../ui.js';
import { store } from '../store.js';
import { buildQueue, requeue, sideFor, applyGrade, moveTo, gradeStep, stepLabel, GRADES, GRADE_LABEL, deckStats, isNew } from '../schedule.js';
import { playCard } from '../audio.js';
import { fmtRel, clone, todayKey, now, shuffle } from '../util.js';

const rulerPref = () => localStorage.getItem('srs.ruler') !== '0';

export function Learn({ deck, onAdd, onEdit, keysEnabled, status }) {
  const [queue, setQueue] = useState(() => buildQueue(deck, store.cardsOf(deck.id)));
  const [flipped, setFlipped] = useState(false);
  const [undo, setUndo] = useState([]);
  const [done, setDone] = useState(0);
  const [ruler, setRuler] = useState(rulerPref);

  const live = queue.filter((id) => store.card(id));
  const card = store.card(live[0]);
  const side = card ? sideFor(deck, card) : null;
  const stats = deckStats(deck, store.cardsOf(deck.id));

  useEffect(() => {
    if (!card?.audio) return;
    if ((side === 'front' && !flipped) || (side === 'back' && flipped)) playCard(card);
  }, [card?.id, flipped]);

  const commit = async (patch, again = false) => {
    const before = { card: clone(card), queue: [...queue], day: clone(deck.day || null) };
    const updated = { ...card, ...patch };
    if (isNew(card) && !isNew(updated)) {
      deck.day = deck.day?.date === todayKey() ? { ...deck.day, count: deck.day.count + 1 } : { date: todayKey(), count: 1 };
      await store.saveDeck(deck);
    }
    await store.saveCard(updated);
    const q = live.slice(1);
    if (again) requeue(q, card.id); else setDone((d) => d + 1);
    setUndo((u) => [...u.slice(-49), before]);
    setQueue(q);
    setFlipped(false);
  };
  const grade = (g) => commit(applyGrade(deck, card, g, side), g === 'again');
  const move = (i) => commit(moveTo(deck, card, i));
  const doUndo = async () => {
    const u = undo[undo.length - 1];
    if (!u) return;
    setUndo(undo.slice(0, -1));
    await store.saveCard(u.card);
    if (u.day) { deck.day = u.day; await store.saveDeck(deck); }
    setQueue(u.queue);
    setFlipped(false);
    setDone((d) => Math.max(0, d - 1));
  };
  const refresh = () => { setQueue(buildQueue(deck, store.cardsOf(deck.id))); setDone(0); };
  const moreNew = () => {
    const inQ = new Set(live);
    let fresh = store.cardsOf(deck.id).filter((c) => isNew(c) && !inQ.has(c.id));
    if (deck.newOrder === 'random') shuffle(fresh);
    else fresh.sort((a, b) => (deck.newOrder === 'newest' ? b.created - a.created : a.created - b.created));
    setQueue([...live, ...fresh.slice(0, 10).map((c) => c.id)]);
  };
  const toggleRuler = () => setRuler((v) => { localStorage.setItem('srs.ruler', v ? '0' : '1'); return !v; });

  useEffect(() => {
    if (!keysEnabled) return;
    const h = (e) => {
      if (isEditing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'u') { doUndo(); e.preventDefault(); return; }
      if (!card) return;
      if (e.key === ' ' || e.key === 'Enter') { if (!flipped) setFlipped(true); else grade('next'); }
      else if (flipped && /^[1-4]$/.test(k)) grade(GRADES[+k - 1]);
      else if (e.key === 'ArrowLeft') move(Math.max(-1, card.step - 1));
      else if (e.key === 'ArrowRight') move(card.step + 1);
      else if (k === 'r') move(-1);
      else if (k === 'a') playCard(card);
      else if (k === 'e') onEdit(card.id);
      else return;
      e.preventDefault();
    };
    addEventListener('keydown', h);
    return () => removeEventListener('keydown', h);
  });

  const top = html`<header class="lt">
    <a class="back" href=${`#/deck/${deck.id}/cards`} title="deck">‹ <b>${deck.name}</b></a>
    <span class="counts"><span>new <b>${stats.newLeft}</b></span><span>due <b>${stats.due}</b></span><span>done <b>${done}</b></span><span>left <b>${live.length}</b></span></span>
    <span class="spacer"></span>
    ${status}
    <button class="ghost sm" onClick=${() => onAdd()}>+ Add <kbd>N</kbd></button>
  </header>`;

  if (!card) {
    const next = store.cardsOf(deck.id).filter((c) => c.due && c.due > now()).reduce((m, c) => Math.min(m, c.due), Infinity);
    const waiting = stats.newAvail - stats.newLeft;
    return html`<div class="lpage">${top}<div class="lbody"><div class="done">
      <h2>${done ? `Done · ${done} card${done === 1 ? '' : 's'}` : 'Nothing to review'}</h2>
      <p class="muted">
        ${waiting > 0 ? `${waiting} new card${waiting === 1 ? '' : 's'} waiting · daily limit ${deck.newPerDay} reached` : ''}
        ${waiting > 0 && next < Infinity ? ' · ' : ''}${next < Infinity ? `next review ${fmtRel(next)}` : ''}
      </p>
      <div class="row" style="justify-content:center">
        <button onClick=${refresh}>Check again</button>
        ${waiting > 0 && html`<button onClick=${moreNew}>+10 new anyway</button>`}
        ${undo.length > 0 && html`<button class="ghost" onClick=${doUndo}>Undo <kbd>U</kbd></button>`}
        <a href="#/"><button class="ghost">Decks <kbd>esc</kbd></button></a>
      </div>
    </div></div></div>`;
  }

  return html`<div class="lpage">${top}
    <div class="lbody">
      <div class=${'card' + (flipped ? '' : ' q')} onClick=${() => { if (!flipped) setFlipped(true); }}>
        <span class="side-tag">${side}</span>
        ${card.audio && html`<button class="ghost audio" onClick=${(e) => { e.stopPropagation(); playCard(card); }} title="play (A)">▶</button>`}
        <${CardBody} deck=${deck} card=${card} side=${side} flipped=${flipped} />
        <span class="step-tag">${stepLabel(deck, card.step)} · ${card.reviews}×</span>
      </div>
    </div>

    <footer class="lfoot">
      ${!flipped
        ? html`<div class="show-bar"><button class="primary" onClick=${() => setFlipped(true)}>Show answer <kbd>space</kbd></button></div>`
        : html`<div class="grades">${GRADES.map((g, i) => html`<button key=${g} class=${g === 'again' ? 'again' : g === 'next' ? 'primary' : ''} onClick=${() => grade(g)}>
            ${GRADE_LABEL[g]}<small>${g === 'again' ? 'later in queue' : stepLabel(deck, gradeStep(deck, card, g))}</small><kbd>${i + 1}</kbd></button>`)}</div>`}
      ${ruler && html`<${Ruler} compact deck=${deck} step=${card.step} target=${flipped ? gradeStep(deck, card, 'next') : undefined} onPick=${move} />`}
      <div class="tools">
        <button class="ghost" onClick=${() => onEdit(card.id)}>Edit <kbd>E</kbd></button>
        ${card.audio && html`<button class="ghost" onClick=${() => playCard(card)}>Audio <kbd>A</kbd></button>`}
        <button class="ghost" disabled=${!undo.length} onClick=${doUndo}>Undo <kbd>U</kbd></button>
        ${!ruler && html`<button class="ghost" onClick=${() => move(-1)}>Reset <kbd>R</kbd></button>`}
        <button class=${'ghost' + (ruler ? ' on' : '')} onClick=${toggleRuler}>Move</button>
        <details class="spoiler"><summary>Hotkeys</summary>
          <div class="legend">
            <span><kbd>space</kbd> show / next</span><span><kbd>1-4</kbd> grade</span><span><kbd>← →</kbd> move</span><span><kbd>R</kbd> reset</span>
            <span><kbd>E</kbd> edit</span><span><kbd>A</kbd> audio</span><span><kbd>U</kbd> undo</span><span><kbd>N</kbd> add</span><span><kbd>esc</kbd> decks</span><span><kbd>?</kbd> all</span>
          </div>
        </details>
      </div>
    </footer>
  </div>`;
}
