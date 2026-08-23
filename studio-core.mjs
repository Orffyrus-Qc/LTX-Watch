export const STUDIO_SCHEMA_VERSION = 1;

export function sceneKey(item) {
  return `${String(item?.section || '').trim()}/${String(item?.slug || '').trim()}`;
}

export function parseShotRange(value, expectedCount = 0) {
  const input = String(value || '').trim();
  if (!input) return [];
  const result = [];
  for (const part of input.split(',')) {
    const token = part.trim();
    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start || end - start > 2_000) return [];
      const width = Math.max(range[1].length, range[2].length);
      for (let shot = start; shot <= end; shot += 1) result.push(String(shot).padStart(width, '0'));
      continue;
    }
    if (!/^\d+$/.test(token)) return [];
    result.push(token);
  }
  const unique = [...new Set(result)];
  if (expectedCount > 0 && unique.length !== Number(expectedCount)) return [];
  return unique;
}

export function normalizeQueueOrder(items, savedOrder = []) {
  const uniqueItems = [];
  const byKey = new Map();
  for (const item of items || []) {
    const key = sceneKey(item);
    if (!key || key === '/' || byKey.has(key)) continue;
    const normalized = { ...item, sceneKey: key };
    byKey.set(key, normalized);
    uniqueItems.push(normalized);
  }
  const ordered = [];
  for (const key of savedOrder || []) {
    const item = byKey.get(key);
    if (!item) continue;
    ordered.push(item);
    byKey.delete(key);
  }
  for (const item of uniqueItems) {
    if (!byKey.has(item.sceneKey)) continue;
    ordered.push(item);
    byKey.delete(item.sceneKey);
  }
  return ordered.map((item, index) => ({ ...item, position: index + 1 }));
}

export function moveSceneFirst(items, savedOrder, targetKey) {
  const normalized = normalizeQueueOrder(items, savedOrder);
  if (!normalized.some((item) => item.sceneKey === targetKey)) throw new Error('The selected scene is not in the Studio queue.');
  return [targetKey, ...normalized.map((item) => item.sceneKey).filter((key) => key !== targetKey)];
}

export function createStudioRecord() {
  return {
    version: STUDIO_SCHEMA_VERSION,
    queueOrder: [],
    selectedSceneKey: null,
    scenes: {},
    activeJob: null,
    updatedAt: null,
  };
}

export function normalizeStudioRecord(input) {
  const fallback = createStudioRecord();
  if (!input || typeof input !== 'object') return fallback;
  return {
    ...fallback,
    ...input,
    version: STUDIO_SCHEMA_VERSION,
    queueOrder: Array.isArray(input.queueOrder) ? input.queueOrder.filter((key) => typeof key === 'string').slice(0, 2_000) : [],
    selectedSceneKey: typeof input.selectedSceneKey === 'string' ? input.selectedSceneKey : null,
    scenes: input.scenes && typeof input.scenes === 'object' ? input.scenes : {},
    activeJob: input.activeJob && typeof input.activeJob === 'object' ? input.activeJob : null,
  };
}

export function ensureSceneRecord(record, item) {
  const key = sceneKey(item);
  if (!record.scenes[key] || typeof record.scenes[key] !== 'object') {
    record.scenes[key] = {
      sceneKey: key,
      section: item.section,
      track: item.track,
      slug: item.slug,
      currentShot: null,
      acceptedShots: [],
      attempts: {},
      status: 'queued',
      updatedAt: null,
    };
  }
  const scene = record.scenes[key];
  scene.acceptedShots = Array.isArray(scene.acceptedShots) ? [...new Set(scene.acceptedShots.map(String))] : [];
  scene.attempts = scene.attempts && typeof scene.attempts === 'object' ? scene.attempts : {};
  return scene;
}

export function nextUnacceptedShot(shots, acceptedShots) {
  const accepted = new Set((acceptedShots || []).map(String));
  return (shots || []).find((shot) => !accepted.has(String(shot))) || null;
}

export function cleanCorrection(value, limit = 2_000) {
  const normalized = String(value || '').replace(/\0/g, '').replace(/\r\n?/g, '\n').trim();
  if (normalized.length > limit) throw new Error(`Correction notes must be ${limit} characters or fewer.`);
  return normalized;
}
