import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('Create adapter validates a private job without launching ComfyUI or Blender', async (context) => {
  const python = process.env.LTX_STUDIO_TEST_PYTHON || (process.platform === 'win32' ? 'python.exe' : 'python3');
  const root = await mkdtemp(path.join(tmpdir(), 'ltx-watch-create-'));
  try {
    const jobPath = path.join(root, 'job.json');
    await writeFile(jobPath, JSON.stringify({
      id: 'create-fixture',
      sourceRunner: path.join(root, 'source.py'),
      comfyRoot: root,
      runtimeRoot: root,
      resultPath: path.join(root, 'result.json'),
      prompt: 'A private test prompt that must remain in this JSON file.',
      referenceMode: 'text',
      outputPrefix: 'video/ltx-watch-create/create-fixture',
    }), 'utf8');
    const arguments_ = [path.join(appRoot, 'scripts', 'ltx-create-runner.py'), '--validate-job', jobPath];
    const run = spawnSync(python, arguments_, {
      cwd: root, encoding: 'utf8', windowsHide: true,
    });
    if (run.error?.code === 'ENOENT') {
      context.skip(`Python executable not available: ${python}`);
      return;
    }
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.deepEqual(JSON.parse(run.stdout), { ok: true, mode: 'text', variations: 1 });
    assert.doesNotMatch([python, ...arguments_].join(' '), /private test prompt/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Create runner copies Blender backbones before invoking background rendering', async () => {
  const script = await readFile(path.join(appRoot, 'scripts', 'ltx-create-runner.py'), 'utf8');
  assert.match(script, /shutil\.copy2\(backbone, working_copy\)/);
  assert.match(script, /"--background", "--disable-autoexec", str\(working_copy\)/);
  assert.doesNotMatch(script, /--python-expr/);
  assert.match(script, /"-sseof", "-0\.15"/);
  assert.match(script, /"-stream_loop", "-1"/);
});
