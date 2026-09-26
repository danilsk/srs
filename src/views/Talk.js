import { html, useState, useEffect, useRef, isEditing } from '../ui.js';
import { Mic, Segmenter, toWav, concat, rmsOf, hasSpeech } from '../mic.js';
import { hear, compose, generateAudio } from '../llm.js';
import { uid, bus } from '../util.js';

export const LANGS = [
  { code: 'ka', name: 'Georgian', short: 'KA' },
  { code: 'uk', name: 'Ukrainian', short: 'UK' },
  { code: 'es', name: 'Spanish', short: 'ES' },
];
const LANG = Object.fromEntries(LANGS.map((l) => [l.code, l]));
const MINE = { en: 'English', ru: 'Russian' };
const CONTEXT = 6, KEEP = 60, TAP_MS = 350, CLIPS = 20;

const load = (k, d) => { try { return JSON.parse(localStorage.getItem('srs.talk.' + k)) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem('srs.talk.' + k, JSON.stringify(v)); } catch {} };
const cut = (s) => (s.length > 200 ? s.slice(0, 200) + '…' : s);
const voice = (code) => ({ tts: { voice: 'Iapetus', instructions: `Speak as a native ${LANG[code].name} speaker, in a natural, friendly conversational tone, clearly and not too fast.` } });

let silent;
const silentUrl = () => (silent ||= URL.createObjectURL(new Blob([toWav(new Float32Array(1600))], { type: 'audio/wav' })));

function micMessage(e) {
  if (!navigator.mediaDevices) return 'The microphone needs HTTPS';
  if (e?.name === 'NotAllowedError') return 'Microphone access is blocked. Allow it in the browser settings.';
  if (e?.name === 'NotFoundError') return 'No microphone found';
  return e?.message || String(e);
}

export function Talk() {
  const [lang, setLang] = useState(() => load('lang', 'all'));
  const [mine, setMine] = useState(() => load('mine', 'en'));
  const [sayLang, setSayLang] = useState(() => load('say', 'es'));
  const [entries, setEntries] = useState(() => load('log', []).filter((e) => e.status === 'done'));
  const [draft, setDraft] = useState('');
  const [always, setAlways] = useState(false);
  const [rec, setRec] = useState(null);
  const [speaking, setSpeaking] = useState(null);
  const log = useRef(entries), cur = useRef({}), fns = useRef({});
  const mic = useRef(null), seg = useRef(null), ptt = useRef(null), pre = useRef([]), idle = useRef(0);
  const wavs = useRef(new Map()), clips = useRef(new Map());
  const player = useRef(null), unlocked = useRef(false), spk = useRef(null), ended = useRef(null), muteUntil = useRef(0);
  const feed = useRef(), foot = useRef(), level = useRef(0), stick = useRef(true);
  cur.current = { lang, mine, always };

  const update = (fn) => {
    log.current = fn(log.current).slice(-200);
    setEntries(log.current);
    save('log', log.current.filter((e) => e.status === 'done').slice(-KEEP));
  };
  const patch = (id, p) => update((l) => l.map((e) => (e.id === id ? { ...e, ...p } : e)));
  const drop = (id) => { wavs.current.delete(id); update((l) => l.filter((e) => e.id !== id)); };
  const find = (id) => log.current.find((e) => e.id === id);
  const context = (id) => {
    const i = log.current.findIndex((e) => e.id === id);
    return log.current.slice(0, i < 0 ? undefined : i)
      .map((e) => (e.who === 'them' ? e.src && `them: ${cut(e.src)}` : e.text && `me: ${cut(e.text)}`))
      .filter(Boolean).slice(-CONTEXT);
  };
  const pickSay = (c) => { setSayLang(c); save('say', c); };
  const pickLang = (c) => { setLang(c); save('lang', c); if (c !== 'all') pickSay(c); };
  const toggleMine = () => { const m = mine === 'en' ? 'ru' : 'en'; setMine(m); save('mine', m); };
  const clear = () => { if (confirm('Clear the conversation?')) { wavs.current.clear(); update(() => []); } };

  const listen = async (id) => {
    const wav = wavs.current.get(id);
    if (!find(id) || !wav) return drop(id);
    const { lang: pick, mine: my, always: auto } = cur.current;
    patch(id, { status: 'busy', error: null });
    try {
      const r = await hear(wav, { langs: pick === 'all' ? LANGS : [LANG[pick]], mine: MINE[my] });
      if (!r.src || !r.translation) {
        if (!auto) bus.toast('Nothing heard');
        return drop(id);
      }
      wavs.current.delete(id);
      patch(id, { ...r, status: 'done' });
      if (r.lang !== 'other' && cur.current.lang === 'all') pickSay(r.lang);
    } catch (err) { patch(id, { status: 'error', error: err.message }); }
  };
  const heard = (samples) => {
    // Gemini transcribes pure silence as made-up speech, so silent clips never leave the device.
    if (!hasSpeech(samples)) { if (!cur.current.always) bus.toast('Nothing heard'); return; }
    stick.current = true;
    const id = uid();
    wavs.current.set(id, toWav(samples));
    update((l) => [...l, { id, who: 'them', status: 'busy' }]);
    listen(id);
  };

  const write = async (id) => {
    const e = find(id);
    if (!e) return;
    patch(id, { status: 'busy', error: null });
    try {
      const r = await compose(e.ask, { lang: LANG[e.lang], mine: MINE[cur.current.mine], context: context(id) });
      patch(id, { ...r, status: 'done' });
      clip(r.text, e.lang).catch(() => {});
    } catch (err) { patch(id, { status: 'error', error: err.message }); }
  };
  const say = (ask) => {
    const id = uid();
    update((l) => [...l, { id, who: 'me', ask, lang: sayLang, status: 'busy' }]);
    setDraft('');
    stick.current = true;
    write(id);
  };
  const retry = (e) => (e.who === 'me' ? write(e.id) : listen(e.id));
  const reply = (r, code) => {
    const last = log.current[log.current.length - 1];
    if (!(last?.who === 'me' && last.text === r.text)) update((l) => [...l, { id: uid(), who: 'me', text: r.text, meaning: r.meaning, lang: code, status: 'done' }]);
    stick.current = true;
    speak(r.text, code);
  };

  const clip = (text, code) => {
    const k = code + ':' + text;
    if (!clips.current.has(k)) {
      const p = generateAudio(voice(code), text);
      clips.current.set(k, p);
      if (clips.current.size > CLIPS) clips.current.delete(clips.current.keys().next().value);
      p.catch(() => clips.current.delete(k));
    }
    return clips.current.get(k);
  };
  const audio = () => (player.current ||= new Audio());
  // iOS lets an audio element play later without a tap only if a tap started it once.
  const unlock = () => {
    if (unlocked.current) return;
    unlocked.current = true;
    const a = audio();
    a.src = silentUrl();
    a.play().catch(() => {});
  };
  const stopAudio = () => {
    player.current?.pause();
    ended.current?.();
    spk.current = null;
    setSpeaking(null);
  };
  const speak = async (text, code) => {
    const k = code + ':' + text, again = spk.current === k;
    stopAudio();
    if (again) return;
    unlock();
    spk.current = k;
    setSpeaking({ k });
    try {
      const blob = await clip(text, code);
      if (spk.current !== k) return;
      // A live microphone makes iOS play quietly through the earpiece.
      if (!cur.current.always && !ptt.current) releaseMic();
      const a = audio(), url = URL.createObjectURL(blob);
      muteUntil.current = Infinity;
      const done = () => {
        a.onended = a.onerror = ended.current = null;
        URL.revokeObjectURL(url);
        muteUntil.current = performance.now() + 400;
        if (spk.current === k) { spk.current = null; setSpeaking(null); }
      };
      a.onended = a.onerror = ended.current = done;
      a.src = url;
      setSpeaking({ k, playing: true });
      await a.play();
    } catch (e) {
      if (spk.current === k) stopAudio();
      if (e.name !== 'AbortError') bus.error(e);
    }
  };

  const onChunk = (c) => {
    const rms = rmsOf(c), lv = Math.min(1, rms * 15);
    if (Math.abs(lv - level.current) > 0.03) { level.current = lv; foot.current?.style.setProperty('--lvl', lv.toFixed(2)); }
    if (ptt.current) { ptt.current.chunks.push(c); return; }
    if (performance.now() < muteUntil.current) { seg.current?.reset(); pre.current = []; return; }
    pre.current.push(c);
    if (pre.current.length > 8) pre.current.shift();
    if (cur.current.always) seg.current?.push(c, rms);
  };
  const openMic = async () => {
    clearTimeout(idle.current);
    mic.current ||= new Mic((c) => fns.current.onChunk(c));
    seg.current ||= new Segmenter((s) => fns.current.heard(s));
    await mic.current.start();
  };
  const releaseMic = () => {
    clearTimeout(idle.current);
    mic.current?.stop();
    pre.current = [];
    seg.current?.reset();
    foot.current?.style.setProperty('--lvl', '0');
  };
  const idleRelease = () => {
    clearTimeout(idle.current);
    idle.current = setTimeout(() => { if (!cur.current.always && !ptt.current) releaseMic(); }, 30e3);
  };

  const startPtt = () => {
    unlock();
    if (spk.current) stopAudio();
    muteUntil.current = 0;
    ptt.current = { chunks: [...pre.current], t: performance.now(), latched: false };
    seg.current?.reset();
    setRec('hold');
    openMic().catch((e) => { ptt.current = null; setRec(null); bus.error(micMessage(e)); });
  };
  const endPtt = () => {
    const p = ptt.current;
    if (!p) return;
    ptt.current = null;
    setRec(null);
    if (!cur.current.always) idleRelease();
    const s = concat(p.chunks);
    heard(s);
  };
  const onDown = (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    if (ptt.current) return endPtt();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    startPtt();
  };
  const onUp = () => {
    const p = ptt.current;
    if (!p || p.latched) return;
    if (performance.now() - p.t < TAP_MS) { p.latched = true; setRec('latched'); } else endPtt();
  };
  const onCancel = () => { if (ptt.current && !ptt.current.latched) endPtt(); };
  const toggleAlways = async () => {
    unlock();
    if (always) { setAlways(false); cur.current.always = false; seg.current?.flush(); idleRelease(); return; }
    try { await openMic(); setAlways(true); } catch (e) { bus.error(micMessage(e)); }
  };
  fns.current = { onChunk, heard, startPtt, endPtt };

  useEffect(() => {
    const vis = () => {
      if (document.visibilityState === 'visible') {
        if (cur.current.always) openMic().catch(() => { setAlways(false); bus.toast('Listening paused'); });
      } else if (!cur.current.always) { fns.current.endPtt(); releaseMic(); }
    };
    const down = (e) => {
      if (e.key !== ' ' || isEditing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      if (!e.repeat && !ptt.current) fns.current.startPtt();
    };
    const up = (e) => { if (e.key === ' ' && !isEditing(e)) { e.preventDefault(); fns.current.endPtt(); } };
    document.addEventListener('visibilitychange', vis);
    addEventListener('keydown', down);
    addEventListener('keyup', up);
    return () => {
      document.removeEventListener('visibilitychange', vis);
      removeEventListener('keydown', down);
      removeEventListener('keyup', up);
      clearTimeout(idle.current);
      mic.current?.stop();
      player.current?.pause();
    };
  }, []);

  useEffect(() => {
    if (!always || !navigator.wakeLock) return;
    let lock = null, dead = false;
    const get = () => navigator.wakeLock.request('screen').then((l) => { if (dead) l.release(); else lock = l; }).catch(() => {});
    const vis = () => { if (document.visibilityState === 'visible') get(); };
    get();
    document.addEventListener('visibilitychange', vis);
    return () => { dead = true; lock?.release().catch(() => {}); document.removeEventListener('visibilitychange', vis); };
  }, [always]);

  const last = entries[entries.length - 1];
  useEffect(() => { const f = feed.current; if (f && stick.current) f.scrollTop = f.scrollHeight; }, [entries.length, last?.status]);
  const onScroll = () => { const f = feed.current; stick.current = f.scrollHeight - f.scrollTop - f.clientHeight < 80; };

  const busy = (e) => e.status === 'busy' && (e.who === 'me' ? 'writing…' : 'translating…');
  const status = (e) => html`
    ${busy(e) && html`<div class="busy">${busy(e)}</div>`}
    ${e.status === 'error' && html`<div class="err">${e.error} · <span class="link" onClick=${() => retry(e)}>retry</span> · <span class="link" onClick=${() => drop(e.id)}>dismiss</span></div>`}`;
  const latest = entries.findLast((e) => e.who === 'them' && e.status === 'done')?.id;
  const them = (e) => html`<div class=${'tm them' + (e.lang === 'other' ? ' other' : '')} key=${e.id}>
    ${e.src && html`<div class="src">${LANG[e.lang] && html`<span class="tag">${LANG[e.lang].short}</span>`}<span lang=${e.lang}>${e.src}</span></div>`}
    ${e.translation && html`<div class="big">${e.translation}</div>`}
    ${status(e)}
    ${e.id === latest && e.replies?.length > 0 && html`<div class="replies">${e.replies.map((r, i) => html`<button key=${i} class=${speaking?.k === e.lang + ':' + r.text ? 'on' : ''} onClick=${() => reply(r, e.lang)}>
      <span lang=${e.lang}>${r.text}</span><small>${r.meaning}</small></button>`)}</div>`}
  </div>`;
  const me = (e) => {
    const st = e.text && speaking?.k === e.lang + ':' + e.text ? speaking : null;
    return html`<div class="tm me" key=${e.id}>
      ${!e.text && html`<div class="src">${e.ask}</div>`}
      ${e.text && html`<div class="big" lang=${e.lang} title=${e.ask || ''}>${e.text}</div>`}
      ${e.meaning && html`<div class="src"><span class="tag">${LANG[e.lang]?.short}</span>${e.meaning}</div>`}
      ${status(e)}
      ${e.text && html`<div><button class=${'speak' + (st ? ' on' : '')} onClick=${() => speak(e.text, e.lang)}>${st ? (st.playing ? '■ Stop' : 'Loading…') : '▶ Read aloud'}</button></div>`}
    </div>`;
  };

  return html`<div class="tpage">
    <header class="lt">
      <a class="back" href="#/" title="decks">‹ <b>Talk</b></a>
      <div class="seg" title="language they speak">${[['all', 'All'], ...LANGS.map((l) => [l.code, l.short])].map(([c, t]) => html`
        <button key=${c} class=${lang === c ? 'on' : ''} title=${c === 'all' ? 'Georgian, Ukrainian or Spanish, detected automatically' : LANG[c].name} onClick=${() => pickLang(c)}>${t}</button>`)}</div>
      <span class="spacer"></span>
      <button class="ghost sm" title=${`translate into ${MINE[mine]}`} onClick=${toggleMine}>→ ${mine.toUpperCase()}</button>
      <button class="ghost sm" disabled=${!entries.length} onClick=${clear}>Clear</button>
    </header>
    <div class="tfeed" ref=${feed} onScroll=${onScroll}><div class="tlog">
      ${!entries.length && html`<div class="tempty">
        <p>Hold the button below while they speak, or switch on <b>Always</b>.</p>
        <p>To reply, type in English or Russian.</p>
      </div>`}
      ${entries.map((e) => (e.who === 'me' ? me(e) : them(e)))}
    </div></div>
    <footer class="tfoot" ref=${foot}>
      <form class="tsay" onSubmit=${(e) => { e.preventDefault(); if (draft.trim()) say(draft.trim()); }}>
        <select title="say in" value=${sayLang} onChange=${(e) => pickSay(e.target.value)}>${LANGS.map((l) => html`<option key=${l.code} value=${l.code}>${l.short}</option>`)}</select>
        <input value=${draft} enterkeyhint="send" placeholder=${`Say in ${LANG[sayLang].name}…`} onInput=${(e) => setDraft(e.target.value)} />
        <button class="primary" type="submit" disabled=${!draft.trim()}>Write</button>
      </form>
      <div class="tmic">
        <button class=${'always' + (always ? ' on' : '')} title="listen continuously" onClick=${toggleAlways}><span class="dot"></span>Always</button>
        <button class=${'ptt' + (rec ? ' rec' : '')} onPointerDown=${onDown} onPointerUp=${onUp} onPointerCancel=${onCancel} onContextMenu=${(e) => e.preventDefault()}>
          ${rec === 'latched' ? 'Tap to send' : rec ? 'Release to send' : 'Hold to talk'}<kbd>space</kbd>
        </button>
      </div>
    </footer>
  </div>`;
}
