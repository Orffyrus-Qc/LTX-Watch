import http from 'node:http';
import { createReadStream } from 'node:fs';
import { access, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(APP_ROOT, 'local.config.json');
const ORCHESTRATOR_STATE_PATH = path.join(APP_ROOT, 'orchestrator.state.json');
const ORCHESTRATOR_SCRIPT_PATH = path.join(APP_ROOT, 'scripts', 'process-orchestrator.ps1');
const PORT = Number(process.env.LTX_WATCH_API_PORT || 4311);
const CONTROL_TOKEN = randomBytes(24).toString('hex');
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.mkv']);
const probeCache = new Map();

function defaultConfig(comfyRoot) {
  return {
    displayName: process.env.LTX_WATCH_NAME || userInfo().username || 'Creator',
    modelLabel: process.env.LTX_WATCH_MODEL_LABEL || 'LTX Video 2.5',
    workerCommandFragment: 'run_full_album_auto.py',
    comfyRoot,
    finalsDirectory: path.join(comfyRoot, 'output', 'assembled'),
    clipsDirectory: path.join(comfyRoot, 'output', 'video'),
    logFile: path.join(comfyRoot, 'full_album_auto_run.log'),
    statusFile: path.join(comfyRoot, 'dual_gpu_status.json'),
    planFile: path.join(comfyRoot, 'dual_gpu_split.json'),
    comfyUrl: process.env.LTX_WATCH_COMFY_URL || 'http://127.0.0.1:8188',
    refreshSeconds: 5,
    maxVideos: 120,
  };
}

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

async function readJson(filePath, fallback = null) {
  try { return JSON.parse(await readFile(filePath, 'utf8')); } catch { return fallback; }
}

async function getConfig() {
  const saved = await readJson(CONFIG_PATH, {});
  const configuredRoot = process.env.LTX_WATCH_COMFY_ROOT || saved.comfyRoot;
  const candidates = [
    configuredRoot,
    path.join(homedir(), 'ComfyUI'),
    'C:\\ComfyUI', 'C:\\AI\\ComfyUI', 'D:\\ComfyUI', 'D:\\AI\\ComfyUI',
  ].filter(Boolean);
  let detectedRoot = candidates[0] || path.join(homedir(), 'ComfyUI');
  for (const candidate of candidates) {
    if (await exists(path.join(candidate, 'main.py'))) { detectedRoot = candidate; break; }
  }
  return { ...defaultConfig(detectedRoot), ...saved };
}

function cleanConfig(input) {
  const next = {};
  for (const key of ['displayName', 'modelLabel', 'workerCommandFragment', 'comfyRoot', 'finalsDirectory', 'clipsDirectory', 'logFile', 'statusFile', 'planFile', 'comfyUrl']) {
    if (typeof input[key] === 'string') {
      const value = input[key].trim();
      if (key === 'workerCommandFragment' && value.length < 4) throw new Error('Worker command match must contain at least four characters.');
      next[key] = value;
    }
  }
  next.refreshSeconds = Math.min(60, Math.max(2, Number(input.refreshSeconds) || 5));
  next.maxVideos = Math.min(500, Math.max(20, Number(input.maxVideos) || 120));
  return next;
}

function sendJson(res, statusCode, body) {
  const data = JSON.stringify(body);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store' });
  res.end(data);
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (!origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-LTX-Control-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

async function readBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 256_000) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

async function readTail(filePath, bytes = 2_000_000) {
  try {
    const info = await stat(filePath);
    const size = Math.min(bytes, info.size);
    const handle = await open(filePath, 'r');
    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, info.size - size);
    await handle.close();
    return buffer.toString('utf8');
  } catch { return ''; }
}

function parseDate(text) {
  if (!text) return null;
  const normalized = text.replace(' ', 'T');
  const value = new Date(normalized);
  return Number.isNaN(value.getTime()) ? null : value;
}

function friendlyName(filename) {
  return path.basename(filename, path.extname(filename))
    .replace(/_concat$/i, '')
    .replace(/_LTX[0-9P.]*_FULL$/i, '')
    .replace(/_FULL$/i, '')
    .replace(/_00001_$/i, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function videoTitle(filePath, kind) {
  const base = path.basename(filePath, path.extname(filePath));
  const shot = base.match(/^(\d+)/)?.[1];
  if (kind === 'clip' && shot) {
    const parent = friendlyName(path.basename(path.dirname(filePath)));
    return `${parent} · Shot ${shot}`;
  }
  return friendlyName(filePath);
}

function encodePath(filePath) {
  return Buffer.from(filePath, 'utf8').toString('base64url');
}

function decodePath(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function isInside(candidate, roots) {
  const target = path.resolve(candidate).toLowerCase();
  return roots.some((root) => {
    if (!root) return false;
    const base = path.resolve(root).toLowerCase();
    return target === base || target.startsWith(`${base}${path.sep}`);
  });
}

async function walkVideos(directory, kind, limit) {
  if (!directory || !(await exists(directory))) return [];
  const found = [];
  async function walk(current, depth) {
    if (depth > 5 || found.length >= limit * 3) return;
    let entries = [];
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (found.length >= limit * 3) break;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase() !== 'trimmed') await walk(fullPath, depth + 1);
      } else if (VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        try {
          const info = await stat(fullPath);
          if (info.size > 100_000) found.push({ fullPath, kind, size: info.size, modifiedMs: info.mtimeMs });
        } catch { /* file may be moving while generation finishes */ }
      }
    }
  }
  await walk(directory, 0);
  return found.sort((a, b) => b.modifiedMs - a.modifiedMs).slice(0, limit);
}

function execFileAsync(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: 5000, maxBuffer: 512_000 }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });
}

async function probeVideo(file, config) {
  const cacheKey = `${file.fullPath}:${file.modifiedMs}`;
  if (probeCache.has(cacheKey)) return probeCache.get(cacheKey);
  const ffprobe = path.join(config.comfyRoot, 'ffprobe.exe');
  if (!(await exists(ffprobe))) return null;
  const output = await execFileAsync(ffprobe, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file.fullPath]);
  if (!output) return null;
  try {
    const data = JSON.parse(output);
    const stream = data.streams?.find((item) => item.codec_type === 'video') || {};
    const meta = {
      duration: Number(data.format?.duration || stream.duration || 0),
      width: Number(stream.width || 0),
      height: Number(stream.height || 0),
      codec: stream.codec_name || path.extname(file.fullPath).slice(1),
    };
    probeCache.set(cacheKey, meta);
    return meta;
  } catch { return null; }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function parseGpuSnapshot(snapshot, plan) {
  if (!snapshot) return [];
  const cards = new Map();
  for (const key of ['gpu0', 'gpu1']) {
    const item = plan?.[key];
    if (item) cards.set(Number(item.device), item.card || '');
  }
  return snapshot.split('|').map((part) => {
    const match = part.trim().match(/^(\d+),\s*(.*?),\s*(\d+)\s*MiB,\s*(\d+)\s*%$/);
    if (!match) return null;
    const totalMatch = cards.get(Number(match[1]))?.match(/(\d+)GB/i);
    return {
      device: Number(match[1]), name: match[2], memoryMb: Number(match[3]), utilization: Number(match[4]),
      totalMemoryGb: totalMatch ? Number(totalMatch[1]) : null,
    };
  }).filter(Boolean);
}

function parseLog(logText) {
  const lines = logText.split(/\r?\n/).filter(Boolean);
  let current = null;
  const activities = [];
  const durations = [];
  const queuedAt = new Map();

  for (const line of lines) {
    const timestamp = line.match(/^\[([^\]]+)\]/)?.[1] || null;
    const time = parseDate(timestamp);
    let match = line.match(/--- starting track (.*?)\/(.*?) -> ([\w-]+) \((\d+) shots\) worker=(\w+)/);
    if (match) {
      current = { section: match[1], track: match[2], slug: match[3], totalShots: Number(match[4]), worker: match[5], startedAt: time?.toISOString() || null, currentShot: null, shotStartedAt: null, stage: 'Preparing inputs' };
      activities.push({ type: 'started', time: time?.toISOString(), title: `Started ${friendlyName(match[2])}`, detail: `${match[4]} shots · ${match[5].toUpperCase()}` });
      continue;
    }
    match = line.match(/=== ([\w-]+)\/(\d+): attempt \d+\/\d+.*\(duration=(\d+)s\) ===/);
    if (match) {
      if (current?.slug === match[1]) Object.assign(current, { currentShot: match[2], shotStartedAt: time?.toISOString() || null, stage: 'Starting ComfyUI', outputSeconds: Number(match[3]) });
      continue;
    }
    match = line.match(/=== ([\w-]+)\/(\d+): queued ([\w-]+) ===/);
    if (match) {
      queuedAt.set(`${match[1]}/${match[2]}`, time);
      if (current?.slug === match[1]) Object.assign(current, { currentShot: match[2], shotStartedAt: time?.toISOString() || current.shotStartedAt, stage: 'Sampling frames', promptId: match[3] });
      activities.push({ type: 'queued', time: time?.toISOString(), title: `Shot ${match[2]} queued`, detail: friendlyName(match[1]) });
      continue;
    }
    match = line.match(/=== ([\w-]+)\/(\d+): completed(?:\s|$)/);
    if (match) {
      const start = queuedAt.get(`${match[1]}/${match[2]}`);
      if (start && time) durations.push((time.getTime() - start.getTime()) / 1000);
      if (current?.slug === match[1]) current.stage = 'Writing output';
      activities.push({ type: 'complete', time: time?.toISOString(), title: `Shot ${match[2]} complete`, detail: friendlyName(match[1]) });
      continue;
    }
    match = line.match(/=== ([\w-]+): assembled final -> (.*?) ===/);
    if (match) {
      activities.push({ type: 'final', time: time?.toISOString(), title: `${friendlyName(match[1])} assembled`, detail: path.basename(match[2]) });
      continue;
    }
    match = line.match(/--- finished track (.*?)\/(.*?) ---/);
    if (match && current?.track === match[2]) current = null;
    if (/FAILED|failed|OOM|error/i.test(line) && !/0 %/.test(line)) {
      activities.push({ type: 'error', time: time?.toISOString(), title: 'Generator warning', detail: line.replace(/^\[[^\]]+\]\s*/, '').slice(0, 180) });
    }
  }
  const usable = durations.filter((value) => value > 30 && value < 3600).slice(-30);
  const averageShotSeconds = usable.length ? usable.reduce((sum, value) => sum + value, 0) / usable.length : 690;
  return { current, averageShotSeconds, activities: activities.slice(-10).reverse() };
}

async function countCompletedShots(config, current) {
  if (!current) return 0;
  const dir = path.join(config.clipsDirectory, current.slug);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const numbers = new Set(entries.filter((entry) => entry.isFile() && VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())).map((entry) => entry.name.match(/^(\d+)/)?.[1]).filter(Boolean));
    return numbers.size;
  } catch { return 0; }
}

async function getComfyQueue(config) {
  const base = config.comfyUrl.replace(/\/$/, '');
  for (const route of ['/queue', '/api/queue']) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 900);
    try {
      const response = await fetch(`${base}${route}`, { signal: controller.signal });
      if (!response.ok) continue;
      const data = await response.json();
      return { online: true, running: data.queue_running?.length || 0, pending: data.queue_pending?.length || 0, route };
    } catch { /* try the alternate route */ }
    finally { clearTimeout(timer); }
  }
  return { online: false, running: 0, pending: 0, route: null };
}

function getWorkerPids(status) {
  return Object.values(status?.workers || {}).map((worker) => {
    const value = typeof worker === 'number' ? worker : worker?.pid;
    return Number(value);
  }).filter((value) => Number.isInteger(value) && value > 0);
}

async function getOrchestratorRecord() {
  return await readJson(ORCHESTRATOR_STATE_PATH, {
    mode: 'running', rootPids: [], affectedPids: [], changedAt: null,
    trackScope: null, trackPausedMs: 0, shotScope: null, shotPausedMs: 0,
  });
}

function getControlView(record, status) {
  const workerPids = getWorkerPids(status);
  const recordedRoots = Array.isArray(record.rootPids) ? record.rootPids.map(Number) : [];
  const targetMatches = recordedRoots.length > 0 && recordedRoots.some((pid) => workerPids.includes(pid));
  const paused = record.mode === 'paused' && targetMatches;
  return {
    state: paused ? 'paused' : 'running',
    canControl: workerPids.length > 0,
    workerPids,
    affectedPids: paused ? record.affectedPids || [] : [],
    changedAt: record.changedAt || null,
    message: paused
      ? 'The LTX worker and its active ComfyUI subprocesses are suspended.'
      : workerPids.length
        ? 'The LTX worker is running normally.'
        : 'No controllable LTX worker was found.',
    token: CONTROL_TOKEN,
  };
}

function runProcessOrchestrator(mode, rootPids, expectedCommandFragment) {
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ORCHESTRATOR_SCRIPT_PATH,
    '-Mode', mode, '-RootPidCsv', rootPids.join(','), '-ExpectedCommandFragment', expectedCommandFragment,
  ];
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', args, { windowsHide: true, timeout: 15_000, maxBuffer: 1_000_000 }, (error, stdout, stderr) => {
      let payload = null;
      try { payload = JSON.parse(stdout.trim()); } catch { /* handled below */ }
      if (error || !payload?.ok) {
        const detail = payload?.results?.find((item) => !item.ok)?.error || stderr?.trim() || error?.message || 'Process control failed';
        reject(new Error(detail));
        return;
      }
      resolve(payload);
    });
  });
}

async function controlGenerator(action) {
  const config = await getConfig();
  const [status, record, logText] = await Promise.all([
    readJson(config.statusFile, {}), getOrchestratorRecord(), readTail(config.logFile),
  ]);
  const currentView = getControlView(record, status);
  if (!currentView.canControl) throw new Error('No active LTX worker is available to control.');
  if (action === 'pause' && currentView.state === 'paused') return currentView;
  if (action === 'resume' && currentView.state !== 'paused') return currentView;

  const current = parseLog(logText).current;
  const now = new Date();
  if (action === 'pause') {
    const result = await runProcessOrchestrator('suspend', currentView.workerPids, config.workerCommandFragment);
    const trackScope = current?.slug || null;
    const shotScope = current ? `${current.slug}/${current.currentShot || ''}` : null;
    const next = {
      mode: 'paused', rootPids: currentView.workerPids, affectedPids: result.affected,
      pausedAt: now.toISOString(), changedAt: now.toISOString(),
      trackScope, trackPausedMs: record.trackScope === trackScope ? Number(record.trackPausedMs || 0) : 0,
      shotScope, shotPausedMs: record.shotScope === shotScope ? Number(record.shotPausedMs || 0) : 0,
    };
    await writeFile(ORCHESTRATOR_STATE_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return getControlView(next, status);
  }

  const roots = Array.isArray(record.rootPids) && record.rootPids.length ? record.rootPids : currentView.workerPids;
  await runProcessOrchestrator('resume', roots, config.workerCommandFragment);
  const pausedForMs = Math.max(0, now.getTime() - new Date(record.pausedAt || now).getTime());
  const next = {
    ...record, mode: 'running', affectedPids: [], changedAt: now.toISOString(), resumedAt: now.toISOString(),
    trackPausedMs: Number(record.trackPausedMs || 0) + pausedForMs,
    shotPausedMs: Number(record.shotPausedMs || 0) + pausedForMs,
  };
  await writeFile(ORCHESTRATOR_STATE_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return getControlView(next, status);
}

async function buildState() {
  const config = await getConfig();
  const [status, plan, logText, finals, clips, comfy, orchestratorRecord] = await Promise.all([
    readJson(config.statusFile, {}), readJson(config.planFile, {}), readTail(config.logFile),
    walkVideos(config.finalsDirectory, 'final', config.maxVideos), walkVideos(config.clipsDirectory, 'clip', config.maxVideos),
    getComfyQueue(config), getOrchestratorRecord(),
  ]);
  const parsed = parseLog(logText);
  const control = getControlView(orchestratorRecord, status);
  const completedShots = await countCompletedShots(config, parsed.current);
  const allFiles = [...finals, ...clips].sort((a, b) => b.modifiedMs - a.modifiedMs).slice(0, config.maxVideos);
  const videos = await mapWithConcurrency(allFiles, 4, async (file, index) => {
    const meta = index < 48 ? await probeVideo(file, config) : null;
    return {
      id: encodePath(file.fullPath), title: videoTitle(file.fullPath, file.kind), filename: path.basename(file.fullPath), kind: file.kind,
      size: file.size, modifiedAt: new Date(file.modifiedMs).toISOString(), mediaUrl: `http://127.0.0.1:${PORT}/media/${encodePath(file.fullPath)}`,
      directory: path.dirname(file.fullPath), ...meta,
    };
  });
  const planTracks = [...(plan?.gpu0?.tracks || []), ...(plan?.gpu1?.tracks || [])];
  const finalSlugs = new Set(finals.map((file) => path.basename(file.fullPath).replace(/_LTX[0-9P.]*_FULL\.mp4$/i, '').toLowerCase()));
  const queued = planTracks.filter((track) => track.slug !== parsed.current?.slug && !finalSlugs.has(track.slug?.toLowerCase())).map((track, index) => ({ ...track, position: index + 1 }));
  const now = Date.now();
  const effectiveNow = control.state === 'paused' ? new Date(orchestratorRecord.pausedAt || now).getTime() : now;
  const trackScope = parsed.current?.slug || null;
  const shotScope = parsed.current ? `${parsed.current.slug}/${parsed.current.currentShot || ''}` : null;
  const trackPausedMs = orchestratorRecord.trackScope === trackScope ? Number(orchestratorRecord.trackPausedMs || 0) : 0;
  const shotPausedMs = orchestratorRecord.shotScope === shotScope ? Number(orchestratorRecord.shotPausedMs || 0) : 0;
  const shotStartedMs = parsed.current?.shotStartedAt ? new Date(parsed.current.shotStartedAt).getTime() : now;
  const activeShotFraction = parsed.current ? Math.min(0.92, Math.max(0.04, (effectiveNow - shotStartedMs - shotPausedMs) / 1000 / parsed.averageShotSeconds)) : 0;
  const progress = parsed.current ? Math.min(99, ((completedShots + activeShotFraction) / parsed.current.totalShots) * 100) : 0;
  const remainingSeconds = parsed.current ? Math.max(0, (parsed.current.totalShots - completedShots - activeShotFraction) * parsed.averageShotSeconds) : 0;
  const statusUpdated = parseDate(status.updated);
  const workerOnline = Boolean(statusUpdated && now - statusUpdated.getTime() < 180_000 && Object.values(status.workers || {}).some((worker) => typeof worker === 'number' || worker?.alive !== false));
  const today = new Date();
  const todayFinals = finals.filter((file) => { const date = new Date(file.modifiedMs); return date.toDateString() === today.toDateString(); }).length;
  return {
    updatedAt: new Date().toISOString(), connection: { comfy: comfy.online, worker: workerOnline, apiUrl: config.comfyUrl },
    current: parsed.current ? {
      ...parsed.current, completedShots, progress, remainingSeconds, averageShotSeconds: parsed.averageShotSeconds,
      elapsedSeconds: Math.max(0, (effectiveNow - new Date(parsed.current.startedAt || effectiveNow).getTime() - trackPausedMs) / 1000),
    } : null,
    control, queue: queued, comfyQueue: comfy, videos,
    activity: control.changedAt ? [{ type: control.state === 'paused' ? 'paused' : 'resumed', time: control.changedAt, title: control.state === 'paused' ? 'Generation paused' : 'Generation resumed', detail: control.message }, ...parsed.activities] : parsed.activities,
    gpus: parseGpuSnapshot(status.gpu_snapshot, plan),
    stats: { finals: finals.length, clips: clips.length, todayFinals, queued: queued.length },
    config,
  };
}

async function serveMedia(req, res, id, config) {
  let filePath;
  try { filePath = decodePath(id); } catch { return sendJson(res, 400, { error: 'Invalid media id' }); }
  if (!isInside(filePath, [config.finalsDirectory, config.clipsDirectory])) return sendJson(res, 403, { error: 'Path is outside configured output folders' });
  let info;
  try { info = await stat(filePath); } catch { return sendJson(res, 404, { error: 'Video not found' }); }
  const ext = path.extname(filePath).toLowerCase();
  const types = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska' };
  const range = req.headers.range;
  if (range) {
    const [startText, endText] = range.replace(/bytes=/, '').split('-');
    const start = Number(startText || 0);
    const end = Math.min(Number(endText || info.size - 1), info.size - 1);
    if (start >= info.size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); return res.end(); }
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'private, max-age=60' });
    createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': info.size, 'Content-Type': types[ext] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=60' });
    createReadStream(filePath).pipe(res);
  }
}

const server = http.createServer(async (req, res) => {
  setCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
  try {
    if (req.method === 'GET' && requestUrl.pathname === '/api/health') return sendJson(res, 200, { ok: true, name: 'LTX Watch local bridge' });
    if (req.method === 'GET' && requestUrl.pathname === '/api/state') return sendJson(res, 200, await buildState());
    if (req.method === 'GET' && requestUrl.pathname === '/api/config') return sendJson(res, 200, await getConfig());
    if (req.method === 'POST' && requestUrl.pathname === '/api/control') {
      if (req.headers['x-ltx-control-token'] !== CONTROL_TOKEN) return sendJson(res, 403, { error: 'Invalid local control token' });
      const action = (await readBody(req)).action;
      if (action !== 'pause' && action !== 'resume') return sendJson(res, 400, { error: 'Action must be pause or resume' });
      return sendJson(res, 200, { ok: true, control: await controlGenerator(action) });
    }
    if (req.method === 'POST' && requestUrl.pathname === '/api/config') {
      const current = await getConfig();
      const next = { ...current, ...cleanConfig(await readBody(req)) };
      await writeFile(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      return sendJson(res, 200, next);
    }
    if (req.method === 'POST' && requestUrl.pathname === '/api/open') {
      const config = await getConfig();
      const body = await readBody(req);
      const target = typeof body.path === 'string' ? body.path : '';
      if (!target || !isInside(target, [config.comfyRoot, config.finalsDirectory, config.clipsDirectory])) return sendJson(res, 403, { error: 'Path is outside configured folders' });
      if (!(await exists(target))) return sendJson(res, 404, { error: 'Path not found' });
      const info = await stat(target);
      const args = info.isDirectory() ? [target] : [`/select,${target}`];
      const child = spawn('explorer.exe', args, { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && requestUrl.pathname.startsWith('/media/')) return serveMedia(req, res, requestUrl.pathname.slice('/media/'.length), await getConfig());
    return sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    return sendJson(res, 500, { error: error instanceof Error ? error.message : 'Unexpected local bridge error' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`LTX Watch local bridge: http://127.0.0.1:${PORT}`);
});
