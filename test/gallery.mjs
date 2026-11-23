#!/usr/bin/env node
// Gallery scan test in real Chrome: thumbnails → full-size pictures (direct
// links, picture-only viewer pages, busy/cross-origin/lazy/hotlink-protected
// viewers), then a bulk download verified with ffprobe.
// Usage: node test/gallery.mjs [outDir] [skin]   (run `npm run build:chrome` first)
import puppeteer from 'puppeteer-core';
import { mkdirSync, rmSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from './server.mjs';
import { chromePath } from '../scripts/common.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] || join(root, 'test', 'out', 'gallery'));
const skin = process.argv[3] || 'crimson';
const dl = join(out, 'downloads');
rmSync(out, { recursive: true, force: true });
mkdirSync(dl, { recursive: true });
const profile = join(out, 'profile');
mkdirSync(join(profile, 'Default'), { recursive: true });
writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: dl, prompt_for_download: false } }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '✔' : '✘'} ${msg}`); if (!ok) failures++; };

const server = await start(8765);
const browser = await puppeteer.launch({
  executablePath: chromePath(), headless: true, pipe: true, enableExtensions: true, userDataDir: profile,
  defaultViewport: { width: 1400, height: 900 },
});
try {
  const extId = await browser.installExtension(join(root, 'dist', 'chrome'));
  const sw = await (await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes(extId))).worker();
  await sw.evaluate((s) => chrome.storage.local.set({ settings: { skin: s, theme: 'dark', notifyOnComplete: false } }), skin);
  await sleep(600);
  for (const p of await browser.pages()) if (p.url().includes('welcome')) await p.close();

  const page = await browser.newPage();
  await page.goto('http://localhost:8765/gallery.html', { waitUntil: 'load' });
  await sleep(800);
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url?.includes('gallery.html'))?.id);

  // Open the panel in images mode with auto-scan, exactly like the right-click menu does.
  await sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'lfd:panel', view: 'images', scanImages: true }, { frameId: 0 }), tabId);
  let scan;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    scan = (await sw.evaluate((id) => chrome.storage.session.get(`imgscan:${id}`), tabId))[`imgscan:${tabId}`];
    if (scan?.state === 'done') break;
  }
  check(scan?.state === 'done', `scan finished (${JSON.stringify(scan)})`);
  await sleep(400);
  await page.screenshot({ path: join(out, 'gallery-panel.png') });

  const items = (await sw.evaluate((id) => chrome.storage.session.get(`tab:${id}`), tabId))[`tab:${tabId}`]?.items || [];
  const images = items.filter((i) => i.kind === 'image');
  const names = images.map((i) => basename(new URL(i.url).pathname)).sort();
  console.log('  found:', images.map((i) => i.url.replace(/^http:\/\/(localhost|127\.0\.0\.1):8765/, '')).join(', '));
  const expected = Array.from({ length: 10 }, (_, i) => `photo${i + 1}.jpg`).sort();
  check(JSON.stringify(names) === JSON.stringify(expected), `exactly the 10 full-size photos found (${names.length})`);
  check(!images.some((i) => /thumbs|logo/.test(i.url)), 'no thumbnails or logos in the results');
  check(images.find((i) => i.url.endsWith('photo9.jpg'))?.url.startsWith('http://127.0.0.1'), 'cross-origin viewer page resolved');
  check(images.find((i) => i.url.endsWith('photo10.jpg'))?.url.includes('/protected/'), 'lazy-loaded image (data-src) resolved');
  check(images.every((i) => i.thumb && /thumbs/.test(i.thumb)), 'grid uses the small thumbnails');
  const badge = await sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);
  check(badge === '', `images don't inflate the media badge ("${badge}")`);

  // Popup view of the grid.
  const popup = await browser.newPage();
  await popup.setViewport({ width: 412, height: 600, deviceScaleFactor: 2 });
  await popup.goto(`chrome-extension://${extId}/popup/popup.html?tab=${tabId}&view=images`);
  await sleep(900);
  await popup.evaluate(() => { document.querySelectorAll('.tile')[1]?.click(); document.querySelectorAll('.tile')[3]?.click(); });
  await sleep(300);
  await popup.screenshot({ path: join(out, 'popup-images.png') });
  await popup.evaluate(() => { document.querySelectorAll('.tile')[1]?.click(); document.querySelectorAll('.tile')[3]?.click(); });
  await popup.evaluate(() => { const b = document.querySelector('[data-filter="all"]'); b.click(); });
  await sleep(300);
  await popup.screenshot({ path: join(out, 'popup-all.png') });

  // Bulk download everything.
  const res = await popup.evaluate((id) => chrome.runtime.sendMessage({ type: 'images:download', tabId: id, ids: [] }), tabId);
  check(res?.ok && res.data.total === 10, `bulk download started (${JSON.stringify(res)})`);
  let rec;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    rec = (await sw.evaluate(async () => (await chrome.storage.local.get('downloads')).downloads || []))[0];
    if (rec && !['downloading', 'queued'].includes(rec.status)) break;
  }
  check(rec?.status === 'completed' && rec.done === 10 && rec.failed === 0, `batch → ${rec?.status} ${rec?.done}/${rec?.total} (failed ${rec?.failed}${rec?.error ? `, ${rec.error}` : ''})`);

  const mgr = await browser.newPage();
  await mgr.setViewport({ width: 1060, height: 560, deviceScaleFactor: 2 });
  await mgr.goto(`chrome-extension://${extId}/manager/manager.html`);
  await sleep(700);
  await mgr.screenshot({ path: join(out, 'manager-batch.png') });

  const files = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p); } };
  walk(dl);
  const imgs = files.filter((f) => f.endsWith('.jpg'));
  check(imgs.length >= 10, `images on disk in ${imgs[0] ? dirname(imgs[0]).replace(dl, '') : '?'}`);
  for (const f of imgs) {
    const wh = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f]).toString().trim();
    if (wh !== '1600,1200') check(false, `${basename(f)} is ${wh}, expected full size`);
  }
  check(imgs.length && imgs.every((f) => statSync(f).size > 50_000), 'every saved image is the full-size file');

  // Hotlink-protected gallery: every image needs the page's Referer.
  const prot = await browser.newPage();
  await prot.goto('http://localhost:8765/gallery-protected.html', { waitUntil: 'load' });
  await sleep(600);
  const ptab = await sw.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url?.includes('gallery-protected'))?.id);
  await sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'lfd:images-scan' }, { frameId: 0 }), ptab);
  for (let i = 0; i < 20; i++) {
    await sleep(400);
    const st = (await sw.evaluate((id) => chrome.storage.session.get(`imgscan:${id}`), ptab))[`imgscan:${ptab}`];
    if (st?.state === 'done') break;
  }
  const pres = await popup.evaluate((id) => chrome.runtime.sendMessage({ type: 'images:download', tabId: id, ids: [] }), ptab);
  let prec;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    prec = (await sw.evaluate(async () => (await chrome.storage.local.get('downloads')).downloads || []))[0];
    if (prec?.id === pres?.data?.id && prec.status !== 'downloading') break;
  }
  check(prec?.status === 'completed' && prec.done === 10, `protected gallery → ${prec?.done}/${prec?.total} saved (failed ${prec?.failed})`);
  const protDir = join(dl, 'LFDownloader', 'Protected Gallery');
  const protFiles = readdirSync(protDir).filter((f) => !f.endsWith('.crdownload'));
  const realImages = protFiles.filter((f) => {
    try { return execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', join(protDir, f)]).toString().trim() === '1600,1200'; } catch { return false; }
  });
  check(protFiles.length === 10 && realImages.length === 10, `protected gallery files are real full-size pictures (${realImages.length}/${protFiles.length}: ${protFiles.join(', ')})`);
  const leftovers = await sw.evaluate(() => chrome.downloads.search({ state: 'interrupted' }));
  check(leftovers.length === 0, `no failed entries left in the browser's download list (${leftovers.length})`);
} catch (e) {
  failures++;
  console.error(e);
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} gallery check(s) failed` : '\nAll gallery checks passed');
process.exit(failures ? 1 : 0);
