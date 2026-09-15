import { db } from './db.js';
import { store } from './store.js';
import { prefs } from './prefs.js';
import { now, debounce } from './util.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
const LOCK_TTL = 10 * 60e3, HEARTBEAT = 2 * 60e3;

class NeedSignIn extends Error { constructor() { super('sign in to Google to sync'); } }

let meta = null;
let heartbeat = null;
let busy = false, rerun = false;
const listeners = new Set();
const emit = () => { for (const fn of listeners) fn(); };

function setStatus(s, error = null) {
  sync.status = s; sync.error = error; emit();
}

// ---- token -------------------------------------------------------------

function loadGis() {
  return new Promise((res, rej) => {
    if (window.google?.accounts?.oauth2) return res();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = res; s.onerror = () => rej(new Error('cannot load Google sign-in'));
    document.head.appendChild(s);
  });
}

function storedToken() {
  try {
    const t = JSON.parse(localStorage.getItem('srs.gToken') || 'null');
    return t && t.exp - 60e3 > now() ? t.token : null;
  } catch { return null; }
}

async function getToken(interactive) {
  const t = storedToken();
  if (t) return t;
  if (!interactive) throw new NeedSignIn();
  await loadGis();
  return new Promise((res, rej) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: prefs.get('gClientId'), scope: SCOPE,
      callback: (r) => {
        if (r.error) return rej(new Error(r.error_description || r.error));
        localStorage.setItem('srs.gToken', JSON.stringify({ token: r.access_token, exp: now() + r.expires_in * 1000 }));
        res(r.access_token);
      },
      error_callback: (e) => rej(new Error(e.message || e.type || 'sign-in failed')),
    });
    client.requestAccessToken({ prompt: '' });
  });
}

async function gfetch(url, opts = {}) {
  const token = await getToken(false);
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } });
  if (r.status === 401) { localStorage.removeItem('srs.gToken'); throw new NeedSignIn(); }
  if (!r.ok) throw new Error(`Drive ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r;
}

// ---- files -------------------------------------------------------------

const q = (s) => encodeURIComponent(s);

async function listFiles(parent) {
  const r = await gfetch(`${API}/files?q=${q(`'${parent}' in parents and trashed=false`)}&fields=files(id,name,modifiedTime,mimeType)&pageSize=1000`);
  return (await r.json()).files || [];
}

async function findFolder(name, parent) {
  const cond = `name='${name}' and mimeType='${FOLDER}' and trashed=false` + (parent ? ` and '${parent}' in parents` : '');
  const r = await gfetch(`${API}/files?q=${q(cond)}&fields=files(id)`);
  return (await r.json()).files?.[0]?.id || null;
}

async function createFolder(name, parent) {
  const r = await gfetch(`${API}/files?fields=id`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER, parents: parent ? [parent] : undefined }),
  });
  return (await r.json()).id;
}

function multipart(metadata, blob) {
  const boundary = 'srs' + Math.random().toString(36).slice(2);
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    `--${boundary}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`, blob, `\r\n--${boundary}--`,
  ]);
  return { headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body };
}

async function upload(name, blob, existingId, parent, keepalive = false) {
  if (existingId) {
    try {
      const r = await gfetch(`${UPLOAD}/files/${existingId}?uploadType=media&fields=id,modifiedTime`, {
        method: 'PATCH', headers: { 'Content-Type': blob.type }, body: blob, keepalive,
      });
      return r.json();
    } catch (e) { if (!/404/.test(e.message)) throw e; }
  }
  const r = await gfetch(`${UPLOAD}/files?uploadType=multipart&fields=id,modifiedTime`, {
    method: 'POST', ...multipart({ name, parents: [parent] }, blob), keepalive,
  });
  return r.json();
}

const jsonBlob = (obj) => new Blob([JSON.stringify(obj)], { type: 'application/json' });
const downloadJson = async (id) => (await gfetch(`${API}/files/${id}?alt=media`)).json();
const downloadBlob = async (id) => (await gfetch(`${API}/files/${id}?alt=media`)).blob();
async function deleteFile(id) {
  try { await gfetch(`${API}/files/${id}`, { method: 'DELETE' }); }
  catch (e) { if (!/404/.test(e.message)) throw e; }
}

const fname = (deckId) => `deck-${deckId}.json`;
const saveMeta = () => db.meta.set('drive', meta);

async function ensureFolders() {
  if (!meta) meta = await db.meta.get('drive', { folderId: null, audioFolderId: null, lockId: null, files: {} });
  if (meta.folderId) {
    try { await listFiles(meta.folderId); return; }
    catch (e) { if (!/404/.test(e.message)) throw e; meta = { folderId: null, audioFolderId: null, lockId: null, files: {} }; }
  }
  meta.folderId = (await findFolder('srs')) || (await createFolder('srs'));
  meta.audioFolderId = (await findFolder('audio', meta.folderId)) || (await createFolder('audio', meta.folderId));
  meta.lockId = null;
  await saveMeta();
}

// ---- lock --------------------------------------------------------------

const me = () => prefs.clientId();
const uaShort = () => {
  const ua = navigator.userAgent;
  const b = /Firefox\//.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Mac/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return `${b}${os ? ' on ' + os : ''}`;
};

async function readLock(files) {
  const f = (files || await listFiles(meta.folderId)).find((x) => x.name === 'lock.json');
  meta.lockId = f?.id || null;
  if (!f) return null;
  try { return await downloadJson(f.id); } catch { return null; }
}

const heldByOther = (lock) => !!lock && lock.clientId !== me() && !lock.released && now() - lock.ts < LOCK_TTL;

async function writeLock(released = false, keepalive = false) {
  const r = await upload('lock.json', jsonBlob({ clientId: me(), ua: uaShort(), ts: now(), released }), meta.lockId, meta.folderId, keepalive);
  meta.lockId = r.id;
  sync.lockSince = released ? null : (sync.lockSince || now());
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeat = setInterval(async () => {
    if (document.visibilityState !== 'visible' || !holding()) return;
    try {
      const lock = await readLock();
      if (heldByOther(lock)) { sync.lockInfo = lock; stopHeartbeat(); setStatus('locked'); return; }
      await writeLock();
    } catch (e) { handleErr(e); }
  }, HEARTBEAT);
}
function stopHeartbeat() { clearInterval(heartbeat); heartbeat = null; }
const holding = () => ['synced', 'pushing', 'pulling'].includes(sync.status);

function handleErr(e) {
  console.warn('sync', e);
  stopHeartbeat();
  if (e instanceof NeedSignIn) setStatus('signin');
  else if (e instanceof TypeError) setStatus('offline');
  else setStatus('error', e.message);
}

// ---- sync --------------------------------------------------------------

async function pull() {
  const files = await listFiles(meta.folderId);
  const remote = new Map(files.filter((f) => /^deck-.*\.json$/.test(f.name)).map((f) => [f.name, f]));
  for (const deck of [...store.decks]) {
    const name = fname(deck.id);
    if (!remote.has(name) && meta.files[name] && !store.dirty.has(deck.id)) {
      await store.removeDeckLocal(deck.id);
      delete meta.files[name];
    }
  }
  for (const [name, f] of remote) {
    const deckId = name.slice(5, -5);
    if (store.dirty.has(deckId) || store.deleted.has(deckId)) {
      meta.files[name] = { id: f.id, modifiedTime: meta.files[name]?.modifiedTime ?? null };
      continue;
    }
    if (meta.files[name]?.modifiedTime === f.modifiedTime && store.deck(deckId)) continue;
    const data = await downloadJson(f.id);
    if (!data?.deck?.id) continue;
    await store.replaceDeck(data.deck, data.cards || []);
    meta.files[name] = { id: f.id, modifiedTime: f.modifiedTime };
  }
  await saveMeta();
  return files;
}

async function push() {
  if (!holding() && sync.status !== 'connecting') return;
  if (busy) { rerun = true; return; }
  busy = true;
  try {
    setStatus('pushing');
    for (const deckId of [...store.dirty]) {
      const rev = store.rev(deckId);
      const deck = store.deck(deckId);
      if (!deck) { await store.clearDirty(deckId); continue; }
      const cards = store.cardsOf(deckId);
      for (const c of cards) {
        if (!c.audio || c.audio.driveId) continue;
        const blob = await store.getAudio(c.audio.key);
        if (!blob) continue;
        const r = await upload(c.audio.key, blob, null, meta.audioFolderId);
        c.audio.driveId = r.id;
        await store.saveCard(c, { silent: true });
      }
      const name = fname(deckId);
      const r = await upload(name, jsonBlob({ deck, cards }), meta.files[name]?.id, meta.folderId);
      meta.files[name] = { id: r.id, modifiedTime: r.modifiedTime };
      // A save during the upload is not in the snapshot we just sent: keep the deck dirty.
      if (store.rev(deckId) === rev) await store.clearDirty(deckId);
    }
    for (const id of [...store.deleted]) {
      const f = meta.files[fname(id)];
      if (f) await deleteFile(f.id);
      delete meta.files[fname(id)];
      await store.clearDeleted(id);
    }
    await saveMeta();
    sync.lastSync = now();
    setStatus('synced');
  } finally {
    busy = false;
    if (rerun) { rerun = false; pushSoon(); }
  }
}

const pushSoon = debounce(() => push().catch(handleErr), 5000);

async function onHide() {
  if (!sync.enabled || !holding()) return;
  stopHeartbeat();
  if (store.dirty.size) { pushSoon.cancel(); await push().catch(handleErr); }
  if (!holding() || store.dirty.size) return;
  await writeLock(true, true).catch(() => {});
  setStatus('idle');
}

async function fullSync() {
  if (!sync.enabled) return;
  if (busy) { rerun = true; return; }
  setStatus('connecting');
  try {
    await ensureFolders();
    const lock = await readLock();
    if (heldByOther(lock)) { sync.lockInfo = lock; setStatus('locked'); return; }
    await writeLock();
    setStatus('pulling');
    await pull();
    startHeartbeat();
    setStatus('synced');
    await push();
  } catch (e) { handleErr(e); }
}

export const sync = {
  status: 'off', error: null, lastSync: null, lockInfo: null, lockSince: null,
  get enabled() { return !!prefs.get('gClientId') && prefs.get('driveOn') === '1'; },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

  async start() {
    store.onDirty = () => { if (holding()) pushSoon(); };
    store.onAudioDeleted = (ids) => { if (holding()) for (const id of ids) deleteFile(id).catch(() => {}); };
    document.addEventListener('visibilitychange', () => {
      if (!sync.enabled) return;
      if (document.visibilityState === 'visible') {
        if (!['off', 'signin'].includes(sync.status)) fullSync();
      } else onHide();
    });
    addEventListener('pagehide', () => { onHide(); });
    if (!this.enabled) return;
    if (!storedToken()) { setStatus('signin'); return; }
    await fullSync();
  },

  async connect() {
    if (!prefs.get('gClientId')) throw new Error('Google client ID is not set');
    prefs.set('driveOn', '1');
    await getToken(true);
    await fullSync();
  },
  async disconnect() {
    stopHeartbeat();
    if (holding()) await writeLock(true).catch(() => {});
    prefs.set('driveOn', '');
    localStorage.removeItem('srs.gToken');
    setStatus('off');
  },
  syncNow: () => fullSync(),
  async takeOver() {
    setStatus('connecting');
    try { await writeLock(); await fullSync(); } catch (e) { handleErr(e); }
  },
  async releaseLock() {
    stopHeartbeat();
    if (store.dirty.size) await push().catch(handleErr);
    await writeLock(true).catch(handleErr);
    setStatus('idle');
  },

  async ensureAudio(card) {
    if (!card.audio) return null;
    let blob = await store.getAudio(card.audio.key);
    if (blob) return blob;
    if (!card.audio.driveId || !this.enabled) return null;
    blob = await downloadBlob(card.audio.driveId);
    await store.saveAudio(card.audio.key, blob);
    return blob;
  },
  deleteRemoteAudio(driveId) { if (driveId && holding()) deleteFile(driveId).catch(() => {}); },

  async info() {
    if (!meta?.folderId) return null;
    const audio = await listFiles(meta.audioFolderId);
    return { decks: Object.keys(meta.files).length, audio: audio.length };
  },
};
