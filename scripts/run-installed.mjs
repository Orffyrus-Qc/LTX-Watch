import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const bridgeUrl = 'http://127.0.0.1:4311/api/health';
const uiUrl = 'http://127.0.0.1:3000/';

async function isAvailable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function startHidden(script) {
  const child = spawn(process.execPath, [resolve(projectRoot, script)], {
    cwd: projectRoot,
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  });
  child.unref();
  return child;
}

async function waitFor(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isAvailable(url)) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  return false;
}

function openBrowser(url) {
  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'start', '', url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

if (!(await isAvailable(bridgeUrl))) startHidden('local-server.mjs');
if (!(await isAvailable(uiUrl))) startHidden('scripts/serve-production.mjs');

if (!(await waitFor(bridgeUrl)) || !(await waitFor(uiUrl))) {
  console.error('LTX Watch did not become ready within 30 seconds.');
  process.exit(1);
}

openBrowser('http://localhost:3000/');
process.exit(0);
