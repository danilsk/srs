import { uid } from './util.js';

export const DEFAULTS = {
  textModel: 'openai/gpt-5.6-luna',
  ttsModel: 'google/gemini-3.1-flash-tts-preview',
  orKey: '',
  gClientId: '231977151347-rkp6ttr0imafmv00kae531cpmj49tto9.apps.googleusercontent.com',
  driveOn: '',
};

export const prefs = {
  get(k) { return localStorage.getItem('srs.' + k) ?? DEFAULTS[k] ?? ''; },
  set(k, v) { localStorage.setItem('srs.' + k, v); },
  clientId() {
    let id = localStorage.getItem('srs.clientId');
    if (!id) { id = uid(); localStorage.setItem('srs.clientId', id); }
    return id;
  },
};
