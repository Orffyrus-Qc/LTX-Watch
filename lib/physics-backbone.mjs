import path from 'node:path';

export const PHYSICS_BACKBONE_SCHEMA_VERSION = 1;
export const PHYSICS_BACKBONE_MAX_FRAMES = 10_000;

export const PHYSICS_BACKBONE_PASSES = Object.freeze([
  { id: 'beauty', label: 'Beauty / RGBA', format: 'PNG', pattern: 'beauty/frame_####.png' },
  { id: 'depth', label: 'Linear depth', format: 'OpenEXR 32-bit', pattern: 'depth/frame_####.exr' },
  { id: 'normal', label: 'Surface normals', format: 'OpenEXR 32-bit', pattern: 'normal/frame_####.exr' },
  { id: 'flow', label: 'Motion vectors', format: 'OpenEXR 32-bit', pattern: 'flow/frame_####.exr' },
  { id: 'camera', label: 'Camera transforms', format: 'JSON Lines', pattern: 'camera.jsonl' },
]);

function integer(value, minimum, maximum, label) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

function inside(candidate, roots) {
  const resolved = path.resolve(String(candidate || ''));
  return roots.some((root) => {
    const relative = path.relative(path.resolve(String(root || '')), resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}

export function physicsBackboneCapability({ blenderInstalled = false, adapterInstalled = false } = {}) {
  const preparationReady = Boolean(blenderInstalled && adapterInstalled);
  return {
    schemaVersion: PHYSICS_BACKBONE_SCHEMA_VERSION,
    preparationReady,
    refinementReady: false,
    animationAuthority: 'blender',
    passes: PHYSICS_BACKBONE_PASSES.map((item) => ({ ...item })),
    blockedReason: !blenderInstalled
      ? 'Install Blender before preparing a physics backbone.'
      : !adapterInstalled
        ? 'The bundled Blender physics-pass adapter is missing.'
        : 'Backbone preparation is ready. LTX 2.5 refinement remains gated because this installation has no verified 2.5 adapter that consumes depth, normals, and motion vectors without re-animating the shot.',
  };
}

export function buildPhysicsBackboneJob(input = {}) {
  const id = String(input.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
  if (!id) throw new Error('Physics backbone job id is required.');
  const runtimeRoot = path.resolve(String(input.runtimeRoot || ''));
  const sourcePath = path.resolve(String(input.sourcePath || ''));
  const workingCopyPath = path.resolve(String(input.workingCopyPath || path.join(runtimeRoot, 'source-copy.blend')));
  const outputRoot = path.resolve(String(input.outputRoot || path.join(runtimeRoot, 'backbone-v1')));
  const resultPath = path.resolve(String(input.resultPath || path.join(runtimeRoot, 'result.json')));
  const cancelPath = path.resolve(String(input.cancelPath || path.join(runtimeRoot, 'cancel.requested.json')));
  const allowedSourceRoots = Array.isArray(input.allowedSourceRoots) ? input.allowedSourceRoots.map((item) => path.resolve(String(item))) : [];
  const frameStart = integer(input.frameStart, 1, 1_000_000, 'First frame');
  const frameEnd = integer(input.frameEnd, frameStart, 1_000_000, 'Last frame');
  if (frameEnd - frameStart + 1 > PHYSICS_BACKBONE_MAX_FRAMES) throw new Error(`A physics backbone is limited to ${PHYSICS_BACKBONE_MAX_FRAMES} frames per package.`);
  const job = {
    schemaVersion: PHYSICS_BACKBONE_SCHEMA_VERSION,
    kind: 'physics-backbone',
    id,
    animationAuthority: 'blender',
    sourcePath,
    allowedSourceRoots,
    runtimeRoot,
    workingCopyPath,
    outputRoot,
    resultPath,
    cancelPath,
    frameStart,
    frameEnd,
    frameRate: integer(input.frameRate, 1, 120, 'Frame rate'),
    width: integer(input.width, 64, 16_384, 'Width'),
    height: integer(input.height, 64, 16_384, 'Height'),
    passes: PHYSICS_BACKBONE_PASSES.map((item) => item.id),
  };
  return validatePhysicsBackboneJob(job);
}

export function validatePhysicsBackboneJob(job = {}) {
  if (job.kind !== 'physics-backbone' || job.animationAuthority !== 'blender') throw new Error('The job is not a Blender-authoritative physics backbone.');
  if (path.extname(String(job.sourcePath || '')).toLowerCase() !== '.blend') throw new Error('Physics backbone source must be a .blend file.');
  if (!Array.isArray(job.allowedSourceRoots) || !job.allowedSourceRoots.length || !inside(job.sourcePath, job.allowedSourceRoots)) throw new Error('Physics backbone source is outside its registered root.');
  for (const candidate of [job.workingCopyPath, job.outputRoot, job.resultPath, job.cancelPath]) {
    if (!inside(candidate, [job.runtimeRoot])) throw new Error('Physics backbone output escaped its private job folder.');
  }
  if (path.resolve(job.sourcePath) === path.resolve(job.workingCopyPath)) throw new Error('Physics backbone must render from a working copy, never the master scene.');
  const expectedPasses = new Set(PHYSICS_BACKBONE_PASSES.map((item) => item.id));
  if (!Array.isArray(job.passes) || job.passes.some((item) => !expectedPasses.has(item)) || expectedPasses.size !== new Set(job.passes).size) throw new Error('Physics backbone pass contract is incomplete.');
  return job;
}

export function createPhysicsBackboneManifest(job, result = {}) {
  validatePhysicsBackboneJob(job);
  const frameCount = job.frameEnd - job.frameStart + 1;
  return {
    schemaVersion: PHYSICS_BACKBONE_SCHEMA_VERSION,
    kind: 'ltx-watch-physics-backbone',
    animationAuthority: 'blender',
    refinementAuthority: 'appearance-only',
    source: {
      masterPath: job.sourcePath,
      workingCopyPath: job.workingCopyPath,
      masterModifiedAt: result.masterModifiedAt || null,
      masterSize: Number(result.masterSize || 0),
    },
    timeline: { frameStart: job.frameStart, frameEnd: job.frameEnd, frameCount, frameRate: job.frameRate },
    resolution: { width: job.width, height: job.height },
    passes: PHYSICS_BACKBONE_PASSES.map((item) => ({ ...item, frameCount })),
    dynamics: result.dynamics || { rigidBodies: 0, clothModifiers: 0, softBodyModifiers: 0, collisionObjects: 0 },
    blender: result.blender || null,
    createdAt: result.createdAt || new Date().toISOString(),
    compatibility: {
      ltxVersion: '2.5',
      refinementReady: false,
      reason: 'No verified LTX 2.5 adapter is configured to consume every structural pass while preserving Blender motion exactly.',
    },
  };
}
