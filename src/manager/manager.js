import { api, call } from '../shared/api.js';
import { icon, LOGO } from '../shared/icons.js';
import { $, $$, esc, toast, timeAgo, hydrateIcons } from '../shared/ui.js';
import { getSettings, saveSettings, applyTheme, onSettingsChanged } from '../shared/settings.js';
import { formatBytes, formatDuration, formatSpeed, formatBitrate, hostOf } from '../shared/media.js';
import { HlsJob } from './hls-job.js';

const MAX_PARALLEL_STREAMS = 2;
const ACTIVE = ['queued', 'downloading', 'saving'];

const state = {
  records: [],
  view: 'all',
  kind: '',
  query: '',
  jobs: new Map(), // recordId -> HlsJob
  fileLive: new Map(), // recordId -> { received, total, speed }
  cleanup: new Map(), // downloadId -> { url, sink }
  settings: null,
};

init();

async function init() {
  state.settings = await getSettings();
  applyTheme(state.settings.theme);
  onSettingsChanged((s) => { state.settings = s; applyTheme(s.theme); syncThemeIcon(); });
  $('#logo').outerHTML = LOGO;
  $('#empty-logo').outerHTML = LOGO;
  hydrateIcons();
  syncThemeIcon();
  call('manager:register').catch(() => {});

  bindUi();
  const { downloads = [] } = await api.storage.local.get('downloads');
  state.records = downloads;
  await recoverInterrupted();
  render();
  processQueue();

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.downloads) return;
    state.records = changes.downloads.newValue || [];
    scheduleRender();
    processQueue();
  });
  api.downloads.onChanged.addListener(onBrowserDownloadChanged);
  setInterval(pollFiles, 800);
  addEventListener('beforeunload', (e) => {
    if ([...state.jobs.values()].length) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

// ───────────────────────── queue / jobs ─────────────────────────

async function recoverInterrupted() {
  for (const r of state.records) {
    if (r.type === 'stream' && (r.status === 'downloading' || (r.status === 'saving' && !r.downloadId))) {
      await call('records:update', { id: r.id, patch: { status: 'interrupted', error: 'The manager window was closed' } });
    }
  }
  // Remove leftover temp files from interrupted sessions.
  try {
    const dir = await navigator.storage.getDirectory();
    for await (const name of dir.keys()) if (name.startsWith('lfd-')) await dir.removeEntry(name).catch(() => {});
  } catch { /* OPFS unavailable */ }
}

function processQueue() {
  const running = state.jobs.size;
  const queued = state.records.filter((r) => r.type === 'stream' && r.status === 'queued' && !state.jobs.has(r.id)).reverse();
  for (const rec of queued.slice(0, Math.max(0, MAX_PARALLEL_STREAMS - running))) startJob(rec);
}

async function startJob(rec) {
  const job = new HlsJob(rec, { concurrency: state.settings.segmentConcurrency });
  state.jobs.set(rec.id, job);
  $('#keep-open').hidden = false;
  await call('records:update', { id: rec.id, patch: { status: 'downloading', error: '', startedAt: Date.now() } });

  job.addEventListener('progress', () => updateActiveRow(rec.id));
  try {
    const results = await job.run();
    job.stats.phase = 'Saving';
    updateActiveRow(rec.id);
    const ids = [];
    let total = 0;
    for (const res of results) {
      const url = URL.createObjectURL(res.file);
      const base = rec.filename.replace(/\.[a-z0-9]+$/i, '');
      const filename = `${base}${res.suffix}.${res.ext}`;
      const downloadId = await api.downloads.download({
        url, filename, saveAs: state.settings.askWhereToSave, conflictAction: 'uniquify',
      });
      state.cleanup.set(downloadId, { url, sink: res.sink });
      ids.push(downloadId);
      total += res.file.size;
    }
    await call('records:update', {
      id: rec.id,
      patch: { status: 'saving', downloadId: ids[0], extraDownloadIds: ids.slice(1), size: total, progress: 1, duration: job.stats.seconds || rec.duration },
    });
  } catch (e) {
    const canceled = e.name === 'AbortError' && !job.failure;
    await job.discardAll();
    await call('records:update', {
      id: rec.id,
      patch: canceled ? { status: 'canceled', error: '' } : { status: 'failed', error: friendlyError(e) },
    });
    if (!canceled) toast(`Failed: ${friendlyError(e)}`, { error: true, ms: 5000 });
  } finally {
    state.jobs.delete(rec.id);
    $('#keep-open').hidden = state.jobs.size === 0;
    processQueue();
  }
}

function friendlyError(e) {
  const m = e?.message || String(e);
  if (/HTTP 403/.test(m)) return 'Access denied by the server (403). The link may have expired — replay the video and try again.';
  if (/HTTP 404|HTTP 410/.test(m)) return 'The stream is gone (404). Reload the page and try again.';
  if (/Failed to fetch|NetworkError/i.test(m)) return 'Network error — check your connection.';
  if (/QuotaExceeded/i.test(m)) return 'Not enough disk space for the temporary file.';
  return m;
}

async function onBrowserDownloadChanged(delta) {
  const c = state.cleanup.get(delta.id);
  if (c && delta.state && delta.state.current !== 'in_progress') {
    state.cleanup.delete(delta.id);
    setTimeout(async () => {
      URL.revokeObjectURL(c.url);
      await c.sink.discard();
    }, 1500);
  }
}

async function pollFiles() {
  const active = state.records.filter((r) => r.type === 'file' && r.status === 'downloading' && r.downloadId != null);
  for (const r of active) {
    const [d] = await api.downloads.search({ id: r.downloadId }).catch(() => []);
    if (!d) continue;
    const prev = state.fileLive.get(r.id);
    const now = performance.now();
    let speed = prev?.speed || 0;
    if (prev && now > prev.at) {
      const inst = ((d.bytesReceived - prev.received) * 1000) / (now - prev.at);
      speed = prev.speed ? prev.speed * 0.7 + inst * 0.3 : inst;
    }
    state.fileLive.set(r.id, { received: d.bytesReceived, total: d.totalBytes > 0 ? d.totalBytes : r.size, speed, paused: d.paused, at: now });
    if (d.state === 'complete' && r.status !== 'completed') {
      call('records:update', { id: r.id, patch: { status: 'completed', size: d.bytesReceived, finishedAt: Date.now(), savedPath: d.filename } });
    }
    updateActiveRow(r.id);
  }
}

// ───────────────────────── rendering ─────────────────────────

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function matches(r) {
  if (state.kind && r.kind !== state.kind) return false;
  if (state.query) {
    const q = state.query.toLowerCase();
    if (!`${r.title} ${r.filename} ${r.url}`.toLowerCase().includes(q)) return false;
  }
  if (state.view === 'active') return ACTIVE.includes(r.status);
  if (state.view === 'completed') return r.status === 'completed';
  if (state.view === 'failed') return ['failed', 'canceled', 'interrupted'].includes(r.status);
  return true;
}

function render() {
  const all = state.records;
  const counts = {
    all: all.length,
    active: all.filter((r) => ACTIVE.includes(r.status)).length,
    completed: all.filter((r) => r.status === 'completed').length,
    failed: all.filter((r) => ['failed', 'canceled', 'interrupted'].includes(r.status)).length,
  };
  for (const el of $$('[data-n]')) el.textContent = counts[el.dataset.n] || '';
  for (const el of $$('[data-k]')) el.textContent = all.filter((r) => r.kind === el.dataset.k).length || '';
  $('#total-size').textContent = formatBytes(all.filter((r) => r.status === 'completed').reduce((a, r) => a + (r.size || 0), 0)) || '0 B';

  const list = all.filter(matches);
  const active = list.filter((r) => ACTIVE.includes(r.status));
  const rest = list.filter((r) => !ACTIVE.includes(r.status));

  const html = [];
  if (active.length) {
    html.push(`<div class="section-title">In progress · ${active.length}</div><div class="rows">${active.map(activeRow).join('')}</div>`);
  }
  const groups = new Map();
  for (const r of rest) {
    const g = dayGroup(r.finishedAt || r.createdAt);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  for (const [g, rows] of groups) {
    html.push(`<div class="section-title">${g}</div><div class="rows">${rows.map(doneRow).join('')}</div>`);
  }

  $('#content').innerHTML = html.join('');
  $('#content').hidden = !list.length;
  $('#empty').hidden = !!list.length;
  if (!list.length) {
    const filtered = state.query || state.kind || state.view !== 'all';
    $('#empty-title').textContent = filtered ? 'Nothing matches' : 'No downloads yet';
    $('#empty-text').textContent = filtered
      ? 'Try a different search or filter.'
      : 'Open a page with a video or song, click the LFDownloader icon, and pick a quality. Your files show up here.';
  }
  for (const r of active) updateActiveRow(r.id);
}

function dayGroup(ts) {
  const d = new Date(ts);
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ts >= start) return 'Today';
  if (ts >= start - 864e5) return 'Yesterday';
  if (ts >= start - 6 * 864e5) return 'This week';
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function tile(r, stateBadge = '') {
  return `<div class="tile">${icon(r.kind === 'audio' ? 'music' : 'film', 20)}${stateBadge}</div>`;
}

function fileName(r) {
  return (r.savedPath || r.filename || r.title || '').split(/[\\/]/).pop();
}

function activeRow(r) {
  const job = state.jobs.get(r.id);
  const isStream = r.type === 'stream';
  const queued = r.status === 'queued';
  const ops = [];
  if (isStream && job?.stats.live) ops.push(`<button class="btn btn-soft btn-sm" data-op="stop">${icon('stop', 13)}Stop &amp; save</button>`);
  if (!queued) ops.push(`<button class="icon-btn" data-op="pause" title="Pause">${icon('pause', 17)}</button>`);
  ops.push(`<button class="icon-btn" data-op="cancel" title="Cancel">${icon('x', 17)}</button>`);
  return `<div class="row active" data-id="${r.id}" data-kind="${r.kind}">
    ${tile(r)}
    <div class="body">
      <div class="name" title="${esc(fileName(r))}">${esc(fileName(r))}</div>
      <div class="sub"><span class="phase" data-f="phase">${queued ? 'Waiting in queue' : 'Starting…'}</span><span class="sep"></span><span>${esc([r.format, r.quality].filter(Boolean).join(' · '))}</span><span class="sep"></span><span class="num" data-f="bytes"></span><span class="num" data-f="speed"></span><span class="num" data-f="eta"></span></div>
      <div class="progress ${queued ? 'indeterminate' : ''}" data-f="bar"><i></i></div>
    </div>
    <div class="ops"><span class="pct" data-f="pct"></span>${ops.join('')}</div>
  </div>`;
}

function updateActiveRow(id) {
  const row = document.querySelector(`.row.active[data-id="${id}"]`);
  if (!row) return;
  const r = state.records.find((x) => x.id === id);
  const set = (f, v) => { const el = row.querySelector(`[data-f="${f}"]`); if (el && el.textContent !== v) el.textContent = v; };
  const bar = row.querySelector('[data-f="bar"]');
  const fill = bar.querySelector('i');
  const job = state.jobs.get(id);

  if (job) {
    const s = job.stats;
    const live = s.live;
    const pct = !live && s.total ? s.done / s.total : 0;
    set('phase', s.phase === 'Downloading' ? (live ? 'Recording live' : 'Downloading') : s.phase);
    set('bytes', live ? `${formatBytes(s.bytes) || '0 B'} · ${formatDuration(s.seconds)}` : `${formatBytes(s.bytes) || '0 B'}${s.total ? ` · ${s.done}/${s.total} parts` : ''}`);
    set('speed', s.speed ? `· ${formatSpeed(s.speed)}` : '');
    const avg = s.done ? s.bytes / s.done : 0;
    const eta = !live && s.speed && avg ? ((s.total - s.done) * avg) / s.speed : 0;
    set('eta', eta > 1 ? `· ${formatDuration(eta)} left` : '');
    set('pct', live ? '' : `${Math.floor(pct * 100)}%`);
    bar.classList.toggle('indeterminate', live || s.phase === 'Preparing' || s.phase === 'Saving');
    fill.style.width = `${pct * 100}%`;
    const pauseBtn = row.querySelector('[data-op="pause"], [data-op="resume"]');
    if (pauseBtn) {
      const paused = job.paused;
      pauseBtn.dataset.op = paused ? 'resume' : 'pause';
      pauseBtn.title = paused ? 'Resume' : 'Pause';
      pauseBtn.innerHTML = icon(paused ? 'play' : 'pause', 17);
    }
    if (live && !row.querySelector('[data-op="stop"]')) render();
    return;
  }

  if (r?.type === 'file') {
    const f = state.fileLive.get(id);
    if (!f) return;
    const pct = f.total ? f.received / f.total : 0;
    set('phase', f.paused ? 'Paused' : 'Downloading');
    set('bytes', f.total ? `${formatBytes(f.received) || '0 B'} of ${formatBytes(f.total)}` : formatBytes(f.received));
    set('speed', f.speed && !f.paused ? `· ${formatSpeed(f.speed)}` : '');
    const eta = f.speed && f.total ? (f.total - f.received) / f.speed : 0;
    set('eta', eta > 1 && !f.paused ? `· ${formatDuration(eta)} left` : '');
    set('pct', f.total ? `${Math.floor(pct * 100)}%` : '');
    bar.classList.toggle('indeterminate', !f.total);
    fill.style.width = `${pct * 100}%`;
    const pauseBtn = row.querySelector('[data-op="pause"], [data-op="resume"]');
    if (pauseBtn) {
      pauseBtn.dataset.op = f.paused ? 'resume' : 'pause';
      pauseBtn.innerHTML = icon(f.paused ? 'play' : 'pause', 17);
    }
  } else if (r?.status === 'saving') {
    set('phase', 'Saving to disk');
    bar.classList.add('indeterminate');
  }
}

function doneRow(r) {
  const ok = r.status === 'completed';
  const badge = ok ? `<span class="state ok">${icon('check', 10)}</span>` : `<span class="state bad">${icon('x', 10)}</span>`;
  const sub = [];
  sub.push(esc([r.format, r.quality].filter(Boolean).join(' · ')));
  if (r.size) sub.push(`<span class="num">${formatBytes(r.size)}</span>`);
  if (r.duration) sub.push(`<span class="num">${formatDuration(r.duration)}</span>`);
  sub.push(esc(hostOf(r.pageUrl || r.url)));
  if (ok) sub.push(timeAgo(r.finishedAt || r.createdAt));
  else sub.push(`<span class="err">${esc(r.status === 'canceled' ? 'Canceled' : r.error || 'Failed')}</span>`);

  const ops = ok && r.downloadId != null
    ? `<button class="btn btn-soft btn-sm" data-op="open">${icon('play', 13)}Open</button>
       <button class="icon-btn" data-op="show" title="Show in folder">${icon('folder', 17)}</button>`
    : !ok ? `<button class="btn btn-soft btn-sm" data-op="retry">${icon('refresh', 13)}Retry</button>` : '';
  return `<div class="row" data-id="${r.id}" data-kind="${r.kind}">
    ${tile(r, badge)}
    <div class="body">
      <div class="name" title="${esc(fileName(r))}">${esc(fileName(r))}</div>
      <div class="sub">${sub.filter(Boolean).join('<span class="sep"></span>')}</div>
    </div>
    <div class="ops">${ops}
      <button class="icon-btn" data-op="copy" title="Copy source link">${icon('link', 17)}</button>
      <button class="icon-btn" data-op="page" title="Open source page">${icon('external', 17)}</button>
      <button class="icon-btn" data-op="remove" title="Remove from list">${icon('trash', 17)}</button>
    </div>
  </div>`;
}

// ───────────────────────── interactions ─────────────────────────

function bindUi() {
  for (const b of $$('#nav [data-view]')) {
    b.onclick = () => {
      state.view = b.dataset.view;
      for (const x of $$('#nav [data-view]')) x.setAttribute('aria-current', String(x === b));
      render();
    };
  }
  for (const b of $$('#kinds [data-kind]')) {
    b.onclick = () => {
      state.kind = state.kind === b.dataset.kind ? '' : b.dataset.kind;
      for (const x of $$('#kinds [data-kind]')) x.setAttribute('aria-current', String(x.dataset.kind === state.kind));
      render();
    };
  }
  $('#search').oninput = (e) => { state.query = e.target.value.trim(); render(); };
  addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') { e.preventDefault(); $('#search').focus(); }
  });
  $('#btn-clear').onclick = async () => {
    await call('records:clear');
    toast('Cleared finished downloads');
  };
  $('#btn-settings').onclick = () => api.runtime.openOptionsPage();
  $('#btn-theme').onclick = async () => {
    const cur = document.documentElement.dataset.theme;
    await saveSettings({ theme: cur === 'dark' ? 'light' : 'dark' });
  };
  $('#btn-add').onclick = openAdd;
  $('#btn-add-2').onclick = openAdd;
  $('#content').addEventListener('click', onRowClick);
  bindAddDialog();
}

function syncThemeIcon() {
  const btn = $('#btn-theme');
  btn.innerHTML = icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon');
}

async function onRowClick(e) {
  const btn = e.target.closest('[data-op]');
  if (!btn) return;
  const id = btn.closest('.row').dataset.id;
  const r = state.records.find((x) => x.id === id);
  if (!r) return;
  const job = state.jobs.get(id);
  try {
    switch (btn.dataset.op) {
      case 'pause':
        if (job) job.pause(); else if (r.downloadId != null) await api.downloads.pause(r.downloadId);
        updateActiveRow(id);
        break;
      case 'resume':
        if (job) job.resume(); else if (r.downloadId != null) await api.downloads.resume(r.downloadId);
        updateActiveRow(id);
        break;
      case 'stop':
        job?.stop();
        toast('Finishing the recording…');
        break;
      case 'cancel':
        if (job) job.cancel();
        else if (r.downloadId != null && r.type === 'file') await api.downloads.cancel(r.downloadId).catch(() => {});
        else await call('records:update', { id, patch: { status: 'canceled' } });
        break;
      case 'open':
        await api.downloads.open(r.downloadId).catch(() => toast('The file was moved or deleted', { error: true }));
        break;
      case 'show':
        api.downloads.show(r.downloadId);
        break;
      case 'retry':
        await call('retry', { id });
        if (r.type === 'file') await call('records:remove', { ids: [id] });
        toast('Retrying…');
        break;
      case 'copy':
        await navigator.clipboard.writeText(r.url);
        toast('Link copied');
        break;
      case 'page':
        api.tabs.create({ url: r.pageUrl || r.url });
        break;
      case 'remove':
        await call('records:remove', { ids: [id] });
        break;
    }
  } catch (err) {
    toast(err.message, { error: true });
  }
}

// ───────────────────────── add link ─────────────────────────

let pending = null;

function openAdd() {
  pending = null;
  $('#add-url').value = '';
  $('#add-result').innerHTML = '';
  $('#add-go').disabled = true;
  $('#add-dialog').showModal();
  navigator.clipboard?.readText?.().then((t) => {
    if (/^https?:\/\/\S+$/.test(t.trim()) && !$('#add-url').value) $('#add-url').value = t.trim();
  }).catch(() => {});
}

function bindAddDialog() {
  const analyze = async () => {
    const url = $('#add-url').value.trim();
    if (!url) return;
    $('#add-result').innerHTML = `<div class="ar-title"><span class="spinner"></span>Analyzing…</div>`;
    $('#add-go').disabled = true;
    try {
      const item = await call('url:inspect', { url });
      pending = { item, variantId: item.variants?.[0]?.id };
      const kindLabel = item.kind === 'stream' ? (item.format === 'dash' ? 'DASH stream' : 'HLS stream') : `${(item.format || '').toUpperCase()} ${item.kind}`;
      const qs = (item.variants || []).length > 1
        ? `<div class="qualities">${item.variants.map((v) => `<button type="button" class="q" data-v="${v.id}" aria-checked="${v.id === pending.variantId}">${esc(v.label)}${v.bandwidth ? ` · ${formatBitrate(v.bandwidth)}` : ''}</button>`).join('')}</div>`
        : '';
      $('#add-result').innerHTML = `
        <div class="ar-title">${icon(item.kind === 'audio' ? 'music' : item.kind === 'stream' ? 'stream' : 'film', 17)}${esc(item.name || hostOf(url))}</div>
        <div class="ar-meta">${esc([kindLabel, formatBytes(item.size), formatDuration(item.duration), item.live ? 'Live' : '', item.drm ? 'DRM-protected' : ''].filter(Boolean).join(' · '))}</div>${qs}`;
      for (const q of $$('#add-result .q')) {
        q.onclick = () => {
          pending.variantId = q.dataset.v;
          for (const x of $$('#add-result .q')) x.setAttribute('aria-checked', String(x === q));
        };
      }
      $('#add-go').disabled = !!item.drm || item.format === 'dash';
    } catch (e) {
      $('#add-result').innerHTML = `<div class="err">${icon('alert', 16)}${esc(e.message)}</div>`;
    }
  };
  $('#add-analyze').onclick = analyze;
  $('#add-url').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); analyze(); }
  });
  $('#add-go').onclick = async () => {
    if (!pending) return;
    try {
      await call('url:download', pending);
      $('#add-dialog').close();
      toast('Download added');
    } catch (e) {
      toast(e.message, { error: true });
    }
  };
}
