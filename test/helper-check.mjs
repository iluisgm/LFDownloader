// Talks to the installed helper the way a browser does (launcher + framed JSON).
//   node test/helper-check.mjs [url]
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const launcher = join(here, '..', 'native', 'out', 'lfdownloader-helper.bat');

export function connect(env = process.env) {
  const proc = spawn('cmd.exe', ['/d', '/s', '/c', `"${launcher}"`], { windowsVerbatimArguments: true, stdio: ['pipe', 'pipe', 'inherit'], env });
  let buf = Buffer.alloc(0);
  const waiters = new Map();
  const listeners = [];
  proc.stdout.on('data', (c) => {
    buf = Buffer.concat([buf, c]);
    while (buf.length >= 4) {
      const n = buf.readUInt32LE(0);
      if (buf.length < 4 + n) break;
      const msg = JSON.parse(buf.subarray(4, 4 + n).toString('utf8'));
      buf = buf.subarray(4 + n);
      if (msg.id != null && waiters.has(msg.id)) { waiters.get(msg.id)(msg); waiters.delete(msg.id); } else listeners.forEach((l) => l(msg));
    }
  });
  let seq = 0;
  const post = (obj) => {
    const b = Buffer.from(JSON.stringify(obj));
    const h = Buffer.alloc(4);
    h.writeUInt32LE(b.length);
    proc.stdin.write(Buffer.concat([h, b]));
  };
  return {
    proc,
    request: (type, payload = {}) => new Promise((res) => { const id = ++seq; waiters.set(id, res); post({ id, type, ...payload }); }),
    post,
    onEvent: (fn) => listeners.push(fn),
    close: () => proc.stdin.end(),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const h = connect();
  console.log('hello →', JSON.stringify((await h.request('hello')).data));
  const url = process.argv[2] || 'https://www.youtube.com/watch?v=9UaVc0NFRog';
  const t = Date.now();
  const info = await h.request('info', { url });
  const raw = JSON.stringify(info);
  console.log(`info → ${info.ok ? 'ok' : info.error} in ${Date.now() - t} ms, ${raw.length} bytes`);
  if (info.ok) {
    const d = info.data;
    console.log(`  ${d.title} · ${d.duration}s · ${d.site}`);
    for (const q of d.qualities) console.log(`  ${q.height}p${q.fps > 30 ? q.fps : ''} ${q.container} ${(q.size / 1e6).toFixed(0)} MB${q.hdr ? ' HDR' : ''}`);
    console.log('  audio', JSON.stringify(d.audio), 'single', JSON.stringify(d.single));
  }
  const bad = await h.request('info', { url: '--exec calc' });
  console.log('flag as url →', bad.ok ? 'ACCEPTED (bad)' : `rejected: ${bad.error}`);
  h.close();
  h.proc.on('exit', (c) => console.log('helper exited', c));
}
