#!/usr/bin/env node
// Tiny static server for the test page + fixtures, with correct MIME types,
// Range support, and a Referer-protected path to test header rules.
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const PORT = Number(process.env.PORT || 8765);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.m4s': 'video/iso.segment',
  '.bin': 'application/octet-stream', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
};

export function start(port = PORT) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    let path = decodeURIComponent(url.pathname);
    if (path === '/') path = '/index.html';

    // /protected/* mirrors /media/* but demands the page's Referer (like many CDNs).
    if (path.startsWith('/protected/')) {
      const ref = req.headers.referer || '';
      if (!ref.startsWith(`http://localhost:${port}/`)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        return res.end('Forbidden: missing referer');
      }
      path = path.replace('/protected/', '/media/');
    }

    const file = normalize(join(root, path));
    if (!file.startsWith(root)) { res.writeHead(400); return res.end(); }
    let st;
    try { st = statSync(file); } catch { res.writeHead(404); return res.end('Not found'); }
    const type = TYPES[extname(file)] || 'application/octet-stream';
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Number(range[2]) : st.size - 1;
      res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1, 'accept-ranges': 'bytes' });
      return createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  await start();
  console.log(`Test page: http://localhost:${PORT}/`);
}
