// LFDownloader content script (classic script, runs in every frame).
// 1. Scans the DOM for <video>/<audio>/links/meta tags and reports them.
// 2. Shows a floating "Download" button over videos (closed Shadow DOM).
// 3. In the top frame, hosts the slide-in media panel (an extension iframe).
(() => {
  if (window.__lfdLoaded) return;
  window.__lfdLoaded = true;

  const api = globalThis.browser ?? globalThis.chrome;
  const EXT_ORIGIN = new URL(api.runtime.getURL('/')).origin;
  const IS_TOP = window === window.top;
  const MEDIA_EXT = /\.(mp4|m4v|webm|mkv|mov|avi|flv|wmv|3gp|ogv|mpe?g|mp3|m4a|aac|wav|flac|ogg|oga|opus|wma|aiff?|m3u8|mpd)(?:$|[?#])/i;

  let settings = { floatingButton: true, disabledSites: [] };
  const host = location.hostname.replace(/^www\./, '');

  const send = (type, payload = {}) => api.runtime.sendMessage({ type, ...payload }).catch(() => null);

  let skinColors = null;
  api.storage.local.get(['settings', 'skinColors']).then(({ settings: s, skinColors: sc }) => {
    settings = { ...settings, ...(s || {}) };
    skinColors = sc || null;
  });
  api.storage.onChanged.addListener((c, area) => {
    if (area !== 'local') return;
    if (c.settings) {
      settings = { ...settings, ...c.settings.newValue };
      if (!buttonAllowed()) hideButton(true);
    }
    if (c.skinColors) {
      skinColors = c.skinColors.newValue;
      paintRoot();
    }
  });

  /** Skin colors reach the closed shadow tree through inherited custom properties. */
  function paintRoot() {
    if (!root || !skinColors) return;
    for (const k of ['a1', 'a2', 'a3', 'on']) root.style.setProperty(`--${k}`, skinColors[k]);
  }

  // ───────────────────────── DOM scan ─────────────────────────

  function abs(u) {
    try {
      return new URL(u, location.href).href;
    } catch {
      return '';
    }
  }

  function scan() {
    const items = new Map();
    const posters = [];
    const add = (url, extra = {}) => {
      url = abs(url);
      if (!/^https?:/.test(url) || items.has(url) || items.size > 200) return;
      items.set(url, { url, ...extra });
    };

    for (const el of document.querySelectorAll('video, audio')) {
      const poster = el.tagName === 'VIDEO' && el.poster ? abs(el.poster) : '';
      const mime = el.tagName === 'AUDIO' ? 'audio/' : '';
      const srcs = [el.currentSrc, el.src, ...[...el.querySelectorAll('source')].map((s) => s.src)].filter(Boolean);
      for (const s of srcs) if (!s.startsWith('blob:')) add(s, { poster, mime });
      if (poster) posters.push({ src: srcs.find((s) => !s.startsWith('blob:')) || '', poster });
    }
    for (const a of document.querySelectorAll('a[href]')) {
      if (!MEDIA_EXT.test(a.href)) continue;
      const name = (a.getAttribute('download') || a.textContent || '').trim().slice(0, 120);
      add(a.href, { name: name.length > 3 ? name : '' });
    }
    for (const m of document.querySelectorAll('meta[property^="og:video"], meta[property^="og:audio"], meta[name="twitter:player:stream"]')) {
      const prop = m.getAttribute('property') || m.getAttribute('name') || '';
      if (/:(type|width|height)$/.test(prop)) continue;
      if (m.content && MEDIA_EXT.test(m.content)) add(m.content, { mime: prop.includes('audio') ? 'audio/' : '' });
    }
    const ogImage = document.querySelector('meta[property="og:image"]')?.content;
    if (IS_TOP && ogImage && !posters.length) posters.push({ src: '', poster: abs(ogImage) });

    if (items.size || posters.length) send('dom:media', { items: [...items.values()], posters });
    return items.size;
  }

  let scanTimer;
  const scheduleScan = (ms = 1200) => {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, ms);
  };

  scheduleScan(800);
  document.addEventListener('play', () => scheduleScan(300), true);
  document.addEventListener('loadedmetadata', () => scheduleScan(500), true);
  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1 && (n.matches?.('video, audio, source') || n.querySelector?.('video, audio'))) {
          scheduleScan();
          return;
        }
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });

  // ───────────────────────── gallery / image scan ─────────────────────────
  // Thumbnails usually link either straight to the full image, or to a
  // "viewer" page that shows only the picture. Direct links are taken as-is;
  // viewer pages are fetched and their main picture is extracted.

  const X = globalThis.LFDExtract;
  const imageScan = { running: false, stop: false };

  function thumbOf(el) {
    const img = el.tagName === 'IMG' ? el : el.querySelector('img');
    if (img) {
      const src = X.imgSource({
        src: img.currentSrc || img.getAttribute('src') || '',
        srcset: '',
        'data-src': img.dataset.src || img.dataset.lazySrc || img.dataset.original || '',
      }, location.href);
      return { src, img };
    }
    // CSS background thumbnails: <a><div style="background-image:url(...)"></div></a>
    for (const node of [el, ...el.querySelectorAll('*')].slice(0, 6)) {
      const bg = node.style?.backgroundImage || '';
      const m = /url\(["']?([^"')]+)["']?\)/.exec(bg);
      if (m) return { src: X.abs(m[1], location.href), img: null, box: node };
    }
    return null;
  }

  function looksLikeChrome(el, src) {
    if (X.JUNK.test(src)) return true;
    const r = el.getBoundingClientRect();
    const nat = el.tagName === 'IMG' ? Math.max(el.naturalWidth, el.naturalHeight) : 0;
    return Math.max(r.width, r.height) < 48 && nat < 64;
  }

  /** @param only  optional Set of elements (magic selection) to limit the scan to */
  function collectImageCandidates(only = null) {
    const direct = new Map(); // full image url -> item
    const viewers = new Map(); // viewer page url -> thumb
    const here = location.href.split('#')[0];
    const origin = location.origin + '/';

    for (const a of document.querySelectorAll('a[href]')) {
      if (only && !only.has(a)) continue;
      const t = thumbOf(a);
      if (!t?.src || t.src.startsWith('data:') && !t.img) continue;
      if (looksLikeChrome(t.img || t.box || a, t.src)) continue;
      const href = a.href.split('#')[0];
      if (!/^https?:/.test(href) || href === here || href === origin) continue;
      if (X.IMG_EXT.test(href)) {
        if (!direct.has(href)) direct.set(href, { url: href, thumb: t.src });
      } else if (!viewers.has(href)) {
        viewers.set(href, t.src);
      }
    }
    // Big pictures shown on the page itself (not inside a link).
    for (const img of document.images) {
      if (img.closest('a[href]') || (only && !only.has(img))) continue;
      const src = X.imgSource({
        src: img.currentSrc || img.src, srcset: img.srcset,
        'data-src': img.dataset.src || '', 'data-original': img.dataset.original || '', 'data-full': img.dataset.full || '',
      }, location.href);
      if (!/^https?:/.test(src) || X.JUNK.test(src)) continue;
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const r = img.getBoundingClientRect();
      const min = only ? 40 : 300; // a hand-picked picture can be small
      if ((w >= min && h >= min) || (r.width >= min && r.height >= min)) {
        if (!direct.has(src)) direct.set(src, { url: src, thumb: img.currentSrc || src, width: w, height: h });
      }
    }
    // The page *is* a picture (opened from a thumbnail).
    if (!only && document.contentType?.startsWith('image/')) direct.set(here, { url: here, thumb: here });
    return { direct: [...direct.values()], viewers: [...viewers.entries()].slice(0, 400) };
  }

  async function resolveViewer(url, thumb) {
    const sameOrigin = new URL(url).origin === location.origin;
    if (!sameOrigin) {
      const res = await send('image:resolve', { url, thumb });
      return res?.data || null;
    }
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    if (type.startsWith('image/')) return { url: res.url || url };
    if (!type.includes('html')) return null;
    return X.bestImageFromHtml(await res.text(), res.url || url, thumb);
  }

  async function scanImages(cands = null, scope = 'page') {
    if (imageScan.running) return;
    imageScan.running = true;
    imageScan.stop = false;
    const { direct, viewers } = cands || collectImageCandidates();
    const total = direct.length + viewers.length;
    let done = direct.length;
    let found = 0;
    const progress = (state) => send('images:progress', { state, done, total, found, scope });
    let batch = [];
    const flush = () => {
      if (!batch.length) return;
      found += batch.length;
      send('images:add', { items: batch });
      batch = [];
    };

    batch.push(...direct);
    flush();
    progress('running');

    let next = 0;
    let lastFlush = Date.now();
    const worker = async () => {
      while (next < viewers.length && !imageScan.stop) {
        const [url, thumb] = viewers[next++];
        try {
          const best = await resolveViewer(url, thumb);
          if (best?.url) batch.push({ url: best.url, thumb, width: best.width || 0, height: best.height || 0, viewerUrl: url });
        } catch { /* skip this one */ }
        done++;
        if (batch.length >= 12 || Date.now() - lastFlush > 700) {
          flush();
          lastFlush = Date.now();
          progress('running');
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    flush();
    imageScan.running = false;
    progress(imageScan.stop ? 'stopped' : 'done');
  }

  // ───────────────────────── floating button ─────────────────────────

  const STYLE = `
    :host { all: initial; }
    .wrap { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; }
    .fab {
      position: fixed; display: flex; align-items: center; gap: 2px; pointer-events: auto;
      height: 34px; padding: 3px; border-radius: 12px;
      background: rgba(14, 16, 24, .82); backdrop-filter: blur(14px) saturate(1.4); -webkit-backdrop-filter: blur(14px) saturate(1.4);
      box-shadow: 0 10px 30px -8px rgba(0,0,0,.55), inset 0 0 0 1px rgba(255,255,255,.09);
      font: 600 12.5px/1 "Inter", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; color: #fff;
      opacity: 0; transform: translateY(-4px) scale(.96); transition: opacity .2s ease, transform .25s cubic-bezier(.34,1.56,.64,1);
      user-select: none;
    }
    .fab.show { opacity: 1; transform: none; }
    .main {
      all: unset; cursor: pointer; display: flex; align-items: center; gap: 7px; height: 28px; padding: 0 12px 0 9px;
      border-radius: 9px; color: var(--on, #fff);
      background: linear-gradient(135deg, var(--a1, #8B6CFF), var(--a2, #5B7CFA) 55%, var(--a3, #22D3EE));
      box-shadow: 0 6px 18px -6px color-mix(in srgb, var(--a2, #5B7CFA) 80%, transparent); transition: filter .2s, transform .15s;
    }
    .main:hover { filter: brightness(1.1); }
    .main:active { transform: scale(.96); }
    .main svg { width: 16px; height: 16px; }
    .count { font-size: 10.5px; font-weight: 800; background: rgba(255,255,255,.22); border-radius: 5px; padding: 2px 5px; margin-left: 1px; }
    .x {
      all: unset; cursor: pointer; width: 24px; height: 28px; display: grid; place-items: center; border-radius: 8px;
      color: rgba(255,255,255,.55); transition: color .2s, background .2s;
    }
    .x:hover { color: #fff; background: rgba(255,255,255,.1); }
    .x svg { width: 13px; height: 13px; }
    .tip {
      position: absolute; top: calc(100% + 8px); right: 0; white-space: nowrap; padding: 6px 9px; border-radius: 8px;
      background: rgba(14,16,24,.92); font-size: 11.5px; font-weight: 500; color: rgba(255,255,255,.85);
      opacity: 0; transform: translateY(-3px); transition: .18s ease; pointer-events: none;
      box-shadow: 0 8px 24px -8px rgba(0,0,0,.6);
    }
    .x:hover + .tip { opacity: 1; transform: none; }
    .panel {
      position: fixed; top: 14px; right: 14px; width: 412px; height: min(640px, calc(100vh - 28px));
      border: 0; border-radius: 18px; pointer-events: auto; color-scheme: normal;
      box-shadow: 0 40px 100px -20px rgba(0,0,0,.6), 0 10px 30px rgba(0,0,0,.25);
      opacity: 0; transform: translateX(16px) scale(.98); transition: opacity .22s ease, transform .35s cubic-bezier(.2,.8,.2,1);
      background: transparent;
    }
    .panel.show { opacity: 1; transform: none; }

    .magic { position: fixed; inset: 0; pointer-events: auto; cursor: crosshair; background: rgba(5,5,8,.28);
      animation: mfade .2s ease; touch-action: none; }
    @keyframes mfade { from { opacity: 0; } }
    .magic.dragging { background: transparent; }
    .magic-hint {
      position: fixed; left: 50%; top: 16px; transform: translateX(-50%); display: flex; align-items: center; gap: 10px;
      padding: 9px 14px 9px 11px; border-radius: 12px; pointer-events: none; white-space: nowrap;
      background: rgba(14,16,24,.9); backdrop-filter: blur(14px); color: rgba(255,255,255,.88);
      font: 500 13px/1.2 "Inter", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
      box-shadow: 0 12px 40px -10px rgba(0,0,0,.6), inset 0 0 0 1px rgba(255,255,255,.08);
    }
    .magic-hint b { color: #fff; font-weight: 700; }
    .magic-hint .wand { width: 26px; height: 26px; border-radius: 8px; display: grid; place-items: center; color: var(--on, #fff);
      background: linear-gradient(135deg, var(--a1, #8B6CFF), var(--a2, #5B7CFA) 55%, var(--a3, #22D3EE)); }
    .magic-hint .wand svg { width: 15px; height: 15px; }
    .magic-hint kbd { font: 600 11px ui-monospace, Consolas, monospace; padding: 2px 6px; border-radius: 5px; border: 1px solid rgba(255,255,255,.25); }
    .magic-box {
      position: fixed; pointer-events: none; border-radius: 6px;
      border: 2px solid var(--a2, #5B7CFA); background: color-mix(in srgb, var(--a2, #5B7CFA) 14%, transparent);
      box-shadow: 0 0 0 9999px rgba(5,5,8,.25);
    }
    .magic-count {
      position: absolute; right: -2px; top: calc(100% + 8px); padding: 5px 9px; border-radius: 8px; white-space: nowrap;
      font: 700 12px/1 "Inter", "Segoe UI", system-ui, sans-serif; color: var(--on, #fff);
      background: linear-gradient(135deg, var(--a1, #8B6CFF), var(--a2, #5B7CFA));
      box-shadow: 0 8px 20px -6px color-mix(in srgb, var(--a2, #5B7CFA) 80%, transparent);
    }
    .magic-mark {
      position: fixed; pointer-events: none; border-radius: 6px;
      outline: 2px solid var(--a1, #8B6CFF); outline-offset: 1px; background: color-mix(in srgb, var(--a1, #8B6CFF) 18%, transparent);
    }
    .magic-mark.video { outline-color: #fff; outline-style: dashed; }
  `;
  const ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>';
  const XICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';

  let root;
  let shadow;
  let fab;
  let panel;

  function ensureRoot() {
    if (root?.isConnected) return;
    root = document.createElement('lfd-overlay');
    shadow = root.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>${STYLE}</style><div class="wrap"></div>`;
    paintRoot();
    (document.fullscreenElement && document.fullscreenElement.tagName !== 'VIDEO' ? document.fullscreenElement : document.documentElement).append(root);
  }

  function buttonAllowed() {
    return settings.floatingButton && !(settings.disabledSites || []).includes(host);
  }

  let current = null; // the <video> under the pointer
  let hideTimer;
  let countCache = { n: 0, at: 0 };

  async function mediaCount() {
    if (Date.now() - countCache.at < 2500) return countCache.n;
    const res = await send('media:count');
    countCache = { n: res?.data || 0, at: Date.now() };
    return countCache.n;
  }

  function videoAt(x, y) {
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      if (r.width < 200 || r.height < 110) continue;
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return v;
    }
    return null;
  }

  function placeFab() {
    if (!fab || !current) return;
    const r = current.getBoundingClientRect();
    const w = fab.offsetWidth || 130;
    fab.style.top = `${Math.max(8, r.top + 12)}px`;
    fab.style.left = `${Math.min(innerWidth - w - 8, r.right - w - 12)}px`;
  }

  async function showButton(video) {
    if (!buttonAllowed()) return;
    const direct = /^https?:/.test(video.currentSrc || video.src || '');
    const n = await mediaCount();
    if (!direct && !n) return;
    ensureRoot();
    if (!fab) {
      fab = document.createElement('div');
      fab.className = 'fab';
      fab.innerHTML = `<button class="main" title="Download with LFDownloader">${ARROW}<span>Download</span><span class="count" hidden></span></button><button class="x" aria-label="Hide on this site">${XICON}</button><span class="tip">Hide on ${host}</span>`;
      fab.querySelector('.main').addEventListener('click', onFabClick);
      fab.querySelector('.x').addEventListener('click', hideForSite);
      fab.addEventListener('pointerenter', () => clearTimeout(hideTimer));
      fab.addEventListener('pointerleave', () => scheduleHide());
    }
    if (!fab.isConnected) shadow.querySelector('.wrap').append(fab);
    const badge = fab.querySelector('.count');
    badge.hidden = n < 2;
    badge.textContent = n;
    current = video;
    placeFab();
    // Force a style flush so the fade-in transition runs, without relying on
    // requestAnimationFrame (which is paused in background/hidden documents).
    void fab.offsetWidth;
    fab.classList.add('show');
  }

  function scheduleHide(ms = 1600) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => hideButton(), ms);
  }

  function hideButton(now = false) {
    if (!fab) return;
    fab.classList.remove('show');
    current = null;
    if (now) fab.remove();
  }

  function onFabClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const src = current?.currentSrc || current?.src || '';
    // YouTube plays from a blob: address; point at the page's YouTube card instead.
    const yt = /(^|\.)youtube(-nocookie)?\.com$/.test(location.hostname)
      && (location.search.match(/[?&]v=([\w-]{11})/) || location.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/) || [])[1];
    send('panel:open', { focus: /^https?:/.test(src) ? src : yt ? `yt:${yt}` : '' });
  }

  async function hideForSite(e) {
    e.preventDefault();
    e.stopPropagation();
    hideButton(true);
    const { settings: s = {} } = await api.storage.local.get('settings');
    const list = new Set(s.disabledSites || []);
    list.add(host);
    await api.storage.local.set({ settings: { ...s, disabledSites: [...list] } });
  }

  let moveQueued = false;
  document.addEventListener('pointermove', (e) => {
    if (moveQueued) return;
    moveQueued = true;
    setTimeout(() => {
      moveQueued = false;
      const v = videoAt(e.clientX, e.clientY);
      if (v) {
        clearTimeout(hideTimer);
        if (v !== current || !fab?.classList.contains('show')) showButton(v);
        else placeFab();
      } else if (current) {
        scheduleHide();
      }
    }, 90);
  }, { passive: true, capture: true });
  addEventListener('scroll', placeFab, { passive: true, capture: true });
  addEventListener('resize', placeFab, { passive: true });
  document.addEventListener('fullscreenchange', () => {
    if (!root) return;
    const fs = document.fullscreenElement;
    (fs && fs.tagName !== 'VIDEO' ? fs : document.documentElement).append(root);
    placeFab();
  });

  // ───────────────────────── magic selector ─────────────────────────
  // Draw a box on the page: only the pictures/videos inside it are collected.

  const WAND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 20 11-11"/><path d="m13 7 2-2 2 2-2 2"/><path d="M18 3v2M21 6h-2M18 9v-1M14 3h1"/><path d="M20 13v2M19 14h2M8 3v2M7 4h2"/></svg>';
  let magic = null;

  /** Everything on the page that can be picked, with its position in page coordinates. */
  function magicTargets() {
    const out = [];
    const sx = scrollX;
    const sy = scrollY;
    const push = (el, kind, box = el) => {
      const r = box.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return;
      out.push({ el, kind, x: r.left + sx, y: r.top + sy, w: r.width, h: r.height });
    };
    for (const a of document.querySelectorAll('a[href]')) {
      const t = thumbOf(a);
      if (t?.src) push(a, 'image', t.img || t.box || a);
    }
    for (const img of document.images) if (!img.closest('a[href]')) push(img, 'image');
    for (const v of document.querySelectorAll('video, audio')) push(v, 'video');
    return out;
  }

  function inBox(t, b) {
    const ix = Math.max(0, Math.min(t.x + t.w, b.x + b.w) - Math.max(t.x, b.x));
    const iy = Math.max(0, Math.min(t.y + t.h, b.y + b.h) - Math.max(t.y, b.y));
    const cx = t.x + t.w / 2;
    const cy = t.y + t.h / 2;
    const centerIn = cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h;
    return centerIn || (ix * iy) / (t.w * t.h) >= 0.6;
  }

  function startMagic() {
    if (!IS_TOP || magic) return;
    closePanel();
    hideButton(true);
    ensureRoot();
    const layer = document.createElement('div');
    layer.className = 'magic';
    layer.innerHTML = `<div class="magic-hint"><span class="wand">${WAND}</span><span><b>Magic select</b> · Drag a box around the pictures or videos you want</span><kbd>Esc</kbd></div>
      <div class="magic-marks"></div><div class="magic-box" hidden><span class="magic-count"></span></div>`;
    shadow.querySelector('.wrap').append(layer);
    magic = { layer, targets: magicTargets(), start: null, last: null, picked: [] };

    const box = layer.querySelector('.magic-box');
    const marks = layer.querySelector('.magic-marks');
    const count = layer.querySelector('.magic-count');

    const update = () => {
      if (!magic?.start) return;
      const ex = magic.last.x + scrollX;
      const ey = magic.last.y + scrollY;
      const b = { x: Math.min(magic.start.x, ex), y: Math.min(magic.start.y, ey), w: Math.abs(ex - magic.start.x), h: Math.abs(ey - magic.start.y) };
      magic.box = b;
      Object.assign(box.style, { left: `${b.x - scrollX}px`, top: `${b.y - scrollY}px`, width: `${b.w}px`, height: `${b.h}px` });
      box.hidden = b.w < 4 && b.h < 4;
      magic.picked = magic.targets.filter((t) => inBox(t, b));
      marks.innerHTML = magic.picked.slice(0, 300).map((t) => `<div class="magic-mark ${t.kind}" style="left:${t.x - scrollX}px;top:${t.y - scrollY}px;width:${t.w}px;height:${t.h}px"></div>`).join('');
      const imgs = magic.picked.filter((t) => t.kind === 'image').length;
      const vids = magic.picked.length - imgs;
      count.textContent = [imgs && `${imgs} picture${imgs > 1 ? 's' : ''}`, vids && `${vids} video${vids > 1 ? 's' : ''}`].filter(Boolean).join(' · ') || 'Nothing here yet';
    };

    layer.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      layer.setPointerCapture?.(e.pointerId);
      layer.classList.add('dragging');
      magic.start = { x: e.clientX + scrollX, y: e.clientY + scrollY };
      magic.last = { x: e.clientX, y: e.clientY };
      update();
    });
    layer.addEventListener('pointermove', (e) => {
      if (!magic?.start) return;
      magic.last = { x: e.clientX, y: e.clientY };
      update();
    });
    layer.addEventListener('pointerup', (e) => {
      if (!magic?.start) return;
      magic.last = { x: e.clientX, y: e.clientY };
      update();
      // A click without dragging picks whatever is under the pointer.
      if (magic.box.w < 6 && magic.box.h < 6) {
        const px = e.clientX + scrollX;
        const py = e.clientY + scrollY;
        magic.picked = magic.targets.filter((t) => px >= t.x && px <= t.x + t.w && py >= t.y && py <= t.y + t.h).slice(-1);
      }
      finishMagic();
    });
    // Let the wheel scroll the page so a selection can span more than one screen.
    layer.addEventListener('wheel', (e) => { e.preventDefault(); scrollBy(e.deltaX, e.deltaY); }, { passive: false });
    magic.onScroll = () => update();
    magic.onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); stopMagic(); } };
    addEventListener('scroll', magic.onScroll, { passive: true });
    document.addEventListener('keydown', magic.onKey, true);
  }

  function stopMagic() {
    if (!magic) return;
    removeEventListener('scroll', magic.onScroll);
    document.removeEventListener('keydown', magic.onKey, true);
    magic.layer.remove();
    magic = null;
  }

  async function finishMagic() {
    const picked = magic.picked;
    stopMagic();
    if (!picked.length) return;
    const images = new Set(picked.filter((t) => t.kind === 'image').map((t) => t.el));
    const videos = picked.filter((t) => t.kind === 'video').map((t) => t.el);

    // Videos: report direct sources; streaming players show up via the network sniffer.
    const vItems = [];
    let focus = '';
    for (const v of videos) {
      const srcs = [v.currentSrc, v.src, ...[...v.querySelectorAll('source')].map((s) => s.src)].filter((s) => /^https?:/.test(s || ''));
      for (const s of srcs) vItems.push({ url: s, poster: v.poster || '', mime: v.tagName === 'AUDIO' ? 'audio/' : '' });
      focus ||= srcs[0] || '';
    }
    if (vItems.length) await send('dom:media', { items: vItems, posters: [] });

    if (images.size) {
      await send('images:clear', {});
      openPanel('', 'images');
      scanImages(collectImageCandidates(images), 'selection');
    } else {
      openPanel(focus);
    }
  }

  // ───────────────────────── panel (top frame) ─────────────────────────

  function openPanel(focus = '', view = '', autoScan = false) {
    ensureRoot();
    const q = new URLSearchParams({ mode: 'panel', focus });
    if (view) q.set('view', view);
    if (autoScan) q.set('scan', '1');
    const url = api.runtime.getURL(`popup/popup.html?${q}`);
    if (panel?.isConnected) {
      panel.src = url;
      return;
    }
    panel = document.createElement('iframe');
    panel.className = 'panel';
    panel.src = url;
    panel.allow = 'clipboard-write';
    panel.setAttribute('aria-label', 'LFDownloader');
    shadow.querySelector('.wrap').append(panel);
    panel.addEventListener('load', () => panel.classList.add('show'), { once: true });
    setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
    document.addEventListener('keydown', onKey, true);
  }

  function closePanel() {
    if (!panel) return;
    const p = panel;
    panel = null;
    p.classList.remove('show');
    setTimeout(() => p.remove(), 250);
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
  }

  function outside(e) {
    if (e.composedPath().includes(root)) return;
    closePanel();
  }

  function onKey(e) {
    if (e.key === 'Escape') closePanel();
  }

  addEventListener('message', (e) => {
    if (e.origin === EXT_ORIGIN && e.data?.lfd === 'close') closePanel();
  });

  // ───────────────────────── messages ─────────────────────────

  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'lfd:rescan') {
      sendResponse({ found: scan() });
      return false;
    }
    if (msg?.type === 'lfd:panel' && IS_TOP) {
      if (msg.rescan) scan();
      openPanel(msg.focus || '', msg.view || '', !!msg.scanImages);
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.type === 'lfd:images-scan' && IS_TOP) {
      scanImages();
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.type === 'lfd:magic' && IS_TOP) {
      startMagic();
      sendResponse({ ok: true });
      return false;
    }
    if (msg?.type === 'lfd:images-stop' && IS_TOP) {
      imageScan.stop = true;
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
})();
