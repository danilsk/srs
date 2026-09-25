import { prefs } from './prefs.js';
import { pcmToWav } from './util.js';

const API = 'https://openrouter.ai/api/v1/chat/completions';

async function call(body, signal) {
  const key = prefs.get('orKey');
  if (!key) throw new Error('OpenRouter key is not set (settings)');
  const r = await fetch(API, {
    method: 'POST', signal,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'srs' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error(data.error?.message || `OpenRouter ${r.status}`);
  return data;
}

function schemaFor(deck) {
  const str = (hint) => ({ type: 'string', description: hint });
  const senseProps = { translation: str(`concise translation of this sense in ${deck.nativeLang}; usually one equivalent, optionally two complementary equivalents separated by ", "; no redundant paraphrases`) };
  for (const f of deck.senseFields) senseProps[f.key] = str(f.hint);
  const props = {
    front_suggestion: { type: ['string', 'null'], description: 'corrected canonical form of the entry, or null if already correct' },
    senses: {
      type: 'array', minItems: deck.sensesMin, maxItems: deck.sensesMax,
      items: { type: 'object', additionalProperties: false, required: Object.keys(senseProps), properties: senseProps },
    },
  };
  for (const f of deck.cardFields) props[f.key] = str(f.hint);
  return { type: 'object', additionalProperties: false, required: Object.keys(props), properties: props };
}

function systemPrompt(deck, front) {
  const tpl = deck.prompt
    .replaceAll('{{target}}', deck.targetLang).replaceAll('{{native}}', deck.nativeLang).replaceAll('{{front}}', front);
  const lines = [
    'Respond with a single JSON object and nothing else:',
    '- front_suggestion: corrected canonical form of the entry, or null if it is already correct. No surrounding quotes, labels, or added sentence-final punctuation. Preserve punctuation that belongs to an established expression.',
    `- senses: array of ${deck.sensesMin}–${deck.sensesMax} objects, most common sense first. Each object: translation (concise, in ${deck.nativeLang}; usually one equivalent, optionally two complementary equivalents separated by ", "; no redundant paraphrases)` +
      deck.senseFields.map((f) => `; ${f.key}: ${f.hint}`).join('') + '.',
    ...deck.cardFields.map((f) => `- ${f.key}: ${f.hint}`),
    `Example count per sense: ${deck.examplesMin === deck.examplesMax ? `exactly ${deck.examplesMin}` : `${deck.examplesMin}–${deck.examplesMax}, using the minimum unless another example teaches a different usage of this same sense`}. One example means ONE ${deck.targetLang} sentence paired with ONE ${deck.nativeLang} translation; the translation is not an additional example. This count takes precedence over any vague or conflicting example-count hints above.`,
    'For the examples field, use <i>sentence</i><br>translation for each pair, and <br><br> only between pairs. No headings, numbering, bullets, extra sentences, or leading/trailing separators. Use natural sentence punctuation within examples.',
    'For synonyms, give up to 3 genuine synonyms matching this sense and part of speech, separated by " · " only between words or phrases. Return an empty string if none fits; never invent synonyms to reach a minimum.',
    'Return an empty string for optional fields with nothing useful to say. Never use punctuation-only placeholders such as ".", ",", "?", "—", or "...", or text such as "N/A". Translations and synonyms have no added sentence-final punctuation. All descriptive fields are strings, never arrays or objects; no Markdown or code fences.',
    `If the target language (${deck.targetLang}) is English: use bare nouns without a/an/the and base-form verbs without an added "to", except where these words belong to an established phrase. Preserve phrasal verbs. Do not turn an entry into a question or a full sentence.`,
    'Choose distinct, common meanings useful to a learner; the maximum sense count is a ceiling, not a quota. Do not pad the card with rare meanings or split equivalent translations into separate senses.',
    `Every field holds only what its description says. ${deck.nativeLang} text goes only into translation and into fields whose description asks for it; never append a translation to another field.`,
    'Before responding, check each sense: the example count matches the rule above, every example and synonym belongs to that sense, and no field contains filler or stray separators.',
  ];
  return tpl + '\n\n' + lines.join('\n');
}

function normalize(deck, front, r) {
  if (!r || !Array.isArray(r.senses)) throw new Error('model returned no senses');
  const senses = r.senses.map((s) => ({
    translation: String(s.translation ?? '').trim(),
    fields: Object.fromEntries(deck.senseFields.map((f) => [f.key, String(s[f.key] ?? '').trim()])),
  })).filter((s) => s.translation);
  if (!senses.length) throw new Error('model returned no senses');
  const fields = Object.fromEntries(deck.cardFields.map((f) => [f.key, String(r[f.key] ?? '').trim()]));
  const sug = r.front_suggestion && String(r.front_suggestion).trim();
  return { front_suggestion: sug && sug !== front ? sug : null, senses, fields };
}

function parseContent(content) {
  const text = typeof content === 'string' ? content : (content?.map?.((p) => p.text || '').join('') || '');
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Error('model returned no JSON');
  return JSON.parse(m[0]);
}

export async function generateCard(deck, front, signal) {
  front = front.trim();
  const messages = [{ role: 'system', content: systemPrompt(deck, front) }, { role: 'user', content: front }];
  const base = { model: prefs.get('textModel'), messages };
  let data;
  try {
    data = await call({ ...base, response_format: { type: 'json_schema', json_schema: { name: 'card', strict: true, schema: schemaFor(deck) } } }, signal);
  } catch (e) {
    if (signal?.aborted) throw e;
    data = await call({ ...base, response_format: { type: 'json_object' } }, signal);
  }
  return normalize(deck, front, parseContent(data.choices?.[0]?.message?.content));
}

const READ_ONLY = 'Read only the text below, exactly once, without a preamble, translation, or commentary.';

// A bare directive line makes Gemini return empty audio; the read-only sentence is what keeps it speaking.
function ttsGuidance(deck) {
  const instr = deck.tts?.instructions?.trim() || '';
  return /read only/i.test(instr) ? instr : [instr, READ_ONLY].filter(Boolean).join('\n');
}

async function tts(deck, text, signal) {
  const key = prefs.get('orKey');
  if (!key) throw new Error('OpenRouter key is not set (settings)');
  const r = await fetch('https://openrouter.ai/api/v1/audio/speech', {
    method: 'POST', signal,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'srs' },
    // Without these headers Gemini 3.8 reads the style notes aloud.
    body: JSON.stringify({
      model: prefs.get('ttsModel'), voice: deck.tts?.voice || 'Iapetus',
      input: `# AUDIO PROFILE: Language tutor\n\n### DIRECTOR'S NOTES\nStyle: ${ttsGuidance(deck)}\n\n#### TRANSCRIPT\n${text}`,
      response_format: 'pcm',
    }),
  });
  const type = r.headers.get('content-type') || '';
  if (!r.ok || type.includes('json')) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.error?.message || `TTS ${r.status}`);
  }
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (!bytes.length) throw new Error('model returned no audio');
  if (bytes[0] === 0x52 && bytes[1] === 0x49) return new Blob([bytes], { type: 'audio/wav' });
  if (type.includes('mpeg') || type.includes('mp3')) return new Blob([bytes], { type: 'audio/mpeg' });
  return pcmToWav(bytes, 24000);
}

export async function generateAudio(deck, text, signal) {
  try { return await tts(deck, text, signal); }
  catch (e) { if (signal?.aborted) throw e; return tts(deck, text, signal); }
}

export async function testKey() {
  const t = performance.now();
  const data = await call({ model: prefs.get('textModel'), messages: [{ role: 'user', content: 'Reply with the single word: ok' }], max_tokens: 5 });
  return { ms: Math.round(performance.now() - t), text: data.choices?.[0]?.message?.content?.trim() };
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const chatStt = new Set();

export async function transcribe(wav, langs, signal) {
  const key = prefs.get('orKey');
  if (!key) throw new Error('OpenRouter key is not set (settings)');
  const model = prefs.get('sttModel'), data = toBase64(wav);
  if (!chatStt.has(model)) {
    const r = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
      method: 'POST', signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'srs' },
      body: JSON.stringify({ model, input_audio: { data, format: 'wav' }, language: langs.length === 1 ? langs[0].code : undefined }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok && !d.error) return String(d.text || '').trim();
    const msg = d.error?.message || `transcription ${r.status}`;
    if (!/does not exist|not a valid model/i.test(msg)) throw Object.assign(new Error(msg), { status: r.status });
    chatStt.add(model);
  }
  const names = langs.map((l) => l.name).join(', ');
  const d = await call({
    model, reasoning: { effort: 'minimal' }, response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: `Transcribe the speech. The speaker speaks ${langs.length > 1 ? `one of: ${names} (possibly mixing them)` : names}. Write it verbatim in the original language and script; never translate. Return JSON {"text": "..."}; use an empty string if there is no speech.` },
      { role: 'user', content: [{ type: 'input_audio', input_audio: { data, format: 'wav' } }] },
    ],
  }, signal);
  return String(parseContent(d.choices?.[0]?.message?.content).text || '').trim();
}

async function talkCall(name, system, user, schema, signal) {
  const base = { model: prefs.get('talkModel'), reasoning: { effort: prefs.get('talkEffort') }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  let data;
  try {
    data = await call({ ...base, response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } } }, signal);
  } catch (e) {
    if (signal?.aborted) throw e;
    data = await call({ ...base, response_format: { type: 'json_object' } }, signal);
  }
  return parseContent(data.choices?.[0]?.message?.content);
}

const str = (description) => ({ type: 'string', description });
const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const lines = (context) => context.length ? `Recent conversation, oldest first:\n${context.join('\n')}\n\n` : '';

export async function interpret(text, { langs, mine, context }, signal) {
  const codes = langs.map((l) => l.code);
  const schema = obj({
    lang: { type: 'string', enum: [...codes, 'other'] },
    translation: str(`natural ${mine} translation of the utterance`),
    question: { type: 'boolean' },
    replies: { type: 'array', maxItems: 3, items: obj({ text: str('the reply, in the language of the utterance'), meaning: str(`${mine} translation of the reply`) }) },
  });
  const system = [
    `You are a live interpreter for a user who speaks ${mine}. The people around them speak ${langs.map((l) => `${l.name} (${l.code})`).join(', ')}.`,
    'You get the latest utterance, transcribed automatically (it may contain recognition errors), and a few earlier lines for context. Return JSON:',
    `- lang: language of the utterance; "other" if it is none of ${codes.join(', ')}.`,
    `- translation: faithful, natural ${mine} translation of the latest utterance only. Fix obvious recognition errors silently. Use an empty string if the transcript is recognition noise (subtitle credits, "thanks for watching", random syllables).`,
    '- question: true if the utterance asks the user something or clearly expects an answer; false for "other".',
    `- replies: when question is true, 3 short, common, natural replies the user could say, in the utterance's language, covering different answers (e.g. yes / no / ask to clarify); each with its ${mine} meaning. Otherwise [].`,
  ].join('\n');
  const r = await talkCall('hear', system, `${lines(context)}Latest utterance:\n${text}`, schema, signal);
  const replies = r.question && Array.isArray(r.replies) ? r.replies.slice(0, 3).map((x) => ({ text: String(x.text || '').trim(), meaning: String(x.meaning || '').trim() })).filter((x) => x.text) : [];
  return { lang: codes.includes(r.lang) ? r.lang : 'other', translation: String(r.translation || '').trim(), question: !!r.question, replies };
}

export async function compose(ask, { lang, mine, context }, signal) {
  const schema = obj({ text: str(`the message in ${lang.name}`), meaning: str(`${mine} back-translation of the message`) });
  const system = [
    `The user is talking with people who speak ${lang.name}. Write what the user wants to say, in ${lang.name}: natural, polite, conversational and short, the way a native speaker would say it.`,
    'The user writes in English or Russian. They may dictate the exact message or describe it ("ask how much it costs"); either way, write the message itself, addressed to the other person.',
    'Use the recent conversation for context (what things refer to, formality). Return JSON with text and meaning.',
  ].join('\n');
  const r = await talkCall('say', system, `${lines(context)}What I want to say:\n${ask}`, schema, signal);
  const text = String(r.text || '').trim();
  if (!text) throw new Error('model returned no text');
  return { text, meaning: String(r.meaning || '').trim() };
}
