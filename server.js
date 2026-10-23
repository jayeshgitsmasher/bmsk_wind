// Zero-dependency static server (ES modules need http://, not file://) plus a
// caching proxy for Open-Meteo, so reloads and repeat views don't spend the
// free API quota. Cached responses live in .cache/ for an hour.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 5173;
const CACHE_DIR = path.join(ROOT, '.cache');
const CACHE_TTL = 60 * 60 * 1000;
const UPSTREAM = {
  '/api/forecast': 'https://api.open-meteo.com/v1/forecast',
  '/api/air': 'https://air-quality-api.open-meteo.com/v1/air-quality',
};
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.geojson': 'application/geo+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

fs.mkdirSync(CACHE_DIR, { recursive: true });
const inflight = new Map();

async function proxy(res, url) {
  const file = path.join(CACHE_DIR, `${crypto.createHash('sha1').update(url).digest('hex')}.json`);
  try {
    const st = await fs.promises.stat(file);
    if (Date.now() - st.mtimeMs < CACHE_TTL) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Cache': 'hit' });
      res.end(await fs.promises.readFile(file));
      return;
    }
  } catch {
    // not cached yet
  }
  let pending = inflight.get(url);
  if (!pending) {
    pending = fetch(url)
      .then(async (r) => ({ status: r.status, body: Buffer.from(await r.arrayBuffer()) }))
      .finally(() => inflight.delete(url));
    inflight.set(url, pending);
  }
  try {
    const { status, body } = await pending;
    if (status === 200) await fs.promises.writeFile(file, body).catch(() => {});
    res.writeHead(status, { 'Content-Type': 'application/json', 'X-Cache': 'miss' });
    res.end(body);
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ reason: `Upstream error: ${err.message}` }));
  }
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (UPSTREAM[url.pathname]) {
      proxy(res, UPSTREAM[url.pathname] + url.search);
      return;
    }
    const urlPath = decodeURIComponent(url.pathname);
    const file = path.normalize(path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath));
    if (!file.startsWith(ROOT) || file.startsWith(CACHE_DIR)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      // Tell the page the caching proxy is available.
      if (file.endsWith('index.html')) data = data.toString().replace('name="zephyr-proxy" content="off"', 'name="zephyr-proxy" content="on"');
      res.end(data);
    });
  })
  .listen(PORT, () => console.log(`Zephyr running at http://localhost:${PORT}/`));
