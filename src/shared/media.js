// Media classification and formatting helpers shared by every context.

export const VIDEO_EXT = ['mp4', 'm4v', 'webm', 'mkv', 'mov', 'avi', 'flv', 'wmv', '3gp', 'ogv', 'mpeg', 'mpg'];
export const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'aif', 'alac', 'weba'];
export const STREAM_EXT = ['m3u8', 'mpd'];
// Pieces of a stream. They are never useful on their own, so they are ignored.
export const SEGMENT_EXT = ['ts', 'm4s', 'm4f', 'cmfv', 'cmfa', 'fmp4', 'm4v-seg', 'key', 'vtt', 'webvtt', 'srt', 'jpg', 'png', 'gif'];

const MIME_MAP = {
  'application/vnd.apple.mpegurl': { kind: 'stream', format: 'hls' },
  'application/x-mpegurl': { kind: 'stream', format: 'hls' },
  'audio/mpegurl': { kind: 'stream', format: 'hls' },
  'audio/x-mpegurl': { kind: 'stream', format: 'hls' },
  'application/dash+xml': { kind: 'stream', format: 'dash' },
  'video/vnd.mpeg.dash.mpd': { kind: 'stream', format: 'dash' },
  'video/mp4': { kind: 'video', format: 'mp4' },
  'video/x-m4v': { kind: 'video', format: 'm4v' },
  'video/webm': { kind: 'video', format: 'webm' },
  'video/x-matroska': { kind: 'video', format: 'mkv' },
  'video/quicktime': { kind: 'video', format: 'mov' },
  'video/x-msvideo': { kind: 'video', format: 'avi' },
  'video/x-flv': { kind: 'video', format: 'flv' },
  'video/ogg': { kind: 'video', format: 'ogv' },
  'video/3gpp': { kind: 'video', format: '3gp' },
  'video/mpeg': { kind: 'video', format: 'mpeg' },
  'audio/mpeg': { kind: 'audio', format: 'mp3' },
  'audio/mp3': { kind: 'audio', format: 'mp3' },
  'audio/mp4': { kind: 'audio', format: 'm4a' },
  'audio/x-m4a': { kind: 'audio', format: 'm4a' },
  'audio/aac': { kind: 'audio', format: 'aac' },
  'audio/aacp': { kind: 'audio', format: 'aac' },
  'audio/wav': { kind: 'audio', format: 'wav' },
  'audio/x-wav': { kind: 'audio', format: 'wav' },
  'audio/wave': { kind: 'audio', format: 'wav' },
  'audio/vnd.wave': { kind: 'audio', format: 'wav' },
  'audio/flac': { kind: 'audio', format: 'flac' },
  'audio/x-flac': { kind: 'audio', format: 'flac' },
  'audio/ogg': { kind: 'audio', format: 'ogg' },
  'audio/opus': { kind: 'audio', format: 'opus' },
  'audio/webm': { kind: 'audio', format: 'weba' },
  'audio/x-ms-wma': { kind: 'audio', format: 'wma' },
  'audio/aiff': { kind: 'audio', format: 'aiff' },
  'audio/x-aiff': { kind: 'audio', format: 'aiff' },
};

const SEGMENT_MIME = ['video/mp2t', 'video/iso.segment', 'audio/iso.segment', 'text/vtt'];

// Query parameters that only describe which byte range a player asked for.
// Stripping them lets many range requests collapse into one media item.
const RANGE_PARAMS = ['range', 'bytestart', 'byteend', 'bytes', 'start', 'end', 'rn', 'rbuf', 'ump', 'srfvp', 'cpn', 'rqh', '_'];

export function extOf(url) {
  try {
    const path = new URL(url).pathname;
    const m = /\.([a-z0-9]{2,5})$/i.exec(path);
    return m ? m[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

/**
 * Decide what a response is from its URL and Content-Type.
 * Returns `{ kind: 'video'|'audio'|'stream', format }`, `{ segment: true }`, or null.
 */
export function classify(url, mime = '') {
  const type = mime.split(';')[0].trim().toLowerCase();
  const ext = extOf(url);

  if (SEGMENT_MIME.includes(type) || SEGMENT_EXT.includes(ext)) return { segment: true };
  if (MIME_MAP[type]) {
    const hit = MIME_MAP[type];
    // `video/mp4` served for an `.m4a` file is still audio.
    if (hit.kind === 'video' && AUDIO_EXT.includes(ext)) return { kind: 'audio', format: ext };
    return { ...hit };
  }
  if (ext === 'm3u8') return { kind: 'stream', format: 'hls' };
  if (ext === 'mpd') return { kind: 'stream', format: 'dash' };
  // Generic binary types: trust the extension.
  const generic = !type || type === 'application/octet-stream' || type === 'binary/octet-stream'
    || type.startsWith('video/') || type.startsWith('audio/');
  if (generic && VIDEO_EXT.includes(ext)) return { kind: 'video', format: ext };
  if (generic && AUDIO_EXT.includes(ext)) return { kind: 'audio', format: ext };
  if (type.startsWith('video/')) return { kind: 'video', format: type.slice(6).replace(/^x-/, '') || 'video' };
  if (type.startsWith('audio/')) return { kind: 'audio', format: type.slice(6).replace(/^x-/, '') || 'audio' };
  return null;
}

/** URL used to de-duplicate repeated (range) requests for the same file. */
export function dedupeKey(url) {
  try {
    const u = new URL(url);
    for (const p of RANGE_PARAMS) u.searchParams.delete(p);
    u.hash = '';
    return u.href;
  } catch {
    return url;
  }
}

export function formatBytes(n) {
  if (n == null || !Number.isFinite(n) || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

export function formatDuration(sec) {
  if (!sec || !Number.isFinite(sec)) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`;
}

export function formatBitrate(bps) {
  if (!bps) return '';
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(bps >= 1e7 ? 0 : 1)} Mbps`;
  return `${Math.round(bps / 1e3)} kbps`;
}

export function formatSpeed(bytesPerSec) {
  const s = formatBytes(bytesPerSec);
  return s ? `${s}/s` : '';
}

export function qualityLabel(height, width) {
  if (!height) return '';
  // Portrait videos report e.g. 1080x1920; quality is the shorter side.
  const short = width ? Math.min(width, height) : height;
  if (short >= 2100) return '4K';
  if (short >= 1400) return '1440p';
  return `${short}p`;
}

/** Make a string safe to use as a file name on Windows, macOS and Linux. */
export function sanitizeFilename(name, max = 140) {
  let s = String(name || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = `_${s}`;
  if (s.length > max) s = s.slice(0, max).trim();
  return s || 'media';
}

export function sanitizeFolder(path) {
  return String(path || '')
    .split(/[\\/]+/)
    .map((p) => sanitizeFilename(p, 60))
    .filter((p) => p && p !== 'media')
    .join('/');
}

/** Best human name for a media URL when the page title is not useful. */
export function nameFromUrl(url) {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
    return last.replace(/\.[a-z0-9]{2,5}$/i, '');
  } catch {
    return '';
  }
}

/** Strip noisy suffixes like " - YouTube" or " | Site name" from a tab title. */
export function cleanTitle(title) {
  return String(title || '')
    .replace(/^\(\d+\+?\)\s*/, '')
    .replace(/\s+[-|•·–—]\s+[^-|•·–—]{2,40}$/, '')
    .trim();
}

export function buildFilename({ template, title, quality, url, ext, folder }) {
  const base = cleanTitle(title) || nameFromUrl(url) || 'media';
  let name = (template || '{title}')
    .replaceAll('{title}', base)
    .replaceAll('{quality}', quality || '')
    .replaceAll('{host}', hostOf(url))
    .replaceAll('{date}', new Date().toISOString().slice(0, 10));
  // Remove separators left dangling by an empty {quality}.
  name = name.replace(/\s*[-_·]\s*$/, '').replace(/\(\s*\)|\[\s*\]/g, '');
  const file = `${sanitizeFilename(name)}.${ext || 'bin'}`;
  const dir = sanitizeFolder(folder);
  return dir ? `${dir}/${file}` : file;
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
