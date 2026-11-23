import { api } from '../shared/api.js';
import { icon, LOGO } from '../shared/icons.js';
import { $, $$, esc, hydrateIcons, toast } from '../shared/ui.js';
import { getSettings, saveSettings, applyTheme, onSettingsChanged } from '../shared/settings.js';
import { buildFilename, formatBytes } from '../shared/media.js';
import { SKINS, resolveSkin } from '../shared/skins.js';

const TOGGLES = ['pureBlack', 'askWhereToSave', 'notifyOnComplete', 'detectVideo', 'detectAudio', 'detectStreams', 'floatingButton'];
let s;
let savedTimer;

init();

async function init() {
  s = await getSettings();
  applyTheme(s);
  $('#logo').outerHTML = LOGO;
  hydrateIcons();
  $('#version').textContent = `v${api.runtime.getManifest().version}`;
  fill();
  bind();
  bindHelper();
  onSettingsChanged((next) => { s = next; applyTheme(s); renderSites(); });
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => applyTheme(s));
  checkPermission();
  historyInfo();
  checkHelper();
  if (location.hash === '#helper') $('#helper').scrollIntoView({ block: 'start' });
}

/** Shows whether the yt-dlp helper answers, or how to set it up. */
async function checkHelper(fresh = false) {
  const box = $('#helper-state');
  box.innerHTML = '<span class="spinner"></span>Checking…';
  let st;
  try {
    const res = await api.runtime.sendMessage({ type: 'helper:status', fresh });
    st = res?.data || {};
  } catch {
    st = {};
  }
  const ok = st.installed && st.ytdlp;
  box.className = `helper-state ${ok ? 'ok' : 'bad'}`;
  box.innerHTML = ok
    ? `${icon('check', 14)}Connected · yt-dlp ${esc(st.ytdlp)}${st.ffmpeg ? ' · ffmpeg' : ' · <span class="warn">no ffmpeg</span>'}`
    : st.installed ? `${icon('alert', 14)}Helper found, but ${esc(st.error || 'yt-dlp is missing')}` : `${icon('alert', 14)}Not set up`;
  $('#helper-setup').hidden = !!ok;
  $('#helper-update').hidden = !ok;
  const firefox = !!st.firefox;
  $('#cmd-install').textContent = firefox ? 'npm run helper:install' : `npm run helper:install -- --id ${st.extensionId || api.runtime.id}`;
  $('#cmd-update').textContent = 'yt-dlp -U   (or: pip install -U yt-dlp)';
}

function bindHelper() {
  for (const b of $$('[data-copy]')) {
    b.onclick = async () => {
      await navigator.clipboard.writeText($(`#${b.dataset.copy}`).textContent);
      toast('Copied');
    };
  }
  $('#helper-check').onclick = () => checkHelper(true);
  $('#helper-recheck').onclick = () => checkHelper(true);
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
  renderSkins();
}

function skinCard(id, name, tagline) {
  const sk = resolveSkin({ ...s, skin: id }, 'dark');
  const bg = sk.neutrals?.['--bg'] || '#0F1118';
  const [a1, a2, a3] = sk.accents;
  const k = sk.kinds;
  return `<div class="skin" role="radio" tabindex="0" data-skin="${id}" aria-checked="${s.skin === id}"
      style="--pv-bg:${bg};--pv-1:${a1};--pv-2:${a2};--pv-3:${a3}">
    <div class="sw">
      <span class="pv-bar"></span>
      <span class="pv-row"><span class="pv-btn"></span><span class="pv-dot" style="background:${k.video}"></span><span class="pv-dot" style="background:${k.audio}"></span><span class="pv-dot" style="background:${k.stream}"></span></span>
    </div>
    <div class="meta"><div><b>${esc(name)}</b><small>${esc(tagline)}</small></div><span class="tick">${icon('check', 12)}</span></div>
    ${id === 'custom' ? `<input type="color" id="accent" value="${esc(s.accent)}" title="Pick your accent color" aria-label="Accent color">` : ''}
  </div>`;
}

function renderSkins() {
  const cards = Object.entries(SKINS).map(([id, sk]) => skinCard(id, sk.name, sk.tagline));
  cards.push(skinCard('custom', 'Custom', 'Your own accent'));
  $('#skins').innerHTML = cards.join('');
  for (const el of $$('#skins .skin')) {
    const pick = () => {
      if (s.skin === el.dataset.skin) return;
      save({ skin: el.dataset.skin }).then(() => { applyTheme(s); renderSkins(); });
    };
    el.addEventListener('click', (e) => { if (e.target.id !== 'accent') pick(); });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
  }
  const accent = $('#accent');
  // Live preview while dragging, save when the picker closes.
  accent.addEventListener('input', () => applyTheme({ ...s, skin: 'custom', accent: accent.value }));
  accent.addEventListener('change', () => save({ skin: 'custom', accent: accent.value }).then(() => { applyTheme(s); renderSkins(); }));
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
      applyTheme(s);
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

