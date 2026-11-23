// Skins: named color schemes (accent gradient, media-type colors and, for
// some, their own dark neutrals) plus a "custom" skin built from one accent.
// Applied as CSS custom properties, so every page picks them up from here.

const PURE_BLACK = {
  '--bg': '#000000',
  '--bg-elev': '#070707',
  '--surface': '#0E0E0F',
  '--surface-2': '#161617',
  '--surface-3': '#212123',
  '--text': '#F4F4F5',
  '--text-2': '#A6A6AD',
  '--text-3': '#6B6B73',
  '--line': 'rgba(255,255,255,.07)',
  '--line-strong': 'rgba(255,255,255,.13)',
};

export const SKINS = {
  aurora: {
    name: 'Aurora',
    tagline: 'Violet to cyan',
    accents: ['#8B6CFF', '#5B7CFA', '#22D3EE'],
    kinds: { video: '#8B6CFF', audio: '#F472B6', stream: '#22D3EE', image: '#FBBF24' },
  },
  crimson: {
    name: 'Crimson',
    tagline: 'Black & red',
    accents: ['#FF4D5E', '#E5172F', '#8E0A1C'],
    kinds: { video: '#E5172F', audio: '#FF7A45', stream: '#C9CDD4', image: '#FF4D8D' },
    dark: {
      ...PURE_BLACK,
      '--bg': '#050505',
      '--bg-elev': '#0A0A0A',
      '--surface': '#111111',
      '--surface-2': '#181818',
      '--surface-3': '#252525',
    },
  },
  ocean: {
    name: 'Ocean',
    tagline: 'Deep blue',
    accents: ['#60A5FA', '#2563EB', '#0891B2'],
    kinds: { video: '#3B82F6', audio: '#F472B6', stream: '#06B6D4', image: '#FBBF24' },
  },
  emerald: {
    name: 'Emerald',
    tagline: 'Green & lime',
    accents: ['#4ADE80', '#059669', '#0D9488'],
    kinds: { video: '#10B981', audio: '#F472B6', stream: '#22D3EE', image: '#FBBF24' },
  },
  sunset: {
    name: 'Sunset',
    tagline: 'Orange to magenta',
    accents: ['#FB923C', '#F43F5E', '#C026D3'],
    kinds: { video: '#F43F5E', audio: '#FB923C', stream: '#C026D3', image: '#FBBF24' },
  },
};

// ───────────────────────── color math ─────────────────────────

function hexToRgb(hex) {
  let h = String(hex || '').replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  if (!/^[0-9a-f]{6}$/i.test(h) || Number.isNaN(n)) return [139, 108, 255];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

export function mix(a, b, t) {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex(x.map((v, i) => v + (y[i] - v) * t));
}

/** Relative luminance (WCAG), 0 = black, 1 = white. */
export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function normalizeHex(hex) {
  return rgbToHex(hexToRgb(hex));
}

// ───────────────────────── resolve ─────────────────────────

/**
 * Turn settings into concrete colors.
 * @returns {{ id, accents: string[], onAccent, kinds, neutrals: object|null }}
 */
export function resolveSkin(settings = {}, theme = 'dark') {
  let id = settings.skin in SKINS || settings.skin === 'custom' ? settings.skin : 'aurora';
  let skin;
  if (id === 'custom') {
    const c = normalizeHex(settings.accent || '#E5172F');
    skin = {
      accents: [mix(c, '#FFFFFF', 0.22), c, mix(c, '#000000', 0.38)],
      kinds: { ...SKINS.aurora.kinds, video: c },
    };
  } else {
    skin = SKINS[id];
  }
  const onAccent = luminance(skin.accents[1]) > 0.5 ? '#0A0A0A' : '#FFFFFF';
  // On light backgrounds, pale type colors (silver, yellow…) need more depth to stay readable.
  const kinds = theme === 'light'
    ? Object.fromEntries(Object.entries(skin.kinds).map(([k, c]) => [k, luminance(c) > 0.42 ? mix(c, '#000000', 0.42) : c]))
    : skin.kinds;
  let neutrals = null;
  if (theme === 'dark') neutrals = skin.dark || (settings.pureBlack ? PURE_BLACK : null);
  if (theme === 'dark' && settings.pureBlack && skin.dark) neutrals = { ...skin.dark, ...PURE_BLACK };
  return { id, accents: skin.accents, onAccent, kinds, neutrals };
}

const MANAGED = new Set(['--accent-1', '--accent-2', '--accent-3', '--on-accent', '--video', '--audio', '--stream', '--image', ...Object.keys(PURE_BLACK)]);

/** Write a resolved skin onto an element's style (usually <html>). */
export function paintSkin(el, skin) {
  for (const prop of MANAGED) el.style.removeProperty(prop);
  const [a1, a2, a3] = skin.accents;
  el.style.setProperty('--accent-1', a1);
  el.style.setProperty('--accent-2', a2);
  el.style.setProperty('--accent-3', a3);
  el.style.setProperty('--on-accent', skin.onAccent);
  for (const [k, v] of Object.entries(skin.kinds)) el.style.setProperty(`--${k}`, v);
  if (skin.neutrals) for (const [k, v] of Object.entries(skin.neutrals)) el.style.setProperty(k, v);
  el.dataset.skin = skin.id;
}
