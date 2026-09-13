// Run against a local server; Chrome uses a disposable profile, leaving your cards untouched.
// Example: node dev/pwa-test.mjs http://127.0.0.1:8124/srs/
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2] || 'http://127.0.0.1:8123/';
const profile = await mkdtemp(join(tmpdir(), 'srs-pwa-'));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0',
  `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let i = 0; i < 100; i++) {
    const value = await fn();
    if (value) return value;
    await sleep(300);
  }
  throw new Error('Timed out: ' + label);
}
let ws;
try {
  const port = await until(async () => {
    try { return (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; }
    catch { return null; }
  }, 'Chrome startup');
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    pending.get(message.id)?.(message);
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error(method + ' timed out')); }, 30000);
    pending.set(key, (message) => {
      clearTimeout(timer); pending.delete(key);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    });
    ws.send(JSON.stringify({ id: key, method, params, sessionId }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = (method, params) => send(method, params, sessionId);
  const evaluate = async (expression) => {
    const result = await page('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };
  await page('Page.enable');
  await page('Network.enable');
  await page('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page('Page.navigate', { url });
  await until(() => evaluate("!!document.querySelector('header.top')"), 'app render');
  await until(() => evaluate('!!navigator.serviceWorker.controller'), 'offline shell install');
  const manifest = await page('Page.getAppManifest');
  assert.deepEqual(manifest.errors, []);
  const data = JSON.parse(manifest.data);
  assert.equal(data.display, 'standalone');
  assert.equal(new URL(data.start_url, manifest.url).href, url);
  for (const icon of data.icons) {
    assert.equal(await evaluate(`(async () => {
      const image = new Image(); image.src = ${JSON.stringify(new URL(icon.src, manifest.url).href)};
      await image.decode(); return image.naturalWidth + 'x' + image.naturalHeight;
    })()`), icon.sizes);
  }
  console.log('PASS manifest, icon dimensions, subpath scope, active service worker');
  const installability = await page('Page.getInstallabilityErrors');
  assert.deepEqual(installability.installabilityErrors, []);
  console.log('PASS Chrome installability checks');
  await evaluate(`(async () => {
    const { store, newDeck, newCard } = await import('./src/store.js');
    const deck = newDeck('Offline test', 'English', 'Russian');
    await store.saveDeck(deck);
    const card = newCard(deck.id, 'hello'); card.senses[0].translation = 'привет';
    await store.saveCard(card); location.hash = '#/settings';
  })()`);
  await until(() => evaluate("document.body.textContent.includes('Install app')"), 'install instructions');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  const screenshot = await page('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile(join(tmpdir(), 'srs-pwa-mobile.png'), Buffer.from(screenshot.data, 'base64'));
  await page('Network.setCacheDisabled', { cacheDisabled: true });
  await page('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await page('Page.navigate', { url: url + '?offline-test=1' });
  await until(() => evaluate("!!document.querySelector('header.top') && document.body.textContent.includes('Offline test')"), 'cold offline load');
  await evaluate("document.querySelector('.deck a[href*=learn]').click()");
  await until(() => evaluate("!!document.querySelector('.card .word')"), 'offline study');
  assert.equal(await evaluate("document.querySelector('.card .word').textContent"), 'hello');
  await evaluate("document.querySelector('.show-bar button').click()");
  await until(() => evaluate("document.body.textContent.includes('привет')"), 'offline answer');
  await until(() => evaluate("!!document.querySelector('.grades button')"), 'offline grading controls');
  await evaluate("document.querySelectorAll('.grades button')[2].click()");
  await until(() => evaluate("import('./src/store.js').then(({ store }) => store.cards[0].reviews === 1)"), 'offline review saved');
  await page('Page.navigate', { url: url + 'index.html' });
  await until(() => evaluate("!!document.querySelector('header.top')"), 'offline index.html');
  assert.equal(await evaluate("import('./src/store.js').then(({ store }) => store.cards[0].reviews)"), 1);
  const cached = await evaluate("caches.keys().then(async keys => (await Promise.all(keys.map(async key => (await (await caches.open(key)).keys()).map(r => r.url)))).flat())");
  assert.equal(cached.some((entry) => /openrouter|googleapis|accounts\.google/.test(entry)), false);
  console.log('PASS offline cold launch with HTTP cache disabled, study, saved review, index.html launch, API cache exclusion');
  console.log('Screenshot: ' + join(tmpdir(), 'srs-pwa-mobile.png'));
} finally {
  ws?.close();
  const exited = new Promise((resolve) => chrome.once('exit', resolve));
  chrome.kill('SIGKILL');
  await exited;
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
