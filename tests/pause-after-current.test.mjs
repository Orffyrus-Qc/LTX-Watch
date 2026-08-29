import assert from 'node:assert/strict';
import test from 'node:test';
import { resolvePauseAfterCurrent, withPauseAfterCurrent } from '../lib/pause-after-current.mjs';

const running = { state: 'running', canControl: true, workerPids: [101] };
const idle = { state: 'running', canControl: false, workerPids: [] };
const paused = { state: 'paused', canControl: true, workerPids: [101] };

test('idle when the drain flag is off', () => {
  assert.deepEqual(resolvePauseAfterCurrent({ pauseAfterCurrent: false }, 'track-a', running), { type: 'idle' });
});

test('keeps waiting while the armed job is still current', () => {
  assert.deepEqual(
    resolvePauseAfterCurrent({ pauseAfterCurrent: true, pauseAfterCurrentSlug: 'track-a' }, 'track-a', running),
    { type: 'keep' },
  );
});

test('pauses after the armed job leaves the current slot', () => {
  assert.deepEqual(
    resolvePauseAfterCurrent({ pauseAfterCurrent: true, pauseAfterCurrentSlug: 'track-a' }, null, running),
    { type: 'pause' },
  );
  assert.deepEqual(
    resolvePauseAfterCurrent({ pauseAfterCurrent: true, pauseAfterCurrentSlug: 'track-a' }, 'track-b', running),
    { type: 'pause' },
  );
});

test('clears the drain flag when the worker is already paused or gone', () => {
  assert.deepEqual(
    resolvePauseAfterCurrent({ pauseAfterCurrent: true, pauseAfterCurrentSlug: 'track-a' }, null, paused),
    { type: 'clear' },
  );
  assert.deepEqual(
    resolvePauseAfterCurrent({ pauseAfterCurrent: true, pauseAfterCurrentSlug: 'track-a' }, null, idle),
    { type: 'clear' },
  );
});

test('binds the current slug if arming happened between jobs', () => {
  assert.deepEqual(
    resolvePauseAfterCurrent({ pauseAfterCurrent: true, pauseAfterCurrentSlug: null }, 'track-a', running),
    { type: 'bind', slug: 'track-a' },
  );
});

test('withPauseAfterCurrent writes a bounded drain record', () => {
  const next = withPauseAfterCurrent({ mode: 'running' }, { armed: true, slug: 'track-a' });
  assert.equal(next.pauseAfterCurrent, true);
  assert.equal(next.pauseAfterCurrentSlug, 'track-a');
  assert.equal(withPauseAfterCurrent(next, { armed: false }).pauseAfterCurrent, false);
  assert.equal(withPauseAfterCurrent(next, { armed: false }).pauseAfterCurrentSlug, null);
});
