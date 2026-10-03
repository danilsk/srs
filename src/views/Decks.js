import { html, useState } from '../ui.js';
import { store, newDeck } from '../store.js';
import { deckStats } from '../schedule.js';
import { bus } from '../util.js';

export function Decks({ onAdd }) {
  const [form, setForm] = useState(null);

  const create = async () => {
    const name = form.name.trim(), target = form.target.trim(), native = form.native.trim();
    if (!name || !target || !native) return bus.toast('name, target and native language are all required');
    const d = newDeck(name, target, native);
    await store.saveDeck(d);
    setForm(null);
    location.hash = `#/deck/${d.id}/settings`;
  };

  return html`<section>
    ${!store.decks.length && !form && html`<div class="empty">No decks yet.</div>`}
    ${store.decks.map((d) => {
      const s = deckStats(d, store.cardsOf(d.id));
      return html`<div class="deck" key=${d.id}>
        <div><a href=${`#/deck/${d.id}/cards`} class="name">${d.name}</a><span class="lang">${d.targetLang} → ${d.nativeLang}</span></div>
        <div class="stats">
          <span class=${'n-new' + (s.newLeft ? '' : ' zero')}>new <b>${s.newLeft}</b><span class="muted">/${d.newPerDay}</span></span>
          <span class=${'n-due' + (s.due ? '' : ' zero')}>due <b>${s.due}</b></span>
          <span>total <b>${s.total}</b></span>
        </div>
        <div class="row">
          <button onClick=${() => onAdd(d.id)}>+ Add</button>
          <a href=${`#/deck/${d.id}/learn`}><button class=${s.newLeft + s.due ? 'primary' : ''}>Learn</button></a>
        </div>
      </div>`;
    })}
    ${form
      ? html`<div class="newdeck" onKeyDown=${(e) => { if (e.key === 'Enter') create(); if (e.key === 'Escape') { e.stopPropagation(); setForm(null); } }}>
          <div class="g3">
            <div class="f"><label>name</label><input autofocus value=${form.name} onInput=${(e) => setForm({ ...form, name: e.target.value })} /></div>
            <div class="f"><label>target language</label><input placeholder="Spanish" value=${form.target} onInput=${(e) => setForm({ ...form, target: e.target.value })} /></div>
            <div class="f"><label>native language</label><input placeholder="Russian" value=${form.native} onInput=${(e) => setForm({ ...form, native: e.target.value })} /></div>
          </div>
          <div class="row"><button class="primary" onClick=${create}>Create</button><button class="ghost" onClick=${() => setForm(null)}>Cancel</button></div>
        </div>`
      : html`<p style="margin-top:22px"><button class="ghost" onClick=${() => setForm({ name: '', target: '', native: '' })}>+ New deck</button></p>`}
  </section>`;
}
