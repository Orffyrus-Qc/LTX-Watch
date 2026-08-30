import { spawn } from 'node:child_process';

const mode = process.argv[2] === 'start' ? 'start' : 'dev';
const sitePort = Math.min(65_535, Math.max(1_024, Number(process.env.LTX_WATCH_SITE_PORT || 3000)));
const apiPort = Math.min(65_535, Math.max(1_024, Number(process.env.LTX_WATCH_API_PORT || 4311)));
const bridgeUrl = `http://127.0.0.1:${apiPort}/api/health`;
const uiUrl = `http://127.0.0.1:${sitePort}/`;
const siteScript = `npm run site:${mode}${sitePort === 3000 ? '' : ` -- --port ${sitePort}`}`;
const siteCommand = process.platform === 'win32'
  ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', siteScript]]
  : ['npm', ['run', `site:${mode}`, ...(sitePort === 3000 ? [] : ['--', '--port', String(sitePort)])]];

async function isAvailable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitFor(url, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isAvailable(url)) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  return false;
}

function startHidden(file, args) {
  const child = spawn(file, args, {
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

if (!(await isAvailable(bridgeUrl))) startHidden(process.execPath, ['local-server.mjs']);
if (!(await waitFor(bridgeUrl))) {
  console.error(`LTX Watch bridge did not start on 127.0.0.1:${apiPort}.`);
  process.exit(1);
}

if (!(await isAvailable(uiUrl))) startHidden(siteCommand[0], siteCommand[1]);
if (!(await waitFor(uiUrl, 30_000))) {
  console.error(`LTX Watch UI did not start on http://127.0.0.1:${sitePort}. The hidden bridge is still running.`);
  process.exit(1);
}

openBrowser(`http://localhost:${sitePort}/`);
process.exit(0);
