// End to end: YouTube page → card with real qualities (via the yt-dlp helper)
// → download through popup + manager. Needs `npm run helper:install` first.
// Files go to test/out/youtube (the browser passes LFD_HELPER_CONFIG to the helper).
import puppeteer from 'puppeteer-core';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromePath } from '../scripts/common.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'test', 'out', 'youtube');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '✔' : '✘'} ${msg}`); if (!ok) failures++; };

const helperCfg = join(root, 'native', 'out', 'config.json');
if (!existsSync(helperCfg)) {
  console.error('Run `npm run helper:install` first.');
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(helperCfg, 'utf8'));
writeFileSync(join(out, 'config.json'), JSON.stringify({ ...cfg, downloads: out }));

const VIDEO = '9UaVc0NFRog';
const OTHER = 'jNQXAC9IVRw'; // "Me at the zoo"
const browser = await puppeteer.launch({
  executablePath: chromePath(), headless: true, pipe: true, enableExtensions: true,
  userDataDir: join(out, 'profile'), defaultViewport: { width: 1280, height: 800 },
  env: { ...process.env, LFD_HELPER_CONFIG: join(out, 'config.json') },
  args: ['--mute-audio'],
});

try {
  const extId = await browser.installExtension(join(root, 'dist', 'chrome'));
  const allowed = JSON.parse(readFileSync(join(root, 'native', 'out', 'chrome.json'), 'utf8')).allowed_origins;
  if (!allowed.includes(`chrome-extension://${extId}/`)) {
    execFileSync(process.execPath, [join(root, 'native', 'install.mjs'), '--id', extId], { stdio: 'ignore' });
  }
  const sw = await (await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes(extId))).worker();
  await sw.evaluate(() => chrome.storage.local.set({ settings: { notifyOnComplete: false } }));
  await sleep(800);
  for (const p of await browser.pages()) if (p.url().includes('welcome')) await p.close();

  const status = await sw.evaluate(async () => {
    const r = await chrome.runtime.sendNativeMessage('com.lfdownloader.helper', { id: 1, type: 'hello' });
    return r;
  });
  check(status?.ok && status.data.ytdlp, `browser reaches the helper (yt-dlp ${status?.data?.ytdlp}, ffmpeg ${status?.data?.ffmpeg})`);

  // ── a YouTube watch page (with &t=, which must not matter) ──
  const page = await browser.newPage();
  await page.goto(`https://www.youtube.com/watch?v=${VIDEO}&t=163s`, { waitUntil: 'domcontentloaded' });
  await sleep(3000);
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url?.includes('youtube.com'))?.id);
  const items = async () => (await sw.evaluate((id) => chrome.storage.session.get(`tab:${id}`), tabId))[`tab:${tabId}`]?.items || [];
  let yt = (await items()).find((i) => i.key === `yt:${VIDEO}`);
  check(!!yt && yt.source === 'ytdlp', `YouTube video detected from the page address (${page.url().slice(0, 60)})`);

  const popup = await browser.newPage();
  await popup.setViewport({ width: 400, height: 600, deviceScaleFactor: 2 });
  await popup.goto(`chrome-extension://${extId}/popup/popup.html?tab=${tabId}`);
  await sleep(500);
  await popup.screenshot({ path: join(out, 'popup-loading.png') });
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    yt = (await items()).find((x) => x.key === `yt:${VIDEO}`);
    if (yt?.info && yt.info !== 'loading') break;
  }
  await sleep(500);
  check(yt?.info === 'ready', `qualities read by yt-dlp → ${yt?.info} ${yt?.infoError || ''}`);
  const labels = (yt?.variants || []).map((v) => v.label);
  check(labels.includes('1080p60') && labels.includes('2160p60') && labels.includes('MP3'), `qualities: ${labels.join(', ')}`);
  check(yt?.defaultVariant === 'v1080', `1080p is preselected (${yt?.defaultVariant})`);
  const card = await popup.evaluate(() => {
    const c = document.querySelector('.card[data-kind="video"]');
    return c && { title: c.querySelector('.title')?.textContent, checked: c.querySelector('.q[aria-checked="true"]')?.textContent.trim(), note: c.querySelector('.actions .grow')?.textContent, earlier: !!document.querySelector('.group-label') };
  });
  check(card && /PRODRIVE/.test(card.title) && /1080p60/.test(card.checked) && !card.earlier, `card: "${card?.title}" · ${card?.checked} · ${card?.note}${card?.earlier ? ' (wrongly under Earlier)' : ''}`);
  await popup.screenshot({ path: join(out, 'popup-youtube.png') });

  // ── moving to another video inside YouTube (no page load) ──
  await page.evaluate((id) => history.pushState({}, '', `/watch?v=${id}`), OTHER);
  await sleep(1500);
  const other = (await items()).find((i) => i.key === `yt:${OTHER}`);
  check(!!other, 'in-page navigation to another video adds its card');
  await page.evaluate((id) => history.pushState({}, '', `/watch?v=${id}&t=10s`), VIDEO);
  await sleep(800);

  // ── download 240p through the popup ──
  await popup.reload();
  await sleep(1500);
  const clicked = await popup.evaluate((key) => {
    const c = document.querySelector(`.card[data-key="${key}"]`);
    const q = [...c.querySelectorAll('.q')].find((b) => b.textContent.trim().startsWith('240p'));
    q?.click();
    const est = c.querySelector('.est')?.textContent;
    c.querySelector('[data-act="download"]').click();
    return { ok: !!q, est };
  }, `yt:${VIDEO}`);
  check(clicked.ok, `picked 240p (${clicked.est})`);

  let rec;
  let sawProgress = false;
  for (let i = 0; i < 240; i++) {
    await sleep(500);
    rec = (await sw.evaluate(async () => (await chrome.storage.local.get('downloads')).downloads || [])).find((r) => r.type === 'ytdlp');
    const mgr = (await browser.pages()).find((p) => p.url().includes('manager.html'));
    if (mgr && !sawProgress) {
      const pct = await mgr.evaluate(() => document.querySelector('.row.active [data-f="pct"]')?.textContent || '').catch(() => '');
      if (/\d+%/.test(pct) && pct !== '0%') {
        sawProgress = true;
        await mgr.setViewport({ width: 1060, height: 560, deviceScaleFactor: 2 });
        await mgr.screenshot({ path: join(out, 'manager-progress.png') });
      }
    }
    if (rec && ['completed', 'failed', 'canceled', 'interrupted'].includes(rec.status)) break;
  }
  check(sawProgress, 'manager showed live progress');
  check(rec?.status === 'completed', `download → ${rec?.status} ${rec?.error || ''} · ${rec?.savedPath?.split(/[\\/]/).pop()}`);
  if (rec?.savedPath) {
    check(rec.savedPath.startsWith(out), 'saved into the configured folder');
    const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,height', '-of', 'csv=p=0', rec.savedPath]).toString().trim().replace(/\r?\n/g, ' | ');
    check(/h264,video,240/.test(probe) && /aac,audio/.test(probe), `file has 240p H.264 video + AAC audio: ${probe}`);
  }
  const mgr = (await browser.pages()).find((p) => p.url().includes('manager.html'));
  if (mgr) {
    await sleep(600);
    await mgr.screenshot({ path: join(out, 'manager-done.png') });
    const ops = await mgr.evaluate(() => [...document.querySelectorAll('.row:not(.active) [data-op]')].map((b) => b.dataset.op));
    check(ops.includes('open') && ops.includes('show'), `finished row offers Open and Show in folder (${ops.join(',')})`);
  }
} finally {
  await browser.close().catch(() => {});
}
console.log(failures ? `${failures} check(s) failed` : 'All YouTube checks passed');
process.exit(failures ? 1 : 0);
