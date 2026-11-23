// Bridge to the LFDownloader helper (native messaging → yt-dlp).
import { api } from '../shared/api.js';
import { uid } from '../shared/media.js';

export const HOST = 'com.lfdownloader.helper';

const MISSING = /not found|No such native application|host not found|forbidden|not registered|Native host has exited|Error when communicating/i;

export class HelperMissing extends Error {
  constructor(detail) {
    super('The yt-dlp helper is not set up yet.');
    this.code = 'HELPER_MISSING';
    this.detail = detail;
  }
}

/** One request → one reply (the browser starts and stops the helper for us). */
export async function nativeRequest(type, payload = {}) {
  let res;
  try {
    res = await api.runtime.sendNativeMessage(HOST, { id: uid(), type, ...payload });
  } catch (e) {
    const m = e?.message || String(e);
    throw MISSING.test(m) ? new HelperMissing(m) : e;
  }
  if (!res) throw new HelperMissing(api.runtime.lastError?.message || 'No answer');
  if (!res.ok) throw new Error(res.error || 'The helper failed');
  return res.data;
}

/** {installed, ytdlp, ffmpeg, error} — cached for a minute. */
export async function helperStatus({ fresh = false } = {}) {
  const { helperStatus: cached } = await api.storage.session.get('helperStatus');
  if (!fresh && cached && Date.now() - cached.at < 60_000) return cached;
  let status;
  try {
    const hello = await nativeRequest('hello');
    status = { installed: true, ...hello, error: hello.ytdlp ? '' : 'yt-dlp was not found' };
  } catch (e) {
    status = { installed: false, error: e.code === 'HELPER_MISSING' ? '' : e.message };
  }
  status.at = Date.now();
  status.extensionId = api.runtime.id;
  status.firefox = !!globalThis.browser?.runtime?.getBrowserInfo;
  await api.storage.session.set({ helperStatus: status });
  return status;
}

/** Turn the helper's summary into the popup's quality options. */
export function variantsFromInfo(info) {
  const out = [];
  for (const q of info.qualities || []) {
    if (q.height < 240 && (info.qualities.length > 3)) continue; // 144p is rarely wanted
    out.push({
      id: `v${q.height}`, height: q.height, fps: q.fps,
      label: `${q.height}p${q.fps > 30 ? q.fps : ''}`,
      size: q.size, container: q.container, hdr: q.hdr,
    });
  }
  if (info.single && !out.length) out.push({ id: 'best', label: 'Best', size: info.single.size, container: info.single.ext });
  if (info.audio) {
    out.push({ id: 'a-m4a', label: 'Audio', sub: 'M4A', audioOnly: true, audioFormat: 'm4a', size: info.audio.size, container: 'm4a' });
    out.push({ id: 'a-mp3', label: 'MP3', audioOnly: true, audioFormat: 'mp3', size: info.audio.size, container: 'mp3' });
  }
  return out;
}

/** The quality picked by default: 1080p (plays everywhere), else the best below it. */
export function defaultVariant(variants) {
  const video = variants.filter((v) => !v.audioOnly);
  return video.find((v) => v.height === 1080) || video.find((v) => (v.height || 0) < 1080) || video[0] || variants[0];
}
