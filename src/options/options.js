import { api } from '../shared/api.js';
import { icon, LOGO } from '../shared/icons.js';
import { $, $$, esc, hydrateIcons, toast } from '../shared/ui.js';
import { getSettings, saveSettings, applyTheme, onSettingsChanged } from '../shared/settings.js';
import { buildFilename, formatBytes } from '../shared/media.js';

const TOGGLES = ['askWhereToSave', 'notifyOnComplete', 'detectVideo', 'detectAudio', 'detectStreams', 'floatingButton'];
let s;
let savedTimer;

init();

async function init() {
  s = await getSettings();
  applyTheme(s.theme);
  $('#logo').outerHTML = LOGO;
  hydrateIcons();
  $('#version').textContent = `v${api.runtime.getManifest().version}`;
  fill();
  bind();
  onSettingsChanged((next) => { s = next; applyTheme(s.theme); renderSites(); });
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => applyTheme(s.theme));
  checkPermission();
  historyInfo();
}

function fill() {
  for (const b of $$('#theme button')) b.setAttribute('aria-pressed', String(b.dataset.v === s.theme));
  $('#folder').value = s.folder;
  $('#filenameTemplate').value = s.filenameTemplate;
  for (const id of TOGGLES) $(`#${id}`).checked = !!s[id];
  $('#minSizeKB').value = s.minSizeKB;
  $('#segmentConcurrency').value = s.segmentConcurrency;
  outputs();
  preview();
  renderSites();
}

function outputs() {
  const kb = Number($('#minSizeKB').value);
  $('#minSizeKB-out').textContent = kb ? formatBytes(kb * 1024) : 'Off';
  $('#segmentConcurrency-out').textContent = $('#segmentConcurrency').value;
}

function preview() {
  $('#name-preview').textContent = buildFilename({
    template: $('#filenameTemplate').value || '{title}',
    title: 'Sunset over Lisbon',
    quality: '1080p',
    url: 'https://www.example.com/v.mp4',
    ext: 'mp4',
    folder: $('#folder').value,
  });
}

async function save(patch) {
  s = await saveSettings(patch);
  const el = $('#saved');
  el.classList.add('on');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el.classList.remove('on'), 1400);
}

function bind() {
  for (const b of $$('#theme button')) {
    b.onclick = async () => {
      for (const x of $$('#theme button')) x.setAttribute('aria-pressed', String(x === b));
      await save({ theme: b.dataset.v });
      applyTheme(b.dataset.v);
    };
  }
  for (const id of TOGGLES) $(`#${id}`).onchange = (e) => save({ [id]: e.target.checked });
  let t;
  const debounced = (fn) => { clearTimeout(t); t = setTimeout(fn, 350); };
  $('#folder').oninput = () => { preview(); debounced(() => save({ folder: $('#folder').value.trim() })); };
  $('#filenameTemplate').oninput = () => { preview(); debounced(() => save({ filenameTemplate: $('#filenameTemplate').value || '{title}' })); };
  $('#minSizeKB').oninput = outputs;
  $('#minSizeKB').onchange = () => save({ minSizeKB: Number($('#minSizeKB').value) });
  $('#segmentConcurrency').oninput = outputs;
  $('#segmentConcurrency').onchange = () => save({ segmentConcurrency: Number($('#segmentConcurrency').value) });
  $('#clear-history').onclick = async () => {
    await api.storage.local.set({ downloads: [] });
    historyInfo();
    toast('History cleared');
  };
  $('#grant').onclick = async () => {
    const ok = await api.permissions.request({ origins: ['<all_urls>'] });
    if (ok) toast('Access granted — you are all set');
    checkPermission();
  };
}

function renderSites() {
  const list = s.disabledSites || [];
  $('#sites').innerHTML = list.length
    ? list.map((h) => `<span class="site">${esc(h)}<button data-h="${esc(h)}" title="Show the button again">${icon('x', 13)}</button></span>`).join('')
    : '<span class="empty-note">None — the button shows everywhere.</span>';
  for (const b of $$('#sites button')) {
    b.onclick = () => save({ disabledSites: list.filter((h) => h !== b.dataset.h) });
  }
}

async function checkPermission() {
  const ok = await api.permissions.contains({ origins: ['<all_urls>'] });
  $('#perm-row').hidden = ok;
}

async function historyInfo() {
  const { downloads = [] } = await api.storage.local.get('downloads');
  $('#history-info').textContent = `${downloads.length} entr${downloads.length === 1 ? 'y' : 'ies'}. Files on disk are never touched.`;
}

