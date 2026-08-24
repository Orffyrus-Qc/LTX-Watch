function finiteNumber(value) {
  const parsed = Number(String(value ?? '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseLiveGpuCsv(text, sampledAt = new Date().toISOString()) {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const parts = line.split(',').map((part) => part.trim());
    if (parts.length < 5) return null;
    const device = finiteNumber(parts[0]);
    const memoryMb = finiteNumber(parts.at(-3));
    const totalMemoryMb = finiteNumber(parts.at(-2));
    const utilization = finiteNumber(parts.at(-1));
    const name = parts.slice(1, -3).join(', ').trim();
    if (!Number.isInteger(device) || !name || memoryMb === null || totalMemoryMb === null || utilization === null) return null;
    return {
      device,
      name,
      memoryMb,
      totalMemoryMb,
      totalMemoryGb: Math.round((totalMemoryMb / 1024) * 10) / 10,
      utilization: Math.min(100, Math.max(0, utilization)),
      source: 'nvidia-smi',
      sampledAt,
    };
  }).filter(Boolean);
}

export function parseLegacyGpuSnapshot(snapshot, plan, sampledAt = null) {
  if (!snapshot) return [];
  const cards = new Map();
  for (const key of ['gpu0', 'gpu1']) {
    const item = plan?.[key];
    if (item) cards.set(Number(item.device), item.card || '');
  }
  return snapshot.split('|').map((part) => {
    const match = part.trim().match(/^(\d+),\s*(.*?),\s*(\d+)\s*MiB,\s*(\d+)\s*%$/);
    if (!match) return null;
    const totalMatch = cards.get(Number(match[1]))?.match(/(\d+(?:\.\d+)?)GB/i);
    const totalMemoryGb = totalMatch ? Number(totalMatch[1]) : null;
    return {
      device: Number(match[1]),
      name: match[2],
      memoryMb: Number(match[3]),
      totalMemoryMb: totalMemoryGb ? Math.round(totalMemoryGb * 1024) : null,
      utilization: Number(match[4]),
      totalMemoryGb,
      source: 'status-file',
      sampledAt,
    };
  }).filter(Boolean);
}
