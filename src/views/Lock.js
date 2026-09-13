import { html, useSync } from '../ui.js';
import { fmtRel } from '../util.js';

export function Lock({ onDismiss }) {
  const sync = useSync();
  const l = sync.lockInfo;
  return html`<div class="lock">
    <h2>In use in another browser</h2>
    <p class="muted">${l?.ua || 'Another client'} took the sync lock ${l ? fmtRel(l.ts) : ''} and is still active.<br />
      Take over only if that tab is closed, otherwise its unsynced changes may be lost.</p>
    <div class="row">
      <button onClick=${() => sync.syncNow()} disabled=${sync.status === 'connecting'}>Retry</button>
      <button class="danger" onClick=${() => sync.takeOver()}>Take over</button>
      <button class="ghost" onClick=${onDismiss}>Work locally</button>
    </div>
    <p class="note" style="margin-top:20px">Working locally keeps changes in this browser; they are pushed the next time this browser gets the lock.</p>
  </div>`;
}
