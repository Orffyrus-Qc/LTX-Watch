import assert from 'node:assert/strict';
import test from 'node:test';
import { averageStudioShotSeconds, samplerSnapshot, studioJobProgress } from '../lib/studio-progress.mjs';

const runnerLog = [
  '[2026-08-23 16:22:53] === scene_full/0093: attempt 1/3, fresh server gpu=0 port=8188 safer=False (duration=25s) ===',
  '[2026-08-23 16:34:23] === scene_full/0093: completed gpu=0 ===',
].join('\n');

test('Studio progress learns its expected duration from completed attempts', () => {
  assert.equal(averageStudioShotSeconds(runnerLog), 690);
});

test('Studio progress detects sampler passes without moving backward on a reset', () => {
  const snapshot = samplerSnapshot('0%| 0/8\r50%| 4/8\r100%| 8/8\n0%| 0/3\r33%| 1/3');
  assert.deepEqual(snapshot, { pass: 1, percentage: 33 });
  const progress = studioJobProgress({
    runnerLog,
    serverLog: 'got prompt\n0%| 0/8\r100%| 8/8\n0%| 0/3\r33%| 1/3',
    startedAt: '2026-08-23T20:40:00Z',
    now: new Date('2026-08-23T20:44:00Z').getTime(),
  });
  assert.equal(progress.stage, 'Refining frames');
  assert.ok(progress.progress >= 65 && progress.progress <= 70);
  assert.equal(progress.remainingSeconds, 450);
});

test('Studio progress preserves the previous high-water mark', () => {
  const progress = studioJobProgress({
    runnerLog: '',
    serverLog: 'Starting server',
    startedAt: new Date().toISOString(),
    previousProgress: 72,
  });
  assert.equal(progress.progress, 72);
});
