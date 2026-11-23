#!/usr/bin/env node
// End-to-end check in real Chrome: detection, popup, panel, floating button,
// and actual downloads of MP4 / HLS (multi-quality, AES-128, fMP4 + Referer).
// Usage: node test/e2e.mjs [outDir]   (run `npm run build:chrome` first)
import puppeteer from 'puppeteer-core';
import { mkdirSync, rmSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from './server.mjs';
import { chromePath } from '../scripts/common.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] || join(root, 'test', 'out'));
const shots = join(out, 'shots');
const dl = join(out, 'downloads');
rmSync(out, { recursive: true, force: true });
mkdirSync(shots, { recursive: true });
mkdirSync(dl, { recursive: true });

const PORT = 8765;
const server = await start(PORT);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '✔' : '✘'} ${msg}`); if (!ok) failures++; };

// A fresh profile whose download folder is our output dir (keeps the
// extension's own file names, unlike CDP's download override).
const profile = join(out, 'profile');
mkdirSync(join(profile, 'Default'), { recursive: true });
writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({
  download: { default_directory: dl, prompt_for_download: false, directory_upgrade: true },
}));

const browser = await puppeteer.launch({
  executablePath: chromePath(),
  userDataDir: profile,
  headless: true,
  pipe: true,
  enableExtensions: true,
  args: ['--window-size=1400,900', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 1400, height: 900 },
});

try {
  const extId = await browser.installExtension(join(root, 'dist', 'chrome'));
  console.log('extension id', extId);

  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes(extId));
  const sw = await swTarget.worker();
  await sw.evaluate(() => chrome.storage.local.set({ settings: { notifyOnComplete: false } }));

  // Close the welcome tab opened on install.
  await sleep(800);
  for (const p of await browser.pages()) if (p.url().includes('welcome')) await p.close();

  // ── detection ──
  const page = await browser.newPage();
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
  await page.evaluate(() => { const v = document.getElementById('mp4'); v.muted = true; return v.play().catch(() => {}); });
  await sleep(3000);
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'http://localhost/*' }))[0]?.id
    ?? (await chrome.tabs.query({})).find((t) => t.url.startsWith('http://localhost'))?.id);
  const items = await sw.evaluate(async (id) => (await chrome.storage.session.get(`tab:${id}`))[`tab:${id}`]?.items || [], tabId);
  const by = (s) => items.find((i) => i.url.includes(s));
  console.log(items.map((i) => `  · ${i.kind}/${i.format} ${i.url.replace(`http://localhost:${PORT}`, '')} ${i.size || ''} ${(i.variants || []).map((v) => v.label).join(',')}${i.error ? ' ERR ' + i.error : ''}`).join('\n'));
  check(by('sample.mp4')?.kind === 'video', 'MP4 detected');
  check(by('song.mp3')?.kind === 'audio', 'MP3 detected');
  check(by('tone.wav')?.kind === 'audio', 'WAV link found by DOM scan');
  check(!by('beep.mp3'), 'tiny beep.mp3 ignored');
  const master = by('hls/master.m3u8');
  check(master?.variants?.map((v) => v.label).join(',') === '720p,360p', 'HLS master → 720p,360p');
  check(!items.some((i) => /hls\/v\d\.m3u8/.test(i.url)), 'child playlists not listed twice');
  check(!items.some((i) => i.url.endsWith('.ts') || i.url.endsWith('.m4s')), 'segments ignored');
  check(by('hls-aes')?.encrypted && !by('hls-aes')?.drm, 'AES-128 stream detected (not DRM)');
  const fmp4 = by('hls-fmp4');
  check(fmp4 && !fmp4.error && fmp4.fmp4, `Referer-protected fMP4 stream inspected${fmp4?.error ? ` (${fmp4.error})` : ''}`);
  check(Math.round(master?.duration || 0) === 12, 'HLS duration read');
  const split = by('hls-split/master');
  check(split?.variants?.some((v) => v.audioOnly) && split.variants[0].audioUrl, 'separate audio track → "Audio only" chip + muxed pairing');
  const badge = await sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);
  check(badge === String(items.length), `badge shows ${badge}`);

  // ── popup UI screenshots ──
  const popup = await browser.newPage();
  await popup.setViewport({ width: 412, height: 600, deviceScaleFactor: 2 });
  await popup.goto(`chrome-extension://${extId}/popup/popup.html?tab=${tabId}`);
  await sleep(700);
  await popup.screenshot({ path: join(shots, 'popup-dark.png') });
  await sw.evaluate(() => chrome.storage.local.set({ settings: { theme: 'light', notifyOnComplete: false } }));
  await popup.reload();
  await sleep(700);
  await popup.screenshot({ path: join(shots, 'popup-light.png') });
  await sw.evaluate(() => chrome.storage.local.set({ settings: { theme: 'dark', notifyOnComplete: false } }));

  // ── floating button + in-page panel ──
  await page.bringToFront();
  const box = await (await page.$('#msevideo')).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await sleep(200);
  await page.mouse.move(box.x + box.width / 2 + 10, box.y + box.height / 2 + 5);
  await sleep(900);
  await page.screenshot({ path: join(shots, 'page-fab.png') });
  await sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'lfd:panel', focus: '' }, { frameId: 0 }), tabId);
  await sleep(1200);
  await page.screenshot({ path: join(shots, 'page-panel.png') });
  await page.keyboard.press('Escape');

  // ── downloads ──
  const dlItem = async (match, label) => {
    const it = items.find((i) => i.url.includes(match));
    const v = label ? it.variants.find((x) => x.label === label) : null;
    return popup.evaluate((tabId, id, variantId) => chrome.runtime.sendMessage({ type: 'media:download', tabId, id, variantId }), tabId, it.id, v?.id);
  };
  for (const [m, l] of [['sample.mp4'], ['hls/master.m3u8', '720p'], ['hls-aes'], ['hls-fmp4'], ['hls-split/master', '720p']]) {
    const r = await dlItem(m, l);
    check(r?.ok, `download started: ${m} ${l || ''}${r?.error ? ` (${r.error})` : ''}`);
  }
  // Audio files: click the popup's own Download buttons (uses its per-item names).
  await popup.bringToFront();
  await popup.reload();
  await sleep(700);
  for (const name of ['song.mp3', 'tone.wav']) {
    await popup.evaluate((n) => document.querySelector(`.card[data-key*="${n}"] [data-act="download"]`)?.click(), name);
    await sleep(400);
  }

  // Wait for every record to finish.
  let recs = [];
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    recs = await sw.evaluate(async () => (await chrome.storage.local.get('downloads')).downloads || []);
    if (i === 1) {
      const mgr = (await browser.pages()).find((p) => p.url().includes('manager.html'));
      if (mgr) {
        await mgr.setViewport({ width: 1060, height: 720, deviceScaleFactor: 2 });
        await mgr.screenshot({ path: join(shots, 'manager-active.png') });
      }
    }
    if (recs.length >= 7 && recs.every((r) => !['queued', 'downloading', 'saving'].includes(r.status))) break;
  }
  for (const r of recs) check(r.status === 'completed', `${r.type} ${r.filename} → ${r.status}${r.error ? ` (${r.error})` : ''}`);

  const mgr = (await browser.pages()).find((p) => p.url().includes('manager.html'));
  if (mgr) {
    await mgr.setViewport({ width: 1060, height: 720, deviceScaleFactor: 2 });
    await sleep(400);
    await mgr.screenshot({ path: join(shots, 'manager-done.png') });
  }

  // Validate the files with ffprobe.
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p); } };
  walk(dl);
  const names = files.map((f) => basename(f));
  check(names.includes('song.mp3') && names.includes('Download the tone (WAV).wav'), `audio files keep their own names (${names.filter((n) => /mp3|wav/.test(n)).join(', ')})`);
  check(names.some((n) => n.includes('(audio)')), 'separate audio track saved as its own file');
  for (const f of files) {
    if (/\.(mp3|wav)$/.test(f)) continue;
    let dur = 0;
    try {
      dur = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());
    } catch { /* invalid */ }
    check(Math.abs(dur - 12) < 1.5, `ffprobe ${f.replace(dl, '')} → ${dur.toFixed(2)}s, ${(statSync(f).size / 1e6).toFixed(2)} MB`);
  }
  check(files.length >= 8, `${files.length} files on disk`);

  // Settings page screenshot.
  const opt = await browser.newPage();
  await opt.setViewport({ width: 900, height: 1100, deviceScaleFactor: 1.5 });
  await opt.goto(`chrome-extension://${extId}/options/options.html`);
  await sleep(500);
  await opt.screenshot({ path: join(shots, 'options.png'), fullPage: true });
  const wel = await browser.newPage();
  await wel.setViewport({ width: 1200, height: 800, deviceScaleFactor: 1.5 });
  await wel.goto(`chrome-extension://${extId}/welcome/welcome.html`);
  await sleep(900);
  await wel.screenshot({ path: join(shots, 'welcome.png') });
} catch (e) {
  failures++;
  console.error(e);
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
