import { render } from 'preact';
import { html, useState, useEffect, useStore, useSync, Toast, Modal, ErrorBoundary, isEditing, HOTKEYS } from './ui.js';
import { store } from './store.js';
import { sync } from './drive.js';
import { fmtRel, bus } from './util.js';
import { Decks } from './views/Decks.js';
import { Learn } from './views/Learn.js';
import { Cards } from './views/Cards.js';
import { DeckSettings } from './views/DeckSettings.js';
import { Settings } from './views/Settings.js';
import { Lock } from './views/Lock.js';
import { CardModal } from './views/CardModal.js';

function parseHash() {
  const h = location.hash.slice(1) || '/';
  if (h === '/settings') return { view: 'settings' };
  if (h === '/lock') return { view: 'lock' };
  const m = /^\/deck\/([^/]+)\/(learn|cards|settings)$/.exec(h);
  if (m) return { view: m[2] === 'settings' ? 'deckSettings' : m[2], deckId: m[1] };
  return { view: 'decks' };
}

function useRoute() {
  const [r, set] = useState(parseHash);
  useEffect(() => {
    const h = () => set(parseHash());
    addEventListener('hashchange', h);
    return () => removeEventListener('hashchange', h);
  }, []);
  return r;
}

function SyncStatus() {
  const s = useSync();
  const [, tick] = useState(0);
  useEffect(() => { const i = setInterval(() => tick((n) => n + 1), 30e3); return () => clearInterval(i); }, []);
  const go = (h) => () => { location.hash = h; };
  const map = {
    off: ['no sync', go('#/settings')],
    signin: ['sign in to sync', () => sync.connect().catch(bus.error)],
    connecting: ['syncing…'], pulling: ['syncing…'], pushing: ['syncing…'],
    synced: [s.lastSync ? `synced ${fmtRel(s.lastSync)}` : 'synced', () => sync.syncNow()],
    idle: ['idle · click to sync', () => sync.syncNow()],
    locked: ['locked elsewhere', go('#/lock')],
    offline: ['offline · retry', () => sync.syncNow()],
    error: ['sync error', go('#/settings')],
  };
  const [label, action] = map[s.status] || [s.status];
  const unsynced = store.dirty.size && s.status !== 'synced' && s.status !== 'off' ? ` · ${store.dirty.size} unsynced` : '';
  return html`<span class=${'sync ' + s.status} title=${s.error || ''} onClick=${action}>${label}${unsynced}</span>`;
}

function Help({ onClose }) {
  return html`<${Modal} narrow onClose=${onClose}>
    <div class="mhead"><b>Hotkeys</b><span class="spacer"></span><button class="ghost" onClick=${onClose}>✕ <kbd>esc</kbd></button></div>
    <table class="hk small">${HOTKEYS.map(([k, d]) => html`<tr key=${d}><td><kbd>${k}</kbd></td><td class="muted">${d}</td></tr>`)}</table>
  <//>`;
}

function App() {
  useStore();
  const s = useSync();
  const route = useRoute();
  const [modal, setModal] = useState(null);
  const [help, setHelp] = useState(false);
  const [lockDismissed, setLockDismissed] = useState(false);
  const deck = route.deckId ? store.deck(route.deckId) : null;
  const openCard = (deckId, cardId = null, mode = 'edit', ids = []) => setModal({ deckId, cardId, view: mode === 'view', ids, n: Math.random() });
  const close = () => setModal(null);
  const showLock = (s.status === 'locked' && !lockDismissed) || route.view === 'lock';
  useEffect(() => { setModal(null); }, [route.view, route.deckId]);

  useEffect(() => {
    const h = (e) => {
      if (help) { if (e.key === 'Escape') setHelp(false); return; }
      if (modal) { if (e.key === 'Escape') close(); return; }
      if (e.key === 'Escape') {
        if (isEditing(e)) return e.target.blur();
        if (route.view !== 'decks') location.hash = '#/';
        return;
      }
      if (isEditing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '?') setHelp(true);
      else if (e.key.toLowerCase() === 'n' && deck && !showLock) { e.preventDefault(); openCard(deck.id); }
    };
    addEventListener('keydown', h);
    return () => removeEventListener('keydown', h);
  });

  if (!store.ready) return html`<main><div class="empty">loading…</div></main>`;

  const keysEnabled = !modal && !help;
  let view;
  if (showLock) view = html`<${Lock} onDismiss=${() => { setLockDismissed(true); if (route.view === 'lock') location.hash = '#/'; }} />`;
  else if (route.view === 'settings') view = html`<${Settings} />`;
  else if (route.deckId && !deck) view = html`<div class="empty">deck not found · <a class="link" href="#/">decks</a></div>`;
  else if (route.view === 'learn') view = html`<${Learn} key=${deck.id} deck=${deck} keysEnabled=${keysEnabled} status=${html`<${SyncStatus} />`} onAdd=${() => openCard(deck.id)} onEdit=${(id) => openCard(deck.id, id)} />`;
  else if (route.view === 'cards') view = html`<${Cards} key=${deck.id} deck=${deck} keysEnabled=${keysEnabled} onAdd=${() => openCard(deck.id)} onOpen=${(id, mode, ids) => openCard(deck.id, id, mode, ids)} />`;
  else if (route.view === 'deckSettings') view = html`<${DeckSettings} key=${deck.id} deck=${deck} onAdd=${() => openCard(deck.id)} />`;
  else view = html`<${Decks} onAdd=${(id) => openCard(id)} />`;

  const guard = (v, key) => html`<${ErrorBoundary} key=${key}>${v}<//>`;
  const overlays = html`
    ${modal && store.deck(modal.deckId) && guard(html`<${CardModal} deckId=${modal.deckId} cardId=${modal.cardId} view=${modal.view} ids=${modal.ids} onClose=${close} />`, 'm' + modal.n)}
    ${help && html`<${Help} onClose=${() => setHelp(false)} />`}
    <${Toast} />`;
  const guarded = guard(view, route.view + (route.deckId || ''));
  if (route.view === 'learn' && deck && !showLock) return html`${guarded}${overlays}`;

  return html`
    <header class="top">
      <a href="#/" class="crumb">Decks</a>
      ${deck && !showLock && html`<span class="sep">/</span><a class="crumb" href=${`#/deck/${deck.id}/cards`}>${deck.name}</a>`}
      <span class="spacer"></span>
      <${SyncStatus} />
      <a href="#/settings" class="gear" title="Settings">⚙</a>
    </header>
    <main>${guarded}</main>
    ${overlays}`;
}

render(html`<${App} />`, document.getElementById('app'));
store.load().then(() => sync.start()).catch(bus.error);
