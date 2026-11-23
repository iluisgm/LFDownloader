// Per-tab media store. The MV3 service worker can be stopped at any time, so
// every change is written through to storage.session and lazily reloaded.
import { api } from '../shared/api.js';
import { uid } from '../shared/media.js';

const cache = new Map(); // tabId -> { items: [], children: [] }
const locks = new Map(); // tabId -> Promise (serialises read-modify-write)
const MAX_ITEMS = 120;

const keyFor = (tabId) => `tab:${tabId}`;

async function load(tabId) {
  if (cache.has(tabId)) return cache.get(tabId);
  const k = keyFor(tabId);
  const got = await api.storage.session.get(k);
  const state = got[k] || { items: [], children: [] };
  cache.set(tabId, state);
  return state;
}

async function persist(tabId, state) {
  cache.set(tabId, state);
  await api.storage.session.set({ [keyFor(tabId)]: state });
  updateBadge(tabId, state);
}

function withLock(tabId, fn) {
  const prev = locks.get(tabId) || Promise.resolve();
  const next = prev.then(() => fn()).catch((e) => console.warn('[LFD] store', e));
  locks.set(tabId, next);
  return next;
}

/** `/media/clip_00012.mp4` and `/media/clip_00013.mp4` share a pattern. */
function pathPattern(url) {
  try {
    const u = new URL(url);
    return u.host + u.pathname.replace(/\d+/g, '#');
  } catch {
    return url;
  }
}

export function updateBadge(tabId, state) {
  const n = state.items.length;
  api.action.setBadgeText({ tabId, text: n ? String(n > 99 ? '99+' : n) : '' }).catch(() => {});
  api.action.setBadgeBackgroundColor({ tabId, color: '#7C5CFF' }).catch(() => {});
  api.action.setBadgeTextColor?.({ tabId, color: '#FFFFFF' })?.catch?.(() => {});
}

export function getItems(tabId) {
  return withLock(tabId, async () => (await load(tabId)).items);
}

export async function getItem(tabId, id) {
  const items = await getItems(tabId);
  return items.find((i) => i.id === id);
}

/**
 * Add or merge a media item. Returns the stored item, or null if it was
 * dropped (e.g. recognised as a stream segment or a child playlist).
 */
export function addItem(tabId, item) {
  return withLock(tabId, async () => {
    const state = await load(tabId);
    if (state.children.includes(item.key)) return null;

    const existing = state.items.find((i) => i.key === item.key);
    if (existing) {
      // Keep the richest information we have seen.
      Object.assign(existing, {
        size: Math.max(existing.size || 0, item.size || 0) || existing.size,
        poster: existing.poster || item.poster,
        variants: item.variants?.length ? item.variants : existing.variants,
        duration: existing.duration || item.duration,
        lastSeen: Date.now(),
      });
      await persist(tabId, state);
      return existing;
    }

    const stored = { id: uid(), detectedAt: Date.now(), lastSeen: Date.now(), ...item };

    if (stored.kind !== 'stream' && stored.source === 'network') {
      // Three or more files that differ only by numbers, fetched within a
      // minute of each other = segments of a stream, not real files.
      stored.pattern = pathPattern(stored.url);
      const recent = Date.now() - 60_000;
      const siblings = state.items.filter((i) => i.pattern === stored.pattern && i.detectedAt > recent);
      if (siblings.length >= 2) {
        state.items = state.items.filter((i) => i.pattern !== stored.pattern);
        state.children.push(stored.key, ...siblings.map((s) => s.key));
        await persist(tabId, state);
        return null;
      }
    }

    if (stored.kind === 'stream' && stored.childKeys?.length) {
      // A master playlist: remember its variants so they are not listed twice.
      state.children.push(...stored.childKeys);
      state.items = state.items.filter((i) => !stored.childKeys.includes(i.key));
    }
    if (state.children.length > 600) state.children = state.children.slice(-400);

    state.items.unshift(stored);
    if (state.items.length > MAX_ITEMS) state.items.length = MAX_ITEMS;
    await persist(tabId, state);
    return stored;
  });
}

export function patchItems(tabId, fn) {
  return withLock(tabId, async () => {
    const state = await load(tabId);
    if (fn(state.items)) await persist(tabId, state);
    return state.items;
  });
}

export function removeItem(tabId, id) {
  return withLock(tabId, async () => {
    const state = await load(tabId);
    state.items = state.items.filter((i) => i.id !== id);
    await persist(tabId, state);
  });
}

export function clearTab(tabId) {
  return withLock(tabId, async () => {
    const state = { items: [], children: [] };
    await persist(tabId, state);
  });
}

export async function forgetTab(tabId) {
  cache.delete(tabId);
  locks.delete(tabId);
  await api.storage.session.remove(keyFor(tabId));
}
