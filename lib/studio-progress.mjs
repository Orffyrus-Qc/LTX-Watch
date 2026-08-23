function logDate(value) {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(' ', 'T') : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function averageStudioShotSeconds(runnerLog, fallback = 690) {
  const starts = new Map();
  const durations = [];
  for (const line of String(runnerLog || '').split(/\r?\n/)) {
    const timestamp = logDate(line.match(/^\[([^\]]+)\]/)?.[1]);
    if (!timestamp) continue;
    let match = line.match(/=== ([\w-]+)\/(\d+): attempt \d+\/\d+/);
    if (match) {
      starts.set(`${match[1]}/${match[2]}`, timestamp.getTime());
      continue;
    }
    match = line.match(/=== ([\w-]+)\/(\d+): completed(?:\s|$)/);
    if (!match) continue;
    const startedAt = starts.get(`${match[1]}/${match[2]}`);
    if (startedAt) durations.push((timestamp.getTime() - startedAt) / 1000);
  }
  const usable = durations.filter((seconds) => seconds >= 30 && seconds <= 3_600).slice(-12);
  return usable.length ? usable.reduce((sum, seconds) => sum + seconds, 0) / usable.length : fallback;
}

export function samplerSnapshot(serverLog) {
  const percentages = [...String(serverLog || '').matchAll(/(\d{1,3})%\|/g)].map((match) => Math.min(100, Number(match[1])));
  if (!percentages.length) return null;
  let pass = 0;
  let previous = percentages[0];
  for (const percentage of percentages.slice(1)) {
    if (previous >= 75 && percentage <= 20 && percentage < previous) pass += 1;
    previous = percentage;
  }
  return { pass, percentage: percentages.at(-1) };
}

export function studioJobProgress({ runnerLog = '', serverLog = '', startedAt, now = Date.now(), previousProgress = 0 }) {
  const startedMs = new Date(startedAt || now).getTime();
  const elapsedSeconds = Math.max(0, (now - (Number.isNaN(startedMs) ? now : startedMs)) / 1000);
  const averageSeconds = averageStudioShotSeconds(runnerLog);
  const timeProgress = Math.min(94, Math.max(2, (elapsedSeconds / averageSeconds) * 100));
  const snapshot = samplerSnapshot(serverLog);
  let stage = 'Starting ComfyUI';
  let logProgress = 3;

  if (/Prompt executed in/i.test(serverLog)) {
    stage = 'Writing output';
    logProgress = 98;
  } else if (snapshot) {
    const phases = [
      { start: 20, end: 60, stage: 'Sampling frames' },
      { start: 60, end: 78, stage: 'Refining frames' },
      { start: 78, end: 90, stage: 'Decoding detail pass' },
      { start: 90, end: 96, stage: 'Finishing render pass' },
    ];
    const phase = phases[Math.min(snapshot.pass, phases.length - 1)];
    stage = phase.stage;
    logProgress = phase.start + ((phase.end - phase.start) * snapshot.percentage) / 100;
  } else if (/got prompt/i.test(serverLog)) {
    stage = 'Loading models';
    logProgress = 12;
  } else if (/Starting server|To see the GUI/i.test(serverLog)) {
    stage = 'Starting ComfyUI';
    logProgress = 7;
  }

  const progress = Math.min(98, Math.max(previousProgress, logProgress, timeProgress));
  return {
    stage,
    progress: Math.round(progress),
    elapsedSeconds: Math.round(elapsedSeconds),
    remainingSeconds: Math.max(0, Math.round(averageSeconds - elapsedSeconds)),
    averageSeconds: Math.round(averageSeconds),
  };
}
