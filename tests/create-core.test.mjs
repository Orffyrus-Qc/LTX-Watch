import assert from 'node:assert/strict';
import test from 'node:test';
import {
  composeCreatePrompt,
  createDefaultDraft,
  createJobSeeds,
  normalizeCreateOptions,
  normalizeCreateRecord,
  resolutionOptions,
} from '../create-core.mjs';

test('Create options normalize a bounded local LTX job', () => {
  const options = normalizeCreateOptions({
    ...createDefaultDraft(),
    prompt: 'A glass airship crosses a storm-lit valley.',
    avoid: 'captions and logos',
    camera: 'tracking',
    audio: 'ambient',
    variations: 3,
  });
  assert.equal(options.width, 1280);
  assert.equal(options.height, 736);
  assert.equal(options.variations, 3);
  assert.match(composeCreatePrompt(options), /smooth tracking shot/i);
  assert.match(composeCreatePrompt(options), /ambient sound/i);
  assert.match(composeCreatePrompt(options), /Do not depict these elements as dialogue/i);
});

test('Create rejects missing prompts and incomplete reference modes', () => {
  assert.throws(() => normalizeCreateOptions(createDefaultDraft()), /Describe the video/i);
  assert.throws(() => normalizeCreateOptions({ ...createDefaultDraft(), prompt: 'A crane rises.', referenceMode: 'first-frame' }), /reference image or context video/i);
  assert.throws(() => normalizeCreateOptions({ ...createDefaultDraft(), prompt: 'A crane rises.', useBlender: true }), /project backbone or drop a .blend/i);
});

test('dropped video, soundtrack, and Blender context satisfy their explicit modes', () => {
  const video = normalizeCreateOptions({ ...createDefaultDraft(), prompt: 'A crane rises.', referenceMode: 'first-last', contextVideoPath: 'private/video.mp4' });
  assert.equal(video.contextVideoPath, 'private/video.mp4');
  const soundtrack = normalizeCreateOptions({ ...createDefaultDraft(), prompt: 'A crane rises.', audio: 'soundtrack', soundtrackPath: 'private/song.flac' });
  assert.match(composeCreatePrompt(soundtrack), /soundtrack is supplied separately/i);
  const blender = normalizeCreateOptions({ ...createDefaultDraft(), prompt: 'A crane rises.', useBlender: true, blenderUploadPath: 'private/scene.blend' });
  assert.equal(blender.blenderUploadPath, 'private/scene.blend');
});

test('fixed variation seeds are deterministic and sequential', () => {
  const options = normalizeCreateOptions({ ...createDefaultDraft(), prompt: 'A quiet lake.', seedMode: 'fixed', seed: 99, variations: 4 });
  assert.deepEqual(createJobSeeds(options), [99, 100, 101, 102]);
  assert.deepEqual(createJobSeeds({ ...options, seedMode: 'random', variations: 2 }, () => 700), [700, 701]);
});

test('Create state ignores queue ids without jobs', () => {
  const record = normalizeCreateRecord({ queue: ['missing', 'kept'], jobs: { kept: { id: 'kept' } }, activeJobId: 'missing' });
  assert.deepEqual(record.queue, ['kept']);
  assert.equal(record.activeJobId, null);
});

test('official resolution presets stay aligned to generation-friendly dimensions', () => {
  for (const item of resolutionOptions()) {
    assert.equal(item.width % 32, 0);
    assert.equal(item.height % 32, 0);
  }
});
