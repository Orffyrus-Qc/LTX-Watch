export function resolvePauseAfterCurrent(record, currentSlug, control) {
  if (record?.pauseAfterCurrent !== true) return { type: 'idle' };
  if (control?.state === 'paused' || control?.state === 'recovery') return { type: 'clear' };

  const slug = typeof record.pauseAfterCurrentSlug === 'string' && record.pauseAfterCurrentSlug
    ? record.pauseAfterCurrentSlug
    : null;
  const canPause = Boolean(control?.canControl && Array.isArray(control.workerPids) && control.workerPids.length);

  if (!slug) {
    if (currentSlug) return { type: 'bind', slug: currentSlug };
    return canPause ? { type: 'pause' } : { type: 'keep' };
  }
  if (currentSlug === slug) return { type: 'keep' };
  return canPause ? { type: 'pause' } : { type: 'clear' };
}

export function withPauseAfterCurrent(record, { armed = false, slug = null } = {}) {
  return {
    ...record,
    pauseAfterCurrent: armed === true,
    pauseAfterCurrentSlug: armed && typeof slug === 'string' && slug ? slug : null,
  };
}
