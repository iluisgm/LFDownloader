// Finds the full-size picture on an image "viewer" page (the page a gallery
// thumbnail opens). Works on raw HTML text, so it runs both in content
// scripts and in the background service worker (which has no DOMParser).
// Classic script: exposes globalThis.LFDExtract; the background imports it.
(() => {
  'use strict';
  if (globalThis.LFDExtract) return;

  const IMG_EXT = /\.(jpe?g|jfif|png|gif|webp|avif|bmp|tiff?|jxl|heic|heif)(?:$|[?#])/i;
  const JUNK = /(^|[/_.-])(logo|icon|favicon|avatar|sprite|spacer|pixel|blank|loading|loader|badge|banner|ads?|emoji|button)([/_.-]|$)/i;
  const THUMB_MARK = /([_.-](thumb(nail)?s?|tn|small|sm|th|t|s|preview|prev|mini|medium|med|m|\d{2,4}x\d{2,4}|w\d{2,4}|h\d{2,4}))+$/i;

  function decode(s) {
    return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  }

  function attrs(tag) {
    const out = {};
    const re = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
    let m;
    while ((m = re.exec(tag))) out[m[1].toLowerCase()] = decode(m[3] ?? m[4] ?? m[5] ?? '');
    return out;
  }

  function abs(u, base) {
    if (!u) return '';
    try {
      return new URL(u.trim(), base).href;
    } catch {
      return '';
    }
  }

  /** Largest candidate of a srcset ("a.jpg 400w, b.jpg 1200w" → b.jpg). */
  function bestFromSrcset(srcset, base) {
    if (!srcset) return '';
    let best = '';
    let bestScore = -1;
    for (const part of srcset.split(/,\s+(?=\S)/)) {
      const [u, d = '1x'] = part.trim().split(/\s+/);
      const n = parseFloat(d) * (/w$/i.test(d) ? 1 : 1000);
      if (u && n > bestScore) { best = u; bestScore = n; }
    }
    return abs(best, base);
  }

  /** "…/thumbs/IMG_0042_t.jpg" → "img_0042": the part shared with the full image. */
  function stem(url) {
    try {
      const last = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
      return last.replace(/\.[a-z0-9]{2,5}$/i, '').replace(THUMB_MARK, '').toLowerCase();
    } catch {
      return '';
    }
  }

  /** Best source of an <img> (or its attribute map): lazy-load attributes first. */
  function imgSource(a, base) {
    const fromSet = bestFromSrcset(a['data-srcset'] || a.srcset, base);
    const lazy = a['data-full'] || a['data-large'] || a['data-original'] || a['data-hires'] || a['data-zoom-image'] || a['data-lazy-src'] || a['data-src'];
    return abs(lazy, base) || fromSet || abs(a.src, base);
  }

  /**
   * Pick the main picture of an HTML page.
   * @returns {{ url, width, height } | null}
   */
  function bestImageFromHtml(html, base, thumbUrl = '') {
    const thumbStem = thumbUrl ? stem(thumbUrl) : '';
    const cands = new Map();
    const add = (url, score, w = 0, h = 0) => {
      if (!/^https?:/.test(url)) return;
      const prev = cands.get(url);
      if (!prev || prev.score < score) cands.set(url, { url, score, width: w || prev?.width || 0, height: h || prev?.height || 0 });
    };

    // Links straight to image files ("View original", "Full size").
    const imageLinks = [];
    for (const m of html.matchAll(/<a\b[^>]*>/gi)) {
      const href = abs(attrs(m[0]).href, base);
      if (IMG_EXT.test(href)) imageLinks.push(href);
    }
    const linkIsGallery = imageLinks.length > 3;
    for (const href of imageLinks) {
      let score = linkIsGallery ? 30 : 75;
      if (thumbStem && stem(href) === thumbStem) score += 60;
      add(href, score);
    }

    const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => attrs(m[0]));
    for (const a of imgs) {
      const src = imgSource(a, base);
      if (!src || src.startsWith('data:')) continue;
      const w = parseInt(a.width, 10) || 0;
      const h = parseInt(a.height, 10) || 0;
      let score = 40;
      if (w && h) score += Math.min(40, (w * h) / 25000);
      if ((w && w < 150) || (h && h < 150)) score -= 45;
      if (JUNK.test(src) || /\b(logo|icon|avatar)\b/i.test(`${a.class || ''} ${a.alt || ''} ${a.id || ''}`)) score -= 60;
      if (thumbStem && stem(src) === thumbStem) score += src === thumbUrl ? 15 : 55;
      if (imgs.length === 1) score += 35;
      add(src, score, w, h);
    }

    for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
      const a = attrs(m[0]);
      const key = (a.property || a.name || '').toLowerCase();
      if (key === 'og:image' || key === 'og:image:url' || key === 'og:image:secure_url' || key === 'twitter:image') {
        const u = abs(a.content, base);
        add(u, (thumbStem && stem(u) === thumbStem ? 70 : 48) - (JUNK.test(u) ? 50 : 0));
      }
    }
    for (const m of html.matchAll(/<link\b[^>]*rel=["']?image_src[^>]*>/gi)) add(abs(attrs(m[0]).href, base), 50);

    let best = null;
    for (const c of cands.values()) if (!best || c.score > best.score) best = c;
    return best && best.score >= 30 ? best : null;
  }

  globalThis.LFDExtract = { IMG_EXT, JUNK, bestImageFromHtml, bestFromSrcset, imgSource, stem, abs };
})();
