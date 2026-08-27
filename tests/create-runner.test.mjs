import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  assert.match(script, /def hide_subprocess_windows\(\):/);
  assert.match(script, /subprocess\.CREATE_NO_WINDOW/);
  assert.match(script, /subprocess\.STARTF_USESHOWWINDOW/);
  assert.match(script, /subprocess\.SW_HIDE/);
  assert.match(script, /shutil\.copy2\(backbone, working_copy\)/);
  assert.match(script, /"--background", "--disable-autoexec", str\(working_copy\)/);
  assert.doesNotMatch(script, /--python-expr/);
  assert.match(script, /"-sseof", "-0\.15"/);
  assert.match(script, /"-stream_loop", "-1"/);
});

test('Create runner applies Windows no-window flags to descendant processes', (context) => {
  if (process.platform !== 'win32') {
    context.skip('Windows process flags are only available on Windows.');
    return;
  }
  const python = process.env.LTX_STUDIO_TEST_PYTHON || 'python.exe';
  const runner = path.join(appRoot, 'scripts', 'ltx-create-runner.py');
  const code = [
    'import importlib.util, json, os, subprocess',
    'spec = importlib.util.spec_from_file_location("ltx_create_hidden_test", os.environ["LTX_CREATE_RUNNER"])',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'captured = {}',
    'def fake_popen(*args, **kwargs):',
    '  captured.update(kwargs)',
    'module.subprocess.Popen = fake_popen',
    'module.hide_subprocess_windows()',
    'module.subprocess.Popen(["cmd.exe", "/d", "/c", "exit", "0"])',
    'startup = captured["startupinfo"]',
    'print(json.dumps({',
    '  "noWindow": bool(captured["creationflags"] & subprocess.CREATE_NO_WINDOW),',
    '  "hideStartup": bool(startup.dwFlags & subprocess.STARTF_USESHOWWINDOW),',
    '  "showValue": startup.wShowWindow,',
    '  "expectedShowValue": subprocess.SW_HIDE,',
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
  const flags = JSON.parse(run.stdout);
  assert.equal(flags.noWindow, true);
  assert.equal(flags.hideStartup, true);
  assert.equal(flags.showValue, flags.expectedShowValue);
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
    'workflow = {',
    '  "nodes": [{"id": 10, "type": "ltx-subgraph", "inputs": [{"name": "clip_name", "link": None}], "widgets_values": ["gemma4_e2b_it_int8_convrot.safetensors"]}],',
    '  "links": [],',
    '  "definitions": {"subgraphs": [{',
    '    "id": "ltx-subgraph",',
    '    "inputs": [{"name": "clip_name", "label": "prompt_enhance_model", "type": "COMBO"}],',
    '    "nodes": [{"id": 393, "type": "CLIPLoader", "inputs": [{"name": "clip_name", "link": 1}], "widgets_values": []}],',
    '    "links": [{"id": 1, "origin_id": -10, "origin_slot": 0, "target_id": 393, "target_slot": 0}]',
    '  }]}',
    '}',
    'compiler = module.WorkflowCompiler("http://127.0.0.1:1")',
    'compiler.object_info = lambda class_type: {"input": {"required": {"clip_name": choices}}}',
    'compiled = compiler.compile(workflow, {}, [], "video/ltx-watch-create/test")',
    'print(json.dumps({',
    '  "renamed": module.reconcile_combo_value("gemma4_e2b_it_int8_convrot.safetensors", choices),',
    '  "enhancerRole": module.reconcile_combo_value("gemma4_e2b_it_int8_convrot.safetensors", choices, "prompt_enhance_model"),',
    '  "missingEnhancer": module.reconcile_combo_value("gemma4_e2b_it_int8_convrot.safetensors", [["gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors"], {}], "prompt_enhance_model"),',
    '  "existing": module.reconcile_combo_value("gemma4_e2b_it_bf16.safetensors", choices),',
    '  "ambiguous": module.reconcile_combo_value("gemma4_e2b_it.safetensors", choices),',
    '  "imageUpload": module.reconcile_widget_value("ltx_watch_create_fixture_reference_1.png", [["example.png"], {"image_upload": True}]),',
    '  "subgraph": compiled["393"]["inputs"]["clip_name"],',
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
  assert.equal(result.enhancerRole, 'gemma4_e2b_it_bf16.safetensors');
  assert.equal(result.missingEnhancer, 'gemma4_e2b_it_int8_convrot.safetensors');
  assert.equal(result.existing, 'gemma4_e2b_it_bf16.safetensors');
  assert.equal(result.ambiguous, 'gemma4_e2b_it.safetensors');
  assert.equal(result.imageUpload, 'ltx_watch_create_fixture_reference_1.png');
  assert.equal(result.subgraph, 'gemma4_e2b_it_bf16.safetensors');
});

test('Create stages reference images at the ComfyUI input root and cleans them', async (context) => {
  const python = process.env.LTX_STUDIO_TEST_PYTHON || (process.platform === 'win32' ? 'python.exe' : 'python3');
  const root = await mkdtemp(path.join(tmpdir(), 'ltx-watch-reference-'));
  try {
    const runtimeRoot = path.join(root, 'runtime');
    const comfyRoot = path.join(root, 'comfy');
    const sourcePath = path.join(runtimeRoot, 'reference.png');
    await mkdir(path.join(comfyRoot, 'input'), { recursive: true });
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(sourcePath, 'private reference fixture', 'utf8');
    const code = [
      'import importlib.util, json, os',
      'from pathlib import Path',
      'spec = importlib.util.spec_from_file_location("ltx_create_reference_test", os.environ["LTX_CREATE_RUNNER"])',
      'module = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(module)',
      'runtime = Path(os.environ["LTX_REFERENCE_RUNTIME"])',
      'comfy = Path(os.environ["LTX_REFERENCE_COMFY"])',
      'job = {"id": "create-fixture", "useBlender": False, "videoContextPath": None, "referenceMode": "first-frame", "referencePaths": [str(runtime / "reference.png")]}',
      'names, staged = module.prepare_reference_files(job, runtime, comfy, object())',
      'before = [item.is_file() for item in staged]',
      'parents = [item.parent == comfy / "input" for item in staged]',
      'module.cleanup_reference_files(staged)',
      'print(json.dumps({"names": names, "before": before, "parents": parents, "after": [item.exists() for item in staged]}))',
    ].join('\n');
    const run = spawnSync(python, ['-c', code], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        LTX_CREATE_RUNNER: path.join(appRoot, 'scripts', 'ltx-create-runner.py'),
        LTX_REFERENCE_RUNTIME: runtimeRoot,
        LTX_REFERENCE_COMFY: comfyRoot,
      },
    });
    if (run.error?.code === 'ENOENT') {
      context.skip(`Python executable not available: ${python}`);
      return;
    }
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const result = JSON.parse(run.stdout);
    assert.deepEqual(result.names, ['ltx_watch_create_create-fixture_reference_1.png']);
    assert.deepEqual(result.before, [true]);
    assert.deepEqual(result.parents, [true]);
    assert.deepEqual(result.after, [false]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Director patch relays timed prompts through the official Ingredients conditioning chain', (context) => {
  const python = process.env.LTX_STUDIO_TEST_PYTHON || (process.platform === 'win32' ? 'python.exe' : 'python3');
  const runner = path.join(appRoot, 'scripts', 'ltx-create-runner.py');
  const code = [
    'import importlib.util, json, os',
    'spec = importlib.util.spec_from_file_location("ltx_create_director_test", os.environ["LTX_CREATE_RUNNER"])',
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'prompt = {',
    '  "model": {"class_type": "LTXICLoRALoaderModelOnly", "inputs": {"strength_model": 1.3}},',
    '  "clip": {"class_type": "CLIPLoader", "inputs": {}},',
    '  "latent": {"class_type": "EmptyLTXVLatentVideo", "inputs": {}},',
    '  "conditioning": {"class_type": "LTXVConditioning", "inputs": {"positive": ["base", 0]}},',
    '  "guide": {"class_type": "LTXAddVideoICLoRAGuide", "inputs": {"positive": ["conditioning", 0]}},',
    '  "guider": {"class_type": "CFGGuider", "inputs": {"model": ["model", 0]}},',
    '}',
    'job = {',
    '  "prompt": "Persistent silver robot in a red raincoat.", "frameRate": 24,',
    '  "director": {"transition": 0.001, "ingredientsStrength": 1.1, "segments": [',
    '    {"duration": 2, "prompt": "Holds still."},',
    '    {"duration": 3, "prompt": "Turns left | then walks."}',
    '  ]}',
    '}',
    'result = module.patch_director_prompt(prompt, job)',
    'print(json.dumps({',
    '  "relay": result["ltx_watch_director_relay"],',
    '  "conditioned": result["conditioning"]["inputs"]["positive"],',
    '  "model": result["guider"]["inputs"]["model"],',
    '  "strength": result["model"]["inputs"]["strength_model"],',
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
  assert.equal(result.relay.class_type, 'PromptRelayEncode');
  assert.equal(result.relay.inputs.global_prompt, 'Persistent silver robot in a red raincoat.');
  assert.equal(result.relay.inputs.local_prompts, 'Holds still.|Turns left / then walks.');
  assert.equal(result.relay.inputs.segment_lengths, '48,73');
  assert.deepEqual(result.conditioned, ['ltx_watch_director_relay', 1]);
  assert.deepEqual(result.model, ['ltx_watch_director_relay', 0]);
  assert.equal(result.strength, 1.1);
});

test('Create retry replaces a stale result before the new runner is spawned', async () => {
  const server = await readFile(path.join(appRoot, 'local-server.mjs'), 'utf8');
  const resultReset = server.indexOf("await writeFile(resultPath, `${JSON.stringify({ status: 'generating'");
  const runnerSpawn = server.indexOf('const child = spawn(launch.executable', resultReset);
  assert.ok(resultReset > -1, 'expected an initial generating result');
  assert.ok(runnerSpawn > resultReset, 'the stale result must be replaced before spawning the retry');
});

test('Create cancellation stays private and is handled by the owning runner', async () => {
  const runner = await readFile(path.join(appRoot, 'scripts', 'ltx-create-runner.py'), 'utf8');
  const server = await readFile(path.join(appRoot, 'local-server.mjs'), 'utf8');
  const workspace = await readFile(path.join(appRoot, 'app', 'create-workspace.tsx'), 'utf8');
  assert.match(server, /path\.join\(path\.dirname\(source\.resultPath\), 'cancel\.requested\.json'\)/);
  assert.match(server, /action === 'cancel'/);
  assert.match(runner, /f"\{base_url\.rstrip\('\/'\)\}\/interrupt"/);
  assert.match(runner, /target=watch_for_cancellation/);
  assert.match(runner, /"status": "canceled" if canceled else "failed"/);
  const cancelBlock = server.slice(server.indexOf("action === 'cancel'"), server.indexOf("action === 'retry'"));
  assert.doesNotMatch(cancelBlock, /taskkill|Stop-Process|process\.kill/);
  assert.match(workspace, /view\.capabilities\?\.cancel/);
  assert.match(workspace, /window\.confirm\(`Cancel/);
});

test('Create output deletion is constrained and recoverable', async () => {
  const server = await readFile(path.join(appRoot, 'local-server.mjs'), 'utf8');
  const workspace = await readFile(path.join(appRoot, 'app', 'create-workspace.tsx'), 'utf8');
  assert.match(server, /RecycleOption\]::SendToRecycleBin/);
  assert.match(server, /LTX_WATCH_RECYCLE_TARGET: filePath/);
  assert.match(server, /GetEnvironmentVariable\('LTX_WATCH_RECYCLE_TARGET', 'Process'\)/);
  assert.doesNotMatch(server, /'-Command', script, filePath/);
  const deleteBlock = server.slice(server.indexOf("action === 'delete-output'"), server.indexOf("action === 'cancel'"));
  assert.match(deleteBlock, /isInside\(source\.outputPath, \[config\.clipsDirectory\]\)/);
  assert.match(deleteBlock, /await recycleFile\(source\.outputPath\)/);
  assert.doesNotMatch(deleteBlock, /\brm\(|unlink|Remove-Item/);
  assert.match(workspace, /view\.capabilities\?\.recycleOutput/);
  assert.match(workspace, /window\.confirm\(`Delete/);
  assert.match(workspace, /action\('delete-output', \{ jobId: job\.id \}/);
});

test('Create output rename stays inside the video root and never overwrites', async () => {
  const server = await readFile(path.join(appRoot, 'local-server.mjs'), 'utf8');
  const workspace = await readFile(path.join(appRoot, 'app', 'create-workspace.tsx'), 'utf8');
  const renameBlock = server.slice(server.indexOf("action === 'rename-output'"), server.indexOf("action === 'delete-output'"));
  assert.match(renameBlock, /source\.status !== 'complete'/);
  assert.match(renameBlock, /isInside\(source\.outputPath, \[config\.clipsDirectory\]\)/);
  assert.match(renameBlock, /isInside\(nextPath, \[config\.clipsDirectory\]\)/);
  assert.match(renameBlock, /existsSync\(nextPath\)/);
  assert.match(renameBlock, /await rename\(source\.outputPath, nextPath\)/);
  assert.doesNotMatch(renameBlock, /\brm\(|unlink|Remove-Item/);
  assert.match(workspace, /view\.capabilities\?\.renameOutput/);
  assert.match(workspace, /action\('rename-output', \{ jobId: job\.id, title \}/);
});
