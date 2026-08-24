import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BROWSER_PLAYBACK_CACHE_LIMIT,
  browserPlaybackArguments,
  browserPlaybackKey,
  browserPlaybackPaths,
} from '../lib/browser-playback.mjs';

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('Browser playback cache identity changes with the source revision', () => {
  const source = path.join('D:\\AI\\ComfyUI', 'output', 'assembled', 'scene.mp4');
  const first = browserPlaybackKey(source, { size: 1000, mtimeMs: 2000 });
  assert.equal(first, browserPlaybackKey(source, { size: 1000, mtimeMs: 2000 }));
  assert.notEqual(first, browserPlaybackKey(source, { size: 1001, mtimeMs: 2000 }));
  assert.match(first, /^[a-f0-9]{32}$/);
  assert.equal(BROWSER_PLAYBACK_CACHE_LIMIT, 8);
});

test('Browser playback derives a continuous H.264 file without overwriting the final', () => {
  const source = path.resolve('final-scene.mp4');
  const paths = browserPlaybackPaths(path.resolve('cache'), '0123456789abcdef0123456789abcdef', 42);
  const arguments_ = browserPlaybackArguments(source, paths.temporaryPath);
  assert.notEqual(paths.targetPath, source);
  assert.notEqual(paths.temporaryPath, source);
  assert.equal(arguments_[arguments_.indexOf('-c:v') + 1], 'libx264');
  assert.equal(arguments_[arguments_.indexOf('-preset') + 1], 'veryfast');
  assert.equal(arguments_[arguments_.indexOf('-fps_mode') + 1], 'cfr');
  assert.equal(arguments_.at(-1), paths.temporaryPath);
  assert.equal(arguments_[arguments_.indexOf('-i') + 1], source);
  assert.throws(() => browserPlaybackArguments(source, source), /must not overwrite/i);
});

test('Local bridge prepares browser copies only while idle and serves range-capable cache files', async () => {
  const server = await readFile(path.join(appRoot, 'local-server.mjs'), 'utf8');
  const installer = await readFile(path.join(appRoot, 'scripts', 'build-msi.ps1'), 'utf8');
  assert.match(server, /if \(render\.active\)[\s\S]*status: 'waiting'/);
  assert.match(server, /spawn\(ffmpeg, browserPlaybackArguments/);
  assert.match(server, /windowsHide: true/);
  assert.match(server, /\/browser-media\//);
  assert.match(server, /serveMedia\(req, res,[\s\S]*PLAYBACK_CACHE_ROOT/);
  assert.match(installer, /lib\\browser-playback\.mjs/);
});
