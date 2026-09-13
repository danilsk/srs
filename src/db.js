const NAME = 'srs', VERSION = 1;
let opening;

function open() {
  if (opening) return opening;
  opening = new Promise((res, rej) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('decks', { keyPath: 'id' });
      d.createObjectStore('cards', { keyPath: 'id' }).createIndex('deckId', 'deckId');
      d.createObjectStore('audio');
      d.createObjectStore('meta');
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  return opening;
}

async function tx(store, mode, fn) {
  const d = await open();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    const r = fn(s);
    if (r && 'onsuccess' in r) r.onsuccess = () => { out = r.result; };
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

export const db = {
  get: (store, key) => tx(store, 'readonly', (s) => s.get(key)),
  all: (store) => tx(store, 'readonly', (s) => s.getAll()),
  allBy: (store, index, value) => tx(store, 'readonly', (s) => s.index(index).getAll(value)),
  put: (store, value, key) => tx(store, 'readwrite', (s) => (key === undefined ? s.put(value) : s.put(value, key))),
  del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
  clear: (store) => tx(store, 'readwrite', (s) => s.clear()),
  putMany: (store, values) => tx(store, 'readwrite', (s) => { for (const v of values) s.put(v); }),
  delMany: (store, keys) => tx(store, 'readwrite', (s) => { for (const k of keys) s.delete(k); }),
  meta: {
    get: async (key, dflt = null) => (await db.get('meta', key)) ?? dflt,
    set: (key, value) => db.put('meta', value, key),
  },
  async wipe() {
    for (const s of ['decks', 'cards', 'audio', 'meta']) await db.clear(s);
  },
};
