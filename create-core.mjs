export const CREATE_SCHEMA_VERSION = 1;
export const CREATE_PROMPT_LIMIT = 8_000;
export const CREATE_BATCH_LIMIT = 4;

const RESOLUTIONS = new Map([
  ['960x544', { width: 960, height: 544, label: '960 × 544 · faster' }],
  ['1280x736', { width: 1280, height: 736, label: '1280 × 736 · balanced' }],
  ['1920x1088', { width: 1920, height: 1088, label: '1920 × 1088 · high detail' }],
  ['736x1280', { width: 736, height: 1280, label: '736 × 1280 · portrait' }],
]);

const CAMERA_GUIDANCE = {
  none: '',
  locked: 'Camera: locked-off tripod shot with a stable horizon and no camera movement.',
  dolly_in: 'Camera: a smooth, deliberate dolly-in with stable framing and cinematic parallax.',
  dolly_out: 'Camera: a smooth dolly-out that gradually reveals the environment.',
  orbit: 'Camera: a controlled cinematic orbit around the main subject while preserving screen direction.',
  tracking: 'Camera: a smooth tracking shot that follows the subject at a consistent distance.',
  handheld: 'Camera: subtle natural handheld movement, physically plausible and never chaotic.',
  aerial: 'Camera: a wide aerial glide with slow, stable movement and clear geography.',
};

const MOTION_GUIDANCE = {
  subtle: 'Motion: restrained, physically plausible movement with strong temporal consistency.',
  balanced: 'Motion: natural cinematic movement with clear subject action and temporal consistency.',
  dynamic: 'Motion: energetic but coherent action, readable silhouettes, and physically plausible momentum.',
};

const STYLE_GUIDANCE = {
  cinematic: 'Look: cinematic lighting, detailed materials, controlled contrast, and coherent color grading.',
  documentary: 'Look: grounded documentary realism, available light, authentic texture, and natural timing.',
  animation: 'Look: polished animated-film art direction with consistent shapes, materials, and color design.',
  product: 'Look: premium product cinematography, precise reflections, clean staging, and crisp detail.',
  custom: '',
};

function text(value, limit, label) {
  const normalized = String(value || '').replace(/\0/g, '').replace(/\r\n?/g, '\n').trim();
  if (normalized.length > limit) throw new Error(`${label} must be ${limit} characters or fewer.`);
  return normalized;
}

function boundedInteger(value, minimum, maximum, fallback, label) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number)) return fallback;
  if (number < minimum || number > maximum) throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  return number;
}

export function resolutionOptions() {
  return [...RESOLUTIONS.entries()].map(([id, value]) => ({ id, ...value }));
}

export function createDefaultDraft() {
  return {
    title: '',
    prompt: '',
    avoid: '',
    resolution: '1280x736',
    duration: 5,
    frameRate: 24,
    seedMode: 'random',
    seed: 42,
    variations: 1,
    promptEnhance: false,
    camera: 'none',
    motion: 'balanced',
    style: 'cinematic',
    customStyle: '',
    audio: 'generate',
    referenceMode: 'text',
    firstFramePath: '',
    lastFramePath: '',
    contextVideoPath: '',
    soundtrackPath: '',
    useBlender: false,
    blenderProjectId: '',
    blenderUploadPath: '',
    blenderFirstFrame: 1,
    blenderLastFrame: 120,
    contextAssets: [],
  };
}

export function cleanCreateDraft(input = {}) {
  const fallback = createDefaultDraft();
  const limits = { title: 120, prompt: CREATE_PROMPT_LIMIT, avoid: 1_000, customStyle: 600, firstFramePath: 1_000, lastFramePath: 1_000, contextVideoPath: 1_000, soundtrackPath: 1_000, blenderProjectId: 160, blenderUploadPath: 1_000 };
  const draft = {};
  for (const [key, defaultValue] of Object.entries(fallback)) {
    const value = input && typeof input === 'object' ? input[key] : undefined;
    if (Array.isArray(defaultValue)) draft[key] = Array.isArray(value) ? value.filter((item) => item && typeof item === 'object').slice(0, 24).map((item) => ({
      id: String(item.id || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80),
      name: String(item.name || '').replace(/\0/g, '').slice(0, 180),
      kind: ['image', 'video', 'audio', 'blend'].includes(item.kind) ? item.kind : 'unknown',
      path: String(item.path || '').replace(/\0/g, '').slice(0, 1_000),
      size: Math.max(0, Number(item.size) || 0),
    })).filter((item) => item.id && item.name && item.path && item.kind !== 'unknown') : [];
    else if (typeof defaultValue === 'string') draft[key] = typeof value === 'string' ? value.replace(/\0/g, '').slice(0, limits[key] || 80) : defaultValue;
    else if (typeof defaultValue === 'boolean') draft[key] = typeof value === 'boolean' ? value : defaultValue;
    else draft[key] = Number.isFinite(Number(value)) ? Number(value) : defaultValue;
  }
  return draft;
}

export function normalizeCreateOptions(input = {}) {
  const fallback = createDefaultDraft();
  const resolution = RESOLUTIONS.has(input.resolution) ? input.resolution : fallback.resolution;
  const seedMode = input.seedMode === 'fixed' ? 'fixed' : 'random';
  const referenceMode = ['text', 'first-frame', 'first-last'].includes(input.referenceMode) ? input.referenceMode : 'text';
  const camera = Object.hasOwn(CAMERA_GUIDANCE, input.camera) ? input.camera : fallback.camera;
  const motion = Object.hasOwn(MOTION_GUIDANCE, input.motion) ? input.motion : fallback.motion;
  const style = Object.hasOwn(STYLE_GUIDANCE, input.style) ? input.style : fallback.style;
  const audio = ['generate', 'ambient', 'silent', 'soundtrack'].includes(input.audio) ? input.audio : fallback.audio;
  const result = {
    title: text(input.title, 120, 'Title'),
    prompt: text(input.prompt, CREATE_PROMPT_LIMIT, 'Prompt'),
    avoid: text(input.avoid, 1_000, 'Avoid notes'),
    resolution,
    ...RESOLUTIONS.get(resolution),
    duration: boundedInteger(input.duration, 3, 20, fallback.duration, 'Duration'),
    frameRate: boundedInteger(input.frameRate, 12, 30, fallback.frameRate, 'Frame rate'),
    seedMode,
    seed: boundedInteger(input.seed, 0, 2_147_483_647, fallback.seed, 'Seed'),
    variations: boundedInteger(input.variations, 1, CREATE_BATCH_LIMIT, fallback.variations, 'Variations'),
    promptEnhance: input.promptEnhance === true,
    camera,
    motion,
    style,
    customStyle: text(input.customStyle, 600, 'Custom style'),
    audio,
    referenceMode,
    firstFramePath: text(input.firstFramePath, 1_000, 'First-frame path'),
    lastFramePath: text(input.lastFramePath, 1_000, 'Last-frame path'),
    contextVideoPath: text(input.contextVideoPath, 1_000, 'Context-video path'),
    soundtrackPath: text(input.soundtrackPath, 1_000, 'Soundtrack path'),
    useBlender: input.useBlender === true,
    blenderProjectId: text(input.blenderProjectId, 160, 'Blender project id'),
    blenderUploadPath: text(input.blenderUploadPath, 1_000, 'Uploaded Blender path'),
    blenderFirstFrame: boundedInteger(input.blenderFirstFrame, 1, 1_000_000, fallback.blenderFirstFrame, 'Blender first frame'),
    blenderLastFrame: boundedInteger(input.blenderLastFrame, 1, 1_000_000, fallback.blenderLastFrame, 'Blender last frame'),
    contextAssets: cleanCreateDraft(input).contextAssets,
  };
  if (!result.prompt) throw new Error('Describe the video you want to create.');
  if (result.style === 'custom' && !result.customStyle) throw new Error('Add a custom visual style or choose a preset.');
  if (!result.useBlender && result.referenceMode !== 'text' && !result.firstFramePath && !result.contextVideoPath) throw new Error('A first reference image or context video is required for this mode.');
  if (!result.useBlender && result.referenceMode === 'first-last' && !result.lastFramePath && !result.contextVideoPath) throw new Error('A last reference image or context video is required for first/last-frame mode.');
  if (result.useBlender && !result.blenderProjectId && !result.blenderUploadPath) throw new Error('Choose a project backbone or drop a .blend file.');
  if (result.audio === 'soundtrack' && !result.soundtrackPath) throw new Error('Drop an audio file before selecting the context soundtrack.');
  if (result.useBlender && result.blenderLastFrame < result.blenderFirstFrame) throw new Error('The Blender last frame must be after the first frame.');
  return result;
}

export function composeCreatePrompt(options) {
  const parts = [options.prompt];
  if (CAMERA_GUIDANCE[options.camera]) parts.push(CAMERA_GUIDANCE[options.camera]);
  if (MOTION_GUIDANCE[options.motion]) parts.push(MOTION_GUIDANCE[options.motion]);
  const style = options.style === 'custom' ? options.customStyle : STYLE_GUIDANCE[options.style];
  if (style) parts.push(style);
  if (options.audio === 'generate') parts.push('Audio: generate synchronized, scene-appropriate sound with no narration unless explicitly requested.');
  if (options.audio === 'ambient') parts.push('Audio: synchronized ambient sound and effects only; no dialogue, speech, lyrics, or narration.');
  if (options.audio === 'silent') parts.push('Audio: silent output; no dialogue, music, ambience, or sound effects.');
  if (options.audio === 'soundtrack') parts.push('Audio: the final soundtrack is supplied separately; prioritize visual rhythm and do not generate dialogue or narration.');
  if (options.avoid) parts.push(`Avoid: ${options.avoid}. Do not depict these elements as dialogue, narration, signage, captions, or visible text.`);
  return parts.filter(Boolean).join('\n\n');
}

export function createJobSeeds(options, random = () => Math.floor(Math.random() * 2_147_483_647)) {
  const base = options.seedMode === 'fixed' ? options.seed : random();
  return Array.from({ length: options.variations }, (_, index) => (base + index) % 2_147_483_648);
}

export function createCreateRecord() {
  return {
    version: CREATE_SCHEMA_VERSION,
    draft: createDefaultDraft(),
    queue: [],
    jobs: {},
    activeJobId: null,
    queuePaused: false,
    updatedAt: null,
  };
}

export function normalizeCreateRecord(input) {
  const fallback = createCreateRecord();
  if (!input || typeof input !== 'object') return fallback;
  const jobs = input.jobs && typeof input.jobs === 'object' ? input.jobs : {};
  return {
    ...fallback,
    ...input,
    version: CREATE_SCHEMA_VERSION,
    draft: cleanCreateDraft(input.draft),
    queue: Array.isArray(input.queue) ? input.queue.filter((id) => typeof id === 'string' && jobs[id]).slice(0, 100) : [],
    jobs,
    activeJobId: typeof input.activeJobId === 'string' && jobs[input.activeJobId] ? input.activeJobId : null,
    queuePaused: input.queuePaused === true,
  };
}

export function safeCreateTitle(value, id) {
  const title = text(value, 120, 'Title');
  return title || `Untitled creation ${String(id || '').slice(0, 6)}`;
}
