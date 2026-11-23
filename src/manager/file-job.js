// Downloads one direct file through the extension (instead of the browser's
// download manager), so the page's Referer/Origin can be sent. Used when a
// server rejects a normal download as hotlinking (HTTP 401/403).
import { call } from '../shared/api.js';
import { Sink } from './hls-job.js';

export class FileJob extends EventTarget {
  constructor(record) {
    super();
    this.rec = record;
    this.abort = new AbortController();
    this.paused = false;
    this.sinks = [];
    this.stats = { done: 0, total: 0, bytes: 0, speed: 0, seconds: 0, phase: 'Preparing', unit: 'bytes' };
    this._win = [];
  }

  emit() { this.dispatchEvent(new CustomEvent('progress', { detail: this.stats })); }
  pause() { this.paused = true; this.stats.phase = 'Paused'; this.emit(); }
  resume() { this.paused = false; this.stats.phase = 'Downloading'; this.emit(); this._wake?.(); }
  stop() {}
  cancel() { this.abort.abort(); this._wake?.(); }

  async run() {
    const { url, referer, ext } = this.rec.job;
    const ruleIds = (await call('headers:add', { urls: [url], referer })) || [];
    const sink = await Sink.create(`lfd-${this.rec.id}.${ext}`);
    this.sinks.push(sink);
    try {
      const res = await fetch(url, { credentials: 'include', signal: this.abort.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (/^(text\/html|application\/xhtml)/i.test(res.headers.get('content-type') || '')) {
        throw new Error('The server sent a web page instead of the file. The link may have expired: reload the page, play the video, and try again.');
      }
      this.stats.total = Number(res.headers.get('content-length')) || 0;
      this.stats.phase = 'Downloading';
      const reader = res.body.getReader();
      for (;;) {
        while (this.paused && !this.abort.signal.aborted) await new Promise((r) => { this._wake = r; });
        const { done, value } = await reader.read();
        if (done) break;
        await sink.write(value);
        this.stats.bytes = this.stats.done = sink.bytes;
        this.track(value.byteLength);
        this.emit();
      }
      const type = res.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
      return [{ file: await sink.finish(type), sink, ext, suffix: '' }];
    } catch (e) {
      await sink.discard();
      throw e;
    } finally {
      call('headers:remove', { ids: ruleIds }).catch(() => {});
    }
  }

  track(bytes) {
    const now = performance.now();
    this._win.push([now, bytes]);
    while (this._win.length && now - this._win[0][0] > 4000) this._win.shift();
    const span = Math.max(1, now - this._win[0][0]) / 1000;
    this.stats.speed = this._win.length > 1 ? this._win.reduce((a, [, b]) => a + b, 0) / span : 0;
  }

  async discardAll() {
    for (const s of this.sinks) await s.discard();
  }
}
