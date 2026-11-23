#!/usr/bin/env node
// Builds dist/chrome and dist/firefox from src/ (no bundler needed: the code
// is plain ES modules). Usage: node scripts/build.mjs [chrome|firefox] [--watch]
import { cp, mkdir, readFile, rm, writeFile, watch } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const args = process.argv.slice(2);
const targets = args.filter((a) => !a.startsWith('--'));
const browsers = targets.length ? targets : ['chrome', 'firefox'];

const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

function manifestFor(browser, base) {
  const m = structuredClone(base);
  m.version = pkg.version;
  if (browser === 'chrome') {
    m.background = { service_worker: 'background/index.js', type: 'module' };
    m.minimum_chrome_version = '116';
  } else {
    m.background = { scripts: ['background/index.js'], type: 'module' };
    m.browser_specific_settings = {
      gecko: {
        id: 'lfdownloader@lfdownloader.local',
        strict_min_version: '142.0',
        data_collection_permissions: { required: ['none'] },
      },
    };
    // Firefox shows the options page inside about:addons unless asked otherwise.
    m.options_ui = { ...m.options_ui, open_in_tab: true };
  }
  return m;
}

async function build(browser) {
  const out = join(root, 'dist', browser);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await cp(src, out, {
    recursive: true,
    filter: (p) => !p.endsWith('manifest.json') && !p.endsWith('.svg.src'),
  });
  const base = JSON.parse(await readFile(join(src, 'manifest.json'), 'utf8'));
  await writeFile(join(out, 'manifest.json'), JSON.stringify(manifestFor(browser, base), null, 2));
  console.log(`✔ built ${browser} → dist/${browser}`);
}

for (const b of browsers) await build(b);

if (args.includes('--watch')) {
  console.log('Watching src/ for changes…');
  let timer;
  for await (const _ of watch(src, { recursive: true })) {
    clearTimeout(timer);
    timer = setTimeout(() => Promise.all(browsers.map(build)).catch(console.error), 150);
  }
}
