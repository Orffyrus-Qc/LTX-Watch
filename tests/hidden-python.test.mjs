import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('Recovery launches through the recursive hidden-process adapter', async () => {
  const server = await readFile(path.join(appRoot, 'local-server.mjs'), 'utf8');
  const installer = await readFile(path.join(appRoot, 'scripts', 'build-msi.ps1'), 'utf8');
  assert.match(server, /spawn\(recoveryPlan\.executable, \[HIDDEN_PYTHON_TREE_PATH, '--script', recoveryPlan\.scriptPath\]/);
  assert.doesNotMatch(server, /spawn\(recoveryPlan\.executable, \[recoveryPlan\.scriptPath\]/);
  assert.match(installer, /scripts\\run-hidden-python\.py/);
});

test('Hidden-process adapter recursively wraps Python scripts', (context) => {
  const python = process.env.LTX_STUDIO_TEST_PYTHON || (process.platform === 'win32' ? 'python.exe' : 'python3');
  const adapter = path.join(appRoot, 'scripts', 'run-hidden-python.py');
  const code = [
    'import importlib.util, json, os, sys',
    'spec = importlib.util.spec_from_file_location("ltx_hidden_tree_test", os.environ["LTX_HIDDEN_ADAPTER"])',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'wrapped = module._wrap_python_command([sys.executable, "-u", "worker.py", "--gpu", "0"])',
    'options = module._hidden_kwargs({})',
    'print(json.dumps({"wrapped": wrapped, "flags": options.get("creationflags", 0), "hasStartup": "startupinfo" in options}))',
  ].join('\n');
  const run = spawnSync(python, ['-c', code], {
    cwd: appRoot,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, LTX_HIDDEN_ADAPTER: adapter },
  });
  if (run.error?.code === 'ENOENT') {
    context.skip(`Python executable not available: ${python}`);
    return;
  }
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const result = JSON.parse(run.stdout);
  assert.equal(result.wrapped[1], '-u');
  assert.match(result.wrapped[2], /run-hidden-python\.py$/i);
  assert.deepEqual(result.wrapped.slice(3), ['--script', 'worker.py', '--gpu', '0']);
  if (process.platform === 'win32') {
    assert.notEqual(result.flags, 0);
    assert.equal(result.hasStartup, true);
  }
});

test('Hidden-process adapter preserves imports beside the target script', async (context) => {
  const python = process.env.LTX_STUDIO_TEST_PYTHON || (process.platform === 'win32' ? 'python.exe' : 'python3');
  const root = await mkdtemp(path.join(tmpdir(), 'ltx-hidden-import-'));
  try {
    const target = path.join(root, 'target.py');
    await writeFile(path.join(root, 'sibling_module.py'), 'VALUE = "target imports ready"\n', 'utf8');
    await writeFile(target, 'import asyncio\nfrom sibling_module import VALUE\nprint(VALUE)\n', 'utf8');
    const run = spawnSync(python, [path.join(appRoot, 'scripts', 'run-hidden-python.py'), '--script', target], {
      cwd: appRoot,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (run.error?.code === 'ENOENT') {
      context.skip(`Python executable not available: ${python}`);
      return;
    }
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.equal(run.stdout.trim(), 'target imports ready');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
