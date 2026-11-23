import { icon } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastRoot;
export function toast(message, { error = false, ms = 2600 } = {}) {
  if (!toastRoot) {
    toastRoot = document.createElement('div');
    toastRoot.className = 'toasts';
    toastRoot.setAttribute('role', 'status');
    document.body.append(toastRoot);
  }
  const el = document.createElement('div');
  el.className = `toast${error ? ' error' : ''}`;
  el.innerHTML = `${icon(error ? 'alert' : 'check', 16)}<span>${esc(message)}</span>`;
  toastRoot.append(el);
  setTimeout(() => {
    el.classList.add('out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, ms);
}

export function timeAgo(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(ts).toLocaleDateString();
}

/** Inject icons declared as <i data-icon="name" data-size="16"></i>. */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('i[data-icon]')) {
    el.outerHTML = icon(el.dataset.icon, Number(el.dataset.size) || 18);
  }
}
