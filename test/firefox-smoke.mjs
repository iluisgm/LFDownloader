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
  const master = byUrl('hls/master');
  for (const [it, v] of [[byUrl('sample.mp4')], [master, master?.variants?.[0]], [fmp4]]) {
    if (!it) continue;
    const r = await send({ type: 'media:download', tabId, id: it.id, variantId: v?.id });
    check(r?.ok, `Firefox: download started ${it.url.split('/').pop()}${r?.error ? ` (${r.error})` : ''}`);
  }
  let recs = [];
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    recs = await mgr.evaluate(async () => (await browser.storage.local.get('downloads')).downloads || []);
    if (recs.length >= 3 && recs.every((r) => !['queued', 'downloading', 'saving'].includes(r.status))) break;
  }
  for (const r of recs) check(r.status === 'completed', `Firefox: ${r.type} ${r.filename} → ${r.status}${r.error ? ` (${r.error})` : ''}`);

  const files = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p); } };
  walk(dl);
  for (const f of files.filter((x) => !x.endsWith('.part'))) {
    let dur = 0;
    try { dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim()); } catch { /* invalid */ }
    check(Math.abs(dur - 12) < 1.5, `Firefox file ${f.replace(dl, '')} → ${dur.toFixed(2)}s`);
  }
  check(files.length >= 3, `Firefox: ${files.length} files on disk`);
} catch (e) {
  failures++;
  console.error(e);
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} Firefox check(s) failed` : '\nAll Firefox checks passed');
process.exit(failures ? 1 : 0);
