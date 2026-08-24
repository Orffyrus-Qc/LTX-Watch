import assert from 'node:assert/strict';
import test from 'node:test';

import { parseLegacyGpuSnapshot, parseLiveGpuCsv } from '../lib/gpu-telemetry.mjs';

test('live GPU telemetry parses utilization and exact device memory totals', () => {
  const sampledAt = '2026-08-24T01:00:00.000Z';
  const cards = parseLiveGpuCsv([
    '0, NVIDIA GeForce RTX 5060 Ti, 15463, 16311, 7',
    '1, NVIDIA GeForce RTX 3060, 0, 12288, 0',
  ].join('\n'), sampledAt);

  assert.equal(cards.length, 2);
  assert.deepEqual(cards[0], {
    device: 0,
    name: 'NVIDIA GeForce RTX 5060 Ti',
    memoryMb: 15463,
    totalMemoryMb: 16311,
    totalMemoryGb: 15.9,
    utilization: 7,
    source: 'nvidia-smi',
    sampledAt,
  });
});

test('legacy runner telemetry remains available as an explicitly labeled fallback', () => {
  const cards = parseLegacyGpuSnapshot(
    '0, NVIDIA GeForce RTX 5060 Ti, 10953 MiB, 15 % | 1, NVIDIA GeForce RTX 3060, 0 MiB, 0 %',
    { gpu0: { device: 0, card: 'RTX 5060 Ti 16GB' }, gpu1: { device: 1, card: 'RTX 3060 12GB' } },
    '2026-08-23T16:06:08.000Z',
  );

  assert.equal(cards[0].source, 'status-file');
  assert.equal(cards[0].totalMemoryMb, 16384);
  assert.equal(cards[0].sampledAt, '2026-08-23T16:06:08.000Z');
});
