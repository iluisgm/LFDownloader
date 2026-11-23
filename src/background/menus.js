// Right-click menu: download a specific video/audio/link, or scan the page.
import { api } from '../shared/api.js';
import { VIDEO_EXT, AUDIO_EXT, STREAM_EXT, classify, dedupeKey, hostOf } from '../shared/media.js';

const MEDIA_PATTERNS = [...VIDEO_EXT, ...AUDIO_EXT, ...STREAM_EXT].flatMap((ext) => [
  `*://*/*.${ext}`, `*://*/*.${ext}?*`, `*://*/*.${ext.toUpperCase()}`,
]);

export async function createMenus() {
  await api.contextMenus.removeAll();
  const add = (props) => api.contextMenus.create(props, () => void api.runtime.lastError);
  add({ id: 'lfd-media', title: 'Download this media', contexts: ['video', 'audio'] });
  add({ id: 'lfd-link', title: 'Download link with LFDownloader', contexts: ['link'], targetUrlPatterns: MEDIA_PATTERNS });
  add({ id: 'lfd-scan', title: 'Scan page for media', contexts: ['page', 'frame', 'selection', 'image', 'video', 'audio', 'link'] });
  add({ id: 'lfd-images', title: 'Find full-size images on this page', contexts: ['page', 'frame', 'image', 'link'] });
  add({ id: 'lfd-manager', title: 'Open download manager', contexts: ['action'] });
  add({ id: 'lfd-options', title: 'Settings', contexts: ['action'] });
}

/**
 * @param deps.openPanel  (tabId, focusUrl?) => Promise
 * @param deps.downloadUrl (tabId, url, kind) => Promise
 */
export function handleMenuClicks({ openPanel, downloadUrl, openManager, scanImages }) {
  api.contextMenus.onClicked.addListener(async (info, tab) => {
    const tabId = tab?.id;
    try {
      switch (info.menuItemId) {
        case 'lfd-media': {
          const src = info.srcUrl || '';
          const c = /^https?:/.test(src) ? classify(src, info.mediaType === 'audio' ? 'audio/' : '') : null;
          if (c && !c.segment && c.kind !== 'stream') {
            await downloadUrl(tabId, src, info.mediaType || c.kind);
          } else {
            // blob:/MediaSource players: show what the network sniffer caught.
            await openPanel(tabId, src && !src.startsWith('blob:') ? dedupeKey(src) : '');
          }
          break;
        }
        case 'lfd-link': {
          const c = classify(info.linkUrl);
          if (c?.kind === 'stream') await openPanel(tabId, dedupeKey(info.linkUrl), info.linkUrl);
          else await downloadUrl(tabId, info.linkUrl, c?.kind || 'video');
          break;
        }
        case 'lfd-scan':
          await openPanel(tabId, '', null, { rescan: true });
          break;
        case 'lfd-images':
          await scanImages(tabId);
          break;
        case 'lfd-manager':
          await openManager();
          break;
        case 'lfd-options':
          await api.runtime.openOptionsPage();
          break;
      }
    } catch (e) {
      console.warn('[LFD] menu action failed', e, hostOf(tab?.url || ''));
    }
  });
}
