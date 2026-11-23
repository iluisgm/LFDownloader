import { api, call } from '../shared/api.js';
import { icon, LOGO } from '../shared/icons.js';
import { $, $$, esc, toast, hydrateIcons } from '../shared/ui.js';
import { getSettings, applyTheme } from '../shared/settings.js';
import { formatBytes, formatDuration, formatBitrate, hostOf, cleanTitle } from '../shared/media.js';

const params = new URLSearchParams(location.search);
const MODE = params.get('mode') === 'panel' ? 'panel' : 'popup';
const FOCUS = params.get('focus') || '';

const state = {
  tabId: null,
  tab: null,
  items: [],
  filter: 'all',
  selected: new Map(), // itemId -> variantId
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
  applyTheme(settings.theme);
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
  await refresh();
  renderActivity();

  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[`tab:${state.tabId}`]) {
      state.items = changes[`tab:${state.tabId}`].newValue?.items || [];
      render();
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

  for (const b of $$('#filters [data-filter]')) {
    b.onclick = () => {
      state.filter = b.dataset.filter;
      for (const x of $$('#filters [data-filter]')) x.setAttribute('aria-pressed', String(x === b));
      render();
    };
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu, [data-act="more"]')) closeMenus();
  });
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
      await api.scripting.executeScript({ target: { tabId: state.tabId, allFrames: true }, files: ['content/content.js'] });
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
  const counts = { all: state.items.length, video: 0, audio: 0, stream: 0 };
  for (const i of state.items) counts[i.kind] = (counts[i.kind] || 0) + 1;
  for (const el of $$('[data-count]')) el.textContent = counts[el.dataset.count] || '';

  $('#filters').hidden = state.items.length < 2;
  $('#restricted').hidden = !restricted;
  $('#empty').hidden = restricted || state.items.length > 0;
  $('#btn-scan').hidden = restricted;

  const visible = state.items
    .filter((i) => state.filter === 'all' || i.kind === state.filter)
    // Streams and bigger files first: they are almost always "the" video.
    .sort((a, b) => rank(b) - rank(a) || b.detectedAt - a.detectedAt);
  const current = visible.filter(isCurrent);
  const earlier = visible.filter((i) => !isCurrent(i));

  const list = $('#list');
  const scroll = list.scrollTop;
  const html = [];
  html.push(...current.map(cardHtml));
  if (earlier.length) {
    html.push(`<div class="group-label">Earlier in this tab · ${earlier.length}<button data-act="toggle-earlier">${state.showEarlier ? 'Hide' : 'Show'}</button></div>`);
    if (state.showEarlier || !current.length) html.push(...earlier.map(cardHtml));
  }
  list.innerHTML = html.join('');
  list.scrollTop = scroll;
  bindCards();

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
