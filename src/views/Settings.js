import { html, useState, useEffect, useSync, HOTKEYS, Q } from '../ui.js';
import { store } from '../store.js';
import { db } from '../db.js';
import { prefs, DEFAULTS } from '../prefs.js';
import { testKey } from '../llm.js';
import { fmtRel, fmtTime, download, bus } from '../util.js';
import { canInstall, isInstalled, installApp } from '../pwa.js';

export function Settings() {
  const sync = useSync();
  const [, force] = useState(0);
  const [test, setTest] = useState(null);
  const [info, setInfo] = useState(null);
  const bind = (k) => ({ value: prefs.get(k), onInput: (e) => { prefs.set(k, e.target.value.trim()); force((n) => n + 1); } });

  useEffect(() => { if (sync.status === 'synced') sync.info().then(setInfo).catch(() => {}); }, [sync.status]);
  useEffect(() => {
    const update = () => force((n) => n + 1);
    addEventListener('srs-install-change', update);
    return () => removeEventListener('srs-install-change', update);
  }, []);

  const runTest = async () => {
    setTest('…');
    try { const r = await testKey(); setTest(`ok · ${r.ms} ms · "${r.text}"`); }
    catch (e) { setTest('✕ ' + e.message); }
  };
  const connect = async () => { try { await sync.connect(); } catch (e) { bus.error(e); } };
  const importFile = (e) => {
    const f = e.target.files[0]; if (!f) return;
    f.text().then((t) => store.importJson(t)).then((r) => bus.toast(`imported ${r.decks} decks, ${r.cards} cards`)).catch(bus.error);
    e.target.value = '';
  };
  const wipe = async () => {
    if (prompt('Type WIPE to delete all local data (Drive is untouched):') !== 'WIPE') return;
    await db.wipe(); localStorage.removeItem('srs.gToken'); location.reload();
  };

  const label = {
    off: 'not connected', signin: 'signed out', connecting: 'connecting…', pulling: 'pulling…', pushing: 'pushing…',
    synced: `synced ${sync.lastSync ? fmtRel(sync.lastSync) : ''}`, idle: 'idle · lock released', locked: 'locked by another browser',
    offline: 'offline', error: `error · ${sync.error}`, conflict: 'conflict · changed on Drive and here',
  }[sync.status] || sync.status;
  const resolve = (id, keep) => sync.resolveConflict(id, keep).catch(bus.error);

  return html`<div class="form">
    <h3>OpenRouter</h3>
    <div class="f"><label>API key · stored in this browser only</label><input type="password" autocomplete="off" ...${bind('orKey')} /></div>
    <div class="g2">
      <div class="f"><label>text model</label><input placeholder=${DEFAULTS.textModel} ...${bind('textModel')} /></div>
      <div class="f"><label>audio model</label><input placeholder=${DEFAULTS.ttsModel} ...${bind('ttsModel')} /></div>
    </div>
    <div class="row"><button onClick=${runTest} disabled=${!prefs.get('orKey')}>Test ⚡</button>${test && html`<span class="muted small">${test}</span>`}</div>

    <h3>Google Drive</h3>
    <div class="f"><label>OAuth client ID<${Q} text=${`Google Cloud console → Google Auth Platform → Clients → Create client, type Web application, authorized JavaScript origin = ${location.origin}. Drive API must be enabled. Scope used: drive.file (only files this app creates).`} /></label>
      <input placeholder="…apps.googleusercontent.com" ...${bind('gClientId')} disabled=${sync.enabled} /></div>
    ${!sync.enabled
      ? html`<div class="row"><button class="primary" disabled=${!prefs.get('gClientId')} onClick=${connect}>Connect Google Drive</button></div>`
      : html`
        <div class="row">
          <span class=${'sync ' + sync.status}>${label}</span>
          ${sync.lockSince && html`<span class="muted small">· lock held since ${fmtTime(sync.lockSince)}</span>`}
          ${info && html`<span class="muted small">· ${info.decks} deck files · ${info.audio} audio files</span>`}
          ${store.dirty.size > 0 && html`<span class="muted small">· ${store.dirty.size} deck${store.dirty.size === 1 ? '' : 's'} unsynced</span>`}
        </div>
        ${sync.status === 'conflict' && sync.conflicts.map((id) => html`<div class="row conflict" key=${id}>
          <b>${store.deck(id)?.name || id}</b>
          <button class="primary" onClick=${() => resolve(id, 'local')}>Keep this device</button>
          <button class="danger" onClick=${() => resolve(id, 'drive')}>Keep Drive, discard local changes</button>
        </div>`)}
        <div class="row" style="margin-top:10px">
          ${sync.status === 'signin' ? html`<button class="primary" onClick=${connect}>Sign in</button>` : html`<button onClick=${() => sync.syncNow()}>Sync now</button>`}
          <span class="spacer"></span>
          <button class="ghost" onClick=${() => sync.disconnect()}>Disconnect</button>
          <${Q} right text="This browser holds the lock while the tab is visible and releases it when hidden, unless there are unsynced changes. Another browser sees a lock screen meanwhile; a stale lock expires after 10 minutes." />
        </div>`}

    <h3>Data<${Q} text="Exports contain decks and cards, not audio. Audio lives in IndexedDB and in Drive." /></h3>
    <div class="row">
      <button onClick=${() => download('srs-export.json', store.exportAll())}>Export everything .json</button>
      <label><input type="file" accept="application/json" hidden onChange=${importFile} /><span class="link">Import .json</span></label>
      <span class="spacer"></span>
      <button class="ghost danger" onClick=${wipe}>Wipe local data</button>
    </div>

    <h3>Install app</h3>
    ${isInstalled() ? html`<p class="small muted">Running as an installed app.</p>` : html`
      ${canInstall() && html`<button class="primary" onClick=${() => installApp().catch(bus.error)}>Install srs</button>`}
      <p class="small muted">iPhone / iPad: in Safari, open Share → Add to Home Screen → Open as Web App → Add.</p>
      <p class="small muted">Android: open the browser menu → Install app or Add to Home screen.</p>
    `}
    <p class="small muted">After the first online load finishes, saved cards are available offline. Generation and Google Drive sync need an internet connection.</p>

    <h3>Hotkeys</h3>
    <table class="hk small">${HOTKEYS.map(([k, d]) => html`<tr key=${d}><td><kbd>${k}</kbd></td><td class="muted">${d}</td></tr>`)}</table>
  </div>`;
}
