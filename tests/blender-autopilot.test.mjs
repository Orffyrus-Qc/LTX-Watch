import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AUTOPILOT_PRIMITIVES,
  autopilotCapability,
  buildAutopilotJob,
  chooseOllamaModel,
  composeClothPrompt,
  loadPresetSpec,
  looksLikeFinalOverrideIntro,
  mergePlannedSpec,
  normalizeOllamaUrl,
  validateSceneSpec,
} from '../lib/blender-autopilot.mjs';

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('Final Override intro wording is recognized even if the dropdown said from-prompt', () => {
  assert.equal(looksLikeFinalOverrideIntro('Final Override Introduction', 'cinematic orbit of Earth inside a black-metal halo with gothic machine-datacenter cathedrals and glass biodomes'), true);
  assert.equal(looksLikeFinalOverrideIntro('A red bicycle in rain'), false);
});

test('Final Override intro preset locks earth, halo, moon, cathedral, and biodome', () => {
  const spec = loadPresetSpec('final-override-intro');
  const primitives = new Set(spec.objects.map((item) => item.primitive));
  assert.equal(spec.preset, 'final-override-intro');
  assert.ok(primitives.has('planet'));
  assert.ok(primitives.has('torus-halo'));
  assert.ok(primitives.has('moon'));
  assert.ok(primitives.has('gothic-machine-cathedral'));
  assert.ok(primitives.has('geodesic-biodome'));
  assert.equal(spec.objects.filter((item) => item.primitive === 'gothic-machine-cathedral').length, 2);
  assert.equal(spec.objects.filter((item) => item.primitive === 'geodesic-biodome').length, 2);
  assert.match(spec.appearancePrompt, /machine-datacenter cathedral/i);
  assert.match(composeClothPrompt(spec), /Blender owns camera path/i);
});

test('scene spec rejects unknown primitives and keeps identity relationships local', () => {
  assert.throws(() => validateSceneSpec({
    preset: 'from-prompt',
    objects: [{ id: 'evil', primitive: 'bpy-script', location: [0, 0, 0] }],
  }), /at least one allowlisted/i);
  const spec = validateSceneSpec({
    preset: 'from-prompt',
    objects: [{ id: 'hero', primitive: 'ship', identityId: 'missing', parent: 'nope' }],
    identities: [{ id: 'pilot', role: 'character', name: 'Pilot', lock: 'Same face and coat.' }],
  });
  assert.equal(spec.objects[0].identityId, null);
  assert.equal(spec.objects[0].parent, null);
  assert.ok(AUTOPILOT_PRIMITIVES.includes('gothic-machine-cathedral'));
});

test('intro geometry stays locked when the local planner only rewrites appearance', () => {
  const base = loadPresetSpec('final-override-intro');
  const merged = mergePlannedSpec(base, {
    appearancePrompt: 'More cyan reactor-eyes, same blocking.',
    objects: [{ id: 'intruder', primitive: 'ship' }],
    identities: [{ id: 'cathedral', lock: 'Keep the wide machine-city fortress.' }],
  }, { lockGeometry: true });
  assert.equal(merged.objects.length, base.objects.length);
  assert.equal(merged.objects.find((item) => item.id === 'intruder'), undefined);
  assert.match(merged.identities.find((item) => item.id === 'cathedral').lock, /machine-city fortress/i);
  assert.match(merged.appearancePrompt, /cyan reactor-eyes/i);
});

test('Ollama stays on loopback and prefers local coder models', () => {
  assert.equal(normalizeOllamaUrl('http://127.0.0.1:11434/'), 'http://127.0.0.1:11434');
  assert.throws(() => normalizeOllamaUrl('http://192.168.1.10:11434'), /loopback/i);
  assert.equal(chooseOllamaModel(['llama3', 'qwen2.5-coder:14b-agent'], ''), 'qwen2.5-coder:14b-agent');
});

test('Auto-Pilot capability never claims physics-pass refinement', () => {
  const capability = autopilotCapability({
    blenderInstalled: true,
    adapterInstalled: true,
    runnerInstalled: true,
    ollamaOnline: true,
    ollamaModel: 'qwen2.5-coder:14b-agent',
    clothTemplateInstalled: true,
  });
  assert.equal(capability.preparationReady, true);
  assert.equal(capability.planningReady, true);
  assert.equal(capability.clothReady, true);
  assert.equal(capability.animationAuthority, 'blender');
  assert.equal(capability.refinementAuthority, 'appearance-only');
});

test('Auto-Pilot job stays inside the private runtime and never overwrites a seed scene', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ltx-watch-autopilot-'));
  try {
    const runtime = path.join(root, 'runtime');
    await mkdir(runtime, { recursive: true });
    const job = buildAutopilotJob({
      id: 'autopilot-fixture',
      preset: 'final-override-intro',
      runtimeRoot: runtime,
      frameStart: 1,
      frameEnd: 24,
      frameRate: 24,
      width: 960,
      height: 544,
      blenderScriptPath: path.join(appRoot, 'scripts', 'blender-autopilot.py'),
    });
    assert.equal(job.kind, 'blender-autopilot');
    assert.equal(job.animationAuthority, 'blender');
    assert.doesNotMatch(job.workingCopyPath, /INTRO_ORBIT_SCENE/i);
    assert.throws(() => buildAutopilotJob({
      id: 'escape',
      runtimeRoot: runtime,
      sourcePath: path.join(root, 'elsewhere.blend'),
      allowedSourceRoots: [runtime],
      blenderScriptPath: job.blenderScriptPath,
    }), /outside its registered root/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bundled adapters refuse generated Python and validate without opening Blender', async (context) => {
  const adapter = await readFile(path.join(appRoot, 'scripts', 'blender-autopilot.py'), 'utf8');
  const runner = await readFile(path.join(appRoot, 'scripts', 'ltx-autopilot-runner.py'), 'utf8');
  assert.match(adapter, /ALLOWED_PRIMITIVES/);
  assert.doesNotMatch(adapter, /exec\(|eval\(|python-expr/);
  assert.match(runner, /api\/chat/);
  assert.match(runner, /keep_alive/);
  assert.match(runner, /keeping the seed scene objects/);
  assert.match(runner, /PRIMITIVE_ALIASES/);
  assert.match(runner, /v1\/chat\/completions/);
  assert.match(runner, /CWM_SYSTEM_PROMPT/);
  assert.doesNotMatch(runner, /exec\(|eval\(/);
  const python = process.env.LTX_STUDIO_TEST_PYTHON || (process.platform === 'win32' ? 'python.exe' : 'python3');
  const root = await mkdtemp(path.join(tmpdir(), 'ltx-watch-autopilot-validate-'));
  try {
    const runtime = path.join(root, 'runtime');
    await mkdir(path.join(runtime, 'backbone-v1'), { recursive: true });
    const spec = loadPresetSpec('final-override-intro');
    const specPath = path.join(runtime, 'scene-spec.json');
    await writeFile(specPath, JSON.stringify(spec), 'utf8');
    const job = buildAutopilotJob({
      id: 'validate-only',
      preset: 'final-override-intro',
      runtimeRoot: runtime,
      specPath,
      frameStart: 1,
      frameEnd: 8,
      frameRate: 24,
      width: 960,
      height: 544,
      blenderScriptPath: path.join(appRoot, 'scripts', 'blender-autopilot.py'),
    });
    const jobPath = path.join(runtime, 'job.json');
    await writeFile(jobPath, JSON.stringify(job), 'utf8');
    const blenderJob = {
      ...job,
      kind: 'blender-autopilot',
      animationAuthority: 'blender',
    };
    const blenderJobPath = path.join(runtime, 'blender-job.json');
    await writeFile(blenderJobPath, JSON.stringify(blenderJob), 'utf8');
    const runAdapter = spawnSync(python, [path.join(appRoot, 'scripts', 'blender-autopilot.py'), '--validate-job', blenderJobPath], {
      cwd: runtime,
      encoding: 'utf8',
      windowsHide: true,
    });
    const runOrchestrator = spawnSync(python, [path.join(appRoot, 'scripts', 'ltx-autopilot-runner.py'), '--validate-job', jobPath], {
      cwd: runtime,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (runAdapter.error?.code === 'ENOENT' || runOrchestrator.error?.code === 'ENOENT') {
      context.skip(`Python executable not available: ${python}`);
      return;
    }
    assert.equal(runAdapter.status, 0, runAdapter.stderr || runAdapter.stdout);
    assert.equal(runOrchestrator.status, 0, runOrchestrator.stderr || runOrchestrator.stdout);
    assert.equal(JSON.parse(runAdapter.stdout).kind, 'blender-autopilot');
    assert.equal(JSON.parse(runOrchestrator.stdout).kind, 'blender-autopilot');
    assert.doesNotMatch([python, blenderJobPath].join(' '), /INTRO_ORBIT_SCENE/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
