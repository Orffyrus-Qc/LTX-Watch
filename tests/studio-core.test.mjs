import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cleanCorrection,
  createStudioRecord,
  ensureSceneRecord,
  moveSceneFirst,
  nextUnacceptedShot,
  normalizeQueueOrder,
  parseShotRange,
  sceneKey,
} from '../studio-core.mjs';

const queue = [
  { section: 'album', track: 'Scene One', slug: 'scene_one_full', shots: '0001-0003', count: 3 },
  { section: 'album', track: 'Scene Two', slug: 'scene_two_full', shots: '0004-0005', count: 2 },
  { section: 'album', track: 'Scene Three', slug: 'scene_three_full', shots: '0006', count: 1 },
];

test('shot ranges retain padding and validate count', () => {
  assert.deepEqual(parseShotRange('0007-0009', 3), ['0007', '0008', '0009']);
  assert.deepEqual(parseShotRange('0007,0009', 2), ['0007', '0009']);
  assert.deepEqual(parseShotRange('0009-0007'), []);
  assert.deepEqual(parseShotRange('0007-0009', 2), []);
});

test('saved queue order is normalized and move-first is stable', () => {
  const key = sceneKey(queue[2]);
  const moved = moveSceneFirst(queue, [], key);
  assert.deepEqual(moved, [key, sceneKey(queue[0]), sceneKey(queue[1])]);
  assert.deepEqual(normalizeQueueOrder(queue, moved).map((item) => item.sceneKey), moved);
});

test('scene records and acceptance progression are deterministic', () => {
  const record = createStudioRecord();
  const scene = ensureSceneRecord(record, queue[0]);
  scene.acceptedShots.push('0001');
  assert.equal(nextUnacceptedShot(parseShotRange(queue[0].shots), scene.acceptedShots), '0002');
  assert.equal(ensureSceneRecord(record, queue[0]), scene);
});

test('correction notes are normalized and bounded', () => {
  assert.equal(cleanCorrection('  pan slower\r\nkeep the face stable  '), 'pan slower\nkeep the face stable');
  assert.throws(() => cleanCorrection('x'.repeat(2001)), /2000/);
});
