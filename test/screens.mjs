#!/usr/bin/env node
// Screenshots of the extension's pages in a given skin, for design review.
// Usage: node test/screens.mjs <outDir> [skin] [theme] [accent]
//   e.g. node test/screens.mjs shots crimson dark
//        node test/screens.mjs shots custom dark "#00C2A8"
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from './server.mjs';
import { chromePath } from '../scripts/common.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [outArg = join(root, 'test', 'out', 'screens'), skin = 'crimson', theme = 'dark', accent = '#E5172F'] = process.argv.slice(2);
const out = resolve(outArg);
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await start(8765);
const profile = join(out, `profile-${Date.now()}`);
mkdirSync(join(profile, 'Default'), { recursive: true });
writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: join(out, 'dl'), prompt_for_download: false } }));
const browser = await puppeteer.launch({
  executablePath: chromePath(), headless: true, pipe: true, enableExtensions: true, userDataDir: profile,
  defaultViewport: { width: 1400, height: 900 },
});
try {
  const extId = await browser.installExtension(join(root, 'dist', 'chrome'));
  const sw = await (await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes(extId))).worker();
  await sw.evaluate((s) => chrome.storage.local.set({ settings: s }), { skin, theme, accent, notifyOnComplete: false });
  await sleep(600);
  for (const p of await browser.pages()) if (p.url().includes('welcome')) await p.close();

  const page = await browser.newPage();
  await page.goto('http://localhost:8765/', { waitUntil: 'load' });
  await sleep(2500);
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url?.startsWith('http://localhost'))?.id);

  const shot = async (name, url, vp, full = false) => {
    const p = await browser.newPage();
    await p.setViewport({ ...vp, deviceScaleFactor: 2 });
    await p.goto(`chrome-extension://${extId}/${url}`);
    await sleep(900);
    await p.screenshot({ path: join(out, `${skin}-${theme}-${name}.png`), fullPage: full });
    return p;
  };
  await shot('popup', `popup/popup.html?tab=${tabId}`, { width: 412, height: 600 });
  await shot('options', 'options/options.html', { width: 900, height: 900 });
  await shot('manager', 'manager/manager.html', { width: 1060, height: 640 });

  await page.bringToFront();
  const box = await (await page.$('#msevideo')).boundingBox();
  await page.mouse.move(box.x + 200, box.y + 80);
  await sleep(150);
  await page.mouse.move(box.x + 210, box.y + 85);
  await sleep(900);
  await page.screenshot({ path: join(out, `${skin}-${theme}-page.png`), clip: { x: 700, y: 120, width: 500, height: 300 } });
  // The toolbar icon as drawn for this skin (128px for inspection, plus 32px).
  const iconPage = await browser.newPage();
  await iconPage.goto(`chrome-extension://${extId}/options/options.html`);
  const icons = await iconPage.evaluate(async (opts) => {
    const { drawIcon } = await import('/background/skin.js');
    const { resolveSkin } = await import('/shared/skins.js');
    const sk = resolveSkin(opts, 'dark');
    const urls = [];
    for (const size of [128, 32]) {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      c.getContext('2d').putImageData(drawIcon(size, sk.accents, sk.onAccent), 0, 0);
      urls.push(c.toDataURL('image/png'));
    }
    return urls;
  }, { skin, accent });
  icons.forEach((u, i) => writeFileSync(join(out, `${skin}-icon-${i ? 32 : 128}.png`), Buffer.from(u.split(',')[1], 'base64')));
  const icon = await sw.evaluate(async () => {
    return (await chrome.storage.local.get('skinColors')).skinColors;
  });
  console.log('skin colors', JSON.stringify(icon));
  console.log('screens in', out);
} finally {
  await browser.close();
  server.close();
}
