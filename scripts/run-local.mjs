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

async function waitFor(url, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isAvailable(url)) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  return false;
}

const children = [];
let stopping = false;
let bridgeChild = null;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  setTimeout(() => process.exit(code), 150).unref();
}

function spawnChild(file, args) {
  const child = spawn(file, args, { stdio: 'inherit' });
  children.push(child);
  return child;
}

if (!(await isAvailable(bridgeUrl))) {
  bridgeChild = spawnChild(process.execPath, ['local-server.mjs']);
  bridgeChild.on('exit', (code) => {
    if (!stopping) {
      console.error('LTX Watch bridge stopped.');
      stop(code || 0);
    }
  });
}

if (!(await waitFor(bridgeUrl))) {
  console.error(`LTX Watch bridge did not start on 127.0.0.1:${apiPort}.`);
  stop(1);
} else {
  console.log(`LTX Watch local bridge: http://127.0.0.1:${apiPort}`);
}

if (!(await isAvailable(uiUrl))) {
  const siteChild = spawnChild(siteCommand[0], siteCommand[1]);
  siteChild.on('exit', (code) => {
    if (stopping) return;
    if (code) console.error(`LTX Watch UI exited (${code}). The local bridge is still running.`);
  });
} else {
  console.log(`LTX Watch UI already running at ${uiUrl}`);
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

if (!children.length) {
  console.log('LTX Watch UI and bridge are already running.');
  process.exit(0);
}

await new Promise((resolve) => {
  const done = () => resolve();
  if (bridgeChild) bridgeChild.once('exit', done);
  else children[0]?.once('exit', done);
});
