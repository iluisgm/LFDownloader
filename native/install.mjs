// Registers the LFDownloader helper with Brave, Chrome, Edge and Firefox
// (current Windows user only; no admin rights needed).
//
//   npm run helper:install                 auto-detects the extension's ID
//   npm run helper:install -- --id <id>    adds a Chrome/Brave extension ID
//   npm run helper:uninstall               removes everything again
//
// Writes:  native/out/  (launcher, manifests, config)
//          HKCU\Software\{Google\Chrome, BraveSoftware\Brave-Browser,
//                         Microsoft\Edge, Chromium, Mozilla}\NativeMessagingHosts\com.lfdownloader.helper
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOST = 'com.lfdownloader.helper';
export const FIREFOX_ID = 'lfdownloader@lfdownloader.local';
export const REG_PARENTS = [
  'Software\\Google\\Chrome',
  'Software\\BraveSoftware\\Brave-Browser',
  'Software\\Microsoft\\Edge',
  'Software\\Chromium',
];
export const REG_FIREFOX = 'Software\\Mozilla';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const out = join(here, 'out');
const regKey = (parent) => `HKCU\\${parent}\\NativeMessagingHosts\\${HOST}`;

if (process.platform !== 'win32') {
  console.error('This installer is for Windows. On macOS/Linux, copy native/out manifests to the browser’s NativeMessagingHosts folder.');
  process.exit(1);
}

const argv = process.argv.slice(2);
if (argv.includes('--uninstall')) {
  for (const p of [...REG_PARENTS, REG_FIREFOX]) {
    try { execFileSync('reg', ['delete', regKey(p), '/f'], { stdio: 'ignore' }); } catch { /* not there */ }
  }
  rmSync(out, { recursive: true, force: true });
  console.log('✔ LFDownloader helper removed (registry keys and native/out).');
  process.exit(0);
}

const ids = new Set();
for (let i = 0; i < argv.length; i++) if (argv[i] === '--id' && argv[i + 1]) ids.add(argv[++i].trim());
for (const id of ids) {
  if (!/^[a-p]{32}$/.test(id)) {
    console.error(`✘ "${id}" is not a Chrome/Brave extension ID (32 letters a–p). Copy it from brave://extensions.`);
    process.exit(1);
  }
}

// Keep IDs registered earlier (e.g. a second browser).
try {
  const prev = JSON.parse(readFileSync(join(out, 'chrome.json'), 'utf8'));
  for (const o of prev.allowed_origins || []) ids.add(o.replace(/^chrome-extension:\/\/|\/$/g, ''));
} catch { /* first install */ }

// Find unpacked copies of dist/chrome loaded in Brave/Chrome/Edge profiles.
const local = process.env.LOCALAPPDATA || '';
const target = resolve(root, 'dist', 'chrome').toLowerCase();
for (const browserDir of ['BraveSoftware\\Brave-Browser', 'Google\\Chrome', 'Microsoft\\Edge', 'Chromium']) {
  const userData = join(local, browserDir, 'User Data');
  if (!existsSync(userData)) continue;
  for (const profile of readdirSync(userData)) {
    for (const file of ['Secure Preferences', 'Preferences']) {
      const p = join(userData, profile, file);
      if (!existsSync(p)) continue;
      try {
        const settings = JSON.parse(readFileSync(p, 'utf8'))?.extensions?.settings || {};
        for (const [id, ext] of Object.entries(settings)) {
          if (ext?.path && resolve(ext.path).toLowerCase() === target) {
            if (!ids.has(id)) console.log(`  found the extension in ${browserDir.split('\\').pop()} (${profile}): ${id}`);
            ids.add(id);
          }
        }
      } catch { /* locked or not JSON */ }
    }
  }
}

function which(cmd) {
  try {
    return execFileSync('where', [cmd], { encoding: 'utf8' }).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || '';
  } catch {
    return '';
  }
}

function version(file, args) {
  try {
    return execFileSync(file, args, { encoding: 'utf8', timeout: 30_000 }).split(/\r?\n/)[0].trim();
  } catch {
    return '';
  }
}

const ytdlp = which('yt-dlp');
const ffmpeg = which('ffmpeg');
let downloads = '';
try {
  downloads = execFileSync('powershell', ['-NoProfile', '-Command', "(New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path"], { encoding: 'utf8' }).trim();
} catch { /* fall back below */ }
if (!downloads || !existsSync(downloads)) downloads = join(process.env.USERPROFILE || '', 'Downloads');

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'config.json'), JSON.stringify({ ytdlp, ffmpeg, downloads }, null, 2));

// The browser starts this launcher; it runs the helper with this exact Node.
const launcher = join(out, 'lfdownloader-helper.bat');
writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${join(here, 'host.mjs')}" %*\r\n`);

const base = { name: HOST, description: 'LFDownloader helper (yt-dlp)', path: launcher, type: 'stdio' };
const chromeManifest = join(out, 'chrome.json');
const firefoxManifest = join(out, 'firefox.json');
writeFileSync(chromeManifest, JSON.stringify({ ...base, allowed_origins: [...ids].map((id) => `chrome-extension://${id}/`) }, null, 2));
writeFileSync(firefoxManifest, JSON.stringify({ ...base, allowed_extensions: [FIREFOX_ID] }, null, 2));

for (const p of REG_PARENTS) execFileSync('reg', ['add', regKey(p), '/ve', '/t', 'REG_SZ', '/d', chromeManifest, '/f'], { stdio: 'ignore' });
execFileSync('reg', ['add', regKey(REG_FIREFOX), '/ve', '/t', 'REG_SZ', '/d', firefoxManifest, '/f'], { stdio: 'ignore' });

console.log('\n✔ LFDownloader helper installed');
console.log(`  yt-dlp     ${ytdlp ? `${version(ytdlp, ['--version'])}  (${ytdlp})` : '✘ not found: winget install yt-dlp.yt-dlp'}`);
console.log(`  ffmpeg     ${ffmpeg ? `found  (${ffmpeg})` : '✘ not found: winget install Gyan.FFmpeg'}`);
console.log(`  saves to   ${downloads}`);
console.log(`  Firefox    ${FIREFOX_ID}`);
console.log(`  Brave/Chrome/Edge  ${ids.size ? [...ids].join(', ') : '✘ no extension ID yet'}`);
if (!ids.size) {
  console.log('\n  Load dist/chrome in brave://extensions first, then run this again,');
  console.log('  or pass the ID shown there: npm run helper:install -- --id <id>');
}
console.log('\n  Reload the extension (or restart the browser) so it sees the helper.');
if (!ytdlp || !ffmpeg) process.exitCode = 2;
