import { api } from './api.js';

export const DEFAULT_SETTINGS = {
  theme: 'system', // 'system' | 'dark' | 'light'
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

/** Apply the theme setting to a document (`data-theme` on <html>). */
export function applyTheme(theme, doc = document) {
  const resolved = theme === 'system'
    ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : theme;
  doc.documentElement.dataset.theme = resolved;
}
