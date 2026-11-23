// Download records (history) and routing: direct files go to the browser's
// download manager; streams are queued for the LFDownloader manager window.
import { api } from '../shared/api.js';
import { buildFilename, extOf, AUDIO_EXT, VIDEO_EXT, uid, cleanTitle } from '../shared/media.js';
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

export const records = {
  add: (rec) => mutate((list) => { list.unshift(rec); return rec; }),
  update: (id, patch) => mutate((list) => {
    const r = list.find((x) => x.id === id);
    if (r) Object.assign(r, patch);
    return r;
  }),
  updateByDownloadId: (downloadId, patchFn) => mutate((list) => {
    const r = list.find((x) => x.downloadId === downloadId);
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
    const ruleIds = await addHeaderRules([item.url], item.referer || item.pageUrl);
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
    return records.add({
      id: uid(), type: 'file', status: 'downloading', downloadId,
      title: title || filename, filename, url: item.url, pageUrl: item.pageUrl, kind: item.kind,
      format: fileExt(item).toUpperCase(), quality, size: item.size || 0, createdAt: Date.now(),
    });
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

// Keep records in sync with the browser's own download states.
api.downloads.onChanged.addListener(async (delta) => {
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
