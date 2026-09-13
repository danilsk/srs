import { spawn } from 'node:child_process';

const url = process.argv[2];
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=9333',
   `--user-data-dir=${process.env.TMPDIR || '/tmp'}/srs-chrome-${Date.now()}`, 'about:blank'],
  { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let ver;
for (let i = 0; i < 60; i++) {
  try { ver = await (await fetch('http://127.0.0.1:9333/json/version')).json(); break; } catch { await sleep(500); }
}
if (!ver) { console.log('chrome did not start'); chrome.kill('SIGKILL'); process.exit(1); }

const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else if (d.method === 'Runtime.consoleAPICalled' || d.method === 'Runtime.exceptionThrown') console.log('console', JSON.stringify(d.params).slice(0, 400)); };
const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });

const { result: { targetId } } = await send('Target.createTarget', { url: 'about:blank' });
const { result: { sessionId } } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Runtime.enable', {}, sessionId);
await send('Page.enable', {}, sessionId);
await send('Page.navigate', { url }, sessionId);

let text = '';
for (let i = 0; i < 120; i++) {
  await sleep(500);
  const r = await send('Runtime.evaluate', { expression: "document.getElementById('log')?.textContent || ''", returnByValue: true }, sessionId);
  text = r.result?.result?.value || '';
  if (/\nDONE|EXC /.test(text)) break;
}
console.log(text);
const shots = (process.argv[3] || '').split(',').filter(Boolean);
const base = url.replace(/dev\/test\.html.*$/, '');
let n = 0;
await send('Page.navigate', { url: base + 'index.html#/' }, sessionId);
await sleep(700);
const href = await send('Runtime.evaluate', { expression: "document.querySelector('.deck a[href*=learn]')?.getAttribute('href') || ''", returnByValue: true }, sessionId);
const deckId = (href.result?.result?.value || '').split('/')[2] || '';
for (const step of shots) {
  const [hash0, keys = '', size = '1100x900'] = step.split('|');
  const [w, h] = size.split('x').map(Number);
  const hash = hash0.replace('{deck}', deckId);
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 }, sessionId);
  await send('Page.navigate', { url: base + 'index.html' + hash }, sessionId);
  await sleep(700);
  for (const k of keys.split('+').filter(Boolean)) {
    if (k.startsWith('click:')) await send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(k.slice(6))})?.dispatchEvent(new MouseEvent('click',{bubbles:true}))` }, sessionId);
    else if (k.startsWith('type:')) await send('Runtime.evaluate', { expression: `(()=>{const el=document.activeElement;el.value=${JSON.stringify(k.slice(5))};el.dispatchEvent(new Event('input',{bubbles:true}))})()` }, sessionId);
    else await send('Runtime.evaluate', { expression: `(document.activeElement && document.activeElement !== document.body ? document.activeElement : window).dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(k === 'space' ? ' ' : k)},bubbles:true}))` }, sessionId);
    await sleep(300);
  }
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 }, sessionId);
  const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  const { writeFileSync } = await import('node:fs');
  const out = `${process.env.SHOT_DIR || '.'}/shot${++n}.png`;
  writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  console.log('screenshot', out, hash, keys);
}
ws.close();
chrome.kill('SIGKILL');
process.exit(0);
