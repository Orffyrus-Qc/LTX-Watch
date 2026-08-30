import assert from 'node:assert/strict';
import test from 'node:test';
import { isWatchServiceCommand } from '../lib/service-runtime.mjs';

test('Watch service commands are the launcher, bridge, and UI only', () => {
  assert.equal(isWatchServiceCommand('node local-server.mjs'), true);
  assert.equal(isWatchServiceCommand('node scripts\\run-studio.mjs'), true);
  assert.equal(isWatchServiceCommand('node node_modules\\vinext\\dist\\cli.js dev --port 3001'), true);
  assert.equal(isWatchServiceCommand('cmd.exe /c npm run site:dev -- --port 3001'), true);
});

test('album, ComfyUI, Python, and Grok processes are never treated as the Watch service', () => {
  assert.equal(isWatchServiceCommand('D:\\AI\\ComfyUI\\venv\\Scripts\\python.exe D:\\AI\\ComfyUI\\run_full_album_auto.py --port 8188'), false);
  assert.equal(isWatchServiceCommand('python.exe main.py --listen 127.0.0.1'), false);
  assert.equal(isWatchServiceCommand('C:\\Users\\Orffyrus\\.grok\\bin\\grok.exe'), false);
  assert.equal(isWatchServiceCommand(''), false);
  assert.equal(isWatchServiceCommand(null), false);
});
