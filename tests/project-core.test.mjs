import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildProjectShots,
  classifyProjectAsset,
  createProjectsRecord,
  enqueueProjectShots,
  inferShotIdentity,
  mergeProjectPlanItems,
  normalizeProjectsRecord,
  safeUploadRelativePath,
} from '../project-core.mjs';

test('project assets recognize Blender and production context formats', () => {
  assert.deepEqual(classifyProjectAsset('master_camera.blend'), { extension: '.blend', kind: 'scene3d', supported: true });
  assert.deepEqual(classifyProjectAsset('camera.usdc'), { extension: '.usdc', kind: 'scene3d', supported: true });
  assert.equal(classifyProjectAsset('notes.md').kind, 'text');
  assert.equal(classifyProjectAsset('installer.exe').supported, false);
});

test('shot identity preserves the scene folder and normalizes shot numbers', () => {
  assert.deepEqual(inferShotIdentity('01_iron_genesis/shot-23-v2.mp4'), {
    shot: '0023',
    sceneSlug: '01_iron_genesis',
    shotKey: '01_iron_genesis/0023',
  });
  assert.equal(inferShotIdentity('references/character.png'), null);
  assert.equal(inferShotIdentity('02_automate_full_concat.mp4'), null);
});

test('shot library maps only shots represented by the configured LTX plan', () => {
  const assets = [{ id: 'asset-1', name: '0023_preview.mp4', relativePath: 'scene_alpha/0023_preview.mp4', kind: 'video', modifiedMs: 2 }];
  const plan = [{ section: '01', track: 'Scene Alpha', slug: 'scene_alpha', shots: '0022-0024', count: 3 }];
  const [shot] = buildProjectShots(assets, {}, plan);
  assert.equal(shot.shotKey, 'scene_alpha/0023');
  assert.equal(shot.regeneratable, true);
  assert.equal(shot.mappedSlug, 'scene_alpha');
  assert.equal(shot.status, 'review');
});

test('regeneration queue rejects duplicates and unmapped shots', () => {
  const project = { regenerationQueue: [] };
  const shots = [
    { shotKey: 'scene/0001', regeneratable: true, mappedSceneKey: '01/scene', mappedSection: '01', mappedTrack: 'Scene', mappedSlug: 'scene', shot: '0001' },
    { shotKey: 'unassigned/0002', regeneratable: false },
  ];
  let counter = 0;
  const first = enqueueProjectShots(project, shots, ['scene/0001', 'unassigned/0002'], 'more stable', () => `regen-${++counter}`);
  const second = enqueueProjectShots(project, shots, ['scene/0001'], 'again', () => `regen-${++counter}`);
  assert.equal(first.length, 1);
  assert.equal(first[0].correction, 'more stable');
  assert.equal(second.length, 0);
});

test('project mapping supplements the active queue with completed source scenes', () => {
  const active = [{ section: 'album', track: 'New Scene', slug: 'new_scene_full', shots: '0200-0201', count: 2 }];
  const source = [
    { section: 'album', track: 'Old Scene', slug: 'old_scene_full', shots: '0093,0094', count: 2 },
    { section: 'album', track: 'New Scene', slug: 'new_scene_full', shots: '0200,0201', count: 2 },
  ];
  const merged = mergeProjectPlanItems(active, source);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((item) => item.slug === 'old_scene_full').shots, '0093,0094');
});

test('project state and upload paths are normalized defensively', () => {
  const empty = createProjectsRecord();
  assert.equal(normalizeProjectsRecord(empty).selectedProjectId, null);
  assert.equal(safeUploadRelativePath('references\\look\\hero.png'), 'references/look/hero.png');
  assert.throws(() => safeUploadRelativePath('../escape.blend'), /invalid/i);
});
