import assert from 'node:assert/strict';
import test from 'node:test';
import { moveFile } from '../lib/move-file.mjs';

test('moveFile uses rename when source and destination share a volume', async () => {
  const calls = [];
  await moveFile('source.mp4', 'destination.mp4', {
    renameFile: async (...args) => calls.push(['rename', ...args]),
    copyFileToDestination: async (...args) => calls.push(['copy', ...args]),
    removeFile: async (...args) => calls.push(['remove', ...args]),
  });

  assert.deepEqual(calls, [['rename', 'source.mp4', 'destination.mp4']]);
});

test('moveFile copies and removes the source after a cross-volume rename fails', async () => {
  const calls = [];
  await moveFile('D:/source.mp4', 'C:/destination.mp4', {
    renameFile: async () => {
      const error = new Error('cross-device link not permitted');
      error.code = 'EXDEV';
      throw error;
    },
    copyFileToDestination: async (...args) => calls.push(['copy', ...args]),
    removeFile: async (...args) => calls.push(['remove', ...args]),
  });

  assert.deepEqual(calls, [
    ['copy', 'D:/source.mp4', 'C:/destination.mp4'],
    ['remove', 'D:/source.mp4'],
  ]);
});

test('moveFile removes a partial destination when source removal fails', async () => {
  const calls = [];
  await assert.rejects(() => moveFile('D:/source.mp4', 'C:/destination.mp4', {
    renameFile: async () => {
      const error = new Error('cross-device link not permitted');
      error.code = 'EXDEV';
      throw error;
    },
    copyFileToDestination: async (...args) => calls.push(['copy', ...args]),
    removeFile: async (target) => {
      calls.push(['remove', target]);
      if (target === 'D:/source.mp4') throw new Error('source is locked');
    },
  }), /source is locked/);

  assert.deepEqual(calls, [
    ['copy', 'D:/source.mp4', 'C:/destination.mp4'],
    ['remove', 'D:/source.mp4'],
    ['remove', 'C:/destination.mp4'],
  ]);
});
