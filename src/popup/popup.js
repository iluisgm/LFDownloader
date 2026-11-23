import { api, call } from '../shared/api.js';
import { icon, LOGO } from '../shared/icons.js';
import { $, $$, esc, toast, hydrateIcons } from '../shared/ui.js';
import { getSettings, saveSettings, applyTheme, onSettingsChanged } from '../shared/settings.js';
import { formatBytes, formatDuration, formatBitrate, hostOf, cleanTitle } from '../shared/media.js';
import { youtubeId, xStatusId } from '../shared/sites.js';

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
  infoAsked: new Set(), // site items whose qualities were requested from the helper
};

// ───────────────────────── boot ─────────────────────────

init().catch((e) => {
  console.error(e);
  toast(e.message, { error: true });
});

async function init() {
  const settings = await getSettings();
  state.settings = settings;
  applyTheme(settings);
  onSettingsChanged((s) => { state.settings = s; applyTheme(s); renderModeButton(); });
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
  state.imgScan = (await sessionGet(`imgscan:${state.tabId}`)) || null;
  await refresh();
  renderActivity();
  if (AUTO_SCAN) startImageScan();

  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[`tab:${state.tabId}`]) setItems(changes[`tab:${state.tabId}`].newValue?.items || []);
    if (area === 'session' && changes[`imgscan:${state.tabId}`]) setImageScan(changes[`imgscan:${state.tabId}`].newValue || null);
    if (area === 'local' && changes.downloads) renderActivity(changes.downloads.newValue);
  });
  // Firefox gives the in-page panel (an extension frame inside a web page) no
  // session storage and no session change events: ask the background instead.
  if (!HAS_SESSION) setInterval(pollSession, 900);
}

const HAS_SESSION = !!api.storage.session;

async function sessionGet(key) {
  if (HAS_SESSION) return (await api.storage.session.get(key))[key];
  return call('session:get', { key }).catch(() => null);
}

let lastItems = '';
let lastScan = '';
function setItems(items) {
  lastItems = JSON.stringify(items);
  state.items = items;
  render();
}

function setImageScan(scan) {
  lastScan = JSON.stringify(scan);
  state.imgScan = scan;
  renderImageProgress();
  if (state.imgScan?.state === 'done' && state.filter === 'image') {
    const n = state.imgScan.found || 0;
    toast(n ? `Found ${n} full-size image${n > 1 ? 's' : ''}` : 'No full-size images found');
  }
}

async function pollSession() {
  if (document.hidden) return;
  const [items, scan] = await Promise.all([
    call('media:list', { tabId: state.tabId }).catch(() => null),
    sessionGet(`imgscan:${state.tabId}`),
  ]);
  if (items && JSON.stringify(items) !== lastItems) setItems(items);
  if (JSON.stringify(scan ?? null) !== lastScan) setImageScan(scan ?? null);
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
  $('#img-mode').onclick = toggleModeMenu;
  $('#btn-magic').onclick = startMagic;
  $('#img-magic').onclick = startMagic;
  $('#img-magic-first').onclick = startMagic;
  renderModeButton();

  for (const b of $$('#filters [data-filter]')) b.onclick = () => setFilter(b.dataset.filter);
  setFilter(state.filter, false);
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu, [data-act="more"]')) closeMenus();
  });
  // A floating menu would drift away from its card, so close it on scroll/resize.
  document.addEventListener('scroll', closeMenus, true);
  addEventListener('resize', closeMenus);
  addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenus(); });
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
  setItems((await call('media:list', { tabId: state.tabId })) || []);
  lastScan = JSON.stringify(state.imgScan ?? null);
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
  // yt-dlp's title is the real one; only page titles need tidying.
  if (item.source === 'ytdlp' && item.info === 'ready' && item.title) return item.title;
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
  if (item.statusId) return hostOf(item.pageUrl) === hostOf(state.tab.url); // X is one long page
  const here = youtubeId(state.tab.url);
  if (item.videoId && here) return item.videoId === here;
  const strip = (u) => u.split('#')[0];
  return strip(item.pageUrl) === strip(state.tab.url);
}

function render() {
  const restricted = state.tab?.url && !/^(https?|file):/.test(state.tab.url) && !state.items.length;
  const images = state.items.filter((i) => i.kind === 'image');
  // X streams in two pieces (silent video + audio); its yt-dlp card saves one MP4 instead.
  const xCards = state.items.some((i) => i.statusId && i.info !== 'missing');
  const media = state.items.filter((i) => i.kind !== 'image' && !(xCards && /^https:\/\/video\.twimg\.com\//.test(i.url)));
  const counts ={ all: media.length, video: 0, audio: 0, stream: 0, image: images.length };
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
  closeMenus();
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
  if (i.source === 'ytdlp') {
    // YouTube / X: the video the page is about; the post being viewed comes first.
    return i.statusId && i.statusId === xStatusId(state.tab?.url || '') ? 5 : 4;
  }
  if (i.kind === 'stream') return 3;
  if (i.kind === 'video') return 2 + Math.min((i.size || 0) / 1e9, 0.9);
  return 1 + Math.min((i.size || 0) / 1e9, 0.9);
}

function selectedVariant(item) {
  const vs = item.variants || [];
  const id = state.selected.get(item.id);
  return vs.find((v) => v.id === id) || vs.find((v) => v.id === item.defaultVariant) || vs[0] || null;
}

function estimate(item, v) {
  if (item.source === 'ytdlp') return v?.size ? `≈ ${formatBytes(v.size)}` : '';
  if (!v || !item.duration) return '';
  const bps = v.bandwidth || 0;
  if (!bps) return '';
  return `≈ ${formatBytes((bps * item.duration) / 8)}`;
}

function cardHtml(item) {
  const name = displayName(item);
  const site = item.source === 'ytdlp';
  const format = site ? item.site || 'yt-dlp' : item.kind === 'stream' ? (item.format === 'dash' ? 'DASH' : 'HLS') : (item.format || '').toUpperCase();
  const kindIcon = item.kind === 'audio' ? 'music' : item.kind === 'stream' ? 'stream' : 'film';
  const v = selectedVariant(item);
  const dur = formatDuration(item.duration);

  const meta = [`<span class="badge ${item.kind}">${esc(format || item.kind)}</span>`];
  if (item.live) meta.push(`<span class="badge live">${icon('live', 11)}Live</span>`);
  if (item.drm) meta.push(`<span class="badge drm">${icon('lock', 11)}DRM</span>`);
  const bits = [];
  // A stream's own size is just the playlist text — meaningless to show.
  if (item.size && item.kind !== 'stream') bits.push(formatBytes(item.size));
  const est = item.kind === 'stream' || site ? estimate(item, v) : '';
  if (est || (site && item.info === 'ready')) bits.push(`<span class="est">${est}</span>`);
  if (!item.poster && dur) bits.push(dur);
  bits.push(esc(site && item.uploader ? item.uploader : hostOf(item.url)));
  meta.push(bits.join('<span class="sep"></span>'));

  const thumb = item.poster
    ? `<img src="${esc(item.poster)}" alt="" referrerpolicy="no-referrer" loading="lazy">${dur ? `<span class="dur">${dur}</span>` : ''}`
    : icon(kindIcon, 22);

  let qualities = '';
  const variants = (item.variants || []).filter((x) => x.label);
  if ((item.kind === 'stream' || site) && variants.length > 1) {
    qualities = `<div class="qualities" role="radiogroup" aria-label="Quality">${variants.map((x) => {
      const hd = x.height >= 2100 ? '4K' : x.height >= 1400 ? '2K' : x.height >= 1080 ? 'FHD' : x.height >= 720 ? 'HD' : '';
      const sub = x.audioOnly ? (x.sub && x.sub !== 'Audio' ? x.sub : '') : x.bandwidth ? formatBitrate(x.bandwidth) : x.hdr ? 'HDR' : '';
      return `<button class="q" role="radio" data-variant="${x.id}" aria-checked="${x.id === v?.id}" title="${esc([x.label, x.codecs, x.audioName].filter(Boolean).join(' · '))}">
        ${x.audioOnly ? icon('music', 12) : ''}${esc(x.label)}${hd && !x.label.startsWith('4K') ? `<span class="hd">${hd}</span>` : ''}${sub ? `<small>${esc(sub)}</small>` : ''}
      </button>`;
    }).join('')}</div>`;
  }

  let note = '';
  let primary = `<button class="btn btn-primary" data-act="download">${icon('download', 16)}<span>Download</span></button>`;
  if (site && item.info === 'missing') {
    note = `<span class="note-warn">${icon('alert', 13)}Needs the free yt-dlp helper</span>`;
    primary = `<button class="btn btn-primary" data-act="setup">${icon('settings', 15)}<span>Set up</span></button>`;
  } else if (site && item.info === 'error') {
    note = `<span class="note-warn" title="${esc(item.infoError)}">${icon('alert', 13)}${esc(item.infoError || 'yt-dlp could not read this video')}</span>`;
    primary = `<button class="btn btn-soft" data-act="reinfo">${icon('refresh', 15)}Try again</button>`;
  } else if (site && item.info !== 'ready') {
    note = `<span class="note-wait"><span class="spinner"></span>Reading qualities…</span>`;
    primary = `<button class="btn btn-primary" disabled>${icon('download', 16)}<span>Download</span></button>`;
  } else if (site && (item.live || item.upcoming)) {
    note = `<span class="note-warn">${icon('live', 13)}${item.upcoming ? 'Not started yet' : 'Live now'}: download it once it ends</span>`;
    primary = `<button class="btn btn-soft" disabled>${icon('live', 15)}Live</button>`;
  } else if (site) {
    note = `${esc(v?.container?.toUpperCase() || '')} · via yt-dlp`;
  } else if (item.drm) {
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

const infoObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    infoObserver.unobserve(e.target);
    const id = e.target.dataset.id;
    if (state.infoAsked.has(id)) continue;
    state.infoAsked.add(id);
    call('site:info', { tabId: state.tabId, id }).catch(() => {});
  }
}, { rootMargin: '120px 0px' });

function bindCards() {
  infoObserver.disconnect();
  for (const card of $$('.card')) {
    const item = state.items.find((i) => i.id === card.dataset.id);
    if (!item) continue;
    // Read the real qualities once the card is on screen (each look-up runs yt-dlp for a few seconds).
    if (item.source === 'ytdlp' && !item.info && !state.infoAsked.has(item.id)) infoObserver.observe(card);
    for (const q of $$('.q', card)) {
      q.onclick = () => {
        state.selected.set(item.id, q.dataset.variant);
        for (const x of $$('.q', card)) x.setAttribute('aria-checked', String(x === q));
        const est = $('.est', card);
        if (est) est.textContent = estimate(item, selectedVariant(item));
        if (item.source === 'ytdlp') $('.actions .grow', card).textContent = `${selectedVariant(item)?.container?.toUpperCase() || ''} · via yt-dlp`;
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
    case 'more': return openMenu(item, card, btn);
    case 'setup': return openHelperSetup();
    case 'reinfo':
      state.infoAsked.add(item.id);
      return call('site:info', { tabId: state.tabId, id: item.id }).catch((e) => toast(e.message, { error: true }));
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
    const managed = item.kind === 'stream' || item.source === 'ytdlp';
    if (label) label.textContent = managed ? 'Queued' : 'Saving';
    toast(managed ? 'Added to the download manager' : 'Download started');
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
  for (const b of $$('[data-act="more"].active')) b.classList.remove('active');
}

function openMenu(item, card, btn) {
  const wasOpen = $(`.menu[data-for="${CSS.escape(item.id)}"]`);
  closeMenus();
  if (wasOpen) return;
  const v = selectedVariant(item);
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.dataset.for = item.id;
  menu.innerHTML = `
    <button data-m="open">${icon('external', 15)}Open in new tab</button>
    ${item.kind === 'stream' && v && v.url !== item.url ? `<button data-m="copy-variant">${icon('link', 15)}Copy ${esc(v.label)} playlist</button>` : ''}
    <button data-m="ytdlp">${icon('copy', 15)}Copy yt-dlp command</button>
    <button data-m="remove" class="danger">${icon('trash', 15)}Remove from list</button>`;
  // Float above every card (cards are separate layers, and the list clips its children).
  document.body.append(menu);
  placeMenu(menu, btn || card);
  btn?.classList.add('active');
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

/** Put a floating menu under its button, or above it when there is no room below. */
function placeMenu(menu, anchor) {
  const r = anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const gap = 6;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const below = vh - r.bottom - gap;
  const up = below < m.height + 8 && r.top - gap > below;
  const top = up ? Math.max(8, r.top - gap - m.height) : Math.min(r.bottom + gap, vh - m.height - 8);
  const left = Math.min(Math.max(8, r.right - m.width), vw - m.width - 8);
  Object.assign(menu.style, { top: `${top}px`, left: `${left}px` });
  menu.classList.toggle('up', up);
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
  const fromSelection = state.imgScan?.scope === 'selection';
  $('#img-count').textContent = state.imgSel.size
    ? `${state.imgSel.size} of ${images.length} selected`
    : `${images.length} image${images.length === 1 ? '' : 's'}${fromSelection ? ' in your box' : ''}`;
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

const CAN_PICK_FOLDER = 'showDirectoryPicker' in window;
const SAVE_MODES = {
  folder: { icon: 'folder', short: 'Folder', title: 'Into a folder', desc: 'Pick a folder once. Every picture goes straight in.' },
  zip: { icon: 'zip', short: 'ZIP', title: 'As one ZIP file', desc: 'A single file, so at most one save dialog.' },
  files: { icon: 'images', short: 'Files', title: 'As separate downloads', desc: 'Your browser may ask where to save every picture.' },
};

function saveMode() {
  let m = state.settings?.imageSaveMode || (CAN_PICK_FOLDER ? 'folder' : 'zip');
  if (m === 'folder' && !CAN_PICK_FOLDER) m = 'zip';
  return SAVE_MODES[m] ? m : 'zip';
}

function renderModeButton() {
  const m = SAVE_MODES[saveMode()];
  $('#img-mode').innerHTML = `${icon(m.icon, 15)}${m.short}${icon('chevup', 13)}`;
}

function toggleModeMenu(e) {
  e.stopPropagation();
  const open = $('.mode-menu');
  if (open) return open.remove();
  const cur = saveMode();
  const menu = document.createElement('div');
  menu.className = 'mode-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = Object.entries(SAVE_MODES)
    .filter(([k]) => k !== 'folder' || CAN_PICK_FOLDER)
    .map(([k, m]) => `<button role="menuitemradio" data-mode="${k}" aria-checked="${k === cur}">
      <span class="mi">${icon(m.icon, 16)}</span><span><b>${m.title}</b><small>${m.desc}</small></span><span class="ck">${icon('check', 15)}</span>
    </button>`).join('');
  $('.mode-wrap').append(menu);
  menu.onclick = async (ev) => {
    const b = ev.target.closest('[data-mode]');
    if (!b) return;
    menu.remove();
    state.settings = await saveSettings({ imageSaveMode: b.dataset.mode });
    renderModeButton();
  };
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

async function downloadImages() {
  const btn = $('#img-download');
  btn.disabled = true;
  try {
    const mode = saveMode();
    const res = await call('images:download', { tabId: state.tabId, ids: [...state.imgSel], mode });
    const n = `${res.total} picture${res.total > 1 ? 's' : ''}`;
    toast(mode === 'folder' ? `Choose a folder for ${n} in the download manager`
      : mode === 'zip' ? `Packing ${n} into one ZIP…`
      : `Saving ${n} to ${res.folder}`, { ms: 3400 });
    state.imgSel.clear();
    renderImages(state.items.filter((i) => i.kind === 'image'));
  } catch (e) {
    toast(e.message, { error: true });
  } finally {
    btn.disabled = false;
  }
}

/** Close this UI and let the user draw a box on the page. */
async function startMagic() {
  await call('magic:start', { tabId: state.tabId });
  if (MODE === 'popup') window.close();
}

/** Settings page, scrolled to the yt-dlp helper setup. */
function openHelperSetup() {
  api.tabs.create({ url: api.runtime.getURL('options/options.html#helper') });
  if (MODE === 'popup') window.close();
}
