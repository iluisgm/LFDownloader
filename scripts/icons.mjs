#!/usr/bin/env node
// Renders the logo to PNG icons using the locally installed Chrome.
// Usage: node scripts/icons.mjs   (set CHROME_PATH if Chrome lives elsewhere)
import puppeteer from 'puppeteer-core';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOGO_SVG, chromePath } from './common.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'src', 'assets', 'icons');
await mkdir(out, { recursive: true });

const browser = await puppeteer.launch({ executablePath: chromePath(), headless: true });
const page = await browser.newPage();
for (const size of [16, 32, 48, 96, 128]) {
  // Small sizes get a slightly heavier arrow so it stays legible.
  const svg = size <= 32 ? LOGO_SVG.replaceAll('stroke-width="5.5"', 'stroke-width="7"') : LOGO_SVG;
  await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg', `<svg width="${size}" height="${size}"`)}</body></html>`);
  await page.screenshot({ path: join(out, `icon-${size}.png`), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  console.log(`✔ icon-${size}.png`);
}
await browser.close();
