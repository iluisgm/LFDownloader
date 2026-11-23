// Per-tab media store. The MV3 service worker can be stopped at any time, so
// every change is written through to storage.session and lazily reloaded.
import { api } from '../shared/api.js';
import { uid } from '../shared/media.js';

const cache = new Map(); // tabId -> { items: [], children: [] }
const locks = new Map(); // tabId -> Promise (serialises read-modify-write)
const MAX_ITEMS = 120; // media items
const MAX_IMAGES = 1000;

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

let badge = { bg: '#7C5CFF', fg: '#FFFFFF' };

/** Called when the skin changes; applies to every tab's badge. */
export function setBadgeColor(bg, fg) {
  badge = { bg, fg };
  api.action.setBadgeBackgroundColor({ color: bg }).catch(() => {});
  api.action.setBadgeTextColor?.({ color: fg })?.catch?.(() => {});
}

export function updateBadge(tabId, state) {
  const n = state.items.filter((i) => i.kind !== 'image').length;
  api.action.setBadgeText({ tabId, text: n ? String(n > 99 ? '99+' : n) : '' }).catch(() => {});
  api.action.setBadgeBackgroundColor({ tabId, color: badge.bg }).catch(() => {});
  api.action.setBadgeTextColor?.({ tabId, color: badge.fg })?.catch?.(() => {});
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
    trim(state);
    await persist(tabId, state);
    return stored;
  });
}

function trim(state) {
  const media = state.items.filter((i) => i.kind !== 'image');
  const images = state.items.filter((i) => i.kind === 'image');
  if (media.length > MAX_ITEMS || images.length > MAX_IMAGES) {
    state.items = [...media.slice(0, MAX_ITEMS), ...images.slice(0, MAX_IMAGES)];
  }
}

/** Add many images at once (one storage write). Returns how many were new. */
export function addImages(tabId, items) {
  return withLock(tabId, async () => {
    const state = await load(tabId);
    const known = new Set(state.items.map((i) => i.key));
    let added = 0;
    for (const it of items) {
      if (known.has(it.key)) continue;
      known.add(it.key);
      state.items.push({ id: uid(), detectedAt: Date.now(), lastSeen: Date.now(), ...it });
      added++;
    }
    trim(state);
    if (added) await persist(tabId, state);
    return added;
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
