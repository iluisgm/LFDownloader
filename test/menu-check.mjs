// Quick visual check: the card "More" menu must float above the other cards.
import puppeteer from 'puppeteer-core';
import { mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from './server.mjs';
import { chromePath } from '../scripts/common.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'test', 'out', 'menu');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const server = await start(8765);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '✔' : '✘'} ${msg}`); if (!ok) failures++; };

const browser = await puppeteer.launch({
  executablePath: chromePath(), headless: true, pipe: true, enableExtensions: true,
  userDataDir: join(out, 'profile'), defaultViewport: { width: 1400, height: 900 },
});
try {
  const extId = await browser.installExtension(join(root, 'dist', 'chrome'));
  const sw = await (await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes(extId))).worker();
  await sleep(800);
  const page = await browser.newPage();
  await page.goto('http://localhost:8765/', { waitUntil: 'load' });
  await sleep(3000);
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({})).find((t) => t.url?.startsWith('http://localhost'))?.id);
  const popup = await browser.newPage();
  await popup.setViewport({ width: 400, height: 600, deviceScaleFactor: 2 });
  await popup.goto(`chrome-extension://${extId}/popup/popup.html?tab=${tabId}`);
  await sleep(1200);

  const probe = () => popup.evaluate(() => {
    const m = document.querySelector('.menu');
    if (!m) return null;
    const r = m.getBoundingClientRect();
    const pts = [[r.left + 10, r.top + 10], [r.right - 10, r.bottom - 10], [r.left + r.width / 2, r.top + r.height / 2]];
    return {
      onTop: pts.every(([x, y]) => m.contains(document.elementFromPoint(x, y))),
      inView: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
      up: m.classList.contains('up'),
    };
  });

  const mores = await popup.$$('[data-act="more"]');
  check(mores.length >= 2, `${mores.length} cards with a More button`);
  await mores[0].click();
  await sleep(300);
  let p = await probe();
  await popup.screenshot({ path: join(out, 'menu-first.png') });
  check(p?.onTop && p?.inView, `first card menu is on top of the next card and fully visible (${JSON.stringify(p)})`);

  await popup.keyboard.press('Escape');
  await sleep(200);
  check(!(await probe()), 'Esc closes the menu');
  await popup.evaluate(() => { const l = document.querySelector('.list'); l.scrollTop = l.scrollHeight; });
  await sleep(400);
  const last = (await popup.$$('[data-act="more"]')).at(-1);
  await last.click();
  await sleep(300);
  p = await probe();
  await popup.screenshot({ path: join(out, 'menu-last.png') });
  check(p?.onTop && p?.inView && p?.up, `last card menu opens upward and stays visible (${JSON.stringify(p)})`);

  await last.click();
  await sleep(200);
  check(!(await probe()), 'clicking More again closes the menu');
} finally {
  await browser.close().catch(() => {});
  server.closeAllConnections?.();
  server.close();
}
console.log(failures ? `${failures} check(s) failed` : 'Menu checks passed');
process.exit(failures ? 1 : 0);
