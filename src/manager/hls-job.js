// Downloads an HLS stream segment by segment and stitches it into one file.
// - Parallel fetches with ordered writes, retries and back-off
// - AES-128 decryption (WebCrypto); DRM (SAMPLE-AES / Widevine...) is refused
// - fMP4 init segments (EXT-X-MAP), byte ranges, live recording
// - Writes to the Origin Private File System so big files don't sit in RAM
import { call } from '../shared/api.js';
import { parseM3U8, isDrmKey } from '../shared/hls.js';
import { extOf } from '../shared/media.js';

const MAX_RETRIES = 5;

class Sink {
  static async create(name) {
    try {
      const dir = await navigator.storage.getDirectory();
      const handle = await dir.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      return new Sink({ dir, name, handle, writable });
    } catch {
      return new Sink({ name }); // in-memory fallback
    }
  }

  constructor({ dir, name, handle, writable }) {
    Object.assign(this, { dir, name, handle, writable, parts: [], bytes: 0 });
  }

  async write(buf) {
    this.bytes += buf.byteLength;
    if (this.writable) await this.writable.write(buf);
    else this.parts.push(new Blob([buf]));
  }

  async finish(mime) {
    if (this.writable) {
      await this.writable.close();
      this.writable = null;
      // OPFS files carry no (or a guessed) MIME type; Chrome then renames
      // `.ts` to `.txt`. Re-wrap with the real type (no data is copied).
      const file = await this.handle.getFile();
      return new Blob([file], { type: mime });
    }
    return new Blob(this.parts, { type: mime });
  }

  async discard() {
    try { await this.writable?.abort(); } catch { /* ignore */ }
    this.writable = null;
    this.parts = [];
    await this.dir?.removeEntry(this.name).catch(() => {});
  }
}

export class HlsJob extends EventTarget {
  constructor(record, { concurrency = 6 } = {}) {
    super();
    this.rec = record;
    this.concurrency = Math.max(1, Math.min(16, concurrency));
    this.abort = new AbortController();
    this.paused = false;
    this.stopRequested = false;
    this.ruleIds = [];
    this.keys = new Map();
    this.sinks = [];
    this.stats = { done: 0, total: 0, bytes: 0, speed: 0, seconds: 0, phase: 'Preparing' };
    this._speedWindow = [];
  }

  emit() {
    this.dispatchEvent(new CustomEvent('progress', { detail: this.stats }));
  }

  pause() { this.paused = true; this.stats.phase = 'Paused'; this.emit(); }
  resume() { this.paused = false; this.stats.phase = 'Downloading'; this.emit(); this._wake?.(); }
  stop() { this.stopRequested = true; this._wake?.(); } // live: stop recording & save
  cancel() { this.abort.abort(); this._wake?.(); }

  async run() {
    const { job } = this.rec;
    try {
      this.ruleIds.push(...(await call('headers:add', { urls: [job.playlistUrl, job.audioUrl].filter(Boolean), referer: job.referer }) || []));

      const results = [];
      const mainExt = job.ext;
      results.push(await this.downloadPlaylist(job.playlistUrl, mainExt, ''));
      if (job.audioUrl && !this.abort.signal.aborted) {
        this.stats.phase = 'Audio track';
        const audioExt = await this.guessAudioExt(job.audioUrl);
        results.push(await this.downloadPlaylist(job.audioUrl, audioExt, ' (audio)'));
      }
      return results;
    } finally {
      call('headers:remove', { ids: this.ruleIds }).catch(() => {});
    }
  }

  async fetchBuf(url, { range, text = false } = {}) {
    let lastErr;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      if (this.abort.signal.aborted) throw new DOMException('Canceled', 'AbortError');
      try {
        const headers = range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : undefined;
        const res = await fetch(url, { credentials: 'include', headers, signal: this.abort.signal, cache: 'no-store' });
        if (!res.ok) {
          const err = new Error(`HTTP ${res.status}`);
          // 4xx (except throttling) won't fix themselves.
          if (res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408) attempt = MAX_RETRIES;
          throw err;
        }
        return text ? await res.text() : await res.arrayBuffer();
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        lastErr = e;
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      }
    }
    throw lastErr || new Error('Network error');
  }

  async loadPlaylist(url) {
    let pl = parseM3U8(await this.fetchBuf(url, { text: true }), url);
    if (pl.type === 'master') {
      // A master was given: take its best variant.
      const best = pl.variants[0];
      if (!best) throw new Error('Empty master playlist');
      pl = parseM3U8(await this.fetchBuf(best.uri, { text: true }), best.uri);
    }
    if (pl.drm) throw new Error('This stream is DRM-protected and cannot be saved.');
    return pl;
  }

  async guessAudioExt(url) {
    try {
      const pl = await this.loadPlaylist(url);
      if (pl.fmp4) return 'm4a';
      const e = extOf(pl.segments[0]?.uri || '');
      return e === 'aac' ? 'aac' : e === 'mp3' ? 'mp3' : 'ts';
    } catch {
      return 'ts';
    }
  }

  async keyFor(seg) {
    const k = seg.key;
    if (!k || k.method === 'NONE') return null;
    if (isDrmKey(k)) throw new Error('This stream is DRM-protected and cannot be saved.');
    if (k.method !== 'AES-128') throw new Error(`Unsupported encryption: ${k.method}`);
    if (!this.keys.has(k.uri)) {
      this.keys.set(k.uri, this.fetchBuf(k.uri).then((raw) => crypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt'])));
    }
    return this.keys.get(k.uri);
  }

  ivFor(seg) {
    const iv = new Uint8Array(16);
    if (seg.key.iv) {
      const hex = seg.key.iv.replace(/^0x/i, '').padStart(32, '0');
      for (let i = 0; i < 16; i++) iv[i] = parseInt(hex.substr(i * 2, 2), 16);
    } else {
      // Default IV = media sequence number, big-endian.
      let n = seg.seq;
      for (let i = 15; i >= 12 && n > 0; i--) { iv[i] = n & 0xff; n = Math.floor(n / 256); }
    }
    return iv;
  }

  async fetchSegment(seg) {
    let data = await this.fetchBuf(seg.uri, { range: seg.byterange });
    const key = await this.keyFor(seg);
    if (key) data = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: this.ivFor(seg) }, key, data);
    this.trackSpeed(data.byteLength);
    return data;
  }

  trackSpeed(bytes) {
    const now = performance.now();
    this._speedWindow.push([now, bytes]);
    while (this._speedWindow.length && now - this._speedWindow[0][0] > 4000) this._speedWindow.shift();
    const span = Math.max(1, now - this._speedWindow[0][0]) / 1000;
    const sum = this._speedWindow.reduce((a, [, b]) => a + b, 0);
    this.stats.speed = this._speedWindow.length > 1 ? sum / span : 0;
  }

  async waitIfPaused() {
    while (this.paused && !this.abort.signal.aborted) {
      await new Promise((r) => { this._wake = r; });
    }
  }

  async downloadPlaylist(url, ext, suffix) {
    const pl = await this.loadPlaylist(url);
    const hosts = [...new Set(pl.segments.map((s) => s.uri).concat(pl.segments.map((s) => s.map?.uri || '')).filter(Boolean))];
    this.ruleIds.push(...(await call('headers:add', { urls: hosts.slice(0, 20), referer: this.rec.job.referer }) || []));

    const sink = await Sink.create(`lfd-${this.rec.id}${suffix ? '-a' : ''}.${ext}`);
    this.sinks.push(sink);
    try {
      if (pl.live) await this.record(pl, url, sink);
      else await this.downloadSegments(pl.segments, sink);
      if (this.abort.signal.aborted) throw new DOMException('Canceled', 'AbortError');
      const mime = ext === 'mp4' ? 'video/mp4' : ext === 'm4a' ? 'audio/mp4' : ext === 'aac' ? 'audio/aac' : 'video/mp2t';
      const file = await sink.finish(mime);
      return { file, sink, ext, suffix };
    } catch (e) {
      await sink.discard();
      throw this.failure || e;
    }
  }

  async downloadSegments(segments, sink, { live = false } = {}) {
    const total = segments.length;
    if (!live) {
      this.stats.total = total;
      this.stats.done = 0;
      this.stats.seconds = segments.reduce((a, s) => a + s.duration, 0);
    }
    this.stats.phase = 'Downloading';
    const results = new Map();
    let next = 0;
    let writeIdx = 0;
    let lastMap = this._lastMap || null;
    const ahead = this.concurrency * 2;

    const flush = async () => {
      while (results.has(writeIdx)) {
        const seg = segments[writeIdx];
        if (seg.map && seg.map.uri + JSON.stringify(seg.map.byterange) !== lastMap) {
          lastMap = seg.map.uri + JSON.stringify(seg.map.byterange);
          await sink.write(await this.fetchBuf(seg.map.uri, { range: seg.map.byterange }));
        }
        const buf = results.get(writeIdx);
        results.delete(writeIdx);
        await sink.write(buf);
        writeIdx++;
        this.stats.done++;
        this.stats.bytes = this.sinks.reduce((a, s) => a + s.bytes, 0);
        this.emit();
      }
    };

    let writing = Promise.resolve();
    const worker = async () => {
      try {
        while (next < total) {
          await this.waitIfPaused();
          if (this.abort.signal.aborted) return;
          // Don't run too far ahead of the writer (keeps memory bounded).
          while (next - writeIdx > ahead && !this.abort.signal.aborted) await new Promise((r) => setTimeout(r, 40));
          if (this.abort.signal.aborted) return;
          const i = next++;
          const buf = await this.fetchSegment(segments[i]);
          results.set(i, buf);
          writing = writing.then(flush);
          await writing;
        }
      } catch (e) {
        // One segment failed for good: stop the other workers too.
        if (!this.failure && e.name !== 'AbortError') this.failure = e;
        this.abort.abort();
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, total || 1) }, worker));
    await writing.catch((e) => { this.failure ||= e; });
    if (this.failure) throw this.failure;
    this._lastMap = lastMap;
  }

  /** Live stream: keep polling the playlist until stopped or the stream ends. */
  async record(pl, url, sink) {
    this.stats.live = true;
    let lastSeq = -1;
    for (;;) {
      const fresh = pl.segments.filter((s) => s.seq > lastSeq);
      if (fresh.length) {
        lastSeq = fresh[fresh.length - 1].seq;
        this.stats.total += fresh.length;
        this.stats.seconds += fresh.reduce((a, s) => a + s.duration, 0);
        await this.downloadSegments(fresh, sink, { live: true });
      }
      if (this.stopRequested || this.abort.signal.aborted || !pl.live) break;
      this.stats.phase = 'Recording';
      this.emit();
      const wait = Math.max(1, (pl.targetDuration || 4) / 2) * 1000;
      await new Promise((r) => { this._wake = r; setTimeout(r, wait); });
      if (this.stopRequested || this.abort.signal.aborted) break;
      try {
        pl = parseM3U8(await this.fetchBuf(url, { text: true }), url);
      } catch { /* transient: try again next tick */ }
    }
  }

  async discardAll() {
    for (const s of this.sinks) await s.discard();
  }
}
