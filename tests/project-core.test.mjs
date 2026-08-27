import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildContinuityDirectorSegments,
  buildContinuityPrompt,
  buildProjectShots,
  classifyProjectAsset,
  createProjectsRecord,
  enqueueProjectShots,
  inferShotIdentity,
  mergeProjectPlanItems,
  mergeLongSceneRuntimeState,
  normalizeContinuityBible,
  normalizeLongScenes,
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

test('continuity memory normalizes canonical elements and persisted long scenes defensively', () => {
  const bible = normalizeContinuityBible({
    premise: 'A permanent orbital city.',
    elements: [
      { id: 'hero<script>', kind: 'character', name: 'Mara', description: 'Short silver hair, blue pressure suit.', referenceAssetIds: ['asset-hero', '../bad'], locked: true },
      { id: 'unfinished', kind: 'character', name: '', description: '' },
    ],
  });
  assert.equal(bible.elements.length, 1);
  assert.equal(bible.elements[0].id, 'heroscript');
  assert.deepEqual(bible.elements[0].referenceAssetIds, ['asset-hero']);

  const [scene] = normalizeLongScenes([{ id: '../scene-one', title: 'Chase', clips: [
    { id: 'a', prompt: 'She runs.', duration: 2, status: 'nonsense' },
    { id: 'b', prompt: 'She turns.', duration: 99, status: 'accepted', lastFramePath: 'local/ending.png' },
  ] }]);
  assert.equal(scene.id, 'scene-one');
  assert.equal(scene.clips[0].duration, 5);
  assert.equal(scene.clips[0].status, 'planned');
  assert.equal(scene.clips[1].duration, 20);
  assert.equal(scene.clips[1].lastFramePath, 'local/ending.png');
});

test('continuity prompt carries canonical identity and accepted-ending rules', () => {
  const prompt = buildContinuityPrompt(
    {
      premise: 'A grounded near-future film.',
      visualLanguage: 'Anamorphic 40 mm, blue hour.',
      invariants: 'Mara always wears the same blue suit.',
      negativeRules: 'No costume changes.',
      elements: [{ id: 'mara', kind: 'character', name: 'Mara', description: 'Short silver hair and a blue pressure suit.', locked: true }],
    },
    { id: 'scene-one', title: 'Hangar', direction: 'Camera remains on the east side.', clips: [] },
    { id: 'clip-two', order: 2, title: 'Door opens', prompt: 'Mara opens the pressure door.', duration: 8, transition: 'continuous' },
    { id: 'clip-one', status: 'accepted' },
  );
  assert.match(prompt, /CANONICAL PROJECT ELEMENTS/);
  assert.match(prompt, /Mara: Short silver hair and a blue pressure suit\. \[LOCKED\]/);
  assert.match(prompt, /Continue directly from the exact accepted ending/);
  assert.match(prompt, /No costume changes/);
});

test('continuity Director segments stay within workflow bounds and preserve total duration', () => {
  const segments = buildContinuityDirectorSegments({ order: 4, prompt: 'The rover crosses the bridge.', duration: 20 }, true);
  assert.equal(segments.reduce((total, segment) => total + segment.duration, 0), 20);
  assert.equal(segments.length, 3);
  assert.ok(segments.every((segment) => segment.duration >= 1 && segment.duration <= 10));
  assert.match(segments[0].prompt, /accepted ending state/);
  assert.match(segments[2].prompt, /Continue the same uninterrupted action/);
});

test('long-scene creative saves preserve newer server-owned render state', () => {
  const incoming = [{ id: 'scene-a', title: 'Edited title', clips: [
    { id: 'clip-a', title: 'Edited clip', prompt: 'New direction.', duration: 9, status: 'planned' },
    { id: 'clip-b', title: 'New continuation', prompt: 'Keep moving.', duration: 8, status: 'planned' },
  ] }];
  const existing = [{ id: 'scene-a', title: 'Old title', status: 'complete', clips: [{
    id: 'clip-a', title: 'Old clip', prompt: 'Old direction.', duration: 8, status: 'accepted', createJobId: 'create-1', outputPath: 'output.mp4', lastFramePath: 'ending.png', acceptedAt: 'now',
  }] }];
  const [scene] = mergeLongSceneRuntimeState(incoming, existing);
  assert.equal(scene.title, 'Edited title');
  assert.equal(scene.clips[0].prompt, 'New direction.');
  assert.equal(scene.clips[0].status, 'accepted');
  assert.equal(scene.clips[0].createJobId, 'create-1');
  assert.equal(scene.clips[0].lastFramePath, 'ending.png');
  assert.equal(scene.clips[1].status, 'planned');
  assert.equal(scene.status, 'active');
});
