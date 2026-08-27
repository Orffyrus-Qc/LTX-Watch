import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('development file watching excludes private generation runtimes', async () => {
  const config = await readFile(new URL('../vite.config.ts', import.meta.url), 'utf8');
  for (const runtime of ['.ltx-watch-create', '.ltx-watch-projects', '.ltx-watch-studio']) {
    assert.match(config, new RegExp(`\\*\\*/\\${runtime}/\\*\\*`));
  }
  assert.match(config, /ignored:\s*LOCAL_RUNTIME_WATCH_IGNORES/);
});
