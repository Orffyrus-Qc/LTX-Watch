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

test('Create runner reconciles an unambiguous renamed model enum', async (context) => {
  const python = process.env.LTX_STUDIO_TEST_PYTHON || (process.platform === 'win32' ? 'python.exe' : 'python3');
  const runner = path.join(appRoot, 'scripts', 'ltx-create-runner.py');
  const code = [
    'import importlib.util, json, os',
    'spec = importlib.util.spec_from_file_location("ltx_create_runner_test", os.environ["LTX_CREATE_RUNNER"])',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'choices = [["gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors", "gemma4_e2b_it_bf16.safetensors"], {}]',
    'print(json.dumps({',
    '  "renamed": module.reconcile_combo_value("gemma4_e2b_it_int8_convrot.safetensors", choices),',
    '  "existing": module.reconcile_combo_value("gemma4_e2b_it_bf16.safetensors", choices),',
    '  "ambiguous": module.reconcile_combo_value("gemma4_e2b_it.safetensors", choices),',
    '}))',
  ].join('\n');
  const run = spawnSync(python, ['-c', code], {
    cwd: appRoot,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, LTX_CREATE_RUNNER: runner },
  });
  if (run.error?.code === 'ENOENT') {
    context.skip(`Python executable not available: ${python}`);
    return;
  }
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout);
  assert.equal(result.renamed, 'gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors');
  assert.equal(result.existing, 'gemma4_e2b_it_bf16.safetensors');
  assert.equal(result.ambiguous, 'gemma4_e2b_it.safetensors');
});

test('Create retry replaces a stale result before the new runner is spawned', async () => {
  const server = await readFile(path.join(appRoot, 'local-server.mjs'), 'utf8');
  const resultReset = server.indexOf("await writeFile(resultPath, `${JSON.stringify({ status: 'generating'");
  const runnerSpawn = server.indexOf('const child = spawn(launch.executable', resultReset);
  assert.ok(resultReset > -1, 'expected an initial generating result');
  assert.ok(runnerSpawn > resultReset, 'the stale result must be replaced before spawning the retry');
});
