// Firefox: the in-page panel (popup.html in an iframe on a web page) must load.
import puppeteer from 'puppeteer-core';
import { mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from './server.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'test', 'out', 'panel-firefox');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const ADDON_ID = 'lfdownloader@lfdownloader.local';
const UUID = '6b1f0c8e-5d2a-4c1e-9a7b-3f2e1d0c9b8a';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '✔' : '✘'} ${msg}`); if (!ok) failures++; };

const server = await start(8765);
const browser = await puppeteer.launch({
  browser: 'firefox', executablePath: process.env.FIREFOX_PATH || 'C:/Program Files/Mozilla Firefox/firefox.exe', headless: true,
  env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
  extraPrefsFirefox: { 'extensions.webextensions.uuids': JSON.stringify({ [ADDON_ID]: UUID }) },
});
try {
  await browser.installExtension(join(root, 'dist', 'firefox'));
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 800 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('http://localhost:8765/', { waitUntil: 'load' });
  await sleep(3500);
  const ext = await browser.newPage();
  await ext.goto('http://localhost:8765/');
  await ext.evaluate((u) => { location.href = u; }, `moz-extension://${UUID}/popup/popup.html?tab=0`);
  await sleep(1500);
  const tabId = (await ext.evaluate(() => browser.tabs.query({ url: 'http://localhost/*' })))[0]?.id;
  await page.bringToFront();
  await ext.evaluate((id) => browser.tabs.sendMessage(id, { type: 'lfd:panel', focus: '' }, { frameId: 0 }), tabId);
  await sleep(2500);
  // The panel is the page's only child frame (an extension frame, cross-origin to the page).
  const panel = () => page.frames().find((f) => f !== page.mainFrame());
  const read = () => panel()?.evaluate(() => ({ cards: document.querySelectorAll('.card').length, toast: document.querySelector('.toast')?.textContent || '' })).catch((e) => ({ err: e.message }));
  const v = (await read()) || {};
  check(!!panel(), 'in-page panel opened');
  check(v.cards > 0 && !/can't access|undefined/i.test(v.toast || ''), `panel lists ${v.cards} cards${v.toast ? ` (toast: ${v.toast})` : ''}${v.err ? ` (${v.err})` : ''}`);
  // New media found while the panel is open shows up without reopening it.
  await page.evaluate(() => fetch('/media/tone.wav?late=1').then((r) => r.arrayBuffer()));
  await sleep(2500);
  const after = (await read())?.cards;
  check(after > v.cards, `panel updates live (${v.cards} → ${after} cards)`);
  await page.screenshot({ path: join(out, 'panel.png') });
} finally {
  await browser.close().catch(() => {});
  server.close();
}
console.log(failures ? `${failures} check(s) failed` : 'Firefox panel checks passed');
process.exit(failures ? 1 : 0);
