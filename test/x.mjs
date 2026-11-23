// End to end: a public X post → "X" card (yt-dlp) → one MP4 with video + audio.
// Needs `npm run helper:install`. Files go to test/out/x.
import puppeteer from 'puppeteer-core';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromePath } from '../scripts/common.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'test', 'out', 'x');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '✔' : '✘'} ${msg}`); if (!ok) failures++; };
const cfgPath = join(root, 'native', 'out', 'config.json');
if (!existsSync(cfgPath)) { console.error('Run `npm run helper:install` first.'); process.exit(1); }
writeFileSync(join(out, 'config.json'), JSON.stringify({ ...JSON.parse(readFileSync(cfgPath, 'utf8')), downloads: out }));

const POST = process.argv[2] || 'https://x.com/CAF_Online/status/1349365911120195585';
const ID = POST.match(/status\/(\d+)/)[1];
const browser = await puppeteer.launch({
  executablePath: chromePath(), headless: true, pipe: true, enableExtensions: true,
  userDataDir: join(out, 'profile'), defaultViewport: { width: 1280, height: 900 },
  env: { ...process.env, LFD_HELPER_CONFIG: join(out, 'config.json') }, args: ['--mute-audio'],
});
try {
  const extId = await browser.installExtension(join(root, 'dist', 'chrome'));
  const sw = await (await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes(extId))).worker();
  await sw.evaluate(() => chrome.storage.local.set({ settings: { notifyOnComplete: false } }));
  await sleep(800);
  for (const p of await browser.pages()) if (p.url().includes('welcome')) await p.close();

  const page = await browser.newPage();
  // X refuses "HeadlessChrome"; present as the regular browser.
  await page.setUserAgent((await browser.userAgent()).replace('HeadlessChrome', 'Chrome'));
  await page.goto(POST, { waitUntil: 'domcontentloaded' });
  let hasVideo = false;
  for (let i = 0; i < 30 && !hasVideo; i++) {
    await sleep(500);
    hasVideo = await page.evaluate(() => !!document.querySelector('article video')).catch(() => false);
  }
  await page.screenshot({ path: join(out, 'post.png') });
  check(hasVideo, 'the post shows its video to a signed-out browser');
  await page.evaluate(() => document.querySelector('article video')?.play().catch(() => {}));
  await sleep(2500);

  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({})).find((t) => /x\.com/.test(t.url || ''))?.id);
  const items = async () => (await sw.evaluate((id) => chrome.storage.session.get(`tab:${id}`), tabId))[`tab:${tabId}`]?.items || [];
  let card = (await items()).find((i) => i.key === `x:${ID}`);
  check(!!card, `X card for post ${ID} (${card?.title || 'none'})`);
  const streams = (await items()).filter((i) => i.url.includes('video.twimg.com')).length;

  const popup = await browser.newPage();
  await popup.setViewport({ width: 400, height: 600, deviceScaleFactor: 2 });
  await popup.goto(`chrome-extension://${extId}/popup/popup.html?tab=${tabId}`);
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    card = (await items()).find((x) => x.key === `x:${ID}`);
    if (card?.info && card.info !== 'loading') break;
  }
  await sleep(600);
  check(card?.info === 'ready', `qualities from yt-dlp → ${card?.info} ${card?.infoError || ''} (${(card?.variants || []).map((v) => v.label).join(', ')})`);
  const shown = await popup.evaluate(() => [...document.querySelectorAll('.card')].map((c) => c.dataset.key));
  check(shown[0] === `x:${ID}` && !shown.some((k) => k.includes('twimg')), `popup shows the X card first and hides ${streams} raw X stream(s) (shown: ${shown.join(', ')})`);
  await popup.screenshot({ path: join(out, 'popup-x.png') });

  await popup.evaluate((key) => document.querySelector(`.card[data-key="${key}"] [data-act="download"]`).click(), `x:${ID}`);
  let rec;
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    rec = (await sw.evaluate(async () => (await chrome.storage.local.get('downloads')).downloads || [])).find((r) => r.type === 'ytdlp');
    if (rec && ['completed', 'failed', 'canceled', 'interrupted'].includes(rec.status)) break;
  }
  check(rec?.status === 'completed', `download → ${rec?.status} ${rec?.error || ''} · ${rec?.savedPath?.split(/[\\/]/).pop()}`);
  if (rec?.savedPath) {
    const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,height', '-of', 'csv=p=0', rec.savedPath]).toString().trim().replace(/\r?\n/g, ' | ');
    check(rec.savedPath.endsWith('.mp4') && /video/.test(probe) && /audio/.test(probe), `one MP4 with video + audio: ${probe}`);
  }
} finally {
  await browser.close().catch(() => {});
}
console.log(failures ? `${failures} check(s) failed` : 'All X checks passed');
process.exit(failures ? 1 : 0);
