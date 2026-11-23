// LFDownloader background: sniffs media from network traffic, keeps a per-tab
// list, and routes downloads. All listeners are registered synchronously at
// the top level so the MV3 service worker wakes up for them.
import { api, EXT_ORIGIN } from '../shared/api.js';
import { classify, dedupeKey, nameFromUrl, extOf, hostOf } from '../shared/media.js';
import { DEFAULT_SETTINGS, getSettings, onSettingsChanged } from '../shared/settings.js';
import * as store from './store.js';
import { inspectHls, inspectDash } from './inspect.js';
import { startDownload, records, ensureManager, notifyDone, startImageBatch, cancelBatch } from './downloads.js';
import '../content/extract.js'; // defines globalThis.LFDExtract
import { addHeaderRules, removeHeaderRules } from './headers.js';
import { createMenus, handleMenuClicks } from './menus.js';
import { applySkin } from './skin.js';

let settings = { ...DEFAULT_SETTINGS };
getSettings().then((s) => { settings = s; applySkin(s); });
onSettingsChanged((s) => {
  const skinChanged = s.skin !== settings.skin || s.accent !== settings.accent;
  settings = s;
  if (skinChanged) applySkin(s);
});

const refererByRequest = new Map();
const inspecting = new Set();

// ───────────────────────── network sniffing ─────────────────────────

const CONTENT_FILES = ['content/extract.js', 'content/content.js'];
const TYPES = ['media', 'xmlhttprequest', 'object', 'other', 'main_frame', 'sub_frame'];

function fromExtension(d) {
  const origin = d.initiator || d.originUrl || d.documentUrl || '';
  return origin.startsWith(EXT_ORIGIN) || /^(chrome|moz)-extension:/.test(origin);
}

function header(headers, name) {
  const h = headers?.find((x) => x.name.toLowerCase() === name);
  return h ? h.value || '' : '';
}

function parseDispositionName(value) {
  if (!value) return '';
  const star = /filename\*\s*=\s*[^']*''([^;]+)/i.exec(value);
  if (star) {
    try { return decodeURIComponent(star[1].trim().replace(/"/g, '')); } catch { /* fall through */ }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(value);
  return plain ? plain[1].trim() : '';
}

const sendHeadersSpec = ['requestHeaders'];
if (!/\bFirefox\//.test(navigator.userAgent)) sendHeadersSpec.push('extraHeaders');

api.webRequest.onSendHeaders.addListener((d) => {
  if (d.tabId < 0) return;
  const ref = header(d.requestHeaders, 'referer');
  if (ref) {
    refererByRequest.set(d.requestId, ref);
    if (refererByRequest.size > 500) refererByRequest.delete(refererByRequest.keys().next().value);
  }
}, { urls: ['<all_urls>'], types: TYPES }, sendHeadersSpec);

api.webRequest.onBeforeRequest.addListener((d) => {
  // A new top-level page: start a fresh list for this tab.
  if (d.type === 'main_frame' && d.tabId >= 0) store.clearTab(d.tabId);
}, { urls: ['<all_urls>'], types: ['main_frame'] });

api.webRequest.onHeadersReceived.addListener((d) => {
  handleResponse(d).catch((e) => console.warn('[LFD] sniff', e));
}, { urls: ['<all_urls>'], types: TYPES }, ['responseHeaders']);

async function tabInfo(tabId) {
  try {
    const tab = await api.tabs.get(tabId);
    return { title: tab.title || '', pageUrl: tab.url || '' };
  } catch {
    return { title: '', pageUrl: '' };
  }
}

function allowed(kind) {
  if (kind === 'video') return settings.detectVideo;
  if (kind === 'audio') return settings.detectAudio;
  if (kind === 'stream') return settings.detectStreams;
  return false;
}

async function handleResponse(d) {
  const referer = refererByRequest.get(d.requestId);
  refererByRequest.delete(d.requestId);
  if (d.tabId < 0 || fromExtension(d)) return;
  if (d.statusCode < 200 || d.statusCode >= 300) return;
  if (!/^https?:/.test(d.url)) return;

  const type = header(d.responseHeaders, 'content-type');
  const c = classify(d.url, type);
  if (!c || c.segment || !allowed(c.kind)) return;

  let size = Number(header(d.responseHeaders, 'content-length')) || 0;
  const range = header(d.responseHeaders, 'content-range');
  const total = /\/(\d+)\s*$/.exec(range);
  if (total) size = Number(total[1]);
  if (c.kind !== 'stream' && size && size < settings.minSizeKB * 1024) return;

  const info = await tabInfo(d.tabId);
  if (d.type === 'main_frame') info.pageUrl = d.url;
  const fileName = parseDispositionName(header(d.responseHeaders, 'content-disposition'));
  await addDetected(d.tabId, {
    key: dedupeKey(d.url),
    url: d.url,
    kind: c.kind,
    format: c.format,
    mime: type.split(';')[0],
    size,
    name: fileName ? fileName.replace(/\.[a-z0-9]{2,5}$/i, '') : nameFromUrl(d.url),
    title: info.title,
    pageUrl: info.pageUrl,
    referer: referer || d.documentUrl || info.pageUrl,
    host: hostOf(d.url),
    source: 'network',
  });
}

/** Add an item, inspecting stream manifests first for quality options. */
async function addDetected(tabId, item) {
  if (item.kind !== 'stream') return store.addItem(tabId, item);

  const flight = `${tabId}|${item.key}`;
  if (inspecting.has(flight)) return null;
  const existing = (await store.getItems(tabId)).find((i) => i.key === item.key);
  if (existing) return existing;

  inspecting.add(flight);
  try {
    const extra = item.format === 'dash' ? await inspectDash(item.url, item.referer) : await inspectHls(item.url, item.referer);
    return await store.addItem(tabId, { ...item, ...extra });
  } catch (e) {
    return store.addItem(tabId, { ...item, variants: [], error: `Couldn't read the playlist (${e.message})` });
  } finally {
    setTimeout(() => inspecting.delete(flight), 3000);
  }
}

// ───────────────────────── tabs / lifecycle ─────────────────────────

api.tabs.onRemoved.addListener(async (tabId) => {
  store.forgetTab(tabId);
  const { managerTabId } = await api.storage.session.get('managerTabId');
  if (managerTabId === tabId) api.storage.session.remove('managerTabId');
});

api.runtime.onInstalled.addListener(async ({ reason }) => {
  await createMenus();
  if (reason === 'install') api.tabs.create({ url: api.runtime.getURL('welcome/welcome.html') });
});
api.runtime.onStartup.addListener(createMenus);

// ───────────────────────── panel / actions ─────────────────────────

async function openPanel(tabId, focus = '', streamUrl = null, { rescan = false, view = '', scanImages = false } = {}) {
  if (tabId == null) return;
  if (streamUrl) {
    const info = await tabInfo(tabId);
    const c = classify(streamUrl);
    await addDetected(tabId, {
      key: dedupeKey(streamUrl), url: streamUrl, kind: 'stream', format: c?.format || 'hls', size: 0,
      name: nameFromUrl(streamUrl), title: info.title, pageUrl: info.pageUrl, referer: info.pageUrl,
      host: hostOf(streamUrl), source: 'link',
    });
  }
  const msg = { type: 'lfd:panel', focus, rescan, view, scanImages };
  try {
    await api.tabs.sendMessage(tabId, msg, { frameId: 0 });
    return;
  } catch { /* content script missing (page loaded before install) */ }
  try {
    await api.scripting.executeScript({ target: { tabId, allFrames: true }, files: CONTENT_FILES });
    await api.tabs.sendMessage(tabId, msg, { frameId: 0 });
  } catch {
    // Restricted page (store, settings...): fall back to the toolbar popup.
    api.action.openPopup?.().catch(() => {});
  }
}

async function downloadUrl(tabId, url, kind) {
  const info = tabId != null ? await tabInfo(tabId) : { title: '', pageUrl: '' };
  const c = classify(url) || { kind, format: extOf(url) };
  return startDownload({
    url, kind: c.kind || kind, format: c.format, title: info.title, name: nameFromUrl(url),
    pageUrl: info.pageUrl, referer: info.pageUrl, size: 0,
  }, null, { tabId });
}

handleMenuClicks({
  openPanel,
  downloadUrl,
  openManager: () => ensureManager(),
  scanImages: (tabId) => openPanel(tabId, '', null, { view: 'images', scanImages: true }),
});

api.commands?.onCommand.addListener(async (command) => {
  if (command !== 'scan-page') return;
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (tab) openPanel(tab.id, '', null, { rescan: true });
});

/** Probe a pasted URL so the manager can show its qualities. */
async function inspectUrl(url) {
  let c = classify(url);
  let size = 0;
  if (!c || c.segment) {
    const res = await fetch(url, { method: 'HEAD', credentials: 'include' }).catch(() => null);
    const type = res?.headers.get('content-type') || '';
    size = Number(res?.headers.get('content-length')) || 0;
    c = classify(url, type);
    if (!c || c.segment) {
      // Unknown type: let the browser figure it out as a plain file.
      c = { kind: 'video', format: extOf(url) || 'bin' };
    }
  }
  const item = {
    id: 'manual', key: dedupeKey(url), url, kind: c.kind, format: c.format, size,
    name: nameFromUrl(url), title: nameFromUrl(url), pageUrl: url, referer: '', host: hostOf(url), source: 'manual',
  };
  if (c.kind === 'stream') Object.assign(item, c.format === 'dash' ? await inspectDash(url, '') : await inspectHls(url, ''));
  return item;
}

// ───────────────────────── messaging ─────────────────────────

const handlers = {
  async whoami(_, sender) {
    return sender.tab?.id ?? null;
  },
  async 'media:list'({ tabId }, sender) {
    return store.getItems(tabId ?? sender.tab?.id);
  },
  async 'media:count'(_, sender) {
    return (await store.getItems(sender.tab.id)).length;
  },
  async 'media:download'({ tabId, id, variantId, title }) {
    const item = await store.getItem(tabId, id);
    if (!item) throw new Error('This media is no longer available — reload the page.');
    const variant = item.variants?.find((v) => v.id === variantId);
    return startDownload(item, variant, { tabId, title });
  },
  async 'media:remove'({ tabId, id }) {
    return store.removeItem(tabId, id);
  },
  async 'media:clear'({ tabId }) {
    return store.clearTab(tabId);
  },
  async 'dom:media'({ items = [], posters = [] }, sender) {
    const tabId = sender.tab?.id;
    if (tabId == null) return;
    const info = await tabInfo(tabId);
    for (const m of items) {
      const c = classify(m.url, m.mime || '');
      if (!c || c.segment || !allowed(c.kind)) continue;
      const added = await addDetected(tabId, {
        key: dedupeKey(m.url), url: m.url, kind: c.kind, format: c.format, size: 0,
        name: m.name || nameFromUrl(m.url), title: info.title, pageUrl: info.pageUrl,
        referer: sender.url || info.pageUrl, host: hostOf(m.url), poster: m.poster || '', source: 'dom',
      });
      if (added && !added.size && c.kind !== 'stream') probeSize(tabId, added);
    }
    if (posters.length) {
      for (const p of posters) p.key = /^https?:/.test(p.src || '') ? dedupeKey(p.src) : '';
      await store.patchItems(tabId, (list) => {
        let changed = false;
        const fallback = posters.find((p) => !p.key)?.poster;
        for (const it of list) {
          if (it.poster) continue;
          const hit = posters.find((p) => p.key && p.key === it.key);
          const poster = hit?.poster || (it.kind === 'stream' || it.kind === 'video' ? fallback : '');
          if (poster) { it.poster = poster; changed = true; }
        }
        return changed;
      });
    }
  },
  async 'images:add'({ items = [] }, sender) {
    const tabId = sender.tab?.id;
    if (tabId == null) return 0;
    const info = await tabInfo(tabId);
    const clean = items.filter((i) => /^https?:/.test(i.url || '')).map((i) => ({
      key: i.url.split('#')[0], url: i.url, kind: 'image', format: (extOf(i.url) || 'jpg').replace('jpeg', 'jpg'),
      thumb: /^(https?|data):/.test(i.thumb || '') ? i.thumb : i.url, width: i.width || 0, height: i.height || 0,
      name: nameFromUrl(i.url), title: info.title, pageUrl: info.pageUrl, referer: i.viewerUrl || info.pageUrl,
      viewerUrl: i.viewerUrl || '', host: hostOf(i.url), source: 'gallery', size: 0,
    }));
    return store.addImages(tabId, clean);
  },
  async 'images:progress'({ state, done, total, found }, sender) {
    const tabId = sender.tab?.id;
    if (tabId != null) await api.storage.session.set({ [`imgscan:${tabId}`]: { state, done, total, found, at: Date.now() } });
  },
  async 'image:resolve'({ url, thumb }) {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    if (type.startsWith('image/')) return { url: res.url || url };
    if (!type.includes('html')) return null;
    return globalThis.LFDExtract.bestImageFromHtml(await res.text(), res.url || url, thumb);
  },
  async 'images:download'({ tabId, ids }) {
    const items = (await store.getItems(tabId)).filter((i) => i.kind === 'image' && (!ids?.length || ids.includes(i.id)));
    if (!items.length) throw new Error('No images selected');
    const info = await tabInfo(tabId);
    return startImageBatch(items, { title: info.title || items[0].title, pageUrl: info.pageUrl || items[0].pageUrl });
  },
  async 'images:clear'({ tabId }) {
    await api.storage.session.remove(`imgscan:${tabId}`);
    return store.patchItems(tabId, (list) => {
      const before = list.length;
      for (let i = list.length - 1; i >= 0; i--) if (list[i].kind === 'image') list.splice(i, 1);
      return list.length !== before;
    });
  },
  async 'batch:cancel'({ id }) {
    return cancelBatch(id);
  },
  async 'panel:open'({ focus }, sender) {
    return openPanel(sender.tab?.id, focus || '');
  },
  async 'manager:open'() {
    return ensureManager();
  },
  async 'manager:register'(_, sender) {
    if (sender.tab?.id != null) await api.storage.session.set({ managerTabId: sender.tab.id });
  },
  async 'records:update'({ id, patch }) {
    return records.update(id, patch);
  },
  async 'records:remove'({ ids }) {
    return records.remove(ids);
  },
  async 'records:clear'() {
    return records.clearFinished();
  },
  async 'records:notify'({ id }) {
    const { downloads = [] } = await api.storage.local.get('downloads');
    const rec = downloads.find((r) => r.id === id);
    if (rec) notifyDone(rec);
  },
  async 'headers:add'({ urls, referer }, sender) {
    return addHeaderRules(urls, referer, sender.tab?.id != null ? [sender.tab.id] : []);
  },
  async 'headers:remove'({ ids }) {
    return removeHeaderRules(ids);
  },
  async 'url:inspect'({ url }) {
    if (!/^https?:\/\//i.test(url)) throw new Error('Enter a link that starts with http:// or https://');
    return inspectUrl(url);
  },
  async 'url:download'({ item, variantId }) {
    const variant = item.variants?.find((v) => v.id === variantId);
    return startDownload(item, variant, {});
  },
  async 'retry'({ id }) {
    const { downloads = [] } = await api.storage.local.get('downloads');
    const rec = downloads.find((r) => r.id === id);
    if (!rec) throw new Error('Download not found');
    if (rec.type === 'stream' || rec.type === 'fetch') {
      await records.update(id, { status: 'queued', error: '', progress: 0 });
      return ensureManager({ focus: false });
    }
    return startDownload({ url: rec.url, kind: rec.kind, format: rec.format?.toLowerCase(), title: rec.title, pageUrl: rec.pageUrl, referer: rec.pageUrl }, null, {});
  },
};

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const fn = handlers[msg?.type];
  if (!fn) return false;
  Promise.resolve()
    .then(() => fn(msg, sender))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
  return true; // async response
});

async function probeSize(tabId, item) {
  try {
    const res = await fetch(item.url, { method: 'HEAD', credentials: 'include' });
    const size = Number(res.headers.get('content-length')) || 0;
    if (size) {
      await store.patchItems(tabId, (list) => {
        const it = list.find((i) => i.id === item.id);
        if (!it) return false;
        it.size = size;
        return true;
      });
    }
  } catch { /* size stays unknown */ }
}
