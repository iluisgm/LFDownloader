import { api } from './api.js';
import { resolveSkin, paintSkin } from './skins.js';

export const DEFAULT_SETTINGS = {
  theme: 'system', // 'system' | 'dark' | 'light'
  skin: 'aurora', // see shared/skins.js, or 'custom'
  accent: '#E5172F', // used by the custom skin
  pureBlack: false, // true-black backgrounds in dark mode (OLED)
  folder: 'LFDownloader', // sub-folder inside the browser's download folder
  askWhereToSave: false,
  filenameTemplate: '{title} - {quality}',
  minSizeKB: 150, // ignore direct files smaller than this (icons, beeps, ads)
  detectVideo: true,
  detectAudio: true,
  detectStreams: true,
  floatingButton: true,
  disabledSites: [], // hostnames where the floating button is hidden
  segmentConcurrency: 6,
  imageSaveMode: '', // '' = best available: 'folder' (Chromium) or 'zip'; or 'files'
  notifyOnComplete: true,
};

export async function getSettings() {
  const { settings } = await api.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await api.storage.local.set({ settings: next });
  return next;
}

export function onSettingsChanged(cb) {
  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) cb({ ...DEFAULT_SETTINGS, ...changes.settings.newValue });
  });
}

/** Apply theme + skin settings to a document (`data-theme` and CSS variables on <html>). */
export function applyTheme(settings, doc = document) {
  const s = typeof settings === 'string' ? { theme: settings } : settings || {};
  const theme = s.theme || 'system';
  const resolved = theme === 'system'
    ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : theme;
  doc.documentElement.dataset.theme = resolved;
  paintSkin(doc.documentElement, resolveSkin(s, resolved));
}
