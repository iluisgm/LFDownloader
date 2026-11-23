import { api, call } from '../shared/api.js';
import { icon, LOGO } from '../shared/icons.js';
import { $, $$, esc, toast, hydrateIcons } from '../shared/ui.js';
import { getSettings, applyTheme, onSettingsChanged } from '../shared/settings.js';
import { formatBytes, formatDuration, formatBitrate, hostOf, cleanTitle } from '../shared/media.js';

const params = new URLSearchParams(location.search);
const MODE = params.get('mode') === 'panel' ? 'panel' : 'popup';
const FOCUS = params.get('focus') || '';
const VIEW = params.get('view') || '';
const AUTO_SCAN = params.get('scan') === '1';

const state = {
  tabId: null,
  tab: null,
  items: [],
  filter: VIEW === 'images' ? 'image' : 'all',
  selected: new Map(), // itemId -> variantId
  imgSel: new Set(), // selected image ids
  imgScan: null, // { state, done, total, found }
  showEarlier: false,
  focusDone: false,
};

// ───────────────────────── boot ─────────────────────────

init().catch((e) => {
  console.error(e);
  toast(e.message, { error: true });
});

async function init() {
  const settings = await getSettings();
  applyTheme(settings);
  onSettingsChanged(applyTheme);
  document.body.classList.toggle('panel', MODE === 'panel');
  $('#logo').outerHTML = LOGO;
  hydrateIcons();

  if (MODE === 'panel') {
    $('#btn-close').hidden = false;
    state.tabId = await call('whoami');
    addEventListener('keydown', (e) => e.key === 'Escape' && closePanel());
  } else if (params.get('tab')) {
    state.tabId = Number(params.get('tab'));
  } else {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    state.tabId = tab?.id;
  }
  try {
    state.tab = await api.tabs.get(state.tabId);
  } catch { /* panel inside a tab we can't read */ }

  $('#page-host').textContent = hostOf(state.tab?.url || '') || cleanTitle(state.tab?.title || '') || ' ';

  bindChrome();
  ({ [`imgscan:${state.tabId}`]: state.imgScan = null } = await api.storage.session.get(`imgscan:${state.tabId}`));
  await refresh();
  renderActivity();
  if (AUTO_SCAN) startImageScan();

  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[`tab:${state.tabId}`]) {
      state.items = changes[`tab:${state.tabId}`].newValue?.items || [];
      render();
    }
    if (area === 'session' && changes[`imgscan:${state.tabId}`]) {
      state.imgScan = changes[`imgscan:${state.tabId}`].newValue || null;
      renderImageProgress();
      if (state.imgScan?.state === 'done' && state.filter === 'image') {
        const n = state.imgScan.found || 0;
        toast(n ? `Found ${n} full-size image${n > 1 ? 's' : ''}` : 'No full-size images found');
      }
    }
    if (area === 'local' && changes.downloads) renderActivity(changes.downloads.newValue);
  });
}

function bindChrome() {
  const openManager = async () => {
    await call('manager:open');
    if (MODE === 'popup') window.close();
  };
  $('#btn-manager').onclick = openManager;
  $('#btn-manager-2').onclick = openManager;
  $('#btn-settings').onclick = () => {
    api.runtime.openOptionsPage();
    if (MODE === 'popup') window.close();
  };
  $('#btn-close').onclick = closePanel;
  $('#btn-scan').onclick = rescan;
  $('#btn-scan-empty').onclick = rescan;
  $('#btn-images').onclick = () => { setFilter('image'); startImageScan(); };
  $('#btn-images-empty').onclick = () => { setFilter('image'); startImageScan(); };
  $('#img-scan-first').onclick = startImageScan;
  $('#img-rescan').onclick = startImageScan;
  $('#img-stop').onclick = () => api.tabs.sendMessage(state.tabId, { type: 'lfd:images-stop' }, { frameId: 0 }).catch(() => {});
  $('#img-selall').onclick = toggleSelectAll;
  $('#img-download').onclick = downloadImages;
  $('#img-clear').onclick = async () => { state.imgSel.clear(); await call('images:clear', { tabId: state.tabId }); };

  for (const b of $$('#filters [data-filter]')) b.onclick = () => setFilter(b.dataset.filter);
  setFilter(state.filter, false);
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu, [data-act="more"]')) closeMenus();
  });
}

function setFilter(f, draw = true) {
  state.filter = f;
  for (const x of $$('#filters [data-filter]')) x.setAttribute('aria-pressed', String(x.dataset.filter === f));
  if (draw) render();
}

function closePanel() {
  parent.postMessage({ lfd: 'close' }, '*');
}

async function refresh() {
  state.items = (await call('media:list', { tabId: state.tabId })) || [];
  render();
}

async function rescan() {
  const btn = $('#btn-scan');
  btn.classList.add('spinning');
  try {
    await api.tabs.sendMessage(state.tabId, { type: 'lfd:rescan' });
  } catch {
    try {
      await api.scripting.executeScript({ target: { tabId: state.tabId, allFrames: true }, files: ['content/extract.js', 'content/content.js'] });
      await api.tabs.sendMessage(state.tabId, { type: 'lfd:rescan' });
    } catch { /* restricted page */ }
  }
  await new Promise((r) => setTimeout(r, 500));
  await refresh();
  btn.classList.remove('spinning');
  const n = state.items.length;
  toast(n ? `${n} item${n > 1 ? 's' : ''} on this page` : 'No media found yet — try playing it');
}

// ───────────────────────── render ─────────────────────────

const GENERIC = /^(index|master|playlist|manifest|video|audio|media|chunklist.*|stream|hls|dash|output|file|download|main|default|source|mp4|play|get|view|\d+)$/i;

function displayName(item) {
  const name = (item.name || '').replace(/[_+]+/g, ' ').trim();
  const meaningful = name.length >= 4 && /[a-z]/i.test(name) && !GENERIC.test(name) && !/^[a-f0-9-]{12,}$/i.test(name);
  const page = cleanTitle(item.title);
  // Multiple files on one page (e.g. an album): their own names tell them apart.
  const siblings = state.items.filter((i) => i.kind === item.kind && i.kind !== 'stream').length;
  if (meaningful && (siblings > 1 || !page)) return name;
  return page || (meaningful ? name : hostOf(item.url) || 'Untitled media');
}

function isCurrent(item) {
  if (!state.tab?.url || !item.pageUrl) return true;
  const strip = (u) => u.split('#')[0];
  return strip(item.pageUrl) === strip(state.tab.url);
}

function render() {
  const restricted = state.tab?.url && !/^(https?|file):/.test(state.tab.url) && !state.items.length;
  const images = state.items.filter((i) => i.kind === 'image');
  const media = state.items.filter((i) => i.kind !== 'image');
  const counts = { all: media.length, video: 0, audio: 0, stream: 0, image: images.length };
  for (const i of media) counts[i.kind] = (counts[i.kind] || 0) + 1;
  for (const el of $$('[data-count]')) el.textContent = counts[el.dataset.count] || '';

  const imageView = state.filter === 'image';
  $('#filters').hidden = !imageView && !images.length && media.length < 2;
  $('#restricted').hidden = !restricted || imageView;
  $('#empty').hidden = restricted || imageView || state.items.length > 0;
  $('#btn-scan').hidden = restricted;
  $('#images-view').hidden = !imageView;
  $('#list').hidden = imageView;
  if (imageView) return renderImages(images);

  const visible = media
    .filter((i) => state.filter === 'all' || i.kind === state.filter)
    // Streams and bigger files first: they are almost always "the" video.
    .sort((a, b) => rank(b) - rank(a) || b.detectedAt - a.detectedAt);
  const current = visible.filter(isCurrent);
  const earlier = visible.filter((i) => !isCurrent(i));

  const list = $('#list');
  const scroll = list.scrollTop;
  const html = [];
  if (state.filter === 'all' && images.length) html.push(imageSummaryHtml(images));
  html.push(...current.map(cardHtml));
  if (earlier.length) {
    html.push(`<div class="group-label">Earlier in this tab · ${earlier.length}<button data-act="toggle-earlier">${state.showEarlier ? 'Hide' : 'Show'}</button></div>`);
    if (state.showEarlier || !current.length) html.push(...earlier.map(cardHtml));
  }
  list.innerHTML = html.join('');
  list.scrollTop = scroll;
  bindCards();
  const sum = $('.img-summary', list);
  if (sum) sum.onclick = () => setFilter('image');

  if (FOCUS && !state.focusDone) {
    const el = list.querySelector(`[data-key="${CSS.escape(FOCUS)}"]`);
    if (el) {
      el.classList.add('focus');
      el.scrollIntoView({ block: 'center' });
      state.focusDone = true;
    }
  }
}

function rank(i) {
  if (i.drm) return 0;
  if (i.kind === 'stream') return 3;
  if (i.kind === 'video') return 2 + Math.min((i.size || 0) / 1e9, 0.9);
  return 1 + Math.min((i.size || 0) / 1e9, 0.9);
}

function selectedVariant(item) {
  const vs = item.variants || [];
  const id = state.selected.get(item.id);
  return vs.find((v) => v.id === id) || vs[0] || null;
}

function estimate(item, v) {
  if (!v || !item.duration) return '';
  const bps = v.bandwidth || 0;
  if (!bps) return '';
  return `≈ ${formatBytes((bps * item.duration) / 8)}`;
}

function cardHtml(item) {
  const name = displayName(item);
  const format = item.kind === 'stream' ? (item.format === 'dash' ? 'DASH' : 'HLS') : (item.format || '').toUpperCase();
  const kindIcon = item.kind === 'audio' ? 'music' : item.kind === 'stream' ? 'stream' : 'film';
  const v = selectedVariant(item);
  const dur = formatDuration(item.duration);

  const meta = [`<span class="badge ${item.kind}">${esc(format || item.kind)}</span>`];
  if (item.live) meta.push(`<span class="badge live">${icon('live', 11)}Live</span>`);
  if (item.drm) meta.push(`<span class="badge drm">${icon('lock', 11)}DRM</span>`);
  const bits = [];
  // A stream's own size is just the playlist text — meaningless to show.
  if (item.size && item.kind !== 'stream') bits.push(formatBytes(item.size));
  const est = item.kind === 'stream' ? estimate(item, v) : '';
  if (est) bits.push(`<span class="est">${est}</span>`);
  if (!item.poster && dur) bits.push(dur);
  bits.push(esc(hostOf(item.url)));
  meta.push(bits.join('<span class="sep"></span>'));

  const thumb = item.poster
    ? `<img src="${esc(item.poster)}" alt="" referrerpolicy="no-referrer" loading="lazy">${dur ? `<span class="dur">${dur}</span>` : ''}`
    : icon(kindIcon, 22);

  let qualities = '';
  const variants = (item.variants || []).filter((x) => x.label);
  if (item.kind === 'stream' && variants.length > 1) {
    qualities = `<div class="qualities" role="radiogroup" aria-label="Quality">${variants.map((x) => {
      const hd = x.height >= 2100 ? '4K' : x.height >= 1080 ? 'FHD' : x.height >= 720 ? 'HD' : '';
      const sub = x.audioOnly ? (x.sub && x.sub !== 'Audio' ? x.sub : '') : x.bandwidth ? formatBitrate(x.bandwidth) : '';
      return `<button class="q" role="radio" data-variant="${x.id}" aria-checked="${x.id === v?.id}" title="${esc([x.label, x.codecs, x.audioName].filter(Boolean).join(' · '))}">
        ${x.audioOnly ? icon('music', 12) : ''}${esc(x.label)}${hd && !x.label.startsWith('4K') ? `<span class="hd">${hd}</span>` : ''}${sub ? `<small>${esc(sub)}</small>` : ''}
      </button>`;
    }).join('')}</div>`;
  }

  let note = '';
  let primary = `<button class="btn btn-primary" data-act="download">${icon('download', 16)}<span>Download</span></button>`;
  if (item.drm) {
    note = `<span class="note-warn">${icon('lock', 13)}Protected by DRM</span>`;
    primary = `<button class="btn btn-soft" disabled>${icon('lock', 15)}Protected</button>`;
  } else if (item.format === 'dash') {
    note = 'DASH — coming soon. Copy the link for yt-dlp.';
    primary = `<button class="btn btn-soft" data-act="copy">${icon('copy', 15)}Copy link</button>`;
  } else if (item.live) {
    primary = `<button class="btn btn-primary" data-act="download">${icon('live', 16)}<span>Record</span></button>`;
  } else if (item.error) {
    note = `<span class="note-warn" title="${esc(item.error)}">${icon('alert', 13)}${esc(item.error)}</span>`;
  } else if (item.kind === 'stream' && v?.audioUrl) {
    note = 'Video + separate audio track';
  } else if (item.kind === 'stream' && variants.length === 1) {
    note = 'Single quality stream';
  }

  return `<article class="card" data-id="${item.id}" data-key="${esc(item.key)}" data-kind="${item.kind}">
    <div class="card-main">
      <div class="thumb">${thumb}</div>
      <div class="info">
        <div class="title" title="${esc(name)}">${esc(name)}</div>
        <div class="meta">${meta.join('')}</div>
      </div>
    </div>
    ${qualities}
    <div class="actions">
      <span class="grow">${note}</span>
      <button class="icon-btn sm" data-act="copy" title="Copy link">${icon('copy', 16)}</button>
      <button class="icon-btn sm" data-act="more" title="More">${icon('more', 16)}</button>
      ${primary}
    </div>
  </article>`;
}

function bindCards() {
  for (const card of $$('.card')) {
    const item = state.items.find((i) => i.id === card.dataset.id);
    if (!item) continue;
    for (const q of $$('.q', card)) {
      q.onclick = () => {
        state.selected.set(item.id, q.dataset.variant);
        for (const x of $$('.q', card)) x.setAttribute('aria-checked', String(x === q));
        const est = $('.est', card);
        if (est) est.textContent = estimate(item, selectedVariant(item));
      };
    }
    for (const b of $$('[data-act]', card)) b.onclick = (e) => act(b.dataset.act, item, b, card, e);
  }
  const toggle = $('[data-act="toggle-earlier"]');
  if (toggle) toggle.onclick = () => { state.showEarlier = !state.showEarlier; render(); };
}

async function act(action, item, btn, card) {
  switch (action) {
    case 'download': return download(item, btn);
    case 'copy': {
      const v = selectedVariant(item);
      await navigator.clipboard.writeText(item.kind === 'stream' && item.format !== 'dash' ? item.url : v?.url || item.url);
      return toast('Link copied');
    }
    case 'more': return openMenu(item, card);
  }
}

async function download(item, btn) {
  const v = selectedVariant(item);
  btn.classList.add('is-busy');
  btn.disabled = true;
  const label = btn.querySelector('span');
  const old = label?.textContent;
  if (label) label.textContent = 'Starting…';
  btn.insertAdjacentHTML('afterbegin', '<span class="spinner"></span>');
  try {
    await call('media:download', { tabId: state.tabId, id: item.id, variantId: v?.id, title: displayName(item) });
    btn.querySelector('.spinner')?.remove();
    btn.classList.remove('is-busy');
    btn.classList.add('is-done');
    if (label) label.textContent = item.kind === 'stream' ? 'Queued' : 'Saving';
    toast(item.kind === 'stream' ? 'Added to the download manager' : 'Download started');
    setTimeout(() => {
      btn.classList.remove('is-done');
      btn.disabled = false;
      if (label) label.textContent = old;
    }, 2200);
  } catch (e) {
    btn.querySelector('.spinner')?.remove();
    btn.classList.remove('is-busy');
    btn.disabled = false;
    if (label) label.textContent = old;
    toast(e.message, { error: true, ms: 4200 });
  }
}

function closeMenus() {
  for (const m of $$('.menu')) m.remove();
}

function openMenu(item, card) {
  const wasOpen = card.querySelector('.menu');
  closeMenus();
  if (wasOpen) return;
  const v = selectedVariant(item);
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.innerHTML = `
    <button data-m="open">${icon('external', 15)}Open in new tab</button>
    ${item.kind === 'stream' && v && v.url !== item.url ? `<button data-m="copy-variant">${icon('link', 15)}Copy ${esc(v.label)} playlist</button>` : ''}
    <button data-m="ytdlp">${icon('copy', 15)}Copy yt-dlp command</button>
    <button data-m="remove" class="danger">${icon('trash', 15)}Remove from list</button>`;
  card.append(menu);
  menu.onclick = async (e) => {
    const m = e.target.closest('[data-m]')?.dataset.m;
    closeMenus();
    if (m === 'open') api.tabs.create({ url: item.url });
    if (m === 'copy-variant') { await navigator.clipboard.writeText(v.url); toast('Playlist link copied'); }
    if (m === 'ytdlp') {
      const ref = item.referer || item.pageUrl;
      const cmd = `yt-dlp ${ref ? `--referer "${ref}" ` : ''}"${item.url}"`;
      await navigator.clipboard.writeText(cmd);
      toast('yt-dlp command copied');
    }
    if (m === 'remove') await call('media:remove', { tabId: state.tabId, id: item.id });
  };
}

async function renderActivity(list) {
  if (!list) ({ downloads: list = [] } = await api.storage.local.get('downloads'));
  const active = list.filter((d) => d.status === 'downloading' || d.status === 'queued' || d.status === 'saving');
  const el = $('#activity');
  el.classList.toggle('on', active.length > 0);
  $('#activity-text').textContent = active.length
    ? `${active.length} download${active.length > 1 ? 's' : ''} in progress`
    : 'No active downloads';
}

// ───────────────────────── images ─────────────────────────

function imageSummaryHtml(images) {
  const thumbs = images.slice(0, 3).map((i) => `<img src="${esc(i.thumb || i.url)}" alt="" loading="lazy">`).join('');
  return `<button class="img-summary">
    <span class="stack">${thumbs}</span>
    <span><b>${images.length} image${images.length > 1 ? 's' : ''} found</b><small>Full-size pictures from this page</small></span>
    ${icon('chevron', 16)}
  </button>`;
}

async function startImageScan() {
  setFilter('image');
  state.imgScan = { state: 'running', done: 0, total: 0, found: 0 };
  renderImageProgress();
  const msg = { type: 'lfd:images-scan' };
  try {
    await api.tabs.sendMessage(state.tabId, msg, { frameId: 0 });
  } catch {
    try {
      await api.scripting.executeScript({ target: { tabId: state.tabId, allFrames: true }, files: ['content/extract.js', 'content/content.js'] });
      await api.tabs.sendMessage(state.tabId, msg, { frameId: 0 });
    } catch {
      state.imgScan = null;
      renderImageProgress();
      toast("This page can't be scanned", { error: true });
    }
  }
}

function renderImageProgress() {
  const s = state.imgScan;
  const running = s?.state === 'running';
  $('#img-progress').hidden = !running;
  if (running) {
    const pct = s.total ? (s.done / s.total) * 100 : 0;
    $('#img-progress-bar').style.width = `${pct}%`;
    $('#img-progress-bar').parentElement.classList.toggle('indeterminate', !s.total);
    $('#img-progress-text').textContent = s.total
      ? `Following thumbnails… ${s.done}/${s.total}`
      : 'Looking for thumbnails…';
  }
  if (state.filter === 'image') renderImages(state.items.filter((i) => i.kind === 'image'));
}

function dims(i) {
  return i.width && i.height ? `${i.width}×${i.height}` : '';
}

function renderImages(images) {
  for (const id of [...state.imgSel]) if (!images.some((i) => i.id === id)) state.imgSel.delete(id);
  const running = state.imgScan?.state === 'running';
  const grid = $('#img-grid');
  $('#img-empty').hidden = images.length > 0 || running;
  $('#img-actions').hidden = !images.length;
  $('.img-bar').hidden = !images.length;
  $('#img-count').textContent = state.imgSel.size
    ? `${state.imgSel.size} of ${images.length} selected`
    : `${images.length} image${images.length === 1 ? '' : 's'}`;
  const all = images.length && state.imgSel.size === images.length;
  $('#img-selall').setAttribute('aria-checked', all ? 'true' : state.imgSel.size ? 'mixed' : 'false');
  const label = $('#img-download span');
  label.textContent = state.imgSel.size ? `Download ${state.imgSel.size} selected` : `Download all ${images.length}`;
  grid.classList.toggle('selecting', state.imgSel.size > 0);

  // Only append new tiles so thumbnails don't reload while a scan streams in.
  const have = new Map($$('.tile', grid).map((t) => [t.dataset.id, t]));
  for (const [id, el] of have) if (!images.some((i) => i.id === id)) el.remove();
  for (const i of images) {
    let el = have.get(i.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'tile';
      el.dataset.id = i.id;
      el.setAttribute('role', 'checkbox');
      el.tabIndex = 0;
      el.title = i.name || i.url;
      el.innerHTML = `<img src="${esc(i.thumb || i.url)}" alt="" loading="lazy" decoding="async">
        <span class="cb">${icon('check', 12)}</span>
        <button class="open" title="Open full image">${icon('external', 13)}</button>
        ${dims(i) ? `<span class="dim">${esc(dims(i))}</span>` : ''}`;
      el.querySelector('img').onerror = (e) => { e.target.replaceWith(Object.assign(document.createElement('span'), { className: 'broken', innerHTML: icon('image', 20) })); };
      el.querySelector('.open').onclick = (e) => { e.stopPropagation(); api.tabs.create({ url: i.url }); };
      const toggle = () => {
        if (state.imgSel.has(i.id)) state.imgSel.delete(i.id); else state.imgSel.add(i.id);
        renderImages(state.items.filter((x) => x.kind === 'image'));
      };
      el.onclick = toggle;
      el.onkeydown = (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); } };
      grid.append(el);
    }
    el.setAttribute('aria-checked', String(state.imgSel.has(i.id)));
  }
}

function toggleSelectAll() {
  const images = state.items.filter((i) => i.kind === 'image');
  if (state.imgSel.size === images.length) state.imgSel.clear();
  else for (const i of images) state.imgSel.add(i.id);
  renderImages(images);
}

async function downloadImages() {
  const btn = $('#img-download');
  btn.disabled = true;
  try {
    const res = await call('images:download', { tabId: state.tabId, ids: [...state.imgSel] });
    toast(`Saving ${res.total} image${res.total > 1 ? 's' : ''} to ${res.folder}`, { ms: 3400 });
    state.imgSel.clear();
    renderImages(state.items.filter((i) => i.kind === 'image'));
  } catch (e) {
    toast(e.message, { error: true });
  } finally {
    btn.disabled = false;
  }
}
