#!/usr/bin/env node
// Builds the Firefox add-on and gets it signed by Mozilla as an *unlisted*
// (private, self-distributed) add-on, so regular Firefox keeps it installed
// across restarts. Nothing is published on addons.mozilla.org.
//
// One-time setup: create API credentials at
//   https://addons.mozilla.org/developers/addon/api/key/
// and store them as user environment variables (see README):
//   WEB_EXT_API_KEY     (the "JWT issuer", looks like user:12345:678)
//   WEB_EXT_API_SECRET  (the "JWT secret")
//
// Usage: npm run sign:firefox
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

if (!process.env.WEB_EXT_API_KEY || !process.env.WEB_EXT_API_SECRET) {
  console.error(`✘ Missing Mozilla API credentials.

  1. Sign in at https://addons.mozilla.org/developers/addon/api/key/ and click
     "Generate new credentials".
  2. Save them as environment variables (PowerShell), then open a new terminal:
       [Environment]::SetEnvironmentVariable('WEB_EXT_API_KEY', '<JWT issuer>', 'User')
       [Environment]::SetEnvironmentVariable('WEB_EXT_API_SECRET', '<JWT secret>', 'User')
  3. Run npm run sign:firefox again.`);
  process.exit(1);
}

const run = (cmd, args) => spawnSync(cmd, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });

console.log(`Building LFDownloader ${version} for Firefox…`);
if (run('node', ['scripts/build.mjs', 'firefox']).status !== 0) process.exit(1);

console.log('Submitting to Mozilla for signing (unlisted — nothing is published)…');
const res = run('npx', [
  'web-ext', 'sign',
  '--channel', 'unlisted',
  '--source-dir', 'dist/firefox',
  '--artifacts-dir', 'dist/packages',
  '--approval-timeout', '900000',
]);
if (res.status !== 0) {
  console.error(`
✘ Signing failed. Common causes:
  • "Version ${version} already exists": every upload needs a new version. Run
      npm version patch --no-git-tag-version
    then npm run sign:firefox again.
  • Invalid credentials: regenerate them on the API key page.`);
  process.exit(1);
}

const xpis = readdirSync(join(root, 'dist', 'packages'))
  .filter((f) => f.endsWith('.xpi'))
  .map((f) => join(root, 'dist', 'packages', f))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
console.log(`
✔ Signed: ${xpis[0] || 'dist/packages/*.xpi'}

Install it once: open Firefox and drag the .xpi file onto any window
(or about:addons → ⚙ → "Install Add-on From File…"). It stays installed
across restarts. To update later: bump the version, sign again, install the new .xpi.`);
