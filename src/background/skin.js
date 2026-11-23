// Re-colors browser chrome for the active skin: toolbar icon, badge, and the
// colors the content script uses for the in-page button.
import { api } from '../shared/api.js';
import { resolveSkin } from '../shared/skins.js';
import { setBadgeColor } from './store.js';

export function drawIcon(size, [a1, a2, a3], on) {
  const c = new OffscreenCanvas(size, size);
  const g = c.getContext('2d');
  const s = size / 64;
  const grad = g.createLinearGradient(6 * s, 4 * s, 58 * s, 60 * s);
  grad.addColorStop(0, a1);
  grad.addColorStop(0.55, a2);
  grad.addColorStop(1, a3);
  g.fillStyle = grad;
  g.beginPath();
  g.roundRect(2 * s, 2 * s, 60 * s, 60 * s, 18 * s);
  g.fill();
  g.strokeStyle = on;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  g.lineWidth = (size <= 32 ? 7 : 5.5) * s;
  g.beginPath();
  g.moveTo(32 * s, 15 * s); g.lineTo(32 * s, 37 * s);
  g.moveTo(21.5 * s, 28 * s); g.lineTo(32 * s, 38.5 * s); g.lineTo(42.5 * s, 28 * s);
  g.stroke();
  g.globalAlpha = 0.75;
  g.beginPath();
  g.moveTo(19 * s, 47.5 * s); g.lineTo(45 * s, 47.5 * s);
  g.stroke();
  return g.getImageData(0, 0, size, size);
}

export async function applySkin(settings) {
  // Toolbar chrome is always dark-ish, so use the dark variant of the skin.
  const skin = resolveSkin(settings, 'dark');
  setBadgeColor(skin.accents[1], skin.onAccent);
  await api.storage.local.set({ skinColors: { a1: skin.accents[0], a2: skin.accents[1], a3: skin.accents[2], on: skin.onAccent } });
  if (typeof OffscreenCanvas === 'undefined') return;
  try {
    const imageData = {};
    for (const size of [16, 32]) imageData[size] = drawIcon(size, skin.accents, skin.onAccent);
    await api.action.setIcon({ imageData });
  } catch (e) {
    console.warn('[LFD] icon', e);
  }
}
