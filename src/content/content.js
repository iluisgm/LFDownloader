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

  api.storage.local.get('settings').then(({ settings: s }) => {
    settings = { ...settings, ...(s || {}) };
  });
  api.storage.onChanged.addListener((c, area) => {
    if (area === 'local' && c.settings) {
      settings = { ...settings, ...c.settings.newValue };
      if (!buttonAllowed()) hideButton(true);
    }
  });

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
      border-radius: 9px; background: linear-gradient(135deg, #8B6CFF, #5B7CFA 55%, #22D3EE);
      box-shadow: 0 6px 18px -6px rgba(110,100,255,.8); transition: filter .2s, transform .15s;
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
    send('panel:open', { focus: /^https?:/.test(src) ? src : '' });
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

  // ───────────────────────── panel (top frame) ─────────────────────────

  function openPanel(focus = '') {
    ensureRoot();
    const url = api.runtime.getURL(`popup/popup.html?mode=panel&focus=${encodeURIComponent(focus)}`);
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
      openPanel(msg.focus || '');
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });
})();
