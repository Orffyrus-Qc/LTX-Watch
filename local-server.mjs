import http from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { access, appendFile, copyFile, mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir, uptime, userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanCorrection,
  ensureSceneRecord,
  moveSceneFirst,
  nextUnacceptedShot,
  normalizeQueueOrder,
  normalizeStudioRecord,
  parseShotRange,
  sceneKey,
} from './studio-core.mjs';
import { buildEnvironmentAudit, findBlenderInstallation } from './lib/environment-audit.mjs';
import { updateComfyUiCore } from './lib/comfyui-core-update.mjs';
import { installComfyUiBlender, normalizeLoopbackComfyUrl } from './lib/comfyui-blender-setup.mjs';
import { moveFile } from './lib/move-file.mjs';
import { installSam3Model } from './lib/sam3-setup.mjs';
import { studioJobProgress } from './lib/studio-progress.mjs';
import {
  PROJECT_FILE_LIMIT,
  buildProjectShots,
  classifyProjectAsset,
  createProjectsRecord,
  enqueueProjectShots,
  inferShotIdentity,
  mergeProjectPlanItems,
  normalizeProjectsRecord,
  projectAssetId,
  safeUploadRelativePath,
} from './project-core.mjs';
import {
  composeCreatePrompt,
  cleanCreateDraft,
  createDefaultDraft,
  createJobSeeds,
  normalizeCreateOptions,
  normalizeCreateRecord,
  resolutionOptions,
  safeCreateTitle,
} from './create-core.mjs';

const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(APP_ROOT, 'local.config.json');
const ORCHESTRATOR_STATE_PATH = path.join(APP_ROOT, 'orchestrator.state.json');
const ORCHESTRATOR_SCRIPT_PATH = path.join(APP_ROOT, 'scripts', 'process-orchestrator.ps1');
const STUDIO_STATE_PATH = path.join(APP_ROOT, 'studio.state.json');
const STUDIO_RUNTIME_ROOT = path.join(APP_ROOT, '.ltx-watch-studio');
const STUDIO_RUNNER_PATH = path.join(APP_ROOT, 'scripts', 'ltx-studio-runner.py');
const PROJECTS_STATE_PATH = path.join(APP_ROOT, 'projects.state.json');
const PROJECTS_RUNTIME_ROOT = path.join(APP_ROOT, '.ltx-watch-projects');
const CREATE_STATE_PATH = path.join(APP_ROOT, 'create.state.json');
const CREATE_RUNTIME_ROOT = path.join(APP_ROOT, '.ltx-watch-create');
const CREATE_RUNNER_PATH = path.join(APP_ROOT, 'scripts', 'ltx-create-runner.py');
const CREATE_UPLOAD_CHUNK_LIMIT = 4 * 1024 * 1024;
const CREATE_CONTEXT_EXTENSIONS = new Map([
  ['.png', 'image'], ['.jpg', 'image'], ['.jpeg', 'image'], ['.webp', 'image'],
  ['.mp4', 'video'], ['.webm', 'video'], ['.mov', 'video'], ['.mkv', 'video'],
  ['.wav', 'audio'], ['.mp3', 'audio'], ['.flac', 'audio'], ['.m4a', 'audio'], ['.ogg', 'audio'], ['.aac', 'audio'],
  ['.blend', 'blend'],
]);
const PROJECT_UPLOAD_CHUNK_LIMIT = 4 * 1024 * 1024;
const COMFY_BLENDER_SCRIPT_PATH = path.join(APP_ROOT, 'scripts', 'install-comfyui-blender.ps1');
const SAM3_SCRIPT_PATH = path.join(APP_ROOT, 'scripts', 'install-sam3.ps1');
const MAINTENANCE_ROOT = path.join(process.env.LOCALAPPDATA || APP_ROOT, 'LTX Watch', 'maintenance');
const COMFY_BLENDER_RECEIPT_PATH = path.join(MAINTENANCE_ROOT, 'comfyui-blender.json');
const MAINTENANCE_BACKUP_ROOT = path.join(MAINTENANCE_ROOT, 'backups');
const PORT = Number(process.env.LTX_WATCH_API_PORT || 4311);
const CONTROL_TOKEN = randomBytes(24).toString('hex');
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.mkv']);
const probeCache = new Map();
let environmentCache = { key: '', expiresAt: 0, value: null, promise: null };
let maintenanceState = { status: 'idle', action: null, stage: null, startedAt: null, completedAt: null, result: null };
const studioProgressHighWater = new Map();
let recoveryInFlight = false;
let studioMutationInFlight = false;
let projectMutationInFlight = false;
let createMutationInFlight = false;
let generationLaunchInFlight = false;
let sourcePlanCache = { key: '', expiresAt: 0, value: [], promise: null };
const projectUploads = new Map();
const createUploads = new Map();
let blenderCache = { expiresAt: 0, value: null };

function defaultConfig(comfyRoot) {
  return {
    displayName: process.env.LTX_WATCH_NAME || userInfo().username || 'Creator',
    modelLabel: process.env.LTX_WATCH_MODEL_LABEL || 'LTX Video 2.5',
    workerCommandFragment: 'run_full_album_auto.py',
    recoveryScript: 'run_dual_gpu_album.py',
    studioSourceRunner: path.join(comfyRoot, 'run_full_album_auto.py'),
    studioGpu: 0,
    studioPort: 8188,
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
  for (const key of ['displayName', 'modelLabel', 'workerCommandFragment', 'recoveryScript', 'studioSourceRunner', 'comfyRoot', 'finalsDirectory', 'clipsDirectory', 'logFile', 'statusFile', 'planFile', 'comfyUrl']) {
    if (typeof input[key] === 'string') {
      const value = input[key].trim();
      if (key === 'workerCommandFragment' && value.length < 4) throw new Error('Worker command match must contain at least four characters.');
      if (key === 'recoveryScript' && value && !/^[a-zA-Z0-9._\\/-]+\.py$/i.test(value)) throw new Error('Recovery script must be a Python file path.');
      next[key] = value;
    }
  }
  next.refreshSeconds = Math.min(60, Math.max(2, Number(input.refreshSeconds) || 5));
  next.maxVideos = Math.min(500, Math.max(20, Number(input.maxVideos) || 120));
  next.studioGpu = Math.min(15, Math.max(0, Math.trunc(Number(input.studioGpu) || 0)));
  next.studioPort = Math.min(65_535, Math.max(1_024, Math.trunc(Number(input.studioPort) || 8188)));
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-LTX-Control-Token, X-LTX-Upload-Offset');
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

async function readBinaryBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > PROJECT_UPLOAD_CHUNK_LIMIT) throw new Error('Upload chunk is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
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

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout: options.timeout || 5000, maxBuffer: options.maxBuffer || 512_000 }, (error, stdout) => {
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
    if (typeof worker === 'object' && worker?.alive === false) return NaN;
    const value = typeof worker === 'number' ? worker : worker?.pid;
    return Number(value);
  }).filter((value) => Number.isInteger(value) && value > 0);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function getSystemBootTimeMs() {
  return Date.now() - (uptime() * 1000);
}

function getStalePauseReason(record) {
  if (record?.mode !== 'paused') return null;
  const pausedAtMs = new Date(record.pausedAt || 0).getTime();
  if (Number.isFinite(pausedAtMs) && pausedAtMs > 0 && pausedAtMs < getSystemBootTimeMs() - 5_000) {
    return 'system-restarted';
  }
  const roots = Array.isArray(record.rootPids) ? record.rootPids.map(Number).filter(Number.isInteger) : [];
  if (!roots.length || !roots.some(processExists)) return 'process-ended';
  return null;
}

async function getOrchestratorRecord() {
  const record = await readJson(ORCHESTRATOR_STATE_PATH, {
    mode: 'running', rootPids: [], affectedPids: [], changedAt: null,
    trackScope: null, trackPausedMs: 0, shotScope: null, shotPausedMs: 0,
  });
  const recoveryReason = getStalePauseReason(record);
  if (!recoveryReason) return record;

  const now = new Date();
  const next = {
    ...record,
    mode: 'recovery',
    rootPids: [],
    affectedPids: [],
    changedAt: now.toISOString(),
    recoveryDetectedAt: now.toISOString(),
    recoveryReason,
  };
  await writeFile(ORCHESTRATOR_STATE_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

function resolveRecoveryPlan(config, record) {
  if (!config?.recoveryScript || !record?.shotScope) return null;
  const scriptPath = path.resolve(config.comfyRoot, config.recoveryScript);
  if (!isInside(scriptPath, [config.comfyRoot]) || path.extname(scriptPath).toLowerCase() !== '.py' || !existsSync(scriptPath)) return null;
  const pythonCandidates = [
    // Prefer the windowless launcher so a recovery started from the dashboard
    // stays in the background. All output is already captured in the recovery log.
    path.join(config.comfyRoot, 'venv', 'Scripts', 'pythonw.exe'),
    path.join(config.comfyRoot, '.venv', 'Scripts', 'pythonw.exe'),
    path.join(config.comfyRoot, 'python_embeded', 'pythonw.exe'),
    path.join(config.comfyRoot, 'python', 'pythonw.exe'),
    path.join(config.comfyRoot, 'venv', 'Scripts', 'python.exe'),
    path.join(config.comfyRoot, '.venv', 'Scripts', 'python.exe'),
    path.join(config.comfyRoot, 'python_embeded', 'python.exe'),
    path.join(config.comfyRoot, 'python', 'python.exe'),
  ];
  const executable = pythonCandidates.find(existsSync);
  return executable ? { executable, scriptPath } : null;
}

function parseShotScope(record) {
  const [trackSlug, shot] = String(record?.shotScope || '').split('/');
  if (!/^[a-zA-Z0-9._-]+$/.test(trackSlug || '') || !/^\d{4,}$/.test(shot || '')) return null;
  return { trackSlug, shot };
}

async function archiveInterruptedShot(config, record) {
  const scope = parseShotScope(record);
  if (!scope) throw new Error('The interrupted shot could not be identified safely.');
  const sourceDirectory = path.resolve(config.clipsDirectory, scope.trackSlug);
  if (!isInside(sourceDirectory, [config.clipsDirectory])) throw new Error('The interrupted shot path is outside the configured clips folder.');

  let names = [];
  try { names = await readdir(sourceDirectory); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const candidates = names.filter((name) => name.startsWith(scope.shot) && VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase()));
  if (!candidates.length) return { ...scope, archived: [] };

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveDirectory = path.join(config.comfyRoot, '.ltx-watch-recovery', `${stamp}_${scope.trackSlug}_${scope.shot}`);
  await mkdir(archiveDirectory, { recursive: true });
  const archived = [];
  for (const name of candidates) {
    const source = path.join(sourceDirectory, name);
    const destination = path.join(archiveDirectory, name);
    await rename(source, destination);
    archived.push(destination);
  }
  return { ...scope, archived };
}

async function waitForRecoveryWorker(config, launchedAtMs, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await readJson(config.statusFile, {});
    const updated = parseDate(status.updated)?.getTime() || 0;
    const workerPids = getWorkerPids(status).filter(processExists);
    if (updated >= launchedAtMs - 1_000 && workerPids.length) return { status, workerPids };
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  throw new Error(`The recovery script started, but no new worker appeared within ${Math.round(timeoutMs / 1000)} seconds. Check ltx-watch-recovery.log in the ComfyUI folder.`);
}

async function restartInterruptedShot(config, record) {
  if (recoveryInFlight) throw new Error('Shot recovery is already starting. Wait for the worker to appear.');
  recoveryInFlight = true;
  try {
    const recoveryPlan = resolveRecoveryPlan(config, record);
    if (!recoveryPlan) throw new Error('Automatic shot recovery is unavailable. Configure a valid recoveryScript and ComfyUI Python environment.');
    const shot = await archiveInterruptedShot(config, record);
    const launchedAtMs = Date.now();
    const logHandle = await open(path.join(config.comfyRoot, 'ltx-watch-recovery.log'), 'a');
    try {
      const child = spawn(recoveryPlan.executable, [recoveryPlan.scriptPath], {
        cwd: config.comfyRoot,
        detached: true,
        stdio: ['ignore', logHandle.fd, logHandle.fd],
        windowsHide: true,
      });
      await new Promise((resolveSpawn, rejectSpawn) => {
        child.once('spawn', resolveSpawn);
        child.once('error', rejectSpawn);
      });
      child.unref();
    } finally {
      await logHandle.close();
    }
    const worker = await waitForRecoveryWorker(config, launchedAtMs);
    return { ...shot, ...worker, script: path.basename(recoveryPlan.scriptPath) };
  } finally {
    recoveryInFlight = false;
  }
}

function getControlView(record, status, config) {
  const statusUpdated = parseDate(status?.updated);
  const statusIsFresh = !status?.updated || Boolean(statusUpdated && Date.now() - statusUpdated.getTime() < 180_000);
  const statusWorkerPids = getWorkerPids(status).filter(processExists);
  const recordedRoots = Array.isArray(record.rootPids) ? record.rootPids.map(Number) : [];
  const liveRecordedRoots = recordedRoots.filter(processExists);
  const paused = record.mode === 'paused' && liveRecordedRoots.length > 0;
  const recovery = record.mode === 'recovery';
  const workerPids = paused ? liveRecordedRoots : recovery ? [] : statusIsFresh ? statusWorkerPids : [];
  const recoveryAvailable = recovery && Boolean(resolveRecoveryPlan(config, record));
  const recoveryMessage = record.recoveryReason === 'system-restarted'
    ? `Windows restarted while shot ${parseShotScope(record)?.shot || ''} was paused. Resume will restart that shot from the beginning.`
    : record.recoveryReason === 'process-ended'
      ? `The paused worker ended before it could resume. Resume will restart shot ${parseShotScope(record)?.shot || ''} from the beginning.`
      : null;
  return {
    state: recovery ? 'recovery' : paused ? 'paused' : 'running',
    canControl: recovery ? recoveryAvailable : workerPids.length > 0,
    workerPids,
    affectedPids: paused ? record.affectedPids || [] : [],
    changedAt: record.changedAt || null,
    recoveryReason: record.recoveryReason || null,
    recoveryAvailable,
    restartedShot: record.restartedShot || null,
    message: recoveryMessage || (paused
      ? 'The LTX worker and its active ComfyUI subprocesses are suspended.'
      : record.restartedShot
        ? `Shot ${record.restartedShot} restarted from the beginning after the interrupted process ended.`
      : workerPids.length
        ? 'The LTX worker is running normally.'
        : 'No controllable LTX worker was found.'),
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
  const currentView = getControlView(record, status, config);
  if (action === 'pause' && currentView.state === 'paused') return currentView;
  if (action === 'resume' && currentView.state === 'running') return currentView;
  if (!currentView.canControl) throw new Error('No active LTX worker is available to control.');

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
    return getControlView(next, status, config);
  }

  if (currentView.state === 'recovery') {
    const recovered = await restartInterruptedShot(config, record);
    const pausedForMs = Math.max(0, now.getTime() - new Date(record.pausedAt || now).getTime());
    const next = {
      ...record,
      mode: 'running',
      rootPids: recovered.workerPids,
      affectedPids: [],
      pausedAt: null,
      changedAt: new Date().toISOString(),
      restartedAt: new Date().toISOString(),
      restartedShot: recovered.shot,
      recoveryScript: recovered.script,
      archivedInterruptedFiles: recovered.archived,
      recoveryReason: null,
      trackPausedMs: Number(record.trackPausedMs || 0) + pausedForMs,
      shotPausedMs: Number(record.shotPausedMs || 0) + pausedForMs,
    };
    await writeFile(ORCHESTRATOR_STATE_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return getControlView(next, recovered.status, config);
  }

  const roots = Array.isArray(record.rootPids) && record.rootPids.length
    ? record.rootPids.map(Number).filter(processExists)
    : currentView.workerPids;
  try {
    await runProcessOrchestrator('resume', roots, config.workerCommandFragment);
  } catch (error) {
    if (!/no longer exists/i.test(error?.message || '')) throw error;
    const recoveryRecord = {
      ...record,
      mode: 'recovery',
      rootPids: [],
      affectedPids: [],
      recoveryReason: 'process-ended',
      recoveryDetectedAt: new Date().toISOString(),
    };
    await writeFile(ORCHESTRATOR_STATE_PATH, `${JSON.stringify(recoveryRecord, null, 2)}\n`, 'utf8');
    const recovered = await restartInterruptedShot(config, recoveryRecord);
    const pausedForMs = Math.max(0, now.getTime() - new Date(record.pausedAt || now).getTime());
    const next = {
      ...recoveryRecord,
      mode: 'running',
      rootPids: recovered.workerPids,
      pausedAt: null,
      changedAt: new Date().toISOString(),
      restartedAt: new Date().toISOString(),
      restartedShot: recovered.shot,
      recoveryScript: recovered.script,
      archivedInterruptedFiles: recovered.archived,
      recoveryReason: null,
      trackPausedMs: Number(record.trackPausedMs || 0) + pausedForMs,
      shotPausedMs: Number(record.shotPausedMs || 0) + pausedForMs,
    };
    await writeFile(ORCHESTRATOR_STATE_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return getControlView(next, recovered.status, config);
  }
  const pausedForMs = Math.max(0, now.getTime() - new Date(record.pausedAt || now).getTime());
  const next = {
    ...record, mode: 'running', rootPids: [], affectedPids: [], pausedAt: null,
    changedAt: now.toISOString(), resumedAt: now.toISOString(), recoveryReason: null,
    trackPausedMs: Number(record.trackPausedMs || 0) + pausedForMs,
    shotPausedMs: Number(record.shotPausedMs || 0) + pausedForMs,
  };
  await writeFile(ORCHESTRATOR_STATE_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return getControlView(next, status, config);
}

async function getStudioRecord() {
  return normalizeStudioRecord(await readJson(STUDIO_STATE_PATH, null));
}

async function writeStudioRecord(record) {
  record.updatedAt = new Date().toISOString();
  await writeFile(STUDIO_STATE_PATH, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

function resolveStudioPlan(config) {
  const sourceRunner = path.resolve(config.studioSourceRunner || path.join(config.comfyRoot, 'run_full_album_auto.py'));
  if (!isInside(sourceRunner, [config.comfyRoot]) || path.extname(sourceRunner).toLowerCase() !== '.py' || !existsSync(sourceRunner) || !existsSync(STUDIO_RUNNER_PATH)) return null;
  const candidates = [
    path.join(config.comfyRoot, 'venv', 'Scripts', 'pythonw.exe'),
    path.join(config.comfyRoot, '.venv', 'Scripts', 'pythonw.exe'),
    path.join(config.comfyRoot, 'python_embeded', 'pythonw.exe'),
    path.join(config.comfyRoot, 'python', 'pythonw.exe'),
    path.join(config.comfyRoot, 'venv', 'Scripts', 'python.exe'),
    path.join(config.comfyRoot, '.venv', 'Scripts', 'python.exe'),
    path.join(config.comfyRoot, 'python_embeded', 'python.exe'),
    path.join(config.comfyRoot, 'python', 'python.exe'),
  ];
  const executable = candidates.find(existsSync);
  return executable ? { executable, sourceRunner } : null;
}

function planTracks(plan) {
  return Object.values(plan || {}).flatMap((worker) => Array.isArray(worker?.tracks) ? worker.tracks : []);
}

async function sourceRunnerPlanTracks(config) {
  const launch = resolveStudioPlan(config);
  if (!launch) return [];
  const info = await stat(launch.sourceRunner).catch(() => null);
  const key = `${launch.sourceRunner.toLowerCase()}:${Number(info?.mtimeMs || 0)}`;
  const now = Date.now();
  if (sourcePlanCache.key === key && sourcePlanCache.expiresAt > now) return sourcePlanCache.value;
  if (sourcePlanCache.key === key && sourcePlanCache.promise) return sourcePlanCache.promise;

  const promise = (async () => {
    const output = await execFileAsync(launch.executable, [STUDIO_RUNNER_PATH, '--inspect-source', launch.sourceRunner], { timeout: 15_000, maxBuffer: 2_000_000 });
    if (!output) return [];
    try {
      const parsed = JSON.parse(output);
      return Array.isArray(parsed) ? parsed.slice(0, 5_000) : [];
    } catch { return []; }
  })();
  sourcePlanCache = { key, expiresAt: now + 60_000, value: sourcePlanCache.key === key ? sourcePlanCache.value : [], promise };
  const value = await promise;
  sourcePlanCache = { key, expiresAt: Date.now() + 60_000, value, promise: null };
  return value;
}

async function projectPlanTracks(config, activePlan) {
  return mergeProjectPlanItems(planTracks(activePlan), await sourceRunnerPlanTracks(config));
}

function finalSlugSet(finals) {
  return new Set(finals.map((file) => path.basename(file.fullPath).replace(/_LTX[0-9P.]*_FULL\.mp4$/i, '').toLowerCase()));
}

function studioQueueItems(plan, current, finals, record, workerBusy) {
  const finished = finalSlugSet(finals);
  const available = planTracks(plan).filter((item) => {
    if (!item?.section || !item?.track || !item?.slug || finished.has(String(item.slug).toLowerCase())) return false;
    if (workerBusy && item.slug === current?.slug) return false;
    if (!parseShotRange(item.shots, item.count).length) return false;
    return record.scenes?.[sceneKey(item)]?.status !== 'accepted';
  });
  return normalizeQueueOrder(available, record.queueOrder);
}

function safeStudioSegment(value) {
  const result = String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  if (!result) throw new Error('Studio could not create a safe scene path.');
  return result;
}

async function findShotOutput(config, slug, shot) {
  const directory = path.resolve(config.clipsDirectory, slug);
  if (!isInside(directory, [config.clipsDirectory])) throw new Error('Studio shot output is outside the configured clips folder.');
  let names = [];
  try { names = await readdir(directory); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const candidates = [];
  for (const name of names) {
    if (!(name.startsWith(`${shot}_`) || name === `${shot}${path.extname(name)}`) || !VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase())) continue;
    const fullPath = path.join(directory, name);
    try {
      const info = await stat(fullPath);
      if (info.size > 100_000) candidates.push({ fullPath, size: info.size, modifiedMs: info.mtimeMs });
    } catch { /* an output can move while Studio refreshes */ }
  }
  return candidates.sort((a, b) => b.modifiedMs - a.modifiedMs)[0] || null;
}

async function studioVideo(filePath, config, title) {
  if (!filePath || !isInside(filePath, [config.clipsDirectory, STUDIO_RUNTIME_ROOT])) return null;
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size <= 100_000 || !VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return null;
    const file = { fullPath: filePath, size: info.size, modifiedMs: info.mtimeMs };
    const meta = await probeVideo(file, config);
    return {
      id: encodePath(filePath),
      title,
      filename: path.basename(filePath),
      kind: 'clip',
      size: info.size,
      modifiedAt: new Date(info.mtimeMs).toISOString(),
      mediaUrl: `http://127.0.0.1:${PORT}/media/${encodePath(filePath)}`,
      directory: path.dirname(filePath),
      ...meta,
    };
  } catch { return null; }
}

async function archiveStudioOutput(config, item, shot, scene) {
  const output = await findShotOutput(config, item.slug, shot);
  if (!output) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveDirectory = path.join(STUDIO_RUNTIME_ROOT, 'attempts', safeStudioSegment(item.section), safeStudioSegment(item.slug), safeStudioSegment(shot), stamp);
  await mkdir(archiveDirectory, { recursive: true });
  const destination = path.join(archiveDirectory, path.basename(output.fullPath));
  await moveFile(output.fullPath, destination);

  const attempts = Array.isArray(scene.attempts[shot]) ? scene.attempts[shot] : [];
  const recorded = attempts.find((attempt) => attempt.videoPath === output.fullPath);
  if (recorded) {
    recorded.videoPath = destination;
    if (recorded.status === 'review') recorded.status = 'superseded';
  } else {
    attempts.push({
      id: `imported-${randomBytes(6).toString('hex')}`,
      status: 'superseded',
      correction: '',
      startedAt: new Date(output.modifiedMs).toISOString(),
      completedAt: new Date(output.modifiedMs).toISOString(),
      videoPath: destination,
      imported: true,
    });
  }
  scene.attempts[shot] = attempts;
  return destination;
}

async function startStudioJob({ config, record, item, scene, shot, correction, metadata = {} }) {
  const launch = resolveStudioPlan(config);
  if (!launch) throw new Error('Studio needs a compatible source runner and ComfyUI Python environment.');
  await archiveStudioOutput(config, item, shot, scene);

  const id = randomBytes(12).toString('hex');
  const jobsDirectory = path.join(STUDIO_RUNTIME_ROOT, 'jobs');
  await mkdir(jobsDirectory, { recursive: true });
  const jobPath = path.join(jobsDirectory, `${id}.json`);
  const resultPath = path.join(jobsDirectory, `${id}.result.json`);
  const startedAt = new Date().toISOString();
  await writeFile(jobPath, `${JSON.stringify({
    sourceRunner: launch.sourceRunner,
    section: item.section,
    track: item.track,
    slug: item.slug,
    shot,
    correction,
    port: config.studioPort,
    cudaDevice: config.studioGpu,
    resultPath,
  }, null, 2)}\n`, 'utf8');
  const attempt = { id, status: 'generating', correction, startedAt, completedAt: null, videoPath: null };
  scene.attempts[shot] = [...(Array.isArray(scene.attempts[shot]) ? scene.attempts[shot] : []), attempt];
  scene.currentShot = shot;
  scene.status = 'generating';
  scene.updatedAt = startedAt;
  record.selectedSceneKey = item.sceneKey;
  record.activeJob = { id, sceneKey: item.sceneKey, slug: item.slug, shot, pid: null, jobPath, resultPath, startedAt, ...metadata };
  await writeStudioRecord(record);

  const logHandle = await open(path.join(APP_ROOT, 'studio.log'), 'a');
  try {
    const child = spawn(launch.executable, [STUDIO_RUNNER_PATH, '--job', jobPath], {
      cwd: config.comfyRoot,
      detached: true,
      stdio: ['ignore', logHandle.fd, logHandle.fd],
      windowsHide: true,
    });
    await new Promise((resolveSpawn, rejectSpawn) => {
      child.once('spawn', resolveSpawn);
      child.once('error', rejectSpawn);
    });
    record.activeJob.pid = child.pid;
    child.unref();
    await writeStudioRecord(record);
  } catch (error) {
    attempt.status = 'failed';
    attempt.completedAt = new Date().toISOString();
    attempt.error = error instanceof Error ? error.message : 'Studio runner could not start.';
    scene.status = 'failed';
    record.activeJob = null;
    await writeStudioRecord(record);
    throw error;
  } finally {
    await logHandle.close();
  }
  return { id, startedAt };
}

async function syncStudioJob(record, config) {
  const job = record.activeJob;
  if (!job) return false;
  const scene = record.scenes?.[job.sceneKey];
  const attempt = scene?.attempts?.[job.shot]?.find((item) => item.id === job.id);
  if (!scene || !attempt || !isInside(job.resultPath, [STUDIO_RUNTIME_ROOT])) {
    record.activeJob = null;
    return true;
  }
  const result = await readJson(job.resultPath, null);
  const runnerPid = Number(result?.runnerPid || job.pid);
  if ((!result || result.status === 'generating') && processExists(runnerPid)) return false;

  if (result?.status === 'review' && typeof result.outputPath === 'string' && isInside(result.outputPath, [config.clipsDirectory])) {
    const output = await studioVideo(result.outputPath, config, 'Studio review output');
    if (output) {
      attempt.status = 'review';
      attempt.completedAt = result.completedAt || new Date().toISOString();
      attempt.videoPath = result.outputPath;
      scene.status = 'review';
      scene.currentShot = job.shot;
      scene.updatedAt = attempt.completedAt;
      record.activeJob = null;
      return true;
    }
  }

  attempt.status = 'failed';
  attempt.completedAt = result?.completedAt || new Date().toISOString();
  attempt.error = String(result?.error || 'The Studio runner ended without producing a reviewable video.').slice(0, 500);
  scene.status = 'failed';
  scene.currentShot = job.shot;
  scene.updatedAt = attempt.completedAt;
  record.activeJob = null;
  return true;
}

async function buildStudioView(config, status, plan, current, finals, comfy) {
  const record = await getStudioRecord();
  const createRecord = await getCreateRecord();
  let changed = await syncStudioJob(record, config);
  const liveWorkers = getWorkerPids(status).filter(processExists);
  const workerBusy = liveWorkers.length > 0;
  const queue = studioQueueItems(plan, current, finals, record, workerBusy);
  const validKeys = new Set(queue.map((item) => item.sceneKey));
  if (!record.selectedSceneKey || !validKeys.has(record.selectedSceneKey)) {
    record.selectedSceneKey = queue[0]?.sceneKey || null;
    changed = true;
  }

  const selectedItem = queue.find((item) => item.sceneKey === record.selectedSceneKey) || null;
  let selectedScene = null;
  if (selectedItem) {
    const scene = ensureSceneRecord(record, selectedItem);
    const shots = parseShotRange(selectedItem.shots, selectedItem.count);
    if (!scene.currentShot || !shots.includes(scene.currentShot) || scene.acceptedShots.includes(scene.currentShot)) {
      scene.currentShot = nextUnacceptedShot(shots, scene.acceptedShots);
      changed = true;
    }
    const currentShot = scene.currentShot;
    const shotItems = [];
    for (const shot of shots) {
      const output = await findShotOutput(config, selectedItem.slug, shot);
      const generating = record.activeJob?.sceneKey === selectedItem.sceneKey && record.activeJob?.shot === shot;
      const accepted = scene.acceptedShots.includes(shot);
      shotItems.push({
        shot,
        status: accepted ? 'accepted' : generating ? 'generating' : output ? 'review' : shot === currentShot ? 'ready' : 'queued',
        hasOutput: Boolean(output),
      });
    }
    const output = currentShot ? await findShotOutput(config, selectedItem.slug, currentShot) : null;
    const reviewVideo = output ? await studioVideo(output.fullPath, config, `${selectedItem.track} · Shot ${currentShot}`) : null;
    const attempts = [];
    for (const attempt of (scene.attempts[currentShot] || []).slice().reverse()) {
      const video = attempt.videoPath ? await studioVideo(attempt.videoPath, config, `${selectedItem.track} · Shot ${currentShot}`) : null;
      attempts.push({
        id: attempt.id,
        status: attempt.status,
        correction: attempt.correction || '',
        startedAt: attempt.startedAt || null,
        completedAt: attempt.completedAt || null,
        error: attempt.error || null,
        imported: Boolean(attempt.imported),
        video,
      });
    }
    selectedScene = {
      ...selectedItem,
      currentShot,
      acceptedCount: scene.acceptedShots.length,
      shots: shotItems,
      reviewVideo,
      attempts,
      status: scene.status,
    };
  }

  if (changed) await writeStudioRecord(record);
  const adapterReady = Boolean(resolveStudioPlan(config));
  const activeJob = record.activeJob;
  const canGenerate = Boolean(selectedScene?.currentShot && adapterReady && !activeJob && !createRecord.activeJobId && !workerBusy && !comfy.online);
  const blockedReason = activeJob
    ? `Studio is generating shot ${activeJob.shot}.`
    : createRecord.activeJobId
      ? 'Create is using the local generation adapter.'
    : workerBusy
      ? 'The album worker is still active. Studio will unlock after it finishes.'
      : comfy.online
        ? `ComfyUI port ${config.studioPort} is already in use. Studio requires an idle port.`
        : !adapterReady
          ? 'Configure a compatible Studio source runner and ComfyUI Python environment.'
          : !selectedScene
            ? 'There are no scenes waiting in the Studio queue.'
            : null;
  return {
    enabled: true,
    adapterReady,
    canGenerate,
    blockedReason,
    activeJob: activeJob ? { sceneKey: activeJob.sceneKey, shot: activeJob.shot, startedAt: activeJob.startedAt } : null,
    queue: queue.map((item) => {
      const scene = record.scenes?.[item.sceneKey];
      return { ...item, studioStatus: scene?.status || 'queued', acceptedCount: scene?.acceptedShots?.length || 0 };
    }),
    selectedScene,
  };
}

async function loadStudioContext() {
  const config = await getConfig();
  const [status, plan, logText, finals, comfy, record] = await Promise.all([
    readJson(config.statusFile, {}),
    readJson(config.planFile, {}),
    readTail(config.logFile),
    walkVideos(config.finalsDirectory, 'final', config.maxVideos),
    getComfyQueue(config),
    getStudioRecord(),
  ]);
  if (await syncStudioJob(record, config)) await writeStudioRecord(record);
  const current = parseLog(logText).current;
  const workerBusy = getWorkerPids(status).filter(processExists).length > 0;
  const queue = studioQueueItems(plan, current, finals, record, workerBusy);
  return { config, status, plan, current, finals, comfy, record, workerBusy, queue };
}

async function controlStudio(body) {
  if (studioMutationInFlight) throw new Error('Another Studio action is still being saved.');
  studioMutationInFlight = true;
  try {
    const context = await loadStudioContext();
    const { config, status, plan, current, finals, comfy, record, workerBusy, queue } = context;
    const action = String(body?.action || '');
    const targetKey = String(body?.sceneKey || record.selectedSceneKey || '');
    const item = queue.find((entry) => entry.sceneKey === targetKey);

    if (action === 'select') {
      if (!item) throw new Error('The selected scene is not available in the Studio queue.');
      record.selectedSceneKey = item.sceneKey;
      const scene = ensureSceneRecord(record, item);
      const shots = parseShotRange(item.shots, item.count);
      scene.currentShot = nextUnacceptedShot(shots, scene.acceptedShots);
      await writeStudioRecord(record);
      return buildStudioView(config, status, plan, current, finals, comfy);
    }

    if (action === 'move-first') {
      if (!item) throw new Error('The selected scene is not available in the Studio queue.');
      record.queueOrder = moveSceneFirst(queue, record.queueOrder, item.sceneKey);
      record.selectedSceneKey = item.sceneKey;
      await writeStudioRecord(record);
      return buildStudioView(config, status, plan, current, finals, comfy);
    }

    if (!item) throw new Error('Select a queued scene before using Studio controls.');
    const scene = ensureSceneRecord(record, item);
    const shots = parseShotRange(item.shots, item.count);
    const shot = String(body?.shot || scene.currentShot || '');
    if (!shots.includes(shot)) throw new Error('The selected shot does not belong to this scene.');
    if (record.activeJob) throw new Error('A Studio shot is already generating.');

    if (action === 'accept') {
      const output = await findShotOutput(config, item.slug, shot);
      if (!output) throw new Error('Generate or import a reviewable output before accepting this shot.');
      const attempts = Array.isArray(scene.attempts[shot]) ? scene.attempts[shot] : [];
      let attempt = attempts.find((entry) => entry.status === 'review' && entry.videoPath === output.fullPath);
      if (!attempt) {
        attempt = {
          id: `imported-${randomBytes(6).toString('hex')}`,
          status: 'review',
          correction: '',
          startedAt: new Date(output.modifiedMs).toISOString(),
          completedAt: new Date(output.modifiedMs).toISOString(),
          videoPath: output.fullPath,
          imported: true,
        };
        attempts.push(attempt);
      }
      attempt.status = 'accepted';
      attempt.acceptedAt = new Date().toISOString();
      scene.attempts[shot] = attempts;
      scene.acceptedShots = [...new Set([...scene.acceptedShots, shot])];
      scene.currentShot = nextUnacceptedShot(shots, scene.acceptedShots);
      scene.status = scene.currentShot ? 'reviewing' : 'accepted';
      scene.updatedAt = new Date().toISOString();
      if (!scene.currentShot) {
        const remaining = studioQueueItems(plan, current, finals, record, workerBusy);
        record.selectedSceneKey = remaining.find((entry) => entry.sceneKey !== item.sceneKey)?.sceneKey || null;
      }
      await writeStudioRecord(record);
      return buildStudioView(config, status, plan, current, finals, comfy);
    }

    if (action !== 'generate') throw new Error('Unsupported Studio action.');
    if (generationLaunchInFlight) throw new Error('Another local generation job is claiming the adapter. Try again in a moment.');
    const createRecord = await getCreateRecord();
    if (createRecord.activeJobId) throw new Error('Create is already using the local generation adapter. Studio will wait safely.');
    if (workerBusy) throw new Error('The album worker is still active. Wait for it to finish before starting Studio.');
    if (comfy.online) throw new Error(`ComfyUI port ${config.studioPort} is active. Studio will not compete for the GPU or port.`);
    const correction = cleanCorrection(body?.correction);
    generationLaunchInFlight = true;
    try {
      await startStudioJob({ config, record, item, scene, shot, correction });
    } finally {
      generationLaunchInFlight = false;
    }
    return buildStudioView(config, status, plan, current, finals, comfy);
  } finally {
    studioMutationInFlight = false;
  }
}

async function getCreateRecord() {
  return normalizeCreateRecord(await readJson(CREATE_STATE_PATH, null));
}

async function writeCreateRecord(record) {
  record.updatedAt = new Date().toISOString();
  await writeFile(CREATE_STATE_PATH, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

function createTemplateCandidates(config, name) {
  return [
    path.join(config.comfyRoot, 'venv', 'Lib', 'site-packages', 'comfyui_workflow_templates_json', 'templates', name),
    path.join(config.comfyRoot, '.venv', 'Lib', 'site-packages', 'comfyui_workflow_templates_json', 'templates', name),
    path.join(config.comfyRoot, 'python_embeded', 'Lib', 'site-packages', 'comfyui_workflow_templates_json', 'templates', name),
  ];
}

function resolveCreatePlan(config) {
  const studio = resolveStudioPlan(config);
  if (!studio || !existsSync(CREATE_RUNNER_PATH)) return null;
  const templates = {
    text: createTemplateCandidates(config, 'video_ltx2_5_t2v.json').find(existsSync) || null,
    firstFrame: createTemplateCandidates(config, 'video_ltx2_5_i2v.json').find(existsSync) || null,
    firstLast: createTemplateCandidates(config, 'video_ltx2_5_flf2v.json').find(existsSync) || null,
  };
  return { ...studio, templates };
}

async function getCreateBackbones(config) {
  const record = await getProjectsRecord();
  const result = [];
  for (const project of Object.values(record.projects || {})) {
    if (!project?.blenderBackboneAssetId) continue;
    const assets = await projectAssets(project, config);
    const asset = assets.find((item) => item.id === project.blenderBackboneAssetId && path.extname(item.fullPath).toLowerCase() === '.blend');
    if (!asset || !isInside(asset.fullPath, projectRoots({ projects: { [project.id]: project } }))) continue;
    result.push({ projectId: project.id, projectName: project.name, assetName: asset.name, fullPath: asset.fullPath, rootPath: project.rootPath });
  }
  return result;
}

async function getCachedBlender() {
  if (blenderCache.expiresAt > Date.now()) return blenderCache.value;
  const found = await findBlenderInstallation();
  blenderCache = { expiresAt: Date.now() + 120_000, value: found };
  return found;
}

async function createVideo(filePath, config, title) {
  return studioVideo(filePath, config, title);
}

async function syncCreateJob(record, config) {
  const id = record.activeJobId;
  if (!id) return false;
  const job = record.jobs[id];
  if (!job) {
    record.activeJobId = null;
    return true;
  }
  if (!isInside(job.resultPath, [CREATE_RUNTIME_ROOT])) {
    job.status = 'failed';
    job.error = 'Create job result path is outside the private runtime folder.';
    job.completedAt = new Date().toISOString();
    record.activeJobId = null;
    return true;
  }
  const result = await readJson(job.resultPath, null);
  const runnerPid = Number(result?.runnerPid || job.pid);
  if ((!result || result.status === 'generating') && processExists(runnerPid)) {
    job.stage = String(result?.stage || job.stage || 'Starting local runner').slice(0, 120);
    job.progress = Math.min(99, Math.max(Number(job.progress || 0), Number(result?.progress || 0)));
    job.promptId = typeof result?.promptId === 'string' ? result.promptId : job.promptId || null;
    return true;
  }
  if (result?.status === 'complete' && typeof result.outputPath === 'string' && isInside(result.outputPath, [config.clipsDirectory])) {
    const output = await createVideo(result.outputPath, config, job.title);
    if (output) {
      job.status = 'complete';
      job.stage = 'Complete';
      job.progress = 100;
      job.outputPath = result.outputPath;
      job.completedAt = result.completedAt || new Date().toISOString();
      record.activeJobId = null;
      return true;
    }
  }
  job.status = 'failed';
  job.stage = 'Failed';
  job.error = String(result?.error || 'The local Create runner ended without producing a reviewable video.').slice(0, 500);
  job.completedAt = result?.completedAt || new Date().toISOString();
  record.activeJobId = null;
  return true;
}

async function startCreateJob(record, job, config, backbone) {
  const launch = resolveCreatePlan(config);
  if (!launch) throw new Error('Create needs a compatible local LTX runner, ComfyUI Python, and the bundled Create adapter.');
  const templateKey = job.options.referenceMode === 'first-last' ? 'firstLast' : job.options.referenceMode === 'first-frame' || job.options.useBlender ? 'firstFrame' : 'text';
  if (!launch.templates[templateKey]) throw new Error('The matching official ComfyUI LTX 2.5 workflow template is not installed. Update ComfyUI templates first.');
  const jobsDirectory = path.join(CREATE_RUNTIME_ROOT, 'jobs', job.id);
  await mkdir(jobsDirectory, { recursive: true });
  const jobPath = path.join(jobsDirectory, 'job.json');
  const resultPath = path.join(jobsDirectory, 'result.json');
  const referencePaths = [];
  for (const source of [job.options.firstFramePath, job.options.lastFramePath].filter(Boolean)) {
    if (!isInside(source, [CREATE_RUNTIME_ROOT])) throw new Error('Create reference frames must be uploaded through the local interface.');
    const info = await stat(source).catch(() => null);
    if (!info?.isFile()) throw new Error('An uploaded Create reference frame is no longer available.');
    const destination = path.join(jobsDirectory, `reference-${referencePaths.length + 1}${path.extname(source).toLowerCase()}`);
    await copyFile(source, destination);
    referencePaths.push(destination);
  }
  const copyContextFile = async (source, label, expectedKinds) => {
    if (!source) return null;
    const extension = path.extname(source).toLowerCase();
    if (!isInside(source, [CREATE_RUNTIME_ROOT]) || !expectedKinds.includes(CREATE_CONTEXT_EXTENSIONS.get(extension))) throw new Error(`The ${label} context is not a supported private Create upload.`);
    const info = await stat(source).catch(() => null);
    if (!info?.isFile()) throw new Error(`The ${label} context file is no longer available.`);
    const destination = path.join(jobsDirectory, `${label}${extension}`);
    await copyFile(source, destination);
    return destination;
  };
  const videoContextPath = await copyContextFile(job.options.contextVideoPath, 'context-video', ['video']);
  const soundtrackPath = await copyContextFile(job.options.soundtrackPath, 'soundtrack', ['audio']);
  const blender = job.options.useBlender ? await getCachedBlender() : null;
  if (job.options.useBlender && (!blender?.executable || !backbone)) throw new Error('Blender and a selected or dropped .blend backbone are required for this mode.');
  const outputPrefix = `video/ltx-watch-create/${job.id}`;
  const payload = {
    id: job.id,
    sourceRunner: launch.sourceRunner,
    comfyRoot: path.resolve(config.comfyRoot),
    runtimeRoot: jobsDirectory,
    resultPath,
    prompt: composeCreatePrompt(job.options),
    promptEnhance: job.options.promptEnhance,
    duration: job.options.duration,
    width: job.options.width,
    height: job.options.height,
    frameRate: job.options.frameRate,
    seed: job.seed,
    audio: job.options.audio,
    referenceMode: job.options.referenceMode,
    referencePaths,
    videoContextPath,
    soundtrackPath,
    useBlender: job.options.useBlender,
    blenderExecutable: blender?.executable || null,
    blenderProjectPath: backbone?.fullPath || null,
    allowedProjectRoots: backbone ? [backbone.rootPath] : [],
    blenderFirstFrame: job.options.blenderFirstFrame,
    blenderLastFrame: job.options.blenderLastFrame,
    port: config.studioPort,
    cudaDevice: config.studioGpu,
    safer: false,
    outputPrefix,
    timeoutSeconds: 7_200,
  };
  await writeFile(jobPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await writeFile(resultPath, `${JSON.stringify({ status: 'generating', stage: 'Starting local runner', progress: 0 }, null, 2)}\n`, 'utf8');
  const logHandle = await open(path.join(jobsDirectory, 'runner.log'), 'a');
  try {
    const child = spawn(launch.executable, [CREATE_RUNNER_PATH, '--job', jobPath], {
      cwd: config.comfyRoot,
      detached: true,
      stdio: ['ignore', logHandle.fd, logHandle.fd],
      windowsHide: true,
    });
    await new Promise((resolveSpawn, rejectSpawn) => {
      child.once('spawn', resolveSpawn);
      child.once('error', rejectSpawn);
    });
    const startedAt = new Date().toISOString();
    Object.assign(job, { status: 'generating', stage: 'Starting local runner', progress: 1, pid: child.pid, jobPath, resultPath, startedAt, completedAt: null, error: null });
    record.activeJobId = job.id;
    child.unref();
  } finally {
    await logHandle.close();
  }
}

async function maybeStartCreateJob(record, config) {
  if (record.activeJobId || record.queuePaused || studioMutationInFlight || createMutationInFlight || generationLaunchInFlight) return false;
  generationLaunchInFlight = true;
  try {
    const [studio, freshStatus, freshComfy] = await Promise.all([getStudioRecord(), readJson(config.statusFile, {}), getComfyQueue(config)]);
    if (studio.activeJob || getWorkerPids(freshStatus).some(processExists) || freshComfy.online) return false;
    const nextId = record.queue.find((id) => record.jobs[id]?.status === 'queued');
    if (!nextId) return false;
    const job = record.jobs[nextId];
    const backbones = job.options.useBlender && !job.options.blenderUploadPath ? await getCreateBackbones(config) : [];
    const uploadedBackbone = job.options.blenderUploadPath && isInside(job.options.blenderUploadPath, [CREATE_RUNTIME_ROOT]) && path.extname(job.options.blenderUploadPath).toLowerCase() === '.blend' && existsSync(job.options.blenderUploadPath)
      ? { fullPath: job.options.blenderUploadPath, rootPath: CREATE_RUNTIME_ROOT }
      : null;
    const backbone = uploadedBackbone || backbones.find((item) => item.projectId === job.options.blenderProjectId) || null;
    try {
      await startCreateJob(record, job, config, backbone);
    } catch (error) {
      job.status = 'failed';
      job.stage = 'Failed before launch';
      job.error = error instanceof Error ? error.message.slice(0, 500) : 'Create job could not start.';
      job.completedAt = new Date().toISOString();
    }
    return true;
  } finally {
    generationLaunchInFlight = false;
  }
}

async function buildCreateView({ sync = false } = {}) {
  const config = await getConfig();
  const [status, comfy, record, studio, backbones, blender] = await Promise.all([
    readJson(config.statusFile, {}), getComfyQueue(config), getCreateRecord(), getStudioRecord(), getCreateBackbones(config), getCachedBlender(),
  ]);
  let changed = await syncCreateJob(record, config);
  if (sync && await maybeStartCreateJob(record, config)) changed = true;
  if (changed) await writeCreateRecord(record);
  const launch = resolveCreatePlan(config);
  const workerBusy = getWorkerPids(status).some(processExists);
  const activeJob = record.activeJobId ? record.jobs[record.activeJobId] : null;
  const queued = record.queue.filter((id) => record.jobs[id]?.status === 'queued').length;
  const adapterReady = Boolean(launch?.templates.text);
  const canStart = Boolean(adapterReady && !activeJob && !studio.activeJob && !workerBusy && !comfy.online && !record.queuePaused);
  const blockedReason = activeJob
    ? `Creating ${activeJob.title}.`
    : studio.activeJob
      ? 'Studio is using the local generation adapter.'
      : workerBusy
        ? 'The album worker is still active. Create will wait safely in its queue.'
        : comfy.online
          ? `ComfyUI port ${config.studioPort} is already active. Create will not compete for it.`
          : !adapterReady
            ? 'Install or update the official ComfyUI LTX 2.5 workflow templates.'
            : record.queuePaused
              ? 'The Create queue is paused.'
              : null;
  const jobs = [];
  for (const id of record.queue.slice().reverse()) {
    const job = record.jobs[id];
    if (!job) continue;
    const video = job.outputPath ? await createVideo(job.outputPath, config, job.title) : null;
    jobs.push({
      id: job.id, title: job.title, status: job.status, stage: job.stage || null, progress: Number(job.progress || 0),
      seed: job.seed, variation: job.variation, variations: job.variations, createdAt: job.createdAt,
      startedAt: job.startedAt || null, completedAt: job.completedAt || null, error: job.error || null,
      summary: `${job.options.width}×${job.options.height} · ${job.options.duration}s · ${job.options.frameRate} fps`,
      mode: job.options.useBlender ? 'Blender' : job.options.referenceMode === 'text' ? 'Text' : job.options.referenceMode === 'first-last' ? 'First + last frame' : 'First frame',
      video,
    });
  }
  return {
    enabled: true,
    adapterReady,
    canStart,
    blockedReason,
    queuePaused: record.queuePaused,
    queued,
    activeJobId: record.activeJobId,
    draft: { ...createDefaultDraft(), ...record.draft },
    resolutions: resolutionOptions(),
    templates: {
      text: Boolean(launch?.templates.text), firstFrame: Boolean(launch?.templates.firstFrame), firstLast: Boolean(launch?.templates.firstLast),
    },
    blender: { installed: Boolean(blender?.executable), version: blender?.version?.text || null, backbones: backbones.map((item) => ({ projectId: item.projectId, projectName: item.projectName, assetName: item.assetName })) },
    jobs,
  };
}

async function controlCreate(body) {
  if (createMutationInFlight) throw new Error('Another Create action is still being saved.');
  createMutationInFlight = true;
  try {
    const record = await getCreateRecord();
    const action = String(body?.action || '');
    if (action === 'save-draft') {
      record.draft = cleanCreateDraft(body?.draft);
    } else if (action === 'enqueue') {
      const options = normalizeCreateOptions(body?.draft);
      for (const privatePath of [options.firstFramePath, options.lastFramePath, options.contextVideoPath, options.soundtrackPath, options.blenderUploadPath].filter(Boolean)) {
        if (!isInside(privatePath, [CREATE_RUNTIME_ROOT]) || !existsSync(privatePath)) throw new Error('Upload Create context through the local interface before queuing.');
      }
      const config = await getConfig();
      const backbones = options.useBlender ? await getCreateBackbones(config) : [];
      if (options.useBlender && !options.blenderUploadPath && !backbones.some((item) => item.projectId === options.blenderProjectId)) throw new Error('Choose a project with an assigned .blend backbone or drop a .blend file.');
      if (options.useBlender && !(await getCachedBlender())?.executable) throw new Error('Blender is not detected. Install Blender or switch to a non-Blender creation mode.');
      const seeds = createJobSeeds(options);
      const groupId = randomBytes(8).toString('hex');
      for (const [index, seed] of seeds.entries()) {
        const id = `create-${randomBytes(10).toString('hex')}`;
        record.jobs[id] = {
          id,
          groupId,
          title: safeCreateTitle(options.title, id),
          options,
          seed,
          variation: index + 1,
          variations: seeds.length,
          status: 'queued',
          stage: 'Waiting safely for the GPU',
          progress: 0,
          createdAt: new Date().toISOString(),
          startedAt: null,
          completedAt: null,
          outputPath: null,
          error: null,
        };
        record.queue.push(id);
      }
      record.draft = { ...options, width: undefined, height: undefined, label: undefined };
    } else if (action === 'toggle-queue') {
      record.queuePaused = body?.paused === true;
    } else if (action === 'move-first') {
      const id = String(body?.jobId || '');
      if (record.jobs[id]?.status !== 'queued') throw new Error('Only a queued Create job can move first.');
      record.queue = [id, ...record.queue.filter((item) => item !== id)];
    } else if (action === 'remove') {
      const id = String(body?.jobId || '');
      if (record.jobs[id]?.status === 'generating') throw new Error('An active Create job cannot be removed.');
      record.queue = record.queue.filter((item) => item !== id);
      delete record.jobs[id];
    } else if (action === 'retry') {
      const id = String(body?.jobId || '');
      const source = record.jobs[id];
      if (!source || source.status !== 'failed') throw new Error('Only a failed Create job can be retried.');
      source.status = 'queued';
      source.stage = 'Waiting safely for the GPU';
      source.progress = 0;
      source.startedAt = null;
      source.completedAt = null;
      source.error = null;
      source.pid = null;
      source.promptId = null;
    } else if (action === 'upload-start') {
      const fileName = path.basename(String(body?.fileName || '')).replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 180);
      const extension = path.extname(fileName).toLowerCase();
      const kind = CREATE_CONTEXT_EXTENSIONS.get(extension);
      if (!kind) throw new Error('Create context supports images, MP4/WebM/MOV/MKV video, WAV/MP3/FLAC/M4A/OGG/AAC audio, and .blend files.');
      const size = Math.max(0, Math.trunc(Number(body?.size) || 0));
      const maximum = kind === 'image' ? 100 * 1024 * 1024 : kind === 'audio' ? 2 * 1024 * 1024 * 1024 : 8 * 1024 * 1024 * 1024;
      if (!size || size > maximum) throw new Error(`The ${kind} context file exceeds the ${Math.round(maximum / 1024 / 1024)} MB limit.`);
      const id = randomBytes(18).toString('hex');
      const root = path.join(CREATE_RUNTIME_ROOT, 'uploads');
      await mkdir(root, { recursive: true });
      const temporaryPath = path.join(root, `${id}.part`);
      const destinationPath = path.join(root, `${id}${extension}`);
      await writeFile(temporaryPath, Buffer.alloc(0));
      createUploads.set(id, { id, fileName, kind, size, received: 0, temporaryPath, destinationPath, createdAt: Date.now() });
      return { upload: { id, kind, received: 0, size } };
    } else if (action === 'upload-finish') {
      const id = String(body?.uploadId || '');
      const upload = createUploads.get(id);
      if (!upload) throw new Error('The Create upload session expired.');
      if (upload.received !== upload.size) throw new Error(`Upload is incomplete: received ${upload.received} of ${upload.size} bytes.`);
      await rename(upload.temporaryPath, upload.destinationPath);
      createUploads.delete(id);
      return { upload: { id, fileName: upload.fileName, kind: upload.kind, path: upload.destinationPath, size: upload.size } };
    } else if (action === 'refresh') {
      return buildCreateView({ sync: true });
    } else {
      throw new Error('Unsupported Create action.');
    }
    await writeCreateRecord(record);
    return buildCreateView({ sync: false });
  } finally {
    createMutationInFlight = false;
  }
}

async function appendCreateUpload(req, uploadId) {
  const upload = createUploads.get(uploadId);
  if (!upload) throw new Error('The Create upload session expired. Start the upload again.');
  const requestedOffset = Math.max(0, Math.trunc(Number(req.headers['x-ltx-upload-offset']) || 0));
  if (requestedOffset !== upload.received) throw new Error(`Upload offset mismatch. Expected ${upload.received}.`);
  const chunk = await readBinaryBody(req);
  if (chunk.length > CREATE_UPLOAD_CHUNK_LIMIT || upload.received + chunk.length > upload.size) throw new Error('The reference upload chunk is invalid.');
  await appendFile(upload.temporaryPath, chunk);
  upload.received += chunk.length;
  return { id: uploadId, received: upload.received, size: upload.size };
}

async function getProjectsRecord() {
  return normalizeProjectsRecord(await readJson(PROJECTS_STATE_PATH, createProjectsRecord()));
}

async function writeProjectsRecord(record) {
  record.updatedAt = new Date().toISOString();
  await writeFile(PROJECTS_STATE_PATH, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

async function scanProjectRoot(rootPath, relativePrefix = '') {
  if (!rootPath || !(await exists(rootPath))) return [];
  const root = path.resolve(rootPath);
  const assets = [];
  async function walk(directory, depth) {
    if (depth > 12 || assets.length >= PROJECT_FILE_LIMIT) return;
    let entries = [];
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (assets.length >= PROJECT_FILE_LIMIT) break;
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.ltx-watch-projects') continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath, depth + 1);
        continue;
      }
      const classification = classifyProjectAsset(entry.name);
      if (!classification.supported) continue;
      try {
        const info = await stat(fullPath);
        if (!info.isFile()) continue;
        const localRelative = path.relative(root, fullPath).replaceAll('\\', '/');
        const relativePath = [relativePrefix, localRelative].filter(Boolean).join('/');
        assets.push({
          id: projectAssetId(fullPath),
          fullPath,
          name: entry.name,
          relativePath,
          kind: classification.kind,
          extension: classification.extension,
          size: info.size,
          modifiedMs: info.mtimeMs,
          modifiedAt: new Date(info.mtimeMs).toISOString(),
          identity: inferShotIdentity(relativePath),
        });
      } catch { /* files can move while a project folder is being updated */ }
    }
  }
  await walk(root, 0);
  return assets;
}

async function copyProjectAssets(sourceRoot, destinationRoot) {
  const assets = await scanProjectRoot(sourceRoot);
  for (const asset of assets) {
    const destination = path.join(destinationRoot, ...asset.relativePath.split('/'));
    if (!isInside(destination, [destinationRoot])) throw new Error('A managed project asset resolved outside its project folder.');
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(asset.fullPath, destination);
  }
  return assets.length;
}

function projectRoots(record) {
  return Object.values(record.projects || {}).flatMap((project) => [project.rootPath, project.uploadRoot]).filter(Boolean);
}

async function projectAssets(project, config) {
  const [sourceAssets, uploadedAssets] = await Promise.all([
    scanProjectRoot(project.rootPath),
    project.uploadRoot && path.resolve(project.uploadRoot) !== path.resolve(project.rootPath)
      ? scanProjectRoot(project.uploadRoot, 'uploads')
      : Promise.resolve([]),
  ]);
  const assets = [...sourceAssets, ...uploadedAssets];
  const existing = new Set(assets.map((asset) => asset.id));
  for (const saved of Object.values(project.shots || {})) {
    for (const attempt of Array.isArray(saved?.attempts) ? saved.attempts : []) {
      const fullPath = typeof attempt?.outputPath === 'string' ? attempt.outputPath : '';
      if (!fullPath || existing.has(projectAssetId(fullPath)) || !isInside(fullPath, [config.clipsDirectory, STUDIO_RUNTIME_ROOT])) continue;
      try {
        const info = await stat(fullPath);
        const classification = classifyProjectAsset(fullPath);
        if (!info.isFile() || !classification.supported) continue;
        const relativePath = `generated/${path.basename(path.dirname(fullPath))}/${path.basename(fullPath)}`;
        assets.push({
          id: projectAssetId(fullPath), fullPath, name: path.basename(fullPath), relativePath,
          kind: classification.kind, extension: classification.extension, size: info.size,
          modifiedMs: info.mtimeMs, modifiedAt: new Date(info.mtimeMs).toISOString(), identity: inferShotIdentity(relativePath), generated: true,
        });
        existing.add(projectAssetId(fullPath));
      } catch { /* stale generated attempt */ }
    }
  }
  return assets.sort((left, right) => right.modifiedMs - left.modifiedMs);
}

function decorateProjectAsset(asset) {
  const previewable = ['video', 'image', 'audio'].includes(asset.kind);
  return {
    ...asset,
    directory: path.dirname(asset.fullPath),
    mediaUrl: previewable ? `http://127.0.0.1:${PORT}/project-media/${encodePath(asset.fullPath)}` : null,
  };
}

async function activeProjectProgress(config, activeJob) {
  if (!activeJob?.id || !activeJob?.projectQueueId) {
    studioProgressHighWater.clear();
    return null;
  }
  const slug = String(activeJob.slug || activeJob.sceneKey || '').split('/').at(-1);
  const shot = String(activeJob.shot || '');
  if (!slug || !shot) return null;
  for (const id of studioProgressHighWater.keys()) {
    if (id !== activeJob.id) studioProgressHighWater.delete(id);
  }
  const [runnerLog, serverLog] = await Promise.all([
    readTail(path.join(config.comfyRoot, 'ltx-watch-studio-runner.log'), 1_000_000),
    readTail(path.join(config.comfyRoot, `server_log_ltx-watch-studio_${safeStudioSegment(slug)}_${safeStudioSegment(shot)}.txt`), 1_000_000),
  ]);
  const progress = studioJobProgress({
    runnerLog,
    serverLog,
    startedAt: activeJob.startedAt,
    previousProgress: studioProgressHighWater.get(activeJob.id) || 0,
  });
  studioProgressHighWater.set(activeJob.id, progress.progress);
  return { queueId: activeJob.projectQueueId, ...progress };
}

async function buildProjectsView(config, plan, record = null) {
  const projectsRecord = record || await getProjectsRecord();
  const summaries = Object.values(projectsRecord.projects).map((project) => ({
    id: project.id,
    name: project.name,
    mode: project.mode,
    sourcePath: project.sourcePath,
    queuePaused: project.queuePaused,
    queued: project.regenerationQueue.filter((item) => item.status === 'queued').length,
    review: Object.values(project.shots || {}).filter((shot) => shot?.queueState === 'review').length,
    updatedAt: project.updatedAt,
  })).sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
  const project = projectsRecord.projects[projectsRecord.selectedProjectId] || null;
  if (!project) return { selectedProjectId: null, projects: summaries, project: null };

  const rawAssets = await projectAssets(project, config);
  const assets = rawAssets.map(decorateProjectAsset);
  const shots = buildProjectShots(assets, project.shots, await projectPlanTracks(config, plan));
  const queueByShot = new Map(project.regenerationQueue.filter((item) => ['queued', 'generating', 'review', 'failed'].includes(item.status)).map((item) => [item.shotKey, item]));
  for (const shot of shots) {
    const queued = queueByShot.get(shot.shotKey);
    if (queued) shot.status = queued.status;
  }
  const contextAssets = assets.filter((asset) => !asset.identity || ['text', 'data', 'scene3d', 'audio', 'image'].includes(asset.kind));
  const blenderAssets = assets.filter((asset) => asset.kind === 'scene3d');
  const studioRecord = await getStudioRecord();
  const activeProgress = await activeProjectProgress(config, studioRecord.activeJob);
  const queueProgress = activeProgress ? {
    stage: activeProgress.stage,
    progress: activeProgress.progress,
    elapsedSeconds: activeProgress.elapsedSeconds,
    remainingSeconds: activeProgress.remainingSeconds,
    averageSeconds: activeProgress.averageSeconds,
  } : null;
  const queue = project.regenerationQueue.slice().reverse().map((item) => activeProgress?.queueId === item.id ? { ...item, ...queueProgress } : item);
  return {
    selectedProjectId: projectsRecord.selectedProjectId,
    projects: summaries,
    project: {
      ...project,
      assets,
      shots,
      contextAssets,
      blenderAssets,
      blenderBackbone: blenderAssets.find((asset) => asset.id === project.blenderBackboneAssetId) || null,
      queue,
      counts: {
        assets: assets.length,
        shots: shots.length,
        mapped: shots.filter((shot) => shot.regeneratable).length,
        selectedContext: project.contextAssetIds.length,
        queued: project.regenerationQueue.filter((item) => item.status === 'queued').length,
        generating: project.regenerationQueue.filter((item) => item.status === 'generating').length,
        review: project.regenerationQueue.filter((item) => item.status === 'review').length,
      },
    },
  };
}

async function syncProjectRegeneration(config, status, plan, comfy) {
  const projectsRecord = await getProjectsRecord();
  const studioRecord = await getStudioRecord();
  const activeBeforeSync = studioRecord.activeJob ? { ...studioRecord.activeJob } : null;
  const studioChanged = await syncStudioJob(studioRecord, config);
  let projectsChanged = false;

  if (activeBeforeSync?.projectId && activeBeforeSync?.projectQueueId) {
    const project = projectsRecord.projects[activeBeforeSync.projectId];
    const queueItem = project?.regenerationQueue.find((item) => item.id === activeBeforeSync.projectQueueId);
    const attempt = studioRecord.scenes?.[activeBeforeSync.sceneKey]?.attempts?.[activeBeforeSync.shot]?.find((item) => item.id === activeBeforeSync.id);
    if (queueItem && attempt) {
      queueItem.status = attempt.status;
      queueItem.completedAt = attempt.completedAt || null;
      queueItem.outputPath = attempt.videoPath || null;
      queueItem.error = attempt.error || null;
      const saved = project.shots[queueItem.shotKey] && typeof project.shots[queueItem.shotKey] === 'object' ? project.shots[queueItem.shotKey] : {};
      const savedAttempts = Array.isArray(saved.attempts) ? saved.attempts.filter((item) => item.id !== attempt.id) : [];
      savedAttempts.push({ id: attempt.id, correction: attempt.correction || '', status: attempt.status, startedAt: attempt.startedAt, completedAt: attempt.completedAt, outputPath: attempt.videoPath || null, error: attempt.error || null });
      project.shots[queueItem.shotKey] = {
        ...saved,
        queueState: attempt.status,
        currentAssetId: attempt.videoPath ? projectAssetId(attempt.videoPath) : saved.currentAssetId,
        attempts: savedAttempts,
      };
      project.updatedAt = new Date().toISOString();
      projectsChanged = true;
    }
  }

  const activeProjectJob = studioRecord.activeJob?.projectId;
  const createRecord = await getCreateRecord();
  if (!activeProjectJob && !studioRecord.activeJob && !createRecord.activeJobId && !studioMutationInFlight && !createMutationInFlight && !generationLaunchInFlight) {
    const project = projectsRecord.projects[projectsRecord.selectedProjectId];
    const liveWorkers = getWorkerPids(status).filter(processExists);
    const next = project && !project.queuePaused ? project.regenerationQueue.find((item) => item.status === 'queued') : null;
    if (project && next && liveWorkers.length === 0 && !comfy.online && resolveStudioPlan(config)) {
      generationLaunchInFlight = true;
      try {
        const planItem = (await projectPlanTracks(config, plan)).find((item) => sceneKey(item) === next.sceneKey);
        if (!planItem || !parseShotRange(planItem.shots, planItem.count).includes(next.shot)) {
          next.status = 'failed';
          next.error = 'The source scene or shot no longer exists in the compatible LTX source runner.';
          next.completedAt = new Date().toISOString();
        } else {
          const scene = ensureSceneRecord(studioRecord, planItem);
          next.status = 'generating';
          next.startedAt = new Date().toISOString();
          const launched = await startStudioJob({
            config,
            record: studioRecord,
            item: { ...planItem, sceneKey: sceneKey(planItem) },
            scene,
            shot: next.shot,
            correction: next.correction,
            metadata: { projectId: project.id, projectQueueId: next.id, projectShotKey: next.shotKey },
          });
          next.attemptId = launched.id;
        }
      } finally {
        generationLaunchInFlight = false;
      }
      project.updatedAt = new Date().toISOString();
      projectsChanged = true;
    }
  }

  if (studioChanged) await writeStudioRecord(studioRecord);
  if (projectsChanged) await writeProjectsRecord(projectsRecord);
  return projectsRecord;
}

async function loadProjectsContext({ sync = false } = {}) {
  const config = await getConfig();
  const [status, plan, comfy] = await Promise.all([readJson(config.statusFile, {}), readJson(config.planFile, {}), getComfyQueue(config)]);
  const record = sync ? await syncProjectRegeneration(config, status, plan, comfy) : await getProjectsRecord();
  return { config, status, plan, comfy, record };
}

async function controlProjects(body) {
  if (projectMutationInFlight) throw new Error('Another project action is still being saved.');
  projectMutationInFlight = true;
  try {
    const { config, plan, record } = await loadProjectsContext();
    const action = String(body?.action || '');

    if (action === 'import-folder') {
      const requestedPath = String(body?.path || '').trim();
      if (!requestedPath) throw new Error('Enter an absolute project folder path.');
      const sourcePath = path.resolve(requestedPath);
      if (!path.isAbsolute(sourcePath)) throw new Error('Enter an absolute project folder path.');
      const info = await stat(sourcePath).catch(() => null);
      if (!info?.isDirectory()) throw new Error('The project folder does not exist or is not a directory.');
      const id = `project-${randomBytes(8).toString('hex')}`;
      const mode = body?.mode === 'managed' ? 'managed' : 'reference';
      const managedRoot = path.join(PROJECTS_RUNTIME_ROOT, 'projects', id, 'source');
      const uploadRoot = path.join(PROJECTS_RUNTIME_ROOT, 'projects', id, 'uploads');
      if (mode === 'managed') {
        await mkdir(managedRoot, { recursive: true });
        await copyProjectAssets(sourcePath, managedRoot);
      }
      await mkdir(uploadRoot, { recursive: true });
      const now = new Date().toISOString();
      record.projects[id] = {
        id,
        name: String(body?.name || path.basename(sourcePath) || 'LTX project').trim().slice(0, 120),
        mode,
        rootPath: mode === 'managed' ? managedRoot : sourcePath,
        sourcePath,
        uploadRoot,
        blenderBackboneAssetId: null,
        contextAssetIds: [],
        shots: {},
        regenerationQueue: [],
        queuePaused: false,
        createdAt: now,
        updatedAt: now,
      };
      record.selectedProjectId = id;
      await writeProjectsRecord(record);
      return buildProjectsView(config, plan, record);
    }

    if (action === 'select-project') {
      const id = String(body?.projectId || '');
      if (!record.projects[id]) throw new Error('The selected project does not exist.');
      record.selectedProjectId = id;
      await writeProjectsRecord(record);
      return buildProjectsView(config, plan, record);
    }

    const project = record.projects[String(body?.projectId || record.selectedProjectId || '')];
    if (!project) throw new Error('Import or select a project first.');
    const view = await buildProjectsView(config, plan, record);
    const shots = view.project?.shots || [];
    const shotKeys = [...new Set(Array.isArray(body?.shotKeys) ? body.shotKeys.map(String) : [])];

    if (action === 'queue-regeneration') {
      const correction = cleanCorrection(body?.correction);
      const added = enqueueProjectShots(project, shots, shotKeys, correction, () => `regen-${randomBytes(8).toString('hex')}`);
      if (!added.length) throw new Error('No new mapped shots were added. Select mapped shots that are not already queued.');
    } else if (action === 'attach-context') {
      const assetIds = [...new Set(Array.isArray(body?.assetIds) ? body.assetIds.map(String) : [])];
      const validAssets = new Set((view.project?.contextAssets || []).map((asset) => asset.id));
      const validIds = assetIds.filter((id) => validAssets.has(id));
      if (!validIds.length) throw new Error('Select one or more valid context assets.');
      for (const shotKey of shotKeys) {
        const saved = project.shots[shotKey] && typeof project.shots[shotKey] === 'object' ? project.shots[shotKey] : {};
        project.shots[shotKey] = { ...saved, contextAssetIds: [...new Set([...(saved.contextAssetIds || []), ...validIds])] };
      }
    } else if (action === 'mark-status') {
      const statusValue = body?.status === 'accepted' ? 'accepted' : 'review';
      for (const shotKey of shotKeys) {
        const shot = shots.find((item) => item.shotKey === shotKey);
        if (!shot) continue;
        const saved = project.shots[shotKey] && typeof project.shots[shotKey] === 'object' ? project.shots[shotKey] : {};
        project.shots[shotKey] = { ...saved, queueState: statusValue, acceptedAssetId: statusValue === 'accepted' ? shot.currentAssetId : null };
      }
    } else if (action === 'set-blender-backbone') {
      const assetId = body?.assetId ? String(body.assetId) : null;
      if (assetId && !(view.project?.blenderAssets || []).some((asset) => asset.id === assetId)) throw new Error('Select a Blender or supported 3D scene asset.');
      project.blenderBackboneAssetId = assetId;
    } else if (action === 'set-project-context') {
      const validAssets = new Set((view.project?.contextAssets || []).map((asset) => asset.id));
      project.contextAssetIds = [...new Set(Array.isArray(body?.assetIds) ? body.assetIds.map(String).filter((id) => validAssets.has(id)) : [])];
    } else if (action === 'toggle-queue') {
      project.queuePaused = Boolean(body?.paused);
    } else if (action === 'remove-queued') {
      const queueId = String(body?.queueId || '');
      project.regenerationQueue = project.regenerationQueue.filter((item) => item.id !== queueId || item.status === 'generating');
    } else if (action === 'refresh') {
      return view;
    } else if (action === 'upload-start') {
      const relativePath = safeUploadRelativePath(body?.relativePath || body?.fileName);
      const size = Math.max(0, Math.trunc(Number(body?.size) || 0));
      if (size > 8 * 1024 * 1024 * 1024) throw new Error('Individual uploads are limited to 8 GB.');
      const classification = classifyProjectAsset(relativePath);
      if (!classification.supported) throw new Error(`Unsupported project asset type: ${classification.extension || 'unknown'}`);
      const uploadId = randomBytes(18).toString('hex');
      const temporaryRoot = path.join(PROJECTS_RUNTIME_ROOT, 'uploads');
      await mkdir(temporaryRoot, { recursive: true });
      const temporaryPath = path.join(temporaryRoot, `${uploadId}.part`);
      await writeFile(temporaryPath, Buffer.alloc(0));
      projectUploads.set(uploadId, { uploadId, projectId: project.id, relativePath, size, received: 0, temporaryPath, createdAt: Date.now() });
      return { upload: { id: uploadId, received: 0, size } };
    } else if (action === 'upload-finish') {
      const uploadId = String(body?.uploadId || '');
      const upload = projectUploads.get(uploadId);
      if (!upload || upload.projectId !== project.id) throw new Error('The upload session expired or does not belong to this project.');
      if (upload.received !== upload.size) throw new Error(`Upload is incomplete: received ${upload.received} of ${upload.size} bytes.`);
      const destination = path.join(project.uploadRoot, ...upload.relativePath.split('/'));
      if (!isInside(destination, [project.uploadRoot])) throw new Error('The upload destination is outside the project.');
      await mkdir(path.dirname(destination), { recursive: true });
      await rename(upload.temporaryPath, destination);
      projectUploads.delete(uploadId);
    } else {
      throw new Error('Unsupported project action.');
    }

    project.updatedAt = new Date().toISOString();
    await writeProjectsRecord(record);
    return buildProjectsView(config, plan, record);
  } finally {
    projectMutationInFlight = false;
  }
}

async function appendProjectUpload(req, uploadId) {
  const upload = projectUploads.get(uploadId);
  if (!upload) throw new Error('The upload session expired. Start the file upload again.');
  const requestedOffset = Math.max(0, Math.trunc(Number(req.headers['x-ltx-upload-offset']) || 0));
  if (requestedOffset !== upload.received) throw new Error(`Upload offset mismatch. Expected ${upload.received}.`);
  const chunk = await readBinaryBody(req);
  if (upload.received + chunk.length > upload.size) throw new Error('The upload exceeds its declared size.');
  await appendFile(upload.temporaryPath, chunk);
  upload.received += chunk.length;
  return { id: uploadId, received: upload.received, size: upload.size };
}

async function buildState() {
  const config = await getConfig();
  const [status, plan, logText, finals, clips, comfy, orchestratorRecord] = await Promise.all([
    readJson(config.statusFile, {}), readJson(config.planFile, {}), readTail(config.logFile),
    walkVideos(config.finalsDirectory, 'final', config.maxVideos), walkVideos(config.clipsDirectory, 'clip', config.maxVideos),
    getComfyQueue(config), getOrchestratorRecord(),
  ]);
  const parsed = parseLog(logText);
  const control = getControlView(orchestratorRecord, status, config);
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
  const effectiveNow = control.state === 'paused' || control.state === 'recovery'
    ? new Date(orchestratorRecord.pausedAt || now).getTime()
    : now;
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
  await syncProjectRegeneration(config, status, plan, comfy);
  const studio = await buildStudioView(config, status, plan, parsed.current, finals, comfy);
  return {
    updatedAt: new Date().toISOString(), connection: { comfy: comfy.online, worker: workerOnline, apiUrl: config.comfyUrl },
    current: parsed.current ? {
      ...parsed.current, completedShots, progress, remainingSeconds, averageShotSeconds: parsed.averageShotSeconds,
      elapsedSeconds: Math.max(0, (effectiveNow - new Date(parsed.current.startedAt || effectiveNow).getTime() - trackPausedMs) / 1000),
    } : null,
    control, queue: queued, comfyQueue: comfy, videos, studio,
    activity: control.changedAt ? [{
      type: control.state === 'recovery' ? 'recovery' : control.restartedShot ? 'recovered' : control.state === 'paused' ? 'paused' : 'resumed',
      time: control.changedAt,
      title: control.state === 'recovery' ? 'Shot restart required' : control.restartedShot ? 'Interrupted shot restarted' : control.state === 'paused' ? 'Generation paused' : 'Generation resumed',
      detail: control.message,
    }, ...parsed.activities] : parsed.activities,
    gpus: parseGpuSnapshot(status.gpu_snapshot, plan),
    stats: { finals: finals.length, clips: clips.length, todayFinals, queued: queued.length },
    config,
  };
}

function getMaintenanceView() {
  return {
    status: maintenanceState.status,
    action: maintenanceState.action,
    stage: maintenanceState.stage,
    startedAt: maintenanceState.startedAt,
    completedAt: maintenanceState.completedAt,
    result: maintenanceState.result,
  };
}

async function getMaintenanceRender(config) {
  const [status, comfy] = await Promise.all([readJson(config.statusFile, {}), getComfyQueue(config)]);
  const statusUpdated = parseDate(status.updated);
  const workerOnline = Boolean(statusUpdated && Date.now() - statusUpdated.getTime() < 180_000 && getWorkerPids(status).some(processExists));
  return {
    active: workerOnline || comfy.running > 0 || comfy.pending > 0,
    worker: workerOnline,
    comfyRunning: comfy.running,
    comfyPending: comfy.pending,
  };
}

async function getEnvironmentView(force = false) {
  const config = await getConfig();
  const [render, comfyBlenderReceipt] = await Promise.all([getMaintenanceRender(config), readJson(COMFY_BLENDER_RECEIPT_PATH, null)]);
  const cacheKey = `${config.comfyRoot.toLowerCase()}|${config.comfyUrl.toLowerCase()}|${render.active}|${render.worker}|${render.comfyRunning}|${render.comfyPending}`;
  const decorate = (value) => ({ ...value, maintenance: getMaintenanceView() });
  if (!force && environmentCache.value && environmentCache.key === cacheKey && environmentCache.expiresAt > Date.now()) {
    return decorate(environmentCache.value);
  }
  if (!force && environmentCache.promise && environmentCache.key === cacheKey) return decorate(await environmentCache.promise);

  const promise = buildEnvironmentAudit(config, render, { comfyBlenderReceipt }).then((value) => {
    environmentCache = { key: cacheKey, expiresAt: Date.now() + 90_000, value, promise: null };
    return value;
  }).catch((error) => {
    environmentCache.promise = null;
    throw error;
  });
  environmentCache = { ...environmentCache, key: cacheKey, promise };
  return decorate(await promise);
}

async function runEnvironmentMaintenance(body) {
  const supportedActions = new Set(['update-comfyui-core', 'install-comfyui-blender', 'install-sam3']);
  if (!supportedActions.has(body?.action)) throw new Error('Unsupported environment maintenance action.');
  if (body?.confirmed !== true) throw new Error('Explicit confirmation is required before changing ComfyUI, Blender, dependencies, or launch settings.');
  if (body?.action === 'install-sam3' && body?.licenseAccepted !== true) throw new Error('SAM 3.1 installation requires confirmation that the SAM License was reviewed and accepted.');
  if (maintenanceState.status === 'running') throw new Error('Another environment maintenance action is already running.');

  const config = await getConfig();
  const render = await getMaintenanceRender(config);
  if (render.active) throw new Error('Setup is locked while an LTX worker or ComfyUI queue item is active. Wait for the queue to become idle.');

  const startedAt = new Date().toISOString();
  maintenanceState = { status: 'running', action: body.action, stage: 'Preparing guarded setup', startedAt, completedAt: null, result: null };
  try {
    let result;
    if (body.action === 'update-comfyui-core') {
      result = await updateComfyUiCore({
        comfyRoot: config.comfyRoot,
        backupRoot: MAINTENANCE_BACKUP_ROOT,
        onStage: (stage) => { maintenanceState = { ...maintenanceState, stage }; },
      });
    } else if (body.action === 'install-sam3') {
      result = await installSam3Model({
        scriptPath: SAM3_SCRIPT_PATH,
        comfyRoot: config.comfyRoot,
        backupRoot: MAINTENANCE_BACKUP_ROOT,
        onStage: (stage) => { maintenanceState = { ...maintenanceState, stage }; },
      });
    } else {
      result = await installComfyUiBlender({
        scriptPath: COMFY_BLENDER_SCRIPT_PATH,
        comfyRoot: config.comfyRoot,
        comfyUrl: config.comfyUrl,
        onStage: (stage) => { maintenanceState = { ...maintenanceState, stage }; },
      });
      const receipt = {
        status: 'configured',
        version: result.version,
        blenderVersion: result.blenderVersion,
        serverAddress: normalizeLoopbackComfyUrl(result.serverAddress),
        configuredAt: new Date().toISOString(),
      };
      await mkdir(MAINTENANCE_ROOT, { recursive: true });
      await writeFile(COMFY_BLENDER_RECEIPT_PATH, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    }
    const completedAt = new Date().toISOString();
    maintenanceState = { ...maintenanceState, status: 'complete', stage: 'Setup complete', completedAt, result };
    environmentCache = { key: '', expiresAt: 0, value: null, promise: null };
    return { result, environment: await getEnvironmentView(true) };
  } catch (error) {
    maintenanceState = {
      ...maintenanceState,
      status: 'failed',
      stage: 'Setup failed',
      completedAt: new Date().toISOString(),
      result: { error: error instanceof Error ? error.message : 'Environment setup failed.' },
    };
    throw error;
  }
}

async function serveMedia(req, res, id, config, extraRoots = []) {
  let filePath;
  try { filePath = decodePath(id); } catch { return sendJson(res, 400, { error: 'Invalid media id' }); }
  if (!isInside(filePath, [config.finalsDirectory, config.clipsDirectory, STUDIO_RUNTIME_ROOT, ...extraRoots])) return sendJson(res, 403, { error: 'Path is outside local media folders' });
  let info;
  try { info = await stat(filePath); } catch { return sendJson(res, 404, { error: 'Media not found' }); }
  if (!info.isFile()) return sendJson(res, 404, { error: 'Media not found' });
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.exr': 'image/x-exr',
    '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
  };
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
    if (req.method === 'GET' && requestUrl.pathname === '/api/create') return sendJson(res, 200, await buildCreateView({ sync: true }));
    if (req.method === 'POST' && requestUrl.pathname === '/api/create') {
      if (req.headers['x-ltx-control-token'] !== CONTROL_TOKEN) return sendJson(res, 403, { error: 'Invalid local control token' });
      const result = await controlCreate(await readBody(req));
      return sendJson(res, 200, result.upload ? { ok: true, ...result } : { ok: true, create: result });
    }
    if (req.method === 'POST' && requestUrl.pathname.startsWith('/api/create-upload/')) {
      if (req.headers['x-ltx-control-token'] !== CONTROL_TOKEN) return sendJson(res, 403, { error: 'Invalid local control token' });
      return sendJson(res, 200, { ok: true, upload: await appendCreateUpload(req, requestUrl.pathname.slice('/api/create-upload/'.length)) });
    }
    if (req.method === 'GET' && requestUrl.pathname === '/api/projects') {
      const { config, plan, record } = await loadProjectsContext({ sync: true });
      return sendJson(res, 200, await buildProjectsView(config, plan, record));
    }
    if (req.method === 'POST' && requestUrl.pathname === '/api/projects') {
      if (req.headers['x-ltx-control-token'] !== CONTROL_TOKEN) return sendJson(res, 403, { error: 'Invalid local control token' });
      const result = await controlProjects(await readBody(req));
      return sendJson(res, 200, result.upload ? { ok: true, ...result } : { ok: true, projects: result });
    }
    if (req.method === 'POST' && requestUrl.pathname.startsWith('/api/project-upload/')) {
      if (req.headers['x-ltx-control-token'] !== CONTROL_TOKEN) return sendJson(res, 403, { error: 'Invalid local control token' });
      return sendJson(res, 200, { ok: true, upload: await appendProjectUpload(req, requestUrl.pathname.slice('/api/project-upload/'.length)) });
    }
    if (req.method === 'GET' && requestUrl.pathname === '/api/environment') return sendJson(res, 200, await getEnvironmentView(requestUrl.searchParams.get('refresh') === '1'));
    if (req.method === 'POST' && requestUrl.pathname === '/api/environment/maintenance') {
      if (req.headers['x-ltx-control-token'] !== CONTROL_TOKEN) return sendJson(res, 403, { error: 'Invalid local control token' });
      return sendJson(res, 200, { ok: true, ...await runEnvironmentMaintenance(await readBody(req)) });
    }
    if (req.method === 'GET' && requestUrl.pathname === '/api/config') return sendJson(res, 200, await getConfig());
    if (req.method === 'POST' && requestUrl.pathname === '/api/control') {
      if (req.headers['x-ltx-control-token'] !== CONTROL_TOKEN) return sendJson(res, 403, { error: 'Invalid local control token' });
      const action = (await readBody(req)).action;
      if (action !== 'pause' && action !== 'resume') return sendJson(res, 400, { error: 'Action must be pause or resume' });
      return sendJson(res, 200, { ok: true, control: await controlGenerator(action) });
    }
    if (req.method === 'POST' && requestUrl.pathname === '/api/studio') {
      if (req.headers['x-ltx-control-token'] !== CONTROL_TOKEN) return sendJson(res, 403, { error: 'Invalid local control token' });
      return sendJson(res, 200, { ok: true, studio: await controlStudio(await readBody(req)) });
    }
    if (req.method === 'POST' && requestUrl.pathname === '/api/config') {
      const current = await getConfig();
      const next = { ...current, ...cleanConfig(await readBody(req)) };
      await writeFile(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
      return sendJson(res, 200, next);
    }
    if (req.method === 'POST' && requestUrl.pathname === '/api/open') {
      const config = await getConfig();
      const projectsRecord = await getProjectsRecord();
      const body = await readBody(req);
      const target = typeof body.path === 'string' ? body.path : '';
      if (!target || !isInside(target, [config.comfyRoot, config.finalsDirectory, config.clipsDirectory, STUDIO_RUNTIME_ROOT, CREATE_RUNTIME_ROOT, ...projectRoots(projectsRecord)])) return sendJson(res, 403, { error: 'Path is outside configured folders' });
      if (!(await exists(target))) return sendJson(res, 404, { error: 'Path not found' });
      const info = await stat(target);
      const args = info.isDirectory() ? [target] : [`/select,${target}`];
      const child = spawn('explorer.exe', args, { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && requestUrl.pathname.startsWith('/media/')) return serveMedia(req, res, requestUrl.pathname.slice('/media/'.length), await getConfig());
    if (req.method === 'GET' && requestUrl.pathname.startsWith('/project-media/')) {
      const [config, projectsRecord] = await Promise.all([getConfig(), getProjectsRecord()]);
      return serveMedia(req, res, requestUrl.pathname.slice('/project-media/'.length), config, projectRoots(projectsRecord));
    }
    return sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    return sendJson(res, 500, { error: error instanceof Error ? error.message : 'Unexpected local bridge error' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`LTX Watch local bridge: http://127.0.0.1:${PORT}`);
});
