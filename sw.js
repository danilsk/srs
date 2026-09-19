// Bump the version when changing the app shell (HTML, CSS, JS, or icons).
const CACHE = 'srs-shell-v5';
const LOCAL = [
  './', './index.html', './style.css', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png',
  './src/app.js', './src/pwa.js', './src/audio.js', './src/db.js', './src/drive.js',
  './src/llm.js', './src/prefs.js', './src/schedule.js', './src/store.js', './src/ui.js', './src/util.js',
  './src/views/CardModal.js', './src/views/Cards.js', './src/views/Decks.js',
  './src/views/DeckSettings.js', './src/views/Gate.js', './src/views/Learn.js', './src/views/Lock.js', './src/views/Settings.js',
];
const MODULES = [
  'https://esm.sh/preact@10.24.3/es2022/preact.mjs',
  'https://esm.sh/preact@10.24.3/es2022/hooks.mjs',
  'https://esm.sh/htm@3.1.1/X-ZXByZWFjdA/es2022/preact.mjs',
  'https://esm.sh/htm@3.1.1/X-ZXByZWFjdA/es2022/htm.mjs',
];
const shell = new Set([...LOCAL.map((path) => new URL(path, self.registration.scope).href), ...MODULES]);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(
    [...shell].map((url) => new Request(url, { cache: 'reload', mode: 'cors' })),
  )));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('srs-shell-') && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const root = new URL('./', self.registration.scope);
  const isEntry = request.mode === 'navigate' && url.origin === root.origin &&
    (url.pathname === root.pathname || url.pathname === root.pathname + 'index.html');
  // Cache only the app shell. API responses, credentials, and Drive files bypass this worker.
  if (!isEntry && !shell.has(url.href)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    return await cache.match(isEntry ? root.href : request) || fetch(request);
  })());
});
