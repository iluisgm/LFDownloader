#!/usr/bin/env node
// Firefox test: install the add-on, check detection on the test page, then
// check Referer rules and real downloads (direct file + HLS stream) end to end.
// Usage: node test/firefox-smoke.mjs [outDir]   (run `npm run build:firefox` first)
import puppeteer from 'puppeteer-core';
import { mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from './server.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] || join(root, 'test', 'out-firefox'));
const dl = join(out, 'downloads');
rmSync(out, { recursive: true, force: true });
mkdirSync(dl, { recursive: true });

const ADDON_ID = 'lfdownloader@lfdownloader.local';
const UUID = '6b1f0c8e-5d2a-4c1e-9a7b-3f2e1d0c9b8a';
const firefox = process.env.FIREFOX_PATH || 'C:/Program Files/Mozilla Firefox/firefox.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '✔' : '✘'} ${msg}`); if (!ok) failures++; };

const server = await start(8765);
const browser = await puppeteer.launch({
  browser: 'firefox', executablePath: firefox, headless: true,
  // Lets the test evaluate code inside moz-extension:// pages.
  env: { ...process.env, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' },
  extraPrefsFirefox: {
    'extensions.webextensions.uuids': JSON.stringify({ [ADDON_ID]: UUID }),
    'browser.download.folderList': 2,
    'browser.download.dir': dl,
    'browser.download.useDownloadDir': true,
    'browser.download.always_ask_before_handling_new_types': false,
    'browser.download.alwaysOpenPanel': false,
  },
});
try {
  await browser.installExtension(join(root, 'dist', 'firefox'));
  const page = await browser.newPage();
  await page.goto('http://localhost:8765/', { waitUntil: 'load' });
  await sleep(3500);

  // BiDi can't navigate to moz-extension:// URLs directly.
  // popup.html is web-accessible, so an ordinary page may navigate to it.
  const mgr = await browser.newPage();
  await mgr.goto('http://localhost:8765/');
  await mgr.evaluate((u) => { location.href = u; }, `moz-extension://${UUID}/popup/popup.html?tab=0`);
  await sleep(1500);
  console.log('  extension page:', mgr.url());
  const send = (msg) => mgr.evaluate((m) => browser.runtime.sendMessage(m), msg);

  const tabs = await mgr.evaluate(() => browser.tabs.query({ url: 'http://localhost/*' }));
  const tabId = tabs[0]?.id;
  const list = (await send({ type: 'media:list', tabId }))?.data || [];
  console.log(list.map((i) => `  · ${i.kind}/${i.format} ${i.url.replace('http://localhost:8765', '')} ${(i.variants || []).map((v) => v.label).join(',')}${i.error ? ' ERR ' + i.error : ''}`).join('\n'));
  check(list.some((i) => i.url.endsWith('sample.mp4')), 'Firefox: MP4 detected');
  check(list.find((i) => i.url.includes('hls/master'))?.variants?.length >= 2, 'Firefox: HLS qualities read');
  const fmp4 = list.find((i) => i.url.includes('hls-fmp4'));
  check(fmp4 && !fmp4.error, `Firefox: Referer-protected stream inspected${fmp4?.error ? ` (${fmp4.error})` : ''}`);

  const rules = await send({ type: 'headers:add', urls: ['http://localhost:8765/x'], referer: 'http://localhost:8765/' });
  check(rules?.data?.length === 2, `Firefox: Referer rules accepted (${JSON.stringify(rules)})`);
  await send({ type: 'headers:remove', ids: rules?.data || [] });

  const byUrl = (s) => list.find((i) => i.url.includes(s));
  const pageVid = byUrl('hotlink-html/sample.mp4');
  const master = byUrl('hls/master');
  for (const [it, v] of [[list.find((i) => i.url.endsWith('/media/sample.mp4'))], [master, master?.variants?.[0]], [fmp4], [pageVid]]) {
    if (!it) continue;
    const r = await send({ type: 'media:download', tabId, id: it.id, variantId: v?.id });
    check(r?.ok, `Firefox: download started ${it.url.split('/').pop()}${r?.error ? ` (${r.error})` : ''}`);
  }
  let recs = [];
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    recs = await mgr.evaluate(async () => (await browser.storage.local.get('downloads')).downloads || []);
    if (recs.length >= 4 && recs.every((r) => !['queued', 'downloading', 'saving'].includes(r.status))) break;
  }
  check(recs.find((r) => r.url?.includes('/hotlink-html/'))?.type === 'fetch', 'Firefox: host that answers with a web page → fetched with the Referer');
  for (const r of recs) check(r.status === 'completed', `Firefox: ${r.type} ${r.filename} → ${r.status}${r.error ? ` (${r.error})` : ''}`);

  // ── gallery scan + bulk image download ──
  const gal = await browser.newPage();
  await gal.goto('http://localhost:8765/gallery.html', { waitUntil: 'load' });
  await sleep(1000);
  const galTab = (await mgr.evaluate(() => browser.tabs.query({ url: 'http://localhost/gallery.html' })))[0]?.id;
  await mgr.evaluate((id) => browser.tabs.sendMessage(id, { type: 'lfd:images-scan' }, { frameId: 0 }), galTab);
  let scan;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    scan = (await mgr.evaluate((id) => browser.storage.session.get(`imgscan:${id}`), galTab))[`imgscan:${galTab}`];
    if (scan?.state === 'done') break;
  }
  const imgs = ((await send({ type: 'media:list', tabId: galTab }))?.data || []).filter((i) => i.kind === 'image');
  check(scan?.state === 'done' && imgs.length === 10 && !imgs.some((i) => /thumbs|logo/.test(i.url)), `Firefox: gallery scan found ${imgs.length} full-size images`);
  const batch = await send({ type: 'images:download', tabId: galTab, ids: [] });
  check(batch?.ok, `Firefox: image batch started${batch?.error ? ` (${batch.error})` : ''}`);
  let brec;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    brec = (await mgr.evaluate(async () => (await browser.storage.local.get('downloads')).downloads || [])).find((r) => r.type === 'batch');
    if (brec && brec.status !== 'downloading') break;
  }
  check(brec?.status === 'completed' && brec.done === 10, `Firefox: images saved ${brec?.done}/${brec?.total} (failed ${brec?.failed}${brec?.error ? `, ${brec.error}` : ''})`);
  recs = recs.filter((r) => r.type !== 'batch');

  const files = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p); } };
  walk(dl);
  const jpgs = files.filter((x) => x.endsWith('.jpg'));
  check(jpgs.length === 10, `Firefox: ${jpgs.length} images on disk`);
  for (const f of files.filter((x) => !x.endsWith('.part') && !x.endsWith('.jpg'))) {
    let dur = 0;
    try { dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim()); } catch { /* invalid */ }
    check(Math.abs(dur - 12) < 1.5, `Firefox file ${f.replace(dl, '')} → ${dur.toFixed(2)}s`);
  }
  check(files.length - jpgs.length >= 4, `Firefox: ${files.length - jpgs.length} media files on disk`);
} catch (e) {
  failures++;
  console.error(e);
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} Firefox check(s) failed` : '\nAll Firefox checks passed');
process.exit(failures ? 1 : 0);
