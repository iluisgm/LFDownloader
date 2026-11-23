// Download records (history) and routing: direct files go to the browser's
// download manager; streams are queued for the LFDownloader manager window.
import { api } from '../shared/api.js';
import { buildFilename, extOf, AUDIO_EXT, VIDEO_EXT, uid, cleanTitle, sanitizeFilename, sanitizeFolder, nameFromUrl } from '../shared/media.js';
import { getSettings } from '../shared/settings.js';
import { addHeaderRules, removeHeaderRules } from './headers.js';

const MANAGER_URL = api.runtime.getURL('manager/manager.html');
const MAX_RECORDS = 400;
let lock = Promise.resolve();

function mutate(fn) {
  const run = lock.then(async () => {
    const { downloads = [] } = await api.storage.local.get('downloads');
    const result = await fn(downloads);
    if (downloads.length > MAX_RECORDS) downloads.length = MAX_RECORDS;
    await api.storage.local.set({ downloads });
    return result;
  });
  lock = run.catch(() => {});
  return run;
}

const BATCH_PARALLEL = 4;
// Server refused the browser's own download (usually hotlink protection).
const REFUSED = ['SERVER_FORBIDDEN', 'SERVER_UNAUTHORIZED', 'SERVER_BAD_CONTENT'];

const isPage = (type) => /^(text\/html|application\/xhtml)/i.test(type || '');

/**
 * Ask the server for the first byte, without the page's Referer — the way the
 * browser's own download will ask. Hotlink-protected hosts refuse (401/403) or,
 * like many video CDNs, quietly answer with an HTML page instead of the file.
 */
async function needsReferer(url) {
  try {
    const res = await fetch(url, {
      headers: { Range: 'bytes=0-0' }, credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(8000),
    });
    res.body?.cancel().catch(() => {});
    if (res.status === 401 || res.status === 403) return true;
    return isPage(res.headers.get('content-type'));
  } catch {
    return false; // unreachable from here: let the browser try
  }
}

/** Turn a Blob into something downloads.download accepts in this context. */
async function blobUrl(blob) {
  if (typeof URL.createObjectURL === 'function') return URL.createObjectURL(blob); // Firefox background page
  // Chrome's service worker has no object URLs: use a data URL.
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(bin)}`;
}

/** Fetch with the page's Referer (extension requests honour our header rules). */
async function fetchAsDownloadUrl(url, referer) {
  const ids = await addHeaderRules([url], referer);
  try {
    const res = await fetch(url, { credentials: 'include', signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (isPage(res.headers.get('content-type'))) throw new Error('The server sent a web page instead of the file');
    return blobUrl(await res.blob());
  } finally {
    removeHeaderRules(ids);
  }
}
const IMAGE_EXT = ['jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'avif', 'bmp', 'tif', 'tiff', 'jxl', 'heic', 'heif'];

export const records = {
  mutate,
  add: (rec) => mutate((list) => { list.unshift(rec); return rec; }),
  update: (id, patch) => mutate((list) => {
    const r = list.find((x) => x.id === id);
    if (r) Object.assign(r, patch);
    return r;
  }),
  updateByDownloadId: (downloadId, patchFn) => mutate((list) => {
    const r = list.find((x) => x.downloadId === downloadId && x.type !== 'batch');
    if (r) Object.assign(r, patchFn(r));
    return r;
  }),
  remove: (ids) => mutate((list) => {
    const set = new Set(ids);
    for (let i = list.length - 1; i >= 0; i--) if (set.has(list[i].id)) list.splice(i, 1);
  }),
  clearFinished: () => mutate((list) => {
    for (let i = list.length - 1; i >= 0; i--) {
      if (!['queued', 'downloading'].includes(list[i].status)) list.splice(i, 1);
    }
  }),
};

/** Which file extension to save a direct file with. */
function fileExt(item) {
  const fromUrl = extOf(item.url);
  if (VIDEO_EXT.includes(fromUrl) || AUDIO_EXT.includes(fromUrl)) return fromUrl;
  return item.format && /^[a-z0-9]{2,5}$/.test(item.format) ? item.format : item.kind === 'audio' ? 'mp3' : 'mp4';
}

async function currentTitle(tabId, item) {
  try {
    const tab = await api.tabs.get(tabId);
    if (tab?.title && tab.url === item.pageUrl) return tab.title;
  } catch { /* tab closed */ }
  return item.title;
}

export async function ensureManager({ focus = true } = {}) {
  const { managerTabId } = await api.storage.session.get('managerTabId');
  if (managerTabId != null) {
    try {
      const tab = await api.tabs.get(managerTabId);
      if (tab?.url?.startsWith(MANAGER_URL)) {
        if (focus) {
          await api.tabs.update(tab.id, { active: true });
          await api.windows.update(tab.windowId, { focused: true });
        }
        return tab.id;
      }
    } catch { /* closed */ }
  }
  const win = await api.windows.create({ url: MANAGER_URL, type: 'popup', width: 1060, height: 720, focused: focus });
  const tabId = win.tabs?.[0]?.id;
  if (tabId != null) await api.storage.session.set({ managerTabId: tabId });
  return tabId;
}

/**
 * Start downloading a detected media item.
 * @param item     media item from the store (or a synthetic one)
 * @param variant  chosen quality (streams), optional for files
 */
export async function startDownload(item, variant, { tabId, title: chosenTitle } = {}) {
  const settings = await getSettings();
  // The popup's name for the item wins (e.g. track names on an album page);
  // otherwise use the tab's latest title.
  const title = cleanTitle(chosenTitle || (tabId != null ? await currentTitle(tabId, item) : item.title));
  const quality = variant?.audioOnly ? 'audio' : variant?.label && variant.label !== 'Source' ? variant.label : item.quality || '';

  if (item.drm) throw new Error('This stream is DRM-protected and cannot be saved.');

  if (item.kind !== 'stream') {
    const filename = buildFilename({
      template: settings.filenameTemplate, title, quality, url: item.url, ext: fileExt(item), folder: settings.folder,
    });
    const referer = item.referer || item.pageUrl;
    const base = {
      id: uid(), title: title || filename, filename, url: item.url, pageUrl: item.pageUrl, referer, kind: item.kind,
      format: fileExt(item).toUpperCase(), quality, size: item.size || 0, createdAt: Date.now(),
    };
    if (referer && await needsReferer(item.url)) {
      // The browser's own download would get a web page or an error: fetch it ourselves with the Referer.
      const rec = await records.add({ ...base, type: 'fetch', status: 'queued', viaManager: true, job: { url: item.url, referer, ext: fileExt(item) } });
      await ensureManager({ focus: false });
      return rec;
    }
    const ruleIds = await addHeaderRules([item.url], referer);
    let downloadId;
    try {
      downloadId = await api.downloads.download({
        url: item.url, filename, saveAs: settings.askWhereToSave, conflictAction: 'uniquify',
      });
    } catch (e) {
      removeHeaderRules(ruleIds);
      throw e;
    }
    await api.storage.session.set({ [`rules:${downloadId}`]: ruleIds });
    return records.add({ ...base, type: 'file', status: 'downloading', downloadId });
  }

  if (item.format === 'dash') {
    throw new Error('DASH streams are not supported yet. Use “Copy link” to grab it with yt-dlp.');
  }

  const v = variant || item.variants?.[0] || { url: item.url, label: 'Source' };
  const ext = v.audioOnly ? (item.fmp4 ? 'm4a' : 'aac') : item.fmp4 ? 'mp4' : 'ts';
  const filename = buildFilename({
    template: settings.filenameTemplate, title, quality, url: item.url, ext, folder: settings.folder,
  });
  const rec = await records.add({
    id: uid(), type: 'stream', status: 'queued', title: title || filename, filename,
    url: item.url, pageUrl: item.pageUrl, kind: v.audioOnly ? 'audio' : 'video',
    format: ext.toUpperCase(), quality, duration: item.duration || 0, live: !!item.live, createdAt: Date.now(),
    job: {
      playlistUrl: v.url,
      audioUrl: v.audioOnly ? '' : v.audioUrl || '',
      referer: item.referer || item.pageUrl,
      ext,
    },
  });
  await ensureManager({ focus: true });
  return rec;
}

/** Start up to BATCH_PARALLEL queued files of a batch record (inside mutate). */
async function pumpBatch(rec) {
  while (rec.status === 'downloading' && rec.active.length < BATCH_PARALLEL && rec.pending.length) {
    const job = rec.pending.shift();
    try {
      // Once the host refused one image, skip the doomed browser attempt for the rest.
      const viaFetch = job.viaFetch || rec.viaFetch;
      const url = viaFetch ? await fetchAsDownloadUrl(job.url, rec.pageUrl) : job.url;
      job.viaFetch = viaFetch;
      const id = await api.downloads.download({ url, filename: job.filename, conflictAction: 'uniquify', saveAs: false });
      batchIds.add(id);
      (rec.jobs ||= {})[id] = job;
      rec.active.push(id);
      rec.downloadIds.push(id);
      if (rec.downloadId == null) rec.downloadId = id;
    } catch (e) {
      rec.failed++;
      rec.error = e.message;
    }
  }
  if (rec.status === 'downloading' && !rec.active.length && !rec.pending.length) {
    rec.status = rec.done ? 'completed' : 'failed';
    rec.finishedAt = Date.now();
    if (!rec.done) rec.error ||= 'No image could be downloaded';
    removeHeaderRules(rec.ruleIds);
    return true; // finished
  }
  return false;
}

/** Download a set of images into "<folder>/<page title>/". */
export async function startImageBatch(images, { title, pageUrl }) {
  const settings = await getSettings();
  const folder = [sanitizeFolder(settings.folder), sanitizeFilename(cleanTitle(title) || 'Images', 80)].filter(Boolean).join('/');
  const used = new Set();
  const pending = images.map((img, i) => {
    let ext = extOf(img.url);
    if (!IMAGE_EXT.includes(ext)) ext = IMAGE_EXT.includes(img.format) ? img.format : 'jpg';
    if (ext === 'jfif' || ext === 'jpeg') ext = 'jpg';
    let base = sanitizeFilename(nameFromUrl(img.url) || `image-${i + 1}`, 100);
    let name = `${base}.${ext}`;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n}).${ext}`;
    used.add(name.toLowerCase());
    return { url: img.url, filename: `${folder}/${name}` };
  });
  const ruleIds = await addHeaderRules(images.map((i) => i.url).slice(0, 40), pageUrl);
  return mutate(async (list) => {
    const rec = {
      id: uid(), type: 'batch', kind: 'image', status: 'downloading', title: cleanTitle(title) || 'Images',
      filename: folder, url: pageUrl, pageUrl, format: 'IMAGES', quality: '', size: 0, createdAt: Date.now(),
      total: pending.length, done: 0, failed: 0, pending, active: [], downloadIds: [], downloadId: null, ruleIds,
    };
    list.unshift(rec);
    await pumpBatch(rec);
    return { id: rec.id, total: rec.total, folder };
  });
}

export function cancelBatch(id) {
  return mutate(async (list) => {
    const rec = list.find((r) => r.id === id);
    if (!rec || rec.type !== 'batch') return;
    for (const d of rec.active) api.downloads.cancel(d).catch(() => {});
    rec.pending = [];
    rec.active = [];
    rec.status = 'canceled';
    removeHeaderRules(rec.ruleIds);
  });
}

const batchIds = new Set(); // ids started this service-worker lifetime

async function onBatchChanged(delta) {
  const state = delta.state?.current;
  if (state !== 'complete' && state !== 'interrupted') return false;
  // Cheap pre-check so ordinary downloads don't cost a storage write.
  if (!batchIds.has(delta.id)) {
    const { downloads = [] } = await api.storage.local.get('downloads');
    if (!downloads.some((r) => r.type === 'batch' && r.active?.includes(delta.id))) return false;
  }
  batchIds.delete(delta.id);
  let finished = null;
  const handled = await mutate(async (list) => {
    const rec = list.find((r) => r.type === 'batch' && r.active?.includes(delta.id));
    if (!rec) return false;
    {
      rec.active = rec.active.filter((x) => x !== delta.id);
      const job = rec.jobs?.[delta.id];
      if (rec.jobs) delete rec.jobs[delta.id];
      const [d] = state === 'complete' ? await api.downloads.search({ id: delta.id }).catch(() => []) : [];
      if (state === 'complete' && isPage(d?.mime) && job && !job.viaFetch) {
        // Saved a hotlink "web page" instead of the picture: delete it and retry with the Referer.
        await api.downloads.removeFile(delta.id).catch(() => {});
        api.downloads.erase({ id: delta.id }).catch(() => {});
        rec.viaFetch = true;
        rec.pending.unshift({ ...job, viaFetch: true });
      } else if (state === 'complete') {
        rec.done++;
        rec.size += d?.fileSize || d?.totalBytes || 0;
      } else if (job && !job.viaFetch && REFUSED.includes(delta.error?.current)) {
        rec.viaFetch = true;
        rec.pending.unshift({ ...job, viaFetch: true }); // retry with the page's Referer
        api.downloads.erase({ id: delta.id }).catch(() => {});
      } else {
        rec.failed++;
      }
      if (await pumpBatch(rec)) finished = rec;
    }
    return true;
  });
  if (finished?.status === 'completed') notifyDone({ ...finished, filename: `${finished.done} images · ${finished.title}` });
  return handled;
}

// Safety net: a media download that starts as a web page is canceled and
// re-done through the manager with the page's Referer.
api.downloads.onCreated.addListener(async (item) => {
  if (!isPage(item.mime)) return;
  await new Promise((r) => setTimeout(r, 400)); // let startDownload store its record
  const moved = await mutate((list) => {
    const r = list.find((x) => x.downloadId === item.id && x.type === 'file');
    if (!r || r.viaManager || !r.referer) return false;
    const ext = (r.filename.split('.').pop() || 'bin').toLowerCase();
    Object.assign(r, {
      type: 'fetch', status: 'queued', viaManager: true, error: '', downloadId: null,
      job: { url: r.url, referer: r.referer, ext },
    });
    return true;
  });
  if (!moved) return;
  await api.downloads.cancel(item.id).catch(() => {});
  api.downloads.erase({ id: item.id }).catch(() => {});
  await ensureManager({ focus: false });
});

// Keep records in sync with the browser's own download states.
api.downloads.onChanged.addListener(async (delta) => {
  if (await onBatchChanged(delta)) return;
  if (delta.state?.current === 'interrupted' && REFUSED.includes(delta.error?.current)) {
    const moved = await mutate((list) => {
      const r = list.find((x) => x.downloadId === delta.id && x.type === 'file');
      if (!r || r.viaManager || !r.referer) return false;
      const ext = (r.filename.split('.').pop() || 'bin').toLowerCase();
      Object.assign(r, {
        type: 'fetch', status: 'queued', viaManager: true, error: '', downloadId: null,
        job: { url: r.url, referer: r.referer, ext },
      });
      return true;
    });
    if (moved) {
      api.downloads.erase({ id: delta.id }).catch(() => {});
      const k = `rules:${delta.id}`;
      const got = await api.storage.session.get(k);
      if (got[k]) { removeHeaderRules(got[k]); api.storage.session.remove(k); }
      await ensureManager({ focus: false });
      return;
    }
  }
  const patch = {};
  if (delta.state?.current === 'complete') Object.assign(patch, { status: 'completed', finishedAt: Date.now(), progress: 1 });
  if (delta.state?.current === 'interrupted') {
    patch.status = delta.error?.current === 'USER_CANCELED' ? 'canceled' : 'failed';
    patch.error = delta.error?.current || '';
  }
  if (delta.filename?.current) patch.savedPath = delta.filename.current;
  if (delta.totalBytes?.current > 0) patch.size = delta.totalBytes.current;
  if (delta.paused) patch.paused = delta.paused.current;
  if (!Object.keys(patch).length) return;

  const rec = await records.updateByDownloadId(delta.id, () => patch);
  if (patch.status) {
    const k = `rules:${delta.id}`;
    const got = await api.storage.session.get(k);
    if (got[k]) {
      removeHeaderRules(got[k]);
      api.storage.session.remove(k);
    }
    if (rec && patch.status === 'completed') notifyDone(rec);
  }
});

export async function notifyDone(rec) {
  const settings = await getSettings();
  if (!settings.notifyOnComplete || !api.notifications) return;
  api.notifications.create(`lfd-${rec.id}`, {
    type: 'basic',
    iconUrl: api.runtime.getURL('assets/icons/icon-128.png'),
    title: 'Download complete',
    message: rec.filename?.split('/').pop() || rec.title || 'Your file is ready',
  }).catch(() => {});
}
