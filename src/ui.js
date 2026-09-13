import { Component } from 'preact';
import { html } from 'htm/preact';
import { useState, useEffect, useRef, useMemo, useCallback } from 'preact/hooks';
import { store } from './store.js';
import { sync } from './drive.js';
import { bus, sanitize, isMac } from './util.js';
import { lastStep, stepLabel } from './schedule.js';
import { playCard, playBlob } from './audio.js';

export { html, useState, useEffect, useRef, useMemo, useCallback };

// Re-render once after subscribing: the load may have finished before the effect ran.
export function useStore() {
  const [, set] = useState(0);
  useEffect(() => { const un = store.subscribe(() => set((n) => n + 1)); set((n) => n + 1); return un; }, []);
}
export function useSync() {
  const [, set] = useState(0);
  useEffect(() => { const un = sync.subscribe(() => set((n) => n + 1)); set((n) => n + 1); return un; }, []);
  return sync;
}

export class ErrorBoundary extends Component {
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { console.error(error); }
  render(props, state) {
    if (!state.error) return props.children;
    return html`<div class="empty">This screen could not be rendered.
      <div class="small muted" style="margin:8px 0 14px">${state.error.message}</div>
      <button onClick=${() => location.reload()}>Reload</button>
      <a href="#/"><button class="ghost">Decks</button></a></div>`;
  }
}

export const Html = ({ html: s, class: cls, tag = 'div', title }) =>
  html`<${tag} class=${cls} title=${title} dangerouslySetInnerHTML=${{ __html: sanitize(s) }} />`;

export function Ruler({ deck, step, target, onPick, compact, hint }) {
  const items = [];
  for (let i = -1; i <= lastStep(deck); i++) {
    const cls = ['step', i < step ? 'done' : '', i === step ? 'cur' : '', i === target && i !== step ? 'target' : ''].join(' ');
    items.push(html`<button key=${i} class=${cls} onClick=${() => onPick(i)} title=${i < 0 ? 'reset to new' : `move to ${deck.steps[i]}`}>
      ${stepLabel(deck, i)}${i === lastStep(deck) ? ' ∞' : ''}</button>`);
    if (!compact && i < lastStep(deck)) items.push(html`<span key=${'a' + i} class="arrow">›</span>`);
  }
  return html`<div class=${'ruler' + (compact ? ' compact' : '')}>${items}${hint && html`<span class="hint">${hint}</span>`}</div>`;
}

export function AudioLine({ card, blob, busy, onRegenerate, onRemove, canGenerate }) {
  const has = !!(blob || card?.audio);
  const play = () => (blob ? playBlob(blob) : playCard(card));
  return html`<div class="audio-line">
    <button class="ghost" disabled=${!has} onClick=${play} title="play">▶</button>
    <div class=${'wave' + (has ? '' : ' none')}>${!has && html`<span class="muted small">${busy ? 'generating…' : 'no audio'}</span>`}</div>
    ${busy && has && html`<span class="muted small">…</span>`}
    ${onRegenerate && html`<button class="ghost sm" disabled=${busy || !canGenerate} onClick=${onRegenerate} title=${has ? 'regenerate' : 'generate'}>↻</button>`}
    ${onRemove && has && html`<button class="ghost sm" onClick=${onRemove} title="remove">✕</button>`}
  </div>`;
}

export function Toast() {
  const [t, setT] = useState(null);
  useEffect(() => bus.on((m) => {
    setT(m);
    clearTimeout(Toast._t);
    Toast._t = setTimeout(() => setT(null), m.kind === 'error' ? 6000 : 2500);
  }), []);
  return t ? html`<div class=${'toast ' + t.kind} onClick=${() => setT(null)}>${t.msg}</div>` : null;
}

export function Tabs({ deck, active, meta, onAdd }) {
  const tab = (id, label) => html`<a href=${`#/deck/${deck.id}/${id}`} class=${active === id ? 'on' : ''}>${label}</a>`;
  return html`<nav class="tabs">
    ${tab('learn', 'Learn')}${tab('cards', 'Cards')}${tab('settings', 'Settings')}
    <span class="spacer"></span>
    ${meta && html`<span class="meta">${meta}</span>`}
    <button onClick=${onAdd}>+ Add <kbd>N</kbd></button>
  </nav>`;
}

export function AutoTextarea(props) {
  const ref = useRef();
  useEffect(() => {
    const el = ref.current; if (!el) return;
    el.style.height = 'auto'; el.style.height = el.scrollHeight + 2 + 'px';
  }, [props.value]);
  useEffect(() => {
    const el = ref.current;
    if (props.autoFocus && el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  }, []);
  return html`<textarea ref=${ref} ...${props} />`;
}

export function HtmlField({ value, onInput, placeholder = 'empty · click to edit' }) {
  const [edit, setEdit] = useState(false);
  if (edit) return html`<${AutoTextarea} autoFocus value=${value} onInput=${onInput} onBlur=${() => setEdit(false)}
    onKeyDown=${(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEdit(false); } }} />`;
  return html`<div class=${'preview' + (value ? '' : ' empty')} tabIndex="0" title="click to edit HTML" onClick=${() => setEdit(true)} onFocus=${() => setEdit(true)}>
    ${value ? html`<${Html} html=${value} />` : placeholder}</div>`;
}

export function CardBody({ deck, card, side = 'front', flipped = true }) {
  const hasCardFields = deck.cardFields.some((f) => card.fields?.[f.key]);
  const labels = !!deck.showLabels;
  const prompt = side === 'front' ? card.front
    : card.senses.map((s) => s.translation).filter(Boolean).map((t, i) => html`<div class="p" key=${i}>${t}</div>`);
  const visibleSenses = side === 'front' ? card.senses
    : card.senses.filter((s) => deck.senseFields.some((f) => s.fields?.[f.key]));
  return html`<div class="word">${prompt}</div>
    ${flipped && html`<div class="answer">
      ${side === 'back' && html`<div class="word">${card.front}</div>`}
      ${visibleSenses.length > 0 && html`<ol class=${'senses' + (side === 'front' ? ' first' : '')}>${visibleSenses.map((s, i) => html`<li key=${i}>
        ${side === 'front' && html`<div class="tr">${s.translation}</div>`}
        ${deck.senseFields.map((f) => s.fields?.[f.key] && html`<div class="sf" key=${f.key} title=${labels ? null : f.label}>${labels && html`<span class="lbl">${f.label}</span>`}<${Html} tag="span" html=${s.fields[f.key]} /></div>`)}
      </li>`)}</ol>`}
      ${hasCardFields && html`<div class=${'fields' + (labels ? '' : ' nolabels')}>${deck.cardFields.map((f) => card.fields?.[f.key] && html`${labels && html`<span class="lbl" key=${'l' + f.key}>${f.label}</span>`}<${Html} key=${f.key} title=${labels ? null : f.label} html=${card.fields[f.key]} />`)}</div>`}
    </div>`}`;
}

export const Q = ({ text, right }) => html`<details class=${'q' + (right ? ' r' : '')}><summary title=${text}>?</summary><span class="qtext">${text}</span></details>`;

export function Modal({ children, onClose, narrow }) {
  return html`<div class="overlay" onMouseDown=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class=${'modal' + (narrow ? ' narrow' : '')}>${children}</div>
  </div>`;
}

export const isEditing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;

export const HOTKEYS = [
  ['space / enter', 'learn: show answer, then Next'],
  ['1 2 3 4', 'learn: again · stay · next · skip'],
  ['← →', 'learn: move the card one step back / forward'],
  ['R', 'learn: reset the card to new'],
  ['A', 'learn: play audio'],
  ['E', 'learn: edit the card'],
  ['U', 'learn: undo the last grade'],
  ['← →', 'card view: previous / next card'],
  ['B', 'card view: switch front / back'],
  ['N', 'add a card to the current deck'],
  ['/', 'cards: focus search'],
  ['enter', 'card: generate with the LLM'],
  [`${isMac ? '⌘' : 'Ctrl'} enter`, 'card / settings: add or save'],
  ['esc', 'close · back to decks'],
  ['?', 'this list'],
];
