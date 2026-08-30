import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mode = process.argv[2] === 'start' ? 'start' : 'dev';
const sitePort = Math.min(65_535, Math.max(1_024, Number(process.env.LTX_WATCH_SITE_PORT || 3000)));
const apiPort = Math.min(65_535, Math.max(1_024, Number(process.env.LTX_WATCH_API_PORT || 4311)));
const vinextCli = path.join(projectRoot, 'node_modules', 'vinext', 'dist', 'cli.js');
const serveProduction = path.join(projectRoot, 'scripts', 'serve-production.mjs');

function candidateUrls(port, pathName = '/') {
  return [
    `http://127.0.0.1:${port}${pathName}`,
    `http://localhost:${port}${pathName}`,
    `http://[::1]:${port}${pathName}`,
  ];
}

async function isAvailable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function anyAvailable(urls) {
  for (const url of urls) {
    if (await isAvailable(url)) return url;
  }
  return null;
}

async function waitFor(urls, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await anyAvailable(urls);
    if (ready) return ready;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  return null;
}

function startHidden(file, args) {
  const child = spawn(file, args, {
    cwd: projectRoot,
    env: process.env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child;
}

function openBrowser(url) {
  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'start', '', url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

const bridgeUrls = candidateUrls(apiPort, '/api/health');
if (!(await anyAvailable(bridgeUrls))) {
  startHidden(process.execPath, [path.join(projectRoot, 'local-server.mjs')]);
}
if (!(await waitFor(bridgeUrls))) {
  console.error(`LTX Watch bridge did not start on port ${apiPort}.`);
  process.exit(1);
}

const uiUrls = candidateUrls(sitePort);
if (!(await anyAvailable(uiUrls))) {
  if (mode === 'start') startHidden(process.execPath, [serveProduction]);
  else startHidden(process.execPath, [vinextCli, 'dev', '--port', String(sitePort)]);
}
if (!(await waitFor(uiUrls, 45_000))) {
  console.error(`LTX Watch UI did not start on port ${sitePort}. The hidden bridge is still running.`);
  process.exit(1);
}

openBrowser(`http://localhost:${sitePort}/`);
process.exit(0);
