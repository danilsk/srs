import { html, useSync } from '../ui.js';
import { bus } from '../util.js';

export function Gate({ onDismiss }) {
  const sync = useSync();
  const s = sync.status;
  const busy = s !== 'signin' && s !== 'offline' && s !== 'error';
  let body;
  if (busy) body = html`<h2>Syncing…</h2><p class="muted">Pulling your decks from Google Drive.</p>`;
  else if (s === 'signin') body = html`<h2>Sign in to sync</h2>
    <p class="muted">Your Google session has expired. Sign in to pull the latest decks before studying.</p>
    <div class="row"><button class="primary" onClick=${() => sync.connect().catch(bus.error)}>Sign in with Google</button></div>`;
  else body = html`<h2>${s === 'offline' ? 'Offline' : 'Sync failed'}</h2>
    <p class="muted">${sync.error || 'Google Drive is not reachable.'}</p>
    <div class="row"><button onClick=${() => sync.syncNow()}>Retry</button></div>`;
  return html`<div class="lock">${body}
    <p class="note" style="margin-top:20px"><span class="link" onClick=${onDismiss}>Continue offline</span> · changes stay on this device and sync next time.</p>
  </div>`;
}
