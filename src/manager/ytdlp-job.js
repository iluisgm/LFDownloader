// A download done by yt-dlp through the LFDownloader helper (YouTube & co).
// The helper saves the file straight into the Downloads folder; this job only
// keeps the connection open and turns the helper's messages into progress.
import { api } from '../shared/api.js';

const HOST = 'com.lfdownloader.helper';

export class YtdlpJob extends EventTarget {
  constructor(record) {
    super();
    this.rec = record;
    this.paused = false;
    this.canceled = false;
    this.stats = { done: 0, total: record.size || 0, bytes: 0, speed: 0, seconds: 0, phase: 'Starting yt-dlp', unit: 'bytes', busy: true };
  }

  emit() { this.dispatchEvent(new CustomEvent('progress', { detail: this.stats })); }
  pause() {}
  resume() {}
  stop() {}

  cancel() {
    this.canceled = true;
    this.stats.phase = 'Canceling';
    this.emit();
    try { this.port?.postMessage({ id: 'cancel', type: 'cancel', job: this.rec.id }); } catch { /* gone */ }
    // If the helper doesn't answer, give up on our side anyway.
    setTimeout(() => this._fail?.(Object.assign(new Error('Canceled'), { name: 'AbortError' })), 8000);
  }

  run() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, v) => {
        if (settled) return;
        settled = true;
        try { this.port?.disconnect(); } catch { /* already closed */ }
        fn(v);
      };
      this._fail = (e) => finish(reject, e);

      try {
        this.port = api.runtime.connectNative(HOST);
      } catch (e) {
        return finish(reject, new Error(`The yt-dlp helper is not set up (${e.message}). Open Settings → YouTube & other sites.`));
      }

      this.port.onMessage.addListener((m) => {
        if (m.id && !m.ok && m.error) return finish(reject, new Error(m.error));
        if (m.job !== this.rec.id) return;
        if (m.event === 'progress') {
          const s = this.stats;
          s.bytes = s.done = m.bytes || 0;
          s.total = Math.max(m.total || 0, s.bytes);
          s.speed = m.speed || 0;
          s.phase = m.phase || 'Downloading';
          s.busy = !s.total || /Processing|Merging|Converting/.test(s.phase);
          this.emit();
        } else if (m.event === 'done') {
          this.stats.phase = 'Saved';
          finish(resolve, { path: m.path, size: m.size });
        } else if (m.event === 'canceled') {
          finish(reject, Object.assign(new Error('Canceled'), { name: 'AbortError' }));
        } else if (m.event === 'error') {
          finish(reject, new Error(m.error || 'yt-dlp failed'));
        }
      });

      this.port.onDisconnect.addListener((p) => {
        const why = p?.error?.message || api.runtime.lastError?.message || '';
        if (this.canceled) return finish(reject, Object.assign(new Error('Canceled'), { name: 'AbortError' }));
        finish(reject, new Error(/not found|No such native/i.test(why)
          ? 'The yt-dlp helper is not set up. Open Settings → YouTube & other sites.'
          : `The helper stopped unexpectedly${why ? ` (${why})` : ''}.`));
      });

      const j = this.rec.job;
      this.port.postMessage({
        id: 'start', type: 'download', job: this.rec.id, url: j.url, height: j.height, audioOnly: j.audioOnly,
        audioFormat: j.audioFormat, base: j.base, folder: j.folder, sizeHint: this.rec.size || 0,
      });
    });
  }

  async discardAll() {}
}
