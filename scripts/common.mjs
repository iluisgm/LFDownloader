import { existsSync } from 'node:fs';

export const LOGO_SVG = `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="6" y1="4" x2="58" y2="60" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#8B6CFF"/><stop offset=".55" stop-color="#5B7CFA"/><stop offset="1" stop-color="#22D3EE"/>
    </linearGradient>
  </defs>
  <rect x="2" y="2" width="60" height="60" rx="18" fill="url(#g)"/>
  <path d="M32 15v22" stroke="#fff" stroke-width="5.5" stroke-linecap="round"/>
  <path d="m21.5 28 10.5 10.5L42.5 28" fill="none" stroke="#fff" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M19 47.5h26" stroke="#fff" stroke-opacity=".75" stroke-width="5.5" stroke-linecap="round"/>
</svg>`;

export function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error('Chrome not found — set CHROME_PATH');
  return hit;
}
