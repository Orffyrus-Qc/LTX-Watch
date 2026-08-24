import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildPhysicsBackboneJob,
  createPhysicsBackboneManifest,
  PHYSICS_BACKBONE_PASSES,
  physicsBackboneCapability,
} from '../lib/physics-backbone.mjs';

const appRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function fixture(root) {
  return buildPhysicsBackboneJob({
    id: 'physics-fixture',
    sourcePath: path.join(root, 'master.blend'),
    allowedSourceRoots: [root],
    runtimeRoot: path.join(root, 'runtime'),
    frameStart: 8,
    frameEnd: 31,
    frameRate: 24,
    width: 1280,
    height: 736,
  });
}

test('physics backbone contract keeps Blender as animation authority', () => {
  const root = path.resolve('fixtures', 'physics');
  const job = fixture(root);
  assert.equal(job.animationAuthority, 'blender');
  assert.deepEqual(new Set(job.passes), new Set(['beauty', 'depth', 'normal', 'flow', 'camera']));
  const manifest = createPhysicsBackboneManifest(job, { blender: { version: 'fixture' } });
  assert.equal(manifest.animationAuthority, 'blender');
  assert.equal(manifest.refinementAuthority, 'appearance-only');
  assert.equal(manifest.timeline.frameCount, 24);
  assert.equal(manifest.compatibility.refinementReady, false);
});

test('physics backbone rejects a master scene outside registered roots', () => {
  const root = path.resolve('fixtures', 'physics');
  assert.throws(() => buildPhysicsBackboneJob({
    id: 'escape',
    sourcePath: path.resolve('elsewhere', 'master.blend'),
    allowedSourceRoots: [root],
    runtimeRoot: path.join(root, 'runtime'),
    frameStart: 1,
    frameEnd: 2,
    frameRate: 24,
    width: 960,
    height: 544,
  }), /outside its registered root/i);
});

test('LTX refinement stays gated even when backbone preparation is installed', () => {
  const capability = physicsBackboneCapability({ blenderInstalled: true, adapterInstalled: true });
  assert.equal(capability.preparationReady, true);
  assert.equal(capability.refinementReady, false);
  assert.equal(capability.animationAuthority, 'blender');
  assert.equal(capability.passes.length, PHYSICS_BACKBONE_PASSES.length);
  assert.match(capability.blockedReason, /no verified 2\.5 adapter/i);
});

test('fixed-purpose Blender adapter emits and validates every structural pass without saving a scene', async () => {
  const script = await readFile(path.join(appRoot, 'scripts', 'blender-physics-backbone.py'), 'utf8');
  assert.match(script, /view_layer\.use_pass_z = True/);
  assert.match(script, /view_layer\.use_pass_normal = True/);
  assert.match(script, /view_layer\.use_pass_vector = True/);
  assert.match(script, /matrixWorld/);
  assert.match(script, /pass is incomplete/);
  assert.doesNotMatch(script, /save_as_mainfile|save_mainfile/);
  assert.doesNotMatch(script, /exec\(|eval\(/);
});

test('Blender adapter validates a private fixture without opening Blender', async (context) => {
  const python = process.env.LTX_STUDIO_TEST_PYTHON || (process.platform === 'win32' ? 'python.exe' : 'python3');
  const root = await mkdtemp(path.join(tmpdir(), 'ltx-watch-physics-'));
  try {
    const job = fixture(root);
    const jobPath = path.join(root, 'job.json');
    await writeFile(jobPath, JSON.stringify(job), 'utf8');
    const run = spawnSync(python, [path.join(appRoot, 'scripts', 'blender-physics-backbone.py'), '--validate-job', jobPath], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (run.error?.code === 'ENOENT') {
      context.skip(`Python executable not available: ${python}`);
      return;
    }
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.deepEqual(JSON.parse(run.stdout), { ok: true, kind: 'physics-backbone', frames: 24, animationAuthority: 'blender' });
    assert.doesNotMatch([python, path.join(appRoot, 'scripts', 'blender-physics-backbone.py'), '--validate-job', jobPath].join(' '), /master\.blend/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
