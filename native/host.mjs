// LFDownloader helper — a native-messaging host that lets the extension use
// yt-dlp (and ffmpeg) for sites like YouTube, where the video can't be taken
// from the page's network traffic.
//
// Protocol: every message is a 4-byte little-endian length + UTF-8 JSON, on
// stdin/stdout. NOTHING else may be written to stdout (no console.log).
//
// Requests  {id, type, ...}  →  replies {id, ok, data | error}
//   hello                 versions of the helper, yt-dlp and ffmpeg
//   info {url}            title, duration and the qualities on offer
//   download {job, ...}   starts a download; streams {event, job, ...}
//   cancel {job}          stops a download and removes its partial files
//   open {path, reveal}   opens a downloaded file, or shows it in Explorer
import { spawn, execFile } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync, unlinkSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = 1;
const here = dirname(fileURLToPath(import.meta.url));
const config = loadConfig();
const ENV = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };

function loadConfig() {
  try {
    return JSON.parse(readFileSync(process.env.LFD_HELPER_CONFIG || join(here, 'out', 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

const ytdlp = () => config.ytdlp || 'yt-dlp';
const ffmpegArgs = () => (config.ffmpeg ? ['--ffmpeg-location', config.ffmpeg] : []);

// ───────────────────────── framing ─────────────────────────

let inbox = Buffer.alloc(0);
let pending = 0; // replies still owed (one-shot requests)
let closing = false;

process.stdin.on('data', (chunk) => {
  inbox = Buffer.concat([inbox, chunk]);
  while (inbox.length >= 4) {
    const n = inbox.readUInt32LE(0);
    if (inbox.length < 4 + n) break;
    const raw = inbox.subarray(4, 4 + n).toString('utf8');
    inbox = inbox.subarray(4 + n);
    let msg;
    try { msg = JSON.parse(raw); } catch { continue; }
    handle(msg);
  }
});

// The browser closed the connection: stop everything we started.
process.stdin.on('end', () => {
  closing = true;
  for (const job of jobs.values()) cancelJob(job);
  maybeExit();
});

function maybeExit() {
  if (closing && pending === 0 && jobs.size === 0) setTimeout(() => process.exit(0), 50);
}

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

async function handle(msg) {
  const fn = handlers[msg?.type];
  if (!fn) return send({ id: msg?.id, ok: false, error: `Unknown request: ${msg?.type}` });
  pending++;
  try {
    send({ id: msg.id, ok: true, data: await fn(msg) });
  } catch (e) {
    send({ id: msg.id, ok: false, error: e?.message || String(e) });
  } finally {
    pending--;
    maybeExit();
  }
}

// ───────────────────────── helpers ─────────────────────────

function run(file, args, { timeout = 90_000 } = {}) {
  return new Promise((res, rej) => {
    execFile(file, args, { env: ENV, timeout, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return rej(err);
      }
      res(stdout);
    });
  });
}

function checkUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error('That is not a web address.'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) links can be downloaded.');
  return u.href;
}

/** Turn yt-dlp's error output into something a person can act on. */
function friendly(stderr, fallback = 'yt-dlp failed') {
  const lines = String(stderr || '').split(/\r?\n/).filter(Boolean);
  const err = [...lines].reverse().find((l) => l.startsWith('ERROR:')) || lines.at(-1) || fallback;
  const m = err.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?([\w-]{6,}:\s*)?/, '');
  if (/confirm you.?re not a bot|Sign in to confirm/i.test(m)) return 'YouTube asked to confirm you’re not a bot. Wait a few minutes and try again, or update yt-dlp.';
  if (/age.?restrict|confirm your age|inappropriate for some users/i.test(m)) return 'This video is age-restricted, so it can’t be downloaded without signing in.';
  if (/Private video/i.test(m)) return 'This video is private.';
  if (/members.only|join this channel/i.test(m)) return 'This video is for channel members only.';
  if (/live event will begin|is upcoming|Premieres in/i.test(m)) return 'This live stream or premiere hasn’t started yet.';
  if (/Requested format is not available/i.test(m)) return 'That quality isn’t available for this video. Pick another one.';
  if (/HTTP Error 403/i.test(m)) return 'The site refused the download (403). Updating yt-dlp usually fixes this.';
  if (/Unsupported URL/i.test(m)) return 'yt-dlp doesn’t support this page.';
  if (/ffmpeg.*not (found|installed)|ffprobe.*not found/i.test(m)) return 'ffmpeg is needed to join video and audio. Install it and run the helper setup again.';
  if (/ENOENT/.test(m)) return 'yt-dlp was not found. Install it and run the helper setup again.';
  return m.slice(0, 300);
}

const HEIGHTS = [4320, 2880, 2160, 1440, 1080, 720, 480, 360, 240, 144];

/** Reduce yt-dlp's full JSON (often ~1 MB) to what the popup needs. */
function summarize(j) {
  const formats = (j.formats || []).filter((f) => f.format_note !== 'storyboard' && f.ext !== 'mhtml');
  const size = (f) => f?.filesize || f?.filesize_approx || (f?.tbr && j.duration ? Math.round((f.tbr * 1000 * j.duration) / 8) : 0);
  // Audio-only streams (some sites, like X, don't name the codec).
  const audios = formats.filter((f) => f.vcodec === 'none' && f.acodec !== 'none' && (f.acodec || /audio/i.test(f.format_id || '')));
  // The original-language track first (dubbed tracks have a lower preference).
  const pref = (f) => (f.language_preference ?? 0) * 1e6 + (f.abr || f.tbr || 0);
  const bestAudio = (pred = () => true) => audios.filter(pred).sort((a, b) => pref(b) - pref(a))[0];
  const m4a = bestAudio((f) => f.ext === 'm4a') || bestAudio();
  const anyAudio = bestAudio();
  const videos = formats.filter((f) => f.vcodec !== 'none' && f.height);

  const qualities = [];
  for (const h of HEIGHTS) {
    const at = videos.filter((f) => f.height === h || (f.height > h * 0.9 && f.height <= h));
    if (!at.length) continue;
    const fps = Math.max(...at.map((f) => f.fps || 0));
    // Estimate with the file yt-dlp will really pick: plain https over HLS,
    // H.264 up to 1080p, otherwise AV1 > VP9 > the rest.
    const direct = at.filter((f) => f.protocol === 'https');
    const pool = direct.length ? direct : at;
    const byRate = (a, b) => (b.fps || 0) - (a.fps || 0) || (b.tbr || 0) - (a.tbr || 0);
    const codecRank = (f) => (/^av01/.test(f.vcodec) ? 3 : /^vp0?9/.test(f.vcodec) ? 2 : 1);
    // H.264, or a plain .mp4 whose codec isn't named (X's progressive files).
    const mp4 = pool.filter((f) => /^avc1/.test(f.vcodec || '') || (!f.vcodec && f.ext === 'mp4')).sort(byRate)[0];
    const best = mp4 && h <= 1080 ? mp4 : [...pool].sort((a, b) => codecRank(b) - codecRank(a) || byRate(a, b))[0];
    const hasOwnAudio = best.acodec && best.acodec !== 'none';
    qualities.push({
      height: h, fps, hdr: at.some((f) => f.dynamic_range && f.dynamic_range !== 'SDR'),
      container: mp4 && h <= 1080 ? 'mp4' : 'mkv',
      size: size(best) + (hasOwnAudio ? 0 : size(mp4 && h <= 1080 ? m4a : anyAudio)),
    });
  }
  return {
    id: j.id, title: j.title || '', uploader: j.uploader || j.channel || '', duration: j.duration || 0,
    thumbnail: j.thumbnail || '', webpage_url: j.webpage_url || '', site: j.extractor_key || '',
    live: j.live_status === 'is_live' || j.is_live === true,
    upcoming: j.live_status === 'is_upcoming',
    qualities,
    audio: anyAudio ? { size: size(m4a || anyAudio), abr: Math.round((m4a || anyAudio).abr || (m4a || anyAudio).tbr || 0) } : null,
    // A single file with no separate streams (most non-YouTube sites).
    single: !qualities.length && !anyAudio ? { size: size(formats.at(-1)), ext: formats.at(-1)?.ext || j.ext || 'mp4' } : null,
  };
}

// ───────────────────────── downloads ─────────────────────────

const jobs = new Map(); // job id -> { proc, dir, base, canceled }

function downloadsRoot() {
  return config.downloads || join(process.env.USERPROFILE || '', 'Downloads');
}

function cleanName(s, max = 150) {
  return String(s || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*%]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, max)
    .trim() || 'video';
}

function cleanFolder(f) {
  return String(f || '').split(/[\\/]+/).map((p) => cleanName(p, 60)).filter((p) => p && p !== 'video' && p !== '..' && p !== '.').join(sep);
}

/** "Title.mp4" exists already → "Title (2)". */
function uniqueBase(dir, base) {
  const exts = ['mp4', 'mkv', 'webm', 'm4a', 'mp3', 'opus', 'ogg', 'mov'];
  const taken = (b) => exts.some((e) => existsSync(join(dir, `${b}.${e}`)));
  if (!taken(base)) return base;
  for (let i = 2; i < 1000; i++) if (!taken(`${base} (${i})`)) return `${base} (${i})`;
  return `${base} ${Date.now()}`;
}

function formatArgs({ height, audioOnly, audioFormat }) {
  if (audioOnly) {
    return audioFormat === 'mp3'
      ? ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0']
      : ['-f', 'ba[ext=m4a]/ba/b', '-x', '--audio-format', 'm4a'];
  }
  if (!height) return ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4/mkv'];
  const h = Number(height);
  if (h <= 1080) {
    // H.264 + AAC in MP4 plays everywhere (Windows' own player, phones, TVs).
    return [
      '-f', `bv*[height<=${h}][vcodec^=avc1]+ba[ext=m4a]/b[height<=${h}][ext=mp4]/bv*[height<=${h}]+ba/b[height<=${h}]/b`,
      '--merge-output-format', 'mp4/mkv', '--remux-video', 'mp4',
    ];
  }
  return ['-f', `bv*[height<=${h}]+ba/b[height<=${h}]/b`, '--merge-output-format', 'mkv'];
}

function startDownload(msg) {
  const id = String(msg.job || '');
  if (!id) throw new Error('Missing job id');
  if (jobs.has(id)) return { started: false };
  const url = checkUrl(msg.url);
  const dir = join(downloadsRoot(), cleanFolder(msg.folder));
  mkdirSync(dir, { recursive: true });
  const base = uniqueBase(dir, cleanName(msg.base));
  const args = [
    ...formatArgs(msg), ...ffmpegArgs(),
    '--no-playlist', '--no-mtime',
    '--newline', '--progress', '--no-warnings', '--no-colors',
    '--progress-template', 'download:LFDP|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.filename)s',
    '--print', 'after_move:LFDFILE|%(filepath)s',
    '-P', dir, '-o', `${base}.%(ext)s`,
    '--', url,
  ];
  const proc = spawn(ytdlp(), args, { env: ENV, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const job = { id, proc, dir, base, canceled: false, stderr: '', file: '' };
  jobs.set(id, job);

  const parts = []; // filenames seen, in order
  let doneBytes = 0;
  let current = { file: '', bytes: 0, total: 0 };
  const sizeHint = Number(msg.sizeHint) || 0;
  let last = 0;
  const twoParts = !msg.audioOnly;
  const progress = (extra = {}, force = false) => {
    const now = Date.now();
    if (!force && now - last < 250) return;
    last = now;
    const bytes = doneBytes + current.bytes;
    send({ event: 'progress', job: id, bytes, total: Math.max(sizeHint, doneBytes + current.total), ...extra });
  };

  let out = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (s) => {
    out += s;
    let i;
    while ((i = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, i).replace(/\r$/, '');
      out = out.slice(i + 1);
      if (line.startsWith('LFDFILE|')) { job.file = line.slice(8).trim(); continue; }
      if (!line.startsWith('LFDP|')) continue;
      const [, status, dl, total, est, speed, ...name] = line.split('|');
      const file = name.join('|');
      const num = (v) => (v && v !== 'NA' ? Number(v) || 0 : 0);
      if (file && file !== current.file) {
        if (current.file && !parts.includes(current.file)) { parts.push(current.file); doneBytes += current.total || current.bytes; }
        current = { file, bytes: 0, total: 0 };
      }
      current.bytes = num(dl);
      current.total = num(total) || num(est) || current.total;
      const idx = parts.length;
      const phase = status === 'finished' ? 'Processing'
        : msg.audioOnly ? 'Downloading audio' : twoParts && idx >= 1 ? 'Downloading audio' : 'Downloading video';
      progress({ phase, speed: num(speed) }, status === 'finished');
    }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (s) => {
    job.stderr = (job.stderr + s).slice(-8000);
    if (/\[(Merger|ExtractAudio|VideoConvertor|FixupM3u8|FixupM4a)\]/.test(s)) {
      progress({ phase: /ExtractAudio/.test(s) ? 'Converting' : 'Merging video and audio', speed: 0 }, true);
    }
  });
  proc.on('error', (e) => {
    jobs.delete(id);
    send({ event: 'error', job: id, error: e.code === 'ENOENT' ? 'yt-dlp was not found. Install it and run the helper setup again.' : e.message });
    maybeExit();
  });
  proc.on('close', (code) => {
    jobs.delete(id);
    if (job.canceled) {
      removePartials(job);
      send({ event: 'canceled', job: id });
    } else if (code === 0 && job.file && existsSync(job.file)) {
      send({ event: 'done', job: id, path: job.file, size: statSync(job.file).size });
    } else {
      removePartials(job);
      send({ event: 'error', job: id, error: friendly(job.stderr, `yt-dlp stopped (code ${code})`) });
    }
    maybeExit();
  });
  return { started: true, dir, base };
}

function cancelJob(job) {
  if (!job || job.canceled) return;
  job.canceled = true;
  // Kill the whole tree: yt-dlp may be running ffmpeg.
  if (process.platform === 'win32' && job.proc.pid) {
    execFile('taskkill', ['/pid', String(job.proc.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    job.proc.kill('SIGTERM');
  }
}

/** Remove .part / .ytdl / .fNNN.* / .temp.* leftovers of a canceled or failed job. */
function removePartials(job) {
  setTimeout(() => {
    try {
      for (const f of readdirSync(job.dir)) {
        if (!f.startsWith(`${job.base}.`)) continue;
        const rest = f.slice(job.base.length);
        if (/\.(part|ytdl)$|\.part-Frag\d+|\.f[\w-]+\.\w+$|\.temp\.\w+$/.test(rest)) {
          try { unlinkSync(join(job.dir, f)); } catch { /* still locked */ }
        }
      }
    } catch { /* folder gone */ }
  }, 600);
}

// ───────────────────────── handlers ─────────────────────────

const handlers = {
  async hello() {
    const out = { helper: VERSION, ytdlp: '', ffmpeg: false, downloads: downloadsRoot(), platform: process.platform };
    try { out.ytdlp = (await run(ytdlp(), ['--version'], { timeout: 20_000 })).trim(); } catch { /* missing */ }
    try {
      await run(config.ffmpeg || 'ffmpeg', ['-version'], { timeout: 20_000 });
      out.ffmpeg = true;
    } catch { /* missing */ }
    return out;
  },

  async info({ url }) {
    const safe = checkUrl(url);
    let stdout;
    try {
      stdout = await run(ytdlp(), ['-J', '--no-playlist', '--no-warnings', '--', safe], { timeout: 90_000 });
    } catch (e) {
      throw new Error(e.code === 'ENOENT' ? 'yt-dlp was not found. Install it and run the helper setup again.' : friendly(e.stderr, e.message));
    }
    return summarize(JSON.parse(stdout));
  },

  async download(msg) {
    return startDownload(msg);
  },

  async cancel({ job }) {
    cancelJob(jobs.get(String(job)));
    return true;
  },

  async open({ path, reveal }) {
    const root = resolve(downloadsRoot());
    const p = resolve(String(path || ''));
    // Only files inside the Downloads folder, which is where we save them.
    if (!(p + sep).toLowerCase().startsWith(root.toLowerCase() + sep) || p.includes('"')) throw new Error('That file is outside the Downloads folder.');
    if (!existsSync(p)) throw new Error('The file was moved or deleted');
    if (!/\.(mp4|mkv|webm|mov|m4a|mp3|opus|ogg|aac|flac|wav)$/i.test(p)) throw new Error('Only downloaded videos and songs can be opened.');
    const arg = reveal ? `/select,"${p}"` : `"${p}"`;
    spawn('explorer.exe', [arg], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore' }).unref();
    return true;
  },
};
