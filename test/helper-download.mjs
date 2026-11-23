// Real downloads through the helper into test/out/helper (not the user's Downloads).
//   node test/helper-download.mjs [youtube-url]
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from './helper-check.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'out', 'helper');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const cfg = JSON.parse(readFileSync(join(here, '..', 'native', 'out', 'config.json'), 'utf8'));
writeFileSync(join(out, 'config.json'), JSON.stringify({ ...cfg, downloads: out }));
const env = { ...process.env, LFD_HELPER_CONFIG: join(out, 'config.json') };

let failures = 0;
const check = (ok, msg) => { console.log(`${ok ? '✔' : '✘'} ${msg}`); if (!ok) failures++; };
const url = process.argv[2] || 'https://www.youtube.com/watch?v=9UaVc0NFRog';

function job(h, payload) {
  return new Promise((res) => {
    const phases = new Set();
    let events = 0;
    let lastPct = 0;
    h.onEvent((m) => {
      if (m.job !== payload.job) return;
      if (m.event === 'progress') {
        events++;
        phases.add(m.phase);
        if (m.total) lastPct = Math.round((m.bytes / m.total) * 100);
        return;
      }
      res({ ...m, phases: [...phases], events, lastPct });
    });
    h.request('download', payload);
  });
}

const h = connect(env);

// 1) lowest video quality: video + audio merged into one MP4
const v = await job(h, { job: 'v144', url, height: 144, base: 'Test video - 144p', folder: 'LFDownloader', sizeHint: 31e6 });
check(v.event === 'done', `144p download → ${v.event} ${v.error || ''} (${v.events} progress events, phases: ${v.phases.join(' → ')}, last ${v.lastPct}%)`);
if (v.path) {
  const streams = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,height:stream_tags=language', '-of', 'csv=p=0', v.path]).toString().trim().split(/\r?\n/);
  check(v.path.endsWith('.mp4') && streams.some((s) => s.startsWith('h264') || s.includes('video')) && streams.some((s) => s.includes('aac')), `${v.path.split(/[\\/]/).pop()} has video + audio: ${streams.join(' | ')}`);
}

// 2) same name again → "(2)", not overwritten
const v2 = await job(h, { job: 'a1', url, audioOnly: true, audioFormat: 'm4a', base: 'Test video - 144p', folder: 'LFDownloader', sizeHint: 19e6 });
check(v2.event === 'done' && /\(2\)\.m4a$/.test(v2.path || ''), `audio-only M4A with a taken name → ${(v2.path || v2.error || '').split(/[\\/]/).pop()}`);

// 3) MP3 (converted by ffmpeg) of a short video
const mp3 = await job(h, { job: 'mp3', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', audioOnly: true, audioFormat: 'mp3', base: 'Zoo', folder: 'LFDownloader' });
const codec = mp3.path ? execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', mp3.path]).toString().trim() : '';
check(mp3.event === 'done' && mp3.path.endsWith('.mp3') && codec === 'mp3', `MP3 → ${(mp3.path || mp3.error || '').split(/[\\/]/).pop()} (${codec}, phases: ${mp3.phases.join(' → ')})`);

// 4) "open" refuses anything but media files
const refused = await h.request('open', { path: join(out, 'config.json') });
check(!refused.ok, `open refuses non-media files ("${refused.error}")`);

// 5) cancel midway removes partial files
const c = new Promise((res) => {
  h.onEvent((m) => { if (m.job === 'c1' && m.event === 'progress' && m.bytes > 2e6) h.request('cancel', { job: 'c1' }); if (m.job === 'c1' && m.event !== 'progress') res(m); });
});
h.request('download', { job: 'c1', url, height: 1080, base: 'Cancel me', folder: 'LFDownloader' });
const cr = await c;
await new Promise((r) => setTimeout(r, 1500));
const left = readdirSync(join(out, 'LFDownloader')).filter((f) => f.startsWith('Cancel me'));
check(cr.event === 'canceled' && left.length === 0, `cancel → ${cr.event}, leftovers: ${left.length ? left.join(', ') : 'none'}`);

// 4) a bad link gives a readable error
const bad = await job(h, { job: 'bad', url: 'https://www.youtube.com/watch?v=xxxxxxxxxxx', height: 360, base: 'nope', folder: 'LFDownloader' });
check(bad.event === 'error' && bad.error && !/Traceback/.test(bad.error), `unavailable video → "${bad.error}"`);

h.close();
console.log(failures ? `${failures} check(s) failed` : 'Helper download checks passed');
process.exitCode = failures ? 1 : 0;
