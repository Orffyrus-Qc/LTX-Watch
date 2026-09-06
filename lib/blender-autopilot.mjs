import path from 'node:path';
import { createDefaultFinalOverrideIntroSpec } from './final-override-intro-spec.mjs';

export const AUTOPILOT_SCHEMA_VERSION = 1;
export const AUTOPILOT_MAX_FRAMES = 600;
export const AUTOPILOT_MAX_OBJECTS = 24;
export const AUTOPILOT_MAX_IDENTITIES = 12;
export const AUTOPILOT_PRESETS = Object.freeze(['final-override-intro', 'from-prompt']);
export const AUTOPILOT_PRIMITIVES = Object.freeze([
  'planet',
  'moon',
  'torus-halo',
  'gothic-machine-cathedral',
  'geodesic-biodome',
  'ship',
  'satellite',
  'laser',
  'camera-orbit',
  'empty-rig',
]);
export const AUTOPILOT_ROLES = Object.freeze(['planet', 'location', 'prop', 'vehicle', 'character', 'camera', 'light', 'fx']);
export const AUTOPILOT_CAMERAS = Object.freeze(['orbit', 'dolly-in', 'dolly-out', 'lock', 'closeup-orbit']);
export const AUTOPILOT_WORLDS = Object.freeze(['space', 'dusk', 'void']);
export const AUTOPILOT_PREFERRED_MODELS = Object.freeze([
  'qwen2.5-coder:14b-agent',
  'qwen2.5-coder:14b',
  'qwen2.5-coder:7b-agent',
  'qwen3.5:9b',
  'gpt-oss:20b',
  'qwen3.8:27b',
  'qwen3.6:35b',
]);

function integer(value, minimum, maximum, label) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return number;
}

function bounded(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function token(value, fallback = '') {
  return String(value || fallback).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
}

function phrase(value, limit) {
  return String(value || '').replace(/\0/g, '').replace(/\r\n?/g, '\n').trim().slice(0, limit);
}

function vector3(value, fallback) {
  if (!Array.isArray(value) || value.length !== 3) return fallback.slice();
  return value.map((item, index) => bounded(item, -1000, 1000, fallback[index]));
}

function inside(candidate, roots) {
  const resolved = path.resolve(String(candidate || ''));
  return roots.some((root) => {
    const relative = path.relative(path.resolve(String(root || '')), resolved);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
}

export function isLoopbackHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1');
  } catch {
    return false;
  }
}

export function normalizeOllamaUrl(value) {
  const raw = String(value || 'http://127.0.0.1:11434').trim() || 'http://127.0.0.1:11434';
  if (!isLoopbackHttpUrl(raw)) throw new Error('Ollama must stay on loopback (127.0.0.1 or localhost).');
  return raw.replace(/\/+$/, '');
}

export function chooseOllamaModel(installed = [], preferred = '') {
  const names = new Set((Array.isArray(installed) ? installed : []).map((item) => String(item || '').trim()).filter(Boolean));
  if (preferred && names.has(preferred)) return preferred;
  return AUTOPILOT_PREFERRED_MODELS.find((name) => names.has(name)) || [...names][0] || null;
}

export function autopilotCapability({
  blenderInstalled = false,
  adapterInstalled = false,
  runnerInstalled = false,
  ollamaOnline = false,
  ollamaModel = null,
  clothTemplateInstalled = false,
} = {}) {
  const preparationReady = Boolean(blenderInstalled && adapterInstalled && runnerInstalled);
  const planningReady = Boolean(preparationReady && ollamaOnline && ollamaModel);
  return {
    schemaVersion: AUTOPILOT_SCHEMA_VERSION,
    preparationReady,
    planningReady,
    clothReady: Boolean(preparationReady && clothTemplateInstalled),
    animationAuthority: 'blender',
    refinementAuthority: 'appearance-only',
    presets: AUTOPILOT_PRESETS.slice(),
    primitives: AUTOPILOT_PRIMITIVES.slice(),
    ollamaModel: ollamaModel || null,
    blockedReason: !blenderInstalled
      ? 'Install Blender before using Blender Auto-Pilot.'
      : !adapterInstalled || !runnerInstalled
        ? 'The bundled Blender Auto-Pilot adapter is missing.'
        : !ollamaOnline
          ? 'Local Ollama is offline. Auto-Pilot can still build the Final Override intro preset, but prompt-driven scenes need a loopback Ollama model.'
          : !ollamaModel
            ? 'No local Ollama model is installed for scene planning.'
            : 'Local Ollama will plan a schema-validated scene. Blender owns camera and blocking. LTX may only clothe appearance and add smaller motion.',
  };
}

function cleanIdentity(input, index) {
  const id = token(input?.id, `identity-${index + 1}`);
  if (!id) return null;
  return {
    id,
    role: AUTOPILOT_ROLES.includes(input?.role) ? input.role : 'location',
    name: phrase(input?.name, 80) || id,
    lock: phrase(input?.lock, 800),
    forbidden: Array.isArray(input?.forbidden)
      ? input.forbidden.map((item) => phrase(item, 80)).filter(Boolean).slice(0, 12)
      : [],
  };
}

function cleanObject(input, index) {
  const id = token(input?.id, `object-${index + 1}`);
  const primitive = String(input?.primitive || '');
  if (!id || !AUTOPILOT_PRIMITIVES.includes(primitive)) return null;
  const animationType = ['orbit', 'spin', 'none'].includes(input?.animation?.type) ? input.animation.type : 'none';
  return {
    id,
    primitive,
    role: AUTOPILOT_ROLES.includes(input?.role) ? input.role : 'prop',
    parent: token(input?.parent) || null,
    location: vector3(input?.location, [0, 0, 0]),
    rotation: vector3(input?.rotation, [0, 0, 0]),
    scale: Array.isArray(input?.scale) ? vector3(input.scale, [1, 1, 1]) : [bounded(input?.scale, 0.01, 100, 1), bounded(input?.scale, 0.01, 100, 1), bounded(input?.scale, 0.01, 100, 1)],
    identityId: token(input?.identityId) || null,
    animation: {
      type: animationType,
      speed: bounded(input?.animation?.speed, -8, 8, animationType === 'none' ? 0 : 1),
      radius: bounded(input?.animation?.radius, 0, 50, 0),
    },
  };
}

function cleanShot(input, index) {
  const id = token(input?.id, `shot-${String(index + 1).padStart(2, '0')}`);
  if (!id) return null;
  return {
    id,
    name: phrase(input?.name, 80) || id,
    startNorm: bounded(input?.startNorm, 0, 1, 0),
    endNorm: bounded(input?.endNorm, 0, 1, 1),
    prompt: phrase(input?.prompt, 2_000),
  };
}

export function validateSceneSpec(input = {}) {
  const preset = AUTOPILOT_PRESETS.includes(input.preset) ? input.preset : 'from-prompt';
  const objects = (Array.isArray(input.objects) ? input.objects : []).map(cleanObject).filter(Boolean).slice(0, AUTOPILOT_MAX_OBJECTS);
  if (!objects.length) throw new Error('Auto-Pilot needs at least one allowlisted scene object.');
  const identities = (Array.isArray(input.identities) ? input.identities : []).map(cleanIdentity).filter(Boolean).slice(0, AUTOPILOT_MAX_IDENTITIES);
  const identityIds = new Set(identities.map((item) => item.id));
  const objectIds = new Set(objects.map((item) => item.id));
  for (const object of objects) {
    if (object.parent && !objectIds.has(object.parent)) object.parent = null;
    if (object.identityId && !identityIds.has(object.identityId)) object.identityId = null;
  }
  const shots = (Array.isArray(input.shots) ? input.shots : []).map(cleanShot).filter(Boolean).slice(0, 8);
  const worldKind = AUTOPILOT_WORLDS.includes(input.world?.kind) ? input.world.kind : 'space';
  const cameraType = AUTOPILOT_CAMERAS.includes(input.camera?.type) ? input.camera.type : 'orbit';
  return {
    schemaVersion: AUTOPILOT_SCHEMA_VERSION,
    kind: 'blender-autopilot-scene',
    preset,
    title: phrase(input.title, 120) || (preset === 'final-override-intro' ? 'Final Override Introduction' : 'Auto-Pilot scene'),
    logline: phrase(input.logline, 400),
    appearancePrompt: phrase(input.appearancePrompt, 4_000),
    avoid: phrase(input.avoid, 1_000),
    world: {
      kind: worldKind,
      sunEnergy: bounded(input.world?.sunEnergy, 0, 20, 5),
      sunRotation: vector3(input.world?.sunRotation, [0.85, 0.2, 0.35]),
    },
    camera: {
      type: cameraType,
      lookAt: token(input.camera?.lookAt, objects[0]?.id) || objects[0].id,
      distance: bounded(input.camera?.distance, 0.4, 40, 4.2),
      height: bounded(input.camera?.height, -10, 10, 0.85),
      closeupDistance: bounded(input.camera?.closeupDistance, 0.3, 20, 2.2),
      closeupStart: bounded(input.camera?.closeupStart, 0, 1, 0.38),
      closeupEnd: bounded(input.camera?.closeupEnd, 0, 1, 0.62),
      lensMm: bounded(input.camera?.lensMm, 18, 200, 35),
    },
    identities,
    objects,
    shots: shots.length ? shots : [{ id: 'shot-01', name: 'full-move', startNorm: 0, endNorm: 1, prompt: phrase(input.appearancePrompt, 2_000) }],
  };
}

export function loadPresetSpec(preset) {
  if (preset === 'final-override-intro') return validateSceneSpec(createDefaultFinalOverrideIntroSpec());
  return null;
}

export function mergePlannedSpec(baseSpec, planned = {}, { lockGeometry = false } = {}) {
  const base = validateSceneSpec(baseSpec);
  if (!planned || typeof planned !== 'object') return base;
  if (lockGeometry) {
    return validateSceneSpec({
      ...base,
      title: planned.title || base.title,
      logline: planned.logline || base.logline,
      appearancePrompt: planned.appearancePrompt || base.appearancePrompt,
      avoid: [base.avoid, planned.avoid].filter(Boolean).join('. '),
      identities: base.identities.map((identity) => {
        const overlay = (Array.isArray(planned.identities) ? planned.identities : []).find((item) => token(item?.id) === identity.id);
        return overlay ? { ...identity, lock: phrase(overlay.lock, 800) || identity.lock, forbidden: overlay.forbidden?.length ? overlay.forbidden : identity.forbidden } : identity;
      }),
      shots: base.shots.map((shot) => {
        const overlay = (Array.isArray(planned.shots) ? planned.shots : []).find((item) => token(item?.id) === shot.id);
        return overlay ? { ...shot, prompt: phrase(overlay.prompt, 2_000) || shot.prompt } : shot;
      }),
    });
  }
  return validateSceneSpec({
    ...base,
    ...planned,
    preset: 'from-prompt',
    objects: Array.isArray(planned.objects) && planned.objects.length ? planned.objects : base.objects,
    identities: Array.isArray(planned.identities) && planned.identities.length ? planned.identities : base.identities,
    shots: Array.isArray(planned.shots) && planned.shots.length ? planned.shots : base.shots,
    camera: { ...base.camera, ...(planned.camera || {}) },
    world: { ...base.world, ...(planned.world || {}) },
  });
}

export function composeClothPrompt(spec, options = {}) {
  const scene = validateSceneSpec(spec);
  const identityBlock = scene.identities
    .map((item) => `- ${item.name} (${item.role}): ${item.lock}${item.forbidden.length ? ` Never: ${item.forbidden.join(', ')}.` : ''}`)
    .join('\n');
  const shot = scene.shots.find((item) => item.id === options.shotId) || scene.shots[0];
  const parts = [
    scene.appearancePrompt || options.prompt || '',
    shot?.prompt ? `Beat: ${shot.prompt}` : '',
    identityBlock ? `Identity lock:\n${identityBlock}` : '',
    'Authority: Blender owns camera path, object placement, halo/earth/cathedral/biodome layout, and large motion. LTX may only clothe materials, lighting atmosphere, and smaller secondary animation such as lights, vegetation, weather, or cloth-like surface motion. Do not invent a new camera move, relocate landmarks, or change character/object identity.',
    scene.avoid || options.avoid ? `Avoid: ${[scene.avoid, options.avoid].filter(Boolean).join('. ')}` : '',
  ];
  return parts.filter(Boolean).join('\n\n');
}

export function buildAutopilotJob(input = {}) {
  const id = token(input.id);
  if (!id) throw new Error('Auto-Pilot job id is required.');
  const runtimeRoot = path.resolve(String(input.runtimeRoot || ''));
  const specPath = path.resolve(String(input.specPath || path.join(runtimeRoot, 'scene-spec.json')));
  const workingCopyPath = path.resolve(String(input.workingCopyPath || path.join(runtimeRoot, 'generated.blend')));
  const outputRoot = path.resolve(String(input.outputRoot || path.join(runtimeRoot, 'backbone-v1')));
  const resultPath = path.resolve(String(input.resultPath || path.join(runtimeRoot, 'result.json')));
  const cancelPath = path.resolve(String(input.cancelPath || path.join(runtimeRoot, 'cancel.requested.json')));
  const preset = AUTOPILOT_PRESETS.includes(input.preset) ? input.preset : 'from-prompt';
  const frameStart = integer(input.frameStart ?? 1, 1, 1_000_000, 'First frame');
  const frameEnd = integer(input.frameEnd ?? frameStart, frameStart, 1_000_000, 'Last frame');
  if (frameEnd - frameStart + 1 > AUTOPILOT_MAX_FRAMES) throw new Error(`Auto-Pilot recording is limited to ${AUTOPILOT_MAX_FRAMES} frames per job.`);
  const sourcePath = input.sourcePath ? path.resolve(String(input.sourcePath)) : '';
  const allowedSourceRoots = Array.isArray(input.allowedSourceRoots) ? input.allowedSourceRoots.map((item) => path.resolve(String(item))) : [];
  if (sourcePath) {
    if (path.extname(sourcePath).toLowerCase() !== '.blend') throw new Error('Auto-Pilot seed must be a .blend file.');
    if (!allowedSourceRoots.length || !inside(sourcePath, allowedSourceRoots)) throw new Error('Auto-Pilot seed is outside its registered root.');
  }
  const job = {
    schemaVersion: AUTOPILOT_SCHEMA_VERSION,
    kind: 'blender-autopilot',
    id,
    animationAuthority: 'blender',
    refinementAuthority: 'appearance-only',
    preset,
    prompt: phrase(input.prompt, 8_000),
    avoid: phrase(input.avoid, 1_000),
    ollamaUrl: input.ollamaUrl ? normalizeOllamaUrl(input.ollamaUrl) : '',
    ollamaModel: phrase(input.ollamaModel, 120),
    blenderExecutable: phrase(input.blenderExecutable, 500),
    blenderScriptPath: path.resolve(String(input.blenderScriptPath || '')),
    createRunnerPath: input.createRunnerPath ? path.resolve(String(input.createRunnerPath)) : '',
    sourcePath,
    allowedSourceRoots,
    runtimeRoot,
    specPath,
    workingCopyPath,
    outputRoot,
    resultPath,
    cancelPath,
    frameStart,
    frameEnd,
    frameRate: integer(input.frameRate ?? 24, 12, 30, 'Frame rate'),
    width: integer(input.width ?? 1280, 64, 16_384, 'Width'),
    height: integer(input.height ?? 736, 64, 16_384, 'Height'),
    clothWithLtx: input.clothWithLtx === true,
    seed: integer(input.seed ?? 0, 0, 2_147_483_647, 'Seed'),
    audio: ['generate', 'ambient', 'silent', 'soundtrack'].includes(input.audio) ? input.audio : 'generate',
    soundtrackPath: input.soundtrackPath ? path.resolve(String(input.soundtrackPath)) : '',
    sourceRunner: input.sourceRunner ? path.resolve(String(input.sourceRunner)) : '',
    comfyRoot: input.comfyRoot ? path.resolve(String(input.comfyRoot)) : '',
    outputPrefix: phrase(input.outputPrefix, 200),
    port: integer(input.port ?? 8188, 1_024, 65_535, 'Port'),
    cudaDevice: integer(input.cudaDevice ?? 0, 0, 15, 'CUDA device'),
  };
  return validateAutopilotJob(job);
}

export function validateAutopilotJob(job = {}) {
  if (job.kind !== 'blender-autopilot' || job.animationAuthority !== 'blender') {
    throw new Error('The job is not a Blender Auto-Pilot job.');
  }
  if (!AUTOPILOT_PRESETS.includes(job.preset)) throw new Error('Unknown Auto-Pilot preset.');
  for (const candidate of [job.specPath, job.workingCopyPath, job.outputRoot, job.resultPath, job.cancelPath]) {
    if (!inside(candidate, [job.runtimeRoot])) throw new Error('Auto-Pilot output escaped its private job folder.');
  }
  if (job.sourcePath && path.resolve(job.sourcePath) === path.resolve(job.workingCopyPath)) {
    throw new Error('Auto-Pilot must write a working copy, never the master scene.');
  }
  if (job.ollamaUrl) normalizeOllamaUrl(job.ollamaUrl);
  if (job.clothWithLtx) {
    if (!job.createRunnerPath || !job.comfyRoot || !job.sourceRunner || !job.outputPrefix) {
      throw new Error('LTX clothing needs the official Create runner, ComfyUI root, source runner, and output prefix.');
    }
  }
  if (job.soundtrackPath && !inside(job.soundtrackPath, [job.runtimeRoot])) {
    throw new Error('Auto-Pilot soundtrack is outside the private job folder.');
  }
  return job;
}

export function createAutopilotManifest(job, result = {}) {
  validateAutopilotJob(job);
  const frameCount = job.frameEnd - job.frameStart + 1;
  return {
    schemaVersion: AUTOPILOT_SCHEMA_VERSION,
    kind: 'ltx-watch-blender-autopilot',
    animationAuthority: 'blender',
    refinementAuthority: 'appearance-only',
    preset: job.preset,
    source: {
      seedPath: job.sourcePath || null,
      workingCopyPath: job.workingCopyPath,
      specPath: job.specPath,
    },
    timeline: { frameStart: job.frameStart, frameEnd: job.frameEnd, frameCount, frameRate: job.frameRate },
    resolution: { width: job.width, height: job.height },
    identities: result.identities || [],
    passes: [
      { id: 'beauty', format: 'PNG', pattern: 'beauty/frame_####.png', frameCount },
      { id: 'camera', format: 'JSON Lines', pattern: 'camera.jsonl', frameCount },
      { id: 'first-frame', format: 'PNG', pattern: 'anchors/first.png', frameCount: 1 },
      { id: 'last-frame', format: 'PNG', pattern: 'anchors/last.png', frameCount: 1 },
    ],
    blender: result.blender || null,
    planner: result.planner || null,
    createdAt: result.createdAt || new Date().toISOString(),
    compatibility: {
      ltxVersion: '2.5',
      clothMode: job.clothWithLtx ? 'official-flf2v' : 'backbone-only',
      refinementReady: false,
      reason: 'LTX clothing uses official first/last-frame appearance interpolation. It is not a verified physics-pass consumer; Blender still owns camera and blocking.',
    },
  };
}

export function plannerSystemPrompt() {
  return [
    'You are the local scene planner for LTX Watch Blender Auto-Pilot.',
    'Return ONLY valid JSON for kind "blender-autopilot-scene".',
    `Allowed primitives: ${AUTOPILOT_PRIMITIVES.join(', ')}.`,
    `Allowed camera types: ${AUTOPILOT_CAMERAS.join(', ')}.`,
    `Allowed worlds: ${AUTOPILOT_WORLDS.join(', ')}.`,
    'Do not emit Python, Blender bpy, shell, or file paths.',
    'Keep object count at 24 or fewer. Keep identities at 12 or fewer.',
    'Use identities to lock character and object consistency for later LTX clothing.',
    'Blender will own camera, layout, and large motion. LTX may only clothe appearance and add smaller animation.',
  ].join(' ');
}
