import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const clientRoot = resolve(projectRoot, 'dist', 'client');
const workerPath = resolve(projectRoot, 'dist', 'server', 'index.js');
const host = process.env.LTX_WATCH_UI_HOST || '127.0.0.1';
const port = Number(process.env.PORT || process.env.LTX_WATCH_UI_PORT || 3000);
const worker = (await import(pathToFileURL(workerPath).href)).default;

const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

function getAssetPath(requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl).pathname);
  } catch {
    return null;
  }

  const relativePath = pathname.replace(/^\/+/, '').replaceAll('/', sep);
  if (!relativePath) return null;
  const candidate = resolve(clientRoot, relativePath);
  if (candidate !== clientRoot && !candidate.startsWith(`${clientRoot}${sep}`)) return null;
  return candidate;
}

async function fetchAsset(request) {
  const assetPath = getAssetPath(request.url);
  if (!assetPath) return new Response('Not found', { status: 404 });

  try {
    const info = await stat(assetPath);
    if (!info.isFile()) return new Response('Not found', { status: 404 });
    const body = request.method === 'HEAD' ? null : await readFile(assetPath);
    return new Response(body, {
      status: 200,
      headers: {
        'Cache-Control': assetPath.includes(`${sep}_next${sep}`)
          ? 'public, max-age=31536000, immutable'
          : 'no-cache',
        'Content-Length': String(info.size),
        'Content-Type': mimeTypes.get(extname(assetPath).toLowerCase()) || 'application/octet-stream',
      },
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return new Response('Not found', { status: 404 });
    throw error;
  }
}

async function toWebRequest(req) {
  const requestUrl = `http://${req.headers.host || `${host}:${port}`}${req.url || '/'}`;
  const chunks = [];
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    for await (const chunk of req) chunks.push(chunk);
  }

  return new Request(requestUrl, {
    method: req.method,
    headers: req.headers,
    body: chunks.length ? Buffer.concat(chunks) : undefined,
  });
}

async function sendWebResponse(req, res, response) {
  res.statusCode = response.status;
  res.statusMessage = response.statusText;
  for (const [name, value] of response.headers) res.setHeader(name, value);
  if (req.method === 'HEAD' || !response.body) return res.end();

  for await (const chunk of response.body) res.write(Buffer.from(chunk));
  res.end();
}

const assets = { fetch: fetchAsset };
const executionContext = {
  passThroughOnException() {},
  waitUntil() {},
};

const server = createServer(async (req, res) => {
  try {
    const request = await toWebRequest(req);
    let response = await fetchAsset(request);
    if (response.status === 404) response = await worker.fetch(request, { ASSETS: assets }, executionContext);
    await sendWebResponse(req, res, response);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('LTX Watch could not render this page.');
  }
});

server.on('error', (error) => {
  console.error(`LTX Watch UI server failed: ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`LTX Watch UI: http://${host}:${port}`);
});

