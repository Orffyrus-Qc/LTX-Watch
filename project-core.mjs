import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseShotRange, sceneKey } from './studio-core.mjs';

export const PROJECT_SCHEMA_VERSION = 1;
export const PROJECT_FILE_LIMIT = 12_000;

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
