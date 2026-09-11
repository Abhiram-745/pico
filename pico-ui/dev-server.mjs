/* Minimal static server for local development.
   ES modules require http(s); opening index.html over file:// will not work. */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 4173;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'text/plain; charset=utf-8',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2',
};

createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let rel = normalize(url).replace(/^([/\\])+/, '');
    if (rel === '' ) rel = 'index.html';

    const path = join(ROOT, rel);
    if (!path.startsWith(ROOT)) { res.writeHead(403).end('Forbidden'); return; }

    const info = await stat(path).catch(() => null);
    if (!info || info.isDirectory()) { res.writeHead(404).end('Not found'); return; }

    const body = await readFile(path);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(path).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(500).end(String(err));
  }
}).listen(PORT, () => console.log(`pico-ui dev server on http://localhost:${PORT}`));
