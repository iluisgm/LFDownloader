// Saves a set of pictures in one go, so the browser never asks once per file:
//   mode "zip"    → one .zip file (one save dialog at most)
//   mode "folder" → written straight into a folder the user picked once
// Pictures are fetched by the extension with the page's Referer.
import { call } from '../shared/api.js';
import { Sink } from './hls-job.js';
import { ZipWriter } from './zip.js';

const PARALLEL = 4;
const isPage = (t) => /^(text\/html|application\/xhtml)/i.test(t || '');

export class ImageJob extends EventTarget {
  constructor(record, { dir = null } = {}) {
    super();
    this.rec = record;
    this.dir = dir; // FileSystemDirectoryHandle (folder mode)
    this.abort = new AbortController();
    this.paused = false;
    this.sinks = [];
    this.stats = { done: 0, total: record.images.length, failed: 0, bytes: 0, speed: 0, phase: 'Preparing', unit: 'images' };
    this._win = [];
  }

  emit() { this.dispatchEvent(new CustomEvent('progress', { detail: this.stats })); }
  pause() { this.paused = true; this.stats.phase = 'Paused'; this.emit(); }
  resume() { this.paused = false; this.stats.phase = 'Fetching pictures'; this.emit(); this._wake?.(); }
  stop() {}
  cancel() { this.abort.abort(); this._wake?.(); }

  async fetchImage(url) {
    let last;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.abort.signal.aborted) throw new DOMException('Canceled', 'AbortError');
      try {
        const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(60_000)]);
        const res = await fetch(url, { credentials: 'include', signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        if (isPage(res.headers.get('content-type'))) throw new Error('The server sent a web page instead of the picture');
        return new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        if (this.abort.signal.aborted) throw e;
        last = e;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
    throw last;
  }

  track(bytes) {
    const now = performance.now();
    this._win.push([now, bytes]);
    while (this._win.length && now - this._win[0][0] > 4000) this._win.shift();
    const span = Math.max(1, now - this._win[0][0]) / 1000;
    this.stats.speed = this._win.length > 1 ? this._win.reduce((a, [, b]) => a + b, 0) / span : 0;
  }

  async run() {
    const { images, mode, pageUrl, folderName } = this.rec;
    const ruleIds = (await call('headers:add', { urls: images.map((i) => i.url).slice(0, 40), referer: pageUrl })) || [];
    let zip;
    let sink;
    let target;
    try {
      if (mode === 'zip') {
        sink = await Sink.create(`lfd-${this.rec.id}.zip`);
        this.sinks.push(sink);
        zip = new ZipWriter(sink);
      } else {
        target = await this.dir.getDirectoryHandle(folderName, { create: true });
      }
      this.stats.phase = 'Fetching pictures';
      let next = 0;
      let writing = Promise.resolve();
      const used = new Set();
      const save = async (name, bytes) => {
        if (zip) return zip.add(name, bytes);
        let out = name;
        const dot = name.lastIndexOf('.');
        for (let n = 2; used.has(out.toLowerCase()); n++) out = `${name.slice(0, dot)} (${n})${name.slice(dot)}`;
        used.add(out.toLowerCase());
        const fh = await target.getFileHandle(out, { create: true });
        const w = await fh.createWritable();
        await w.write(bytes);
        await w.close();
      };
      const worker = async () => {
        while (next < images.length && !this.abort.signal.aborted) {
          while (this.paused && !this.abort.signal.aborted) await new Promise((r) => { this._wake = r; });
          const img = images[next++];
          try {
            const bytes = await this.fetchImage(img.url);
            this.track(bytes.byteLength);
            writing = writing.then(() => save(img.name, bytes));
            await writing;
            this.stats.done++;
            this.stats.bytes += bytes.byteLength;
          } catch (e) {
            if (this.abort.signal.aborted) return;
            this.stats.failed++;
            this.lastError = e;
          }
          this.emit();
        }
      };
      await Promise.all(Array.from({ length: PARALLEL }, worker));
      await writing;
      if (this.abort.signal.aborted) throw new DOMException('Canceled', 'AbortError');
      if (!this.stats.done) throw this.lastError || new Error('No picture could be downloaded');
      if (zip) {
        this.stats.phase = 'Creating ZIP';
        this.emit();
        await zip.finish();
        return [{ file: await sink.finish('application/zip'), sink, ext: 'zip', suffix: '' }];
      }
      return [];
    } catch (e) {
      await sink?.discard();
      throw e;
    } finally {
      call('headers:remove', { ids: ruleIds }).catch(() => {});
    }
  }

  async discardAll() {
    for (const s of this.sinks) await s.discard();
  }
}
