import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseShotRange, sceneKey } from './studio-core.mjs';

export const PROJECT_SCHEMA_VERSION = 2;
export const PROJECT_FILE_LIMIT = 12_000;
export const CONTINUITY_ELEMENT_LIMIT = 120;
export const LONG_SCENE_LIMIT = 200;
export const LONG_SCENE_CLIP_LIMIT = 500;

const EXTENSION_KIND = new Map([
  ['.mp4', 'video'], ['.webm', 'video'], ['.mov', 'video'], ['.mkv', 'video'], ['.avi', 'video'],
  ['.png', 'image'], ['.jpg', 'image'], ['.jpeg', 'image'], ['.webp', 'image'], ['.exr', 'image'], ['.tif', 'image'], ['.tiff', 'image'],
  ['.wav', 'audio'], ['.mp3', 'audio'], ['.flac', 'audio'], ['.m4a', 'audio'], ['.ogg', 'audio'],
  ['.txt', 'text'], ['.md', 'text'], ['.rtf', 'text'], ['.srt', 'text'], ['.vtt', 'text'], ['.csv', 'text'],
  ['.json', 'data'], ['.yaml', 'data'], ['.yml', 'data'], ['.toml', 'data'],
  ['.blend', 'scene3d'], ['.fbx', 'scene3d'], ['.obj', 'scene3d'], ['.gltf', 'scene3d'], ['.glb', 'scene3d'], ['.usd', 'scene3d'], ['.usda', 'scene3d'], ['.usdc', 'scene3d'],
]);

export function classifyProjectAsset(filename) {
  const extension = path.extname(String(filename || '')).toLowerCase();
  return { extension, kind: EXTENSION_KIND.get(extension) || 'other', supported: EXTENSION_KIND.has(extension) };
}

function cleanSceneSlug(value) {
  const normalized = String(value || '').replaceAll('\\', '/').split('/').filter(Boolean).pop() || '';
  return normalized.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160);
}

export function inferShotIdentity(relativePath) {
  const normalized = String(relativePath || '').replaceAll('\\', '/');
  const parsed = path.posix.parse(normalized);
  if (/(?:_full)?_concat$/i.test(parsed.name)) return null;
  const patterns = [
    /^(?:shot[_ .-]?)?(\d{1,6})(?:[_ .-]|$)/i,
    /(?:^|[_ .-])shot[_ .-]?(\d{1,6})(?:[_ .-]|$)/i,
  ];
  let match = null;
  for (const pattern of patterns) {
    match = parsed.name.match(pattern);
    if (match) break;
  }
  if (!match) return null;
  const width = Math.max(4, match[1].length);
  const shot = String(Number(match[1])).padStart(width, '0');
  const sceneSlug = cleanSceneSlug(parsed.dir);
  return {
    shot,
    sceneSlug: sceneSlug || null,
    shotKey: `${sceneSlug || 'unassigned'}/${shot}`,
  };
}

export function projectAssetId(fullPath) {
  return `asset-${createHash('sha256').update(path.resolve(String(fullPath || '')).toLowerCase()).digest('hex').slice(0, 20)}`;
}

export function createProjectsRecord() {
  return { version: PROJECT_SCHEMA_VERSION, selectedProjectId: null, projects: {}, updatedAt: null };
}

function boundedText(value, maximum) {
  return String(value || '').replace(/\0/g, '').replace(/\r\n?/g, '\n').trim().slice(0, maximum);
}

function cleanAssetIds(value, maximum = 24) {
  return Array.isArray(value) ? [...new Set(value.filter((item) => typeof item === 'string' && item.startsWith('asset-')))].slice(0, maximum) : [];
}

export function createContinuityBible() {
  return {
    premise: '',
    visualLanguage: '',
    invariants: '',
    negativeRules: '',
    elements: [],
    revision: 1,
    updatedAt: null,
  };
}

export function normalizeContinuityBible(input) {
  const fallback = createContinuityBible();
  if (!input || typeof input !== 'object') return fallback;
  const elements = Array.isArray(input.elements) ? input.elements.slice(0, CONTINUITY_ELEMENT_LIMIT).map((raw, index) => ({
    id: boundedText(raw?.id, 100).replace(/[^a-zA-Z0-9_-]/g, '') || `element-${index + 1}`,
    kind: ['character', 'location', 'prop', 'wardrobe', 'vehicle', 'style'].includes(raw?.kind) ? raw.kind : 'prop',
    name: boundedText(raw?.name, 120),
    description: boundedText(raw?.description, 2_000),
    referenceAssetIds: cleanAssetIds(raw?.referenceAssetIds),
    locked: raw?.locked !== false,
  })).filter((item) => item.name && item.description) : [];
  return {
    premise: boundedText(input.premise, 4_000),
    visualLanguage: boundedText(input.visualLanguage, 4_000),
    invariants: boundedText(input.invariants, 4_000),
    negativeRules: boundedText(input.negativeRules, 2_000),
    elements,
    revision: Math.max(1, Math.trunc(Number(input.revision) || fallback.revision)),
    updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : null,
  };
}

export function createLongScene(id, title = 'Untitled long scene') {
  const now = new Date().toISOString();
  return {
    id: boundedText(id, 100).replace(/[^a-zA-Z0-9_-]/g, '') || `scene-${Date.now()}`,
    title: boundedText(title, 160) || 'Untitled long scene',
    direction: '',
    ingredientsAssetId: null,
    status: 'planning',
    clips: [],
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeLongSceneClip(raw, index) {
  const status = ['planned', 'prepared', 'queued', 'generating', 'review', 'accepted', 'failed'].includes(raw?.status) ? raw.status : 'planned';
  return {
    id: boundedText(raw?.id, 100).replace(/[^a-zA-Z0-9_-]/g, '') || `clip-${index + 1}`,
    order: index + 1,
    title: boundedText(raw?.title, 160) || `Clip ${index + 1}`,
    prompt: boundedText(raw?.prompt, 4_000),
    duration: Math.min(20, Math.max(5, Math.trunc(Number(raw?.duration) || 8))),
    transition: raw?.transition === 'cut' ? 'cut' : 'continuous',
    status,
    createJobId: typeof raw?.createJobId === 'string' ? raw.createJobId : null,
    ingredientsReferencePath: typeof raw?.ingredientsReferencePath === 'string' ? raw.ingredientsReferencePath : null,
    continuityAnchorPath: typeof raw?.continuityAnchorPath === 'string' ? raw.continuityAnchorPath : null,
    outputPath: typeof raw?.outputPath === 'string' ? raw.outputPath : null,
    lastFramePath: typeof raw?.lastFramePath === 'string' ? raw.lastFramePath : null,
    error: boundedText(raw?.error, 1_000) || null,
    createdAt: typeof raw?.createdAt === 'string' ? raw.createdAt : null,
    updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null,
    acceptedAt: typeof raw?.acceptedAt === 'string' ? raw.acceptedAt : null,
  };
}

export function buildContinuityDirectorSegments(clipInput, hasPrevious = false) {
  const clip = normalizeLongSceneClip(clipInput, Math.max(0, Number(clipInput?.order || 1) - 1));
  const segments = [{
    id: 'continuity-establish',
    duration: 2,
    prompt: hasPrevious
      ? 'Hold the exact accepted ending state from the previous clip. Preserve pose, camera side, screen direction, lighting, wardrobe, props, damage, and environment before motion resumes.'
      : 'Hold a stable establishing composition that clearly presents the canonical project elements.',
  }];
  let remaining = clip.duration - 2;
  let actionIndex = 1;
  while (remaining > 0) {
    const duration = Math.min(10, remaining);
    segments.push({
      id: `continuity-action-${actionIndex}`,
      duration,
      prompt: actionIndex === 1 ? clip.prompt : `Continue the same uninterrupted action and trajectory: ${clip.prompt}`,
    });
    remaining -= duration;
    actionIndex += 1;
  }
  return segments;
}

export function normalizeLongScenes(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, LONG_SCENE_LIMIT).map((raw, index) => {
    const fallback = createLongScene(`scene-${index + 1}`);
    return {
      ...fallback,
      id: boundedText(raw?.id, 100).replace(/[^a-zA-Z0-9_-]/g, '') || fallback.id,
      title: boundedText(raw?.title, 160) || fallback.title,
      direction: boundedText(raw?.direction, 4_000),
      ingredientsAssetId: typeof raw?.ingredientsAssetId === 'string' && raw.ingredientsAssetId.startsWith('asset-') ? raw.ingredientsAssetId : null,
      status: ['planning', 'active', 'complete'].includes(raw?.status) ? raw.status : 'planning',
      clips: Array.isArray(raw?.clips) ? raw.clips.slice(0, LONG_SCENE_CLIP_LIMIT).map(normalizeLongSceneClip) : [],
      createdAt: typeof raw?.createdAt === 'string' ? raw.createdAt : fallback.createdAt,
      updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : fallback.updatedAt,
    };
  });
}

export function mergeLongSceneRuntimeState(incomingInput, existingInput) {
  const incoming = normalizeLongScenes(incomingInput);
  const existingScenes = new Map(normalizeLongScenes(existingInput).map((scene) => [scene.id, scene]));
  return incoming.map((scene) => {
    const existingClips = new Map((existingScenes.get(scene.id)?.clips || []).map((clip) => [clip.id, clip]));
    const clips = scene.clips.map((clip) => {
      const existing = existingClips.get(clip.id);
      return existing ? {
        ...clip,
        status: existing.status,
        createJobId: existing.createJobId,
        ingredientsReferencePath: existing.ingredientsReferencePath,
        continuityAnchorPath: existing.continuityAnchorPath,
        outputPath: existing.outputPath,
        lastFramePath: existing.lastFramePath,
        error: existing.error,
        acceptedAt: existing.acceptedAt,
      } : clip;
    });
    const status = clips.length && clips.every((clip) => clip.status === 'accepted')
      ? 'complete'
      : clips.some((clip) => clip.status !== 'planned') ? 'active' : 'planning';
    return { ...scene, clips, status };
  });
}

export function buildContinuityPrompt(bibleInput, sceneInput, clipInput, previousClip = null) {
  const bible = normalizeContinuityBible(bibleInput);
  const scene = normalizeLongScenes([sceneInput])[0];
  const clip = normalizeLongSceneClip(clipInput, Number(clipInput?.order || 1) - 1);
  if (!scene || !clip.prompt) throw new Error('The long-scene clip needs a direction prompt.');
  const parts = [
    bible.premise && `PROJECT PREMISE\n${bible.premise}`,
    bible.visualLanguage && `LOCKED VISUAL LANGUAGE\n${bible.visualLanguage}`,
    bible.invariants && `NON-NEGOTIABLE CONTINUITY\n${bible.invariants}`,
    bible.elements.length && `CANONICAL PROJECT ELEMENTS\n${bible.elements.map((item) => `- ${item.kind.toUpperCase()} — ${item.name}: ${item.description}${item.locked ? ' [LOCKED]' : ''}`).join('\n')}`,
    scene.direction && `LONG-SCENE DIRECTION\n${scene.direction}`,
    `CURRENT CLIP ${clip.order}: ${clip.title}\n${clip.prompt}`,
    previousClip?.status === 'accepted' && clip.transition === 'continuous' && 'CONTINUATION RULE\nContinue directly from the exact accepted ending of the previous clip. Preserve pose, screen direction, camera side, lens, lighting, weather, damage, wardrobe, prop state, and spatial relationships. Do not reset the scene or introduce a cut.',
    bible.negativeRules && `NEVER CHANGE OR INTRODUCE\n${bible.negativeRules}`,
  ];
  return parts.filter(Boolean).join('\n\n').slice(0, 8_000);
}

export function normalizeProjectsRecord(input) {
  const fallback = createProjectsRecord();
  if (!input || typeof input !== 'object') return fallback;
  const projects = {};
  for (const [id, raw] of Object.entries(input.projects && typeof input.projects === 'object' ? input.projects : {})) {
    if (!raw || typeof raw !== 'object' || typeof raw.rootPath !== 'string') continue;
    projects[id] = {
      id,
      name: String(raw.name || 'Untitled project').slice(0, 120),
      mode: raw.mode === 'managed' ? 'managed' : 'reference',
      rootPath: raw.rootPath,
      sourcePath: typeof raw.sourcePath === 'string' ? raw.sourcePath : raw.rootPath,
      uploadRoot: typeof raw.uploadRoot === 'string' ? raw.uploadRoot : null,
      blenderBackboneAssetId: typeof raw.blenderBackboneAssetId === 'string' ? raw.blenderBackboneAssetId : null,
      contextAssetIds: Array.isArray(raw.contextAssetIds) ? [...new Set(raw.contextAssetIds.filter((value) => typeof value === 'string'))].slice(0, 5_000) : [],
      continuityBible: normalizeContinuityBible(raw.continuityBible),
      longScenes: normalizeLongScenes(raw.longScenes),
      shots: raw.shots && typeof raw.shots === 'object' ? raw.shots : {},
      regenerationQueue: Array.isArray(raw.regenerationQueue) ? raw.regenerationQueue.filter((item) => item && typeof item === 'object').slice(-5_000) : [],
      queuePaused: Boolean(raw.queuePaused),
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    };
  }
  const selectedProjectId = typeof input.selectedProjectId === 'string' && projects[input.selectedProjectId]
    ? input.selectedProjectId
    : Object.keys(projects)[0] || null;
  return { ...fallback, ...input, version: PROJECT_SCHEMA_VERSION, selectedProjectId, projects };
}

function planLookup(planItems) {
  const bySlug = new Map();
  for (const item of planItems || []) {
    if (!item?.slug || !item?.section || !item?.track) continue;
    bySlug.set(String(item.slug).toLowerCase(), { ...item, sceneKey: sceneKey(item), shotSet: new Set(parseShotRange(item.shots, item.count)) });
  }
  return bySlug;
}

export function buildProjectShots(assets, savedShots = {}, planItems = []) {
  const groups = new Map();
  const plans = planLookup(planItems);
  for (const asset of assets || []) {
    const identity = asset.identity || inferShotIdentity(asset.relativePath || asset.name);
    if (!identity) continue;
    const current = groups.get(identity.shotKey) || {
      shotKey: identity.shotKey,
      shot: identity.shot,
      sceneSlug: identity.sceneSlug,
      title: identity.sceneSlug ? `${identity.sceneSlug.replace(/_full$/i, '').replaceAll('_', ' ')} · Shot ${identity.shot}` : `Shot ${identity.shot}`,
      versions: [],
    };
    current.versions.push(asset);
    groups.set(identity.shotKey, current);
  }

  return [...groups.values()].map((group) => {
    group.versions.sort((left, right) => Number(right.modifiedMs || 0) - Number(left.modifiedMs || 0));
    const saved = savedShots[group.shotKey] && typeof savedShots[group.shotKey] === 'object' ? savedShots[group.shotKey] : {};
    const mapped = group.sceneSlug ? plans.get(group.sceneSlug.toLowerCase()) : null;
    const regeneratable = Boolean(mapped?.shotSet.has(group.shot));
    const currentAsset = group.versions.find((asset) => asset.id === saved.currentAssetId) || group.versions.find((asset) => asset.kind === 'video') || group.versions[0] || null;
    const queueState = String(saved.queueState || '');
    return {
      ...group,
      currentAssetId: currentAsset?.id || null,
      status: queueState || (saved.acceptedAssetId ? 'accepted' : currentAsset?.kind === 'video' ? 'review' : 'missing'),
      acceptedAssetId: typeof saved.acceptedAssetId === 'string' ? saved.acceptedAssetId : null,
      contextAssetIds: Array.isArray(saved.contextAssetIds) ? [...new Set(saved.contextAssetIds.filter((value) => typeof value === 'string'))] : [],
      attempts: Array.isArray(saved.attempts) ? saved.attempts : [],
      mappedSceneKey: regeneratable ? mapped.sceneKey : null,
      mappedSection: regeneratable ? mapped.section : null,
      mappedTrack: regeneratable ? mapped.track : null,
      mappedSlug: regeneratable ? mapped.slug : null,
      regeneratable,
    };
  }).sort((left, right) => left.sceneSlug?.localeCompare(right.sceneSlug || '') || left.shot.localeCompare(right.shot, undefined, { numeric: true }));
}

export function mergeProjectPlanItems(activeItems = [], sourceItems = []) {
  const merged = new Map();
  for (const item of [...activeItems, ...sourceItems]) {
    if (!item?.section || !item?.track || !item?.slug || !parseShotRange(item.shots, item.count).length) continue;
    merged.set(`${String(item.section).toLowerCase()}/${String(item.slug).toLowerCase()}`, item);
  }
  return [...merged.values()];
}

export function safeUploadRelativePath(value) {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter((part) => part && part !== '.');
  if (!parts.length || parts.some((part) => part === '..' || /[<>:"|?*\0]/.test(part))) throw new Error('The uploaded file path is invalid.');
  return parts.slice(-12).join('/');
}

export function enqueueProjectShots(project, availableShots, shotKeys, correction, idFactory = () => `regen-${Date.now()}`) {
  const byKey = new Map((availableShots || []).map((shot) => [shot.shotKey, shot]));
  const existing = new Set((project.regenerationQueue || []).filter((item) => ['queued', 'generating'].includes(item.status)).map((item) => item.shotKey));
  const added = [];
  for (const shotKey of [...new Set((shotKeys || []).map(String))]) {
    const shot = byKey.get(shotKey);
    if (!shot?.regeneratable || existing.has(shotKey)) continue;
    const item = {
      id: idFactory(),
      shotKey,
      sceneKey: shot.mappedSceneKey,
      section: shot.mappedSection,
      track: shot.mappedTrack,
      slug: shot.mappedSlug,
      shot: shot.shot,
      correction,
      status: 'queued',
      queuedAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      attemptId: null,
      outputPath: null,
      error: null,
    };
    project.regenerationQueue.push(item);
    existing.add(shotKey);
    added.push(item);
  }
  return added;
}
