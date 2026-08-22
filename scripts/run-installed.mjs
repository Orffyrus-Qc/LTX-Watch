import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const children = [];

async function isAvailable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
}

function startNode(script) {
  const child = spawn(process.execPath, [resolve(projectRoot, script)], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  children.push(child);
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

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  setTimeout(() => process.exit(code), 150).unref();
}

const bridgeUrl = 'http://127.0.0.1:4311/api/health';
const uiUrl = 'http://127.0.0.1:3000/';

if (!(await isAvailable(bridgeUrl))) startNode('local-server.mjs');
if (!(await isAvailable(uiUrl))) startNode('scripts/serve-production.mjs');

if (!(await waitFor(bridgeUrl)) || !(await waitFor(uiUrl))) {
  console.error('LTX Watch did not become ready within 30 seconds.');
  stop(1);
} else {
  openBrowser('http://localhost:3000/');
  console.log('LTX Watch is running. Close this window to stop services started by this launcher.');
}

for (const child of children) {
  child.on('exit', (code) => {
    if (!stopping && code && code !== 0) stop(code);
  });
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

if (!children.length) process.exit(0);

