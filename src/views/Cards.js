import { html, useState, useEffect, useRef, Tabs, Q, isEditing } from '../ui.js';
import { store, cardBack } from '../store.js';
import { isNew, isDue, isMature, sideFor, moveTo, stepLabel, lastStep } from '../schedule.js';
import { generateCard, generateAudio } from '../llm.js';
import { sync } from '../drive.js';
import { playCard } from '../audio.js';
import { norm, now, fmtRel, fmtDate, uid, bus } from '../util.js';

const PAGE = 50;

export function Cards({ deck, onAdd, onOpen, keysEnabled }) {
  const cards = store.cardsOf(deck.id);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState({ col: 'due', asc: true });
  const [page, setPage] = useState(0);
  const [sel, setSel] = useState(new Set());
  const [busy, setBusy] = useState(null);
  const searchRef = useRef();
  const t = now();

  const filters = {
    all: () => true,
    new: isNew,
    due: (c) => isDue(c, t),
    learning: (c) => c.step >= 0 && !isMature(deck, c),
    mature: (c) => isMature(deck, c),
    noaudio: (c) => !c.audio,
  };
  const FILTER_LABEL = { all: 'All', new: 'New', due: 'Due', learning: 'Learning', mature: 'Mature', noaudio: 'No audio' };

  const cols = [
    { key: 'front', label: 'front', get: (c) => norm(c.front) },
    { key: 'back', label: 'back', get: (c) => norm(cardBack(c)) },
    { key: 'audio', label: 'audio', get: (c) => (c.audio ? 1 : 0) },
    { key: 'step', label: 'step', get: (c) => c.step },
    { key: 'due', label: 'due', get: (c) => c.due ?? Infinity },
    { key: 'side', label: 'next side', get: (c) => sideFor(deck, c) },
    { key: 'reviews', label: 'reviews', get: (c) => c.reviews, num: true },
    { key: 'lapses', label: 'lapses', get: (c) => c.lapses, num: true },
    { key: 'lastReview', label: 'last review', get: (c) => c.lastReview ?? -Infinity },
    { key: 'created', label: 'added', get: (c) => c.created },
  ];

  const text = (c) => [c.front, ...c.senses.flatMap((s) => [s.translation, ...Object.values(s.fields || {})]), ...Object.values(c.fields || {})]
    .join(' ').replace(/<[^>]+>/g, ' ').toLowerCase();
  const nq = norm(q);
  const col = cols.find((c) => c.key === sort.col);
  let rows = cards.filter(filters[filter]);
  if (nq) rows = rows.filter((c) => text(c).includes(nq));
  rows.sort((a, b) => { const x = col.get(a), y = col.get(b); const d = x < y ? -1 : x > y ? 1 : 0; return sort.asc ? d : -d; });
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const pg = Math.min(page, pages - 1);
  const pageRows = rows.slice(pg * PAGE, pg * PAGE + PAGE);

  const defaultAsc = (key) => key !== 'created' && key !== 'lastReview';
  const toggleSort = (key) => setSort((s) => (s.col === key ? { col: key, asc: !s.asc } : { col: key, asc: defaultAsc(key) }));
  const toggle = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allOnPage = pageRows.length > 0 && pageRows.every((c) => sel.has(c.id));
  const toggleAll = () => setSel((s) => { const n = new Set(s); for (const c of pageRows) allOnPage ? n.delete(c.id) : n.add(c.id); return n; });
  const selected = cards.filter((c) => sel.has(c.id));

  const setStep = (c, step) => store.saveCard({ ...c, ...moveTo(deck, c, step) });
  const bulkMove = async (step) => { await store.saveCards(selected.map((c) => ({ ...c, ...moveTo(deck, c, step, t) }))); setSel(new Set()); };
  const bulkDelete = async () => {
    if (!confirm(`Delete ${selected.length} card${selected.length === 1 ? '' : 's'}?`)) return;
    await store.deleteCards([...sel]); setSel(new Set());
  };
  const bulkRegen = async (what) => {
    let i = 0;
    for (const c of selected) {
      setBusy(`${what} ${++i}/${selected.length}`);
      try {
        const cur = store.card(c.id); if (!cur) continue;
        if (what === 'text') {
          const r = await generateCard(deck, cur.front);
          await store.saveCard({ ...cur, senses: r.senses, fields: r.fields });
        } else {
          const blob = await generateAudio(deck, cur.front);
          const key = uid();
          await store.saveAudio(key, blob);
          if (cur.audio) { store.deleteAudio(cur.audio.key); sync.deleteRemoteAudio(cur.audio.driveId); }
          await store.saveCard({ ...cur, audio: { key, driveId: null, mime: blob.type } });
        }
      } catch (e) { bus.error(`${c.front}: ${e.message}`); }
    }
    setBusy(null); setSel(new Set());
  };

  useEffect(() => {
    if (!keysEnabled) return;
    const h = (e) => { if (e.key === '/' && !isEditing(e)) { e.preventDefault(); searchRef.current?.focus(); } };
    addEventListener('keydown', h);
    return () => removeEventListener('keydown', h);
  }, [keysEnabled]);

  const stepOptions = [];
  for (let i = -1; i <= lastStep(deck); i++) stepOptions.push(html`<option key=${i} value=${i}>${stepLabel(deck, i)}</option>`);

  return html`<${Tabs} deck=${deck} active="cards" meta=${`${cards.length} cards · ${cards.filter(isNew).length} new · ${cards.filter(filters.learning).length} learning · ${cards.filter(filters.mature).length} mature`} onAdd=${() => onAdd()} />
    <div class="toolbar">
      <input ref=${searchRef} placeholder="Search…  /" value=${q} onInput=${(e) => { setQ(e.target.value); setPage(0); }}
        onKeyDown=${(e) => { if (e.key === 'Escape') { e.stopPropagation(); if (q) setQ(''); else e.target.blur(); } }} />
      <div class="filters">${Object.keys(filters).map((k) => html`<button key=${k} class=${filter === k ? 'on' : ''} onClick=${() => { setFilter(k); setPage(0); }}>${FILTER_LABEL[k]} ${cards.filter(filters[k]).length}</button>`)}</div>
      <div class="sortsel">
        <select value=${sort.col} onChange=${(e) => setSort({ col: e.target.value, asc: defaultAsc(e.target.value) })}>
          ${cols.map((c) => html`<option key=${c.key} value=${c.key}>sort: ${c.label}</option>`)}
        </select>
        <button onClick=${() => setSort((s) => ({ ...s, asc: !s.asc }))}>${sort.asc ? '↑' : '↓'}</button>
      </div>
      <span class="spacer"></span>
      <span class="muted small">${rows.length === cards.length ? '' : `${rows.length} shown`}</span>
      <${Q} right text="Click a header to sort. Click a row to view it, ⌘/Ctrl-click or ✎ to edit. Changing the step reschedules the card from now. Tick rows for bulk actions." />
    </div>

    ${sel.size > 0 && html`<div class="bulk">
      <b>${sel.size} selected</b>
      <span>· move to</span>
      <select value="" disabled=${!!busy} onChange=${(e) => { if (e.target.value !== '') bulkMove(+e.target.value); e.target.value = ''; }}><option value="">step…</option>${stepOptions}</select>
      <button disabled=${!!busy} onClick=${() => bulkRegen('text')}>Regenerate text</button>
      <button disabled=${!!busy} onClick=${() => bulkRegen('audio')}>Regenerate audio</button>
      ${busy && html`<span class="muted">${busy}…</span>`}
      <span class="spacer"></span>
      <button class="danger" disabled=${!!busy} onClick=${bulkDelete}>Delete</button>
      <button class="ghost" onClick=${() => setSel(new Set())}>✕</button>
    </div>`}

    <div class="tablewrap"><table>
      <thead><tr>
        <th class="chk"><input type="checkbox" checked=${allOnPage} onChange=${toggleAll} /></th>
        ${cols.map((c) => html`<th key=${c.key} class=${(sort.col === c.key ? 'sorted' : '') + (sort.col === c.key && sort.asc ? ' asc' : '') + (c.num ? ' num' : '')} onClick=${() => toggleSort(c.key)}>${c.label}</th>`)}
        <th class="act"></th>
      </tr></thead>
      <tbody>${pageRows.map((c) => html`<tr key=${c.id} class=${sel.has(c.id) ? 'sel' : ''} onClick=${(e) => onOpen(c.id, e.metaKey || e.ctrlKey ? 'edit' : 'view', rows.map((r) => r.id))}>
        <td class="chk" onClick=${(e) => e.stopPropagation()}><input type="checkbox" checked=${sel.has(c.id)} onChange=${() => toggle(c.id)} /></td>
        <td class="front">${c.front}</td>
        <td class="back" title=${cardBack(c)}>${cardBack(c)}</td>
        <td class="audio">${c.audio ? html`<button class="play" onClick=${(e) => { e.stopPropagation(); playCard(c); }}>▶</button>` : html`<span class="muted">–</span>`}</td>
        <td class="stepcell" onClick=${(e) => e.stopPropagation()}>
          <select class=${'step' + (c.step < 0 ? ' new' : isMature(deck, c) ? ' last' : '')} value=${c.step} onChange=${(e) => setStep(c, +e.target.value)}>${stepOptions}</select>
        </td>
        <td class=${'due' + (isDue(c, t) ? ' over' : '')}>${fmtRel(c.due, t)}</td>
        <td class="muted side">${sideFor(deck, c)}</td>
        <td class="num revs">${c.reviews}</td>
        <td class="num lapses">${c.lapses}</td>
        <td class="muted lastrev">${fmtDate(c.lastReview, t)}</td>
        <td class="muted added">${fmtDate(c.created, t)}</td>
        <td class="act"><button class="ghost sm" title="edit" onClick=${(e) => { e.stopPropagation(); onOpen(c.id, 'edit'); }}>✎</button></td>
      </tr>`)}
      ${!pageRows.length && html`<tr><td colspan="12" class="muted none" style="text-align:center;padding:30px">${cards.length ? 'no matches' : 'no cards yet'}</td></tr>`}
      </tbody>
    </table></div>
    ${pages > 1 && html`<div class="pager">
      <button class="ghost sm" disabled=${pg === 0} onClick=${() => setPage(pg - 1)}>‹ prev</button>
      <span>${pg + 1} / ${pages}</span>
      <button class="ghost sm" disabled=${pg >= pages - 1} onClick=${() => setPage(pg + 1)}>next ›</button>
    </div>`}
`;
}
