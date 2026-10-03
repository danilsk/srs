import { uid } from './util.js';

export const DEFAULTS = {
  textModel: 'google/gemini-3.8-flash',
  textEffort: 'low',
  ttsModel: 'google/gemini-3.8-flash-tts',
  orKey: '',
  gClientId: '231977151347-rkp6ttr0imafmv00kae531cpmj49tto9.apps.googleusercontent.com',
  driveOn: '',
};

export const prefs = {
  get(k) { return localStorage.getItem('srs.' + k) || DEFAULTS[k] || ''; },
  set(k, v) {
    if (!v || v === DEFAULTS[k]) localStorage.removeItem('srs.' + k);
    else localStorage.setItem('srs.' + k, v);
  },
  clientId() {
    let id = localStorage.getItem('srs.clientId');
    if (!id) { id = uid(); localStorage.setItem('srs.clientId', id); }
    return id;
  },
};
