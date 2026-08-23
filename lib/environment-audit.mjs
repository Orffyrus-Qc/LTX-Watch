import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, readFile, readdir, statfs } from 'node:fs/promises';
import path from 'node:path';

export const OFFICIAL_LINKS = Object.freeze({
  comfyDownload: 'https://www.comfy.org/download',
  comfyUpdate: 'https://docs.comfy.org/installation/update_comfyui',
  ltxModels: 'https://huggingface.co/Lightricks/LTX-2.5',
  ltxComfy: 'https://github.com/Lightricks/ComfyUI-LTXVideo',
  ltxDesktop: 'https://github.com/Lightricks/LTX-Desktop/releases',
  blenderDownload: 'https://www.blender.org/download/',
  comfyBlender: 'https://github.com/alexisrolland/ComfyUI-Blender',
  comfyBlenderReleases: 'https://github.com/alexisrolland/ComfyUI-Blender/releases',
  sam3: 'https://huggingface.co/Comfy-Org/sam3.1',
  sam3License: 'https://huggingface.co/Comfy-Org/sam3.1/blob/main/LICENSE',
  sam3Guide: 'https://docs.comfy.org/tutorials/utility/video-segment-sam3',
  nvidiaDriver: 'https://www.nvidia.com/Download/index.aspx',
  pytorch: 'https://pytorch.org/get-started/locally/',
});

const MODEL_GROUPS = Object.freeze({
  transformer: /ltx-2\.5.*transformer.*\.(safetensors|gguf)$/i,
  textEncoder: /gemma4.*(?:ltx-2\.5|e2b).*\.(safetensors|gguf)$/i,
  videoVae: /ltx-2\.5.*video.*vae.*\.safetensors$/i,
  audioVae: /ltx-2\.5.*audio.*vae.*\.safetensors$/i,
  upscaler: /ltx-2\.5.*(?:upscal|spatial).*\.safetensors$/i,
  sam3: /sam3(?:\.1)?[^/\\]*\.(safetensors|pt)$/i,
});

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

function runProcess(command, args, { cwd, timeout = 8_000, maxBuffer = 2_000_000 } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, windowsHide: true, timeout, maxBuffer }, (error, stdout = '', stderr = '') => {
      resolve({
        ok: !error,
        code: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
        stdout: String(stdout).trim(),
        stderr: String(stderr).trim(),
        error: error?.message || null,
      });
    });
  });
}

async function fetchText(url, timeout = 5_000) {
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'LTX-Watch-Environment-Doctor' },
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) return null;
    return await response.text();
  } catch { return null; }
}

async function fetchJson(url, timeout = 5_000) {
  const text = await fetchText(url, timeout);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function normalizedPackageName(value) {
  return String(value || '').toLowerCase().replaceAll('_', '-').replace(/[-.]+/g, '-');
}

function versionParts(value) {
  return String(value || '').split(/[+-]/)[0].split('.').map((part) => Number.parseInt(part, 10) || 0);
}

export function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if ((a[index] || 0) > (b[index] || 0)) return 1;
    if ((a[index] || 0) < (b[index] || 0)) return -1;
  }
  return 0;
}

export function isComfyBlenderReceiptCurrent(receipt, { serverAddress, addonVersion, customNodesVersion, blenderVersion }) {
  return Boolean(
    receipt?.status === 'configured'
    && receipt?.serverAddress === serverAddress
    && addonVersion
    && customNodesVersion
    && blenderVersion
    && compareVersions(receipt?.version, addonVersion) === 0
    && compareVersions(receipt?.version, customNodesVersion) === 0
    && compareVersions(receipt?.blenderVersion, blenderVersion) === 0
  );
}

function satisfiesSpecifier(version, specifier) {
  if (!specifier) return true;
  return specifier.split(',').every((rawRule) => {
    const rule = rawRule.trim();
    const match = rule.match(/^(==|>=|<=|>|<|~=)\s*([^\s]+)$/);
    if (!match) return true;
    const [, operator, expected] = match;
    const compared = compareVersions(version, expected);
    if (operator === '==') return String(version).toLowerCase() === expected.toLowerCase();
    if (operator === '>=') return compared >= 0;
    if (operator === '<=') return compared <= 0;
    if (operator === '>') return compared > 0;
    if (operator === '<') return compared < 0;
    const expectedParts = versionParts(expected);
    const currentParts = versionParts(version);
    return compared >= 0 && currentParts[0] === expectedParts[0];
  });
}

export function parseRequirements(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#') && !line.startsWith('-')).map((line) => {
    const withoutMarker = line.split(';')[0].trim();
    const match = withoutMarker.match(/^([A-Za-z0-9._-]+)(?:\[[^\]]+\])?\s*(.*)$/);
    return match ? { name: normalizedPackageName(match[1]), specifier: match[2].trim(), source: line } : null;
  }).filter(Boolean);
}

export function analyzeRequirements(requirementText, installedPackages = []) {
  const installed = new Map(installedPackages.map((item) => [normalizedPackageName(item.name), String(item.version)]));
  const requirements = parseRequirements(requirementText);
  const missing = requirements.filter((item) => !installed.has(item.name)).map((item) => item.source);
  const mismatched = requirements.filter((item) => installed.has(item.name) && !satisfiesSpecifier(installed.get(item.name), item.specifier)).map((item) => ({
    requirement: item.source,
    installed: installed.get(item.name),
  }));
  return { total: requirements.length, missing, mismatched, satisfied: missing.length === 0 && mismatched.length === 0 };
}

export function parseGpuCsv(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const parts = line.split(',').map((part) => part.trim());
    if (parts.length < 7) return null;
    const memoryTotalMb = Number(parts[3]);
    const memoryUsedMb = Number(parts[4]);
    return {
      device: Number(parts[0]),
      name: parts[1],
      driver: parts[2],
      memoryTotalMb,
      memoryUsedMb,
      memoryFreeMb: Number(parts[5]),
      computeCapability: parts[6],
      totalMemoryGb: Math.round((memoryTotalMb / 1024) * 10) / 10,
    };
  }).filter((item) => item && Number.isInteger(item.device));
}

export function recommendGpuRoles(gpus) {
  if (!gpus.length) return [];
  const primary = [...gpus].sort((a, b) => b.memoryTotalMb - a.memoryTotalMb || a.device - b.device)[0];
  return gpus.map((gpu) => {
    if (gpu.device === primary.device && gpu.memoryTotalMb >= 15_500) {
      return { ...gpu, role: 'primary', title: 'Primary LTX GPU', recommendation: 'Use the Comfy INT8 checkpoint with one LTX worker and a small VRAM reserve.' };
    }
    if (gpu.memoryTotalMb < 15_500) {
      return { ...gpu, role: 'auxiliary', title: 'Auxiliary only', recommendation: 'Keep LTX 2.5 22B off this card; use it for lighter preprocessing or non-concurrent tools.' };
    }
    return { ...gpu, role: 'candidate', title: 'Secondary candidate', recommendation: 'Run an idle-time smoke test before scheduling a second concurrent LTX worker.' };
  });
}

async function listFiles(root, maxDepth = 4, maxFiles = 4_000) {
  const files = [];
  async function walk(directory, depth) {
    if (depth > maxDepth || files.length >= maxFiles) return;
    let entries = [];
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(fullPath, depth + 1);
      else files.push({ fullPath, name: entry.name });
    }
  }
  await walk(root, 0);
  return files;
}

async function findCustomNode(customRoot, expectedName) {
  try {
    const entries = await readdir(customRoot, { withFileTypes: true });
    const match = entries.find((entry) => entry.isDirectory() && entry.name.toLowerCase() === expectedName.toLowerCase());
    return match ? path.join(customRoot, match.name) : null;
  } catch { return null; }
}

export function parseBlenderVersion(value) {
  const match = String(value || '').match(/(?:Blender\s*)?(\d+)\.(\d+)(?:\.(\d+))?/i);
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] || 0), text: `${match[1]}.${match[2]}.${match[3] || 0}` } : null;
}

export function chooseComfyBlenderChannel(blenderVersion) {
  const version = typeof blenderVersion === 'string' ? parseBlenderVersion(blenderVersion) : blenderVersion;
  if (!version) return { supported: false, releaseTag: null, releaseApi: null };
  if (version.major >= 5) return { supported: true, releaseTag: null, releaseApi: 'https://api.github.com/repos/alexisrolland/ComfyUI-Blender/releases/latest' };
  if (version.major === 4 && version.minor >= 5) return { supported: true, releaseTag: 'v3.3.4', releaseApi: 'https://api.github.com/repos/alexisrolland/ComfyUI-Blender/releases/tags/v3.3.4' };
  return { supported: false, releaseTag: null, releaseApi: null };
}

export async function findBlenderInstallation() {
  const candidates = new Map();
  const bases = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Blender Foundation'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Blender Foundation'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Blender Foundation'),
  ].filter(Boolean);
  for (const base of bases) {
    let entries = [];
    try { entries = await readdir(base, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const executable = path.join(base, entry.name, 'blender.exe');
      if (!(await exists(executable))) continue;
      const version = parseBlenderVersion(entry.name);
      if (version) candidates.set(executable.toLowerCase(), { executable, version });
    }
  }
  const whereResult = await runProcess('where.exe', ['blender.exe'], { timeout: 3_000 });
  for (const executable of whereResult.stdout.split(/\r?\n/).filter(Boolean)) {
    if (candidates.has(executable.toLowerCase()) || !(await exists(executable))) continue;
    const versionResult = await runProcess(executable, ['--version'], { timeout: 5_000 });
    const version = parseBlenderVersion(`${versionResult.stdout}\n${versionResult.stderr}`);
    if (version) candidates.set(executable.toLowerCase(), { executable, version });
  }
  return [...candidates.values()].sort((left, right) => compareVersions(right.version.text, left.version.text))[0] || null;
}

async function readComfyBlenderNodeVersion(root) {
  if (!root) return null;
  const text = await readFile(path.join(root, 'pyproject.toml'), 'utf8').catch(() => '');
  if (!/^name\s*=\s*["']comfyui-blender["']\s*$/im.test(text)) return null;
  return text.match(/^version\s*=\s*["']([^"']+)["']\s*$/im)?.[1] || null;
}

async function readComfyBlenderAddonVersion(addonRoot) {
  const text = addonRoot ? await readFile(path.join(addonRoot, '__init__.py'), 'utf8').catch(() => '') : '';
  const match = text.match(/["']version["']\s*:\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

async function getComfyBlenderAudit(comfyRoot, customNodeRoot, comfyUrl, receipt) {
  const blender = await findBlenderInstallation();
  const channel = chooseComfyBlenderChannel(blender?.version || null);
  const release = channel.releaseApi ? await fetchJson(channel.releaseApi) : null;
  const latestVersion = String(release?.tag_name || channel.releaseTag || '').replace(/^v/, '') || null;
  const customNodesVersion = await readComfyBlenderNodeVersion(customNodeRoot);
  const profileVersion = blender ? `${blender.version.major}.${blender.version.minor}` : null;
  const addonRoot = profileVersion && process.env.APPDATA
    ? path.join(process.env.APPDATA, 'Blender Foundation', 'Blender', profileVersion, 'scripts', 'addons', 'comfyui_blender')
    : null;
  const addonVersion = await readComfyBlenderAddonVersion(addonRoot);
  let normalizedServer = null;
  try {
    const parsed = new URL(comfyUrl);
    normalizedServer = `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch { /* reported by the monitor settings validation path */ }
  const configured = isComfyBlenderReceiptCurrent(receipt, {
    serverAddress: normalizedServer,
    addonVersion,
    customNodesVersion,
    blenderVersion: blender?.version.text || null,
  });
  const installed = Boolean(customNodesVersion && addonVersion);
  const updateAvailable = Boolean(latestVersion && installed && (compareVersions(customNodesVersion, latestVersion) < 0 || compareVersions(addonVersion, latestVersion) < 0));
  const ready = Boolean(channel.supported && installed && configured && !updateAvailable);
  const state = !blender ? 'blender-required' : !channel.supported ? 'unsupported' : !installed ? 'install-required' : updateAvailable ? 'update-available' : configured ? 'ready' : 'configuration-required';
  const detail = !blender
    ? 'Install Blender before adding the bridge.'
    : !channel.supported
      ? `Blender ${blender.version.text} is outside the supported automated setup range.`
      : !installed
        ? 'The Blender add-on and matching ComfyUI custom nodes are not both installed.'
        : updateAvailable
          ? `ComfyUI-Blender ${latestVersion} is available for this Blender generation.`
          : configured
            ? `Version ${addonVersion} is enabled and configured for ${normalizedServer}.`
            : 'Both components were found; run setup once to enable the add-on and save its server address.';
  return {
    ready,
    state,
    detail,
    blenderDetected: Boolean(blender),
    blenderVersion: blender?.version.text || null,
    supported: channel.supported,
    customNodesInstalled: Boolean(customNodesVersion),
    customNodesVersion,
    addonInstalled: Boolean(addonVersion),
    addonVersion,
    configured,
    serverAddress: configured ? normalizedServer : null,
    latestVersion,
    updateAvailable,
    releaseUrl: release?.html_url || OFFICIAL_LINKS.comfyBlenderReleases,
    projectUrl: OFFICIAL_LINKS.comfyBlender,
  };
}

async function getPythonAudit(comfyRoot) {
  const candidates = [
    path.join(comfyRoot, 'venv', 'Scripts', 'python.exe'),
    path.join(comfyRoot, '.venv', 'Scripts', 'python.exe'),
    path.join(comfyRoot, 'python_embeded', 'python.exe'),
    path.join(comfyRoot, 'python', 'python.exe'),
  ];
  const executable = candidates.find(existsSync);
  if (!executable) return { installed: false, version: null, pipVersion: null, pipHealthy: false, pipMessage: 'No ComfyUI Python environment was detected.', packages: [], localRequirements: null, latestRequirements: null };

  const [versionResult, pipVersionResult, pipCheckResult, pipListResult] = await Promise.all([
    runProcess(executable, ['--version']),
    runProcess(executable, ['-m', 'pip', '--version']),
    runProcess(executable, ['-m', 'pip', 'check'], { timeout: 20_000 }),
    runProcess(executable, ['-m', 'pip', 'list', '--format=json'], { timeout: 20_000 }),
  ]);
  let packages = [];
  try { packages = JSON.parse(pipListResult.stdout || '[]'); } catch { /* invalid pip output */ }
  const localRequirementsText = await readFile(path.join(comfyRoot, 'requirements.txt'), 'utf8').catch(() => '');
  const latestRequirementsText = await fetchText('https://raw.githubusercontent.com/Comfy-Org/ComfyUI/master/requirements.txt');
  const selectedNames = new Set(['torch', 'torchvision', 'torchaudio', 'transformers', 'numpy', 'comfyui-frontend-package', 'comfyui-workflow-templates', 'comfyui-embedded-docs', 'comfy-kitchen']);
  return {
    installed: versionResult.ok,
    executableKind: path.relative(comfyRoot, executable).replaceAll('\\', '/'),
    version: (versionResult.stdout || versionResult.stderr).replace(/^Python\s+/i, '') || null,
    pipVersion: pipVersionResult.stdout.split(/\r?\n/)[0] || null,
    pipHealthy: pipCheckResult.ok,
    pipMessage: pipCheckResult.stdout || pipCheckResult.stderr || 'Pip check did not return a result.',
    packages: packages.filter((item) => selectedNames.has(normalizedPackageName(item.name))).map((item) => ({ name: normalizedPackageName(item.name), version: item.version })),
    localRequirements: analyzeRequirements(localRequirementsText, packages),
    latestRequirements: latestRequirementsText ? analyzeRequirements(latestRequirementsText, packages) : null,
  };
}

async function getRepositoryAudit(root, definition) {
  if (!root || !(await exists(path.join(root, '.git')))) return { ...definition, installed: false, root: null };
  const safeRoot = root.replaceAll('\\', '/');
  const [headResult, branchResult, statusResult, trustResult] = await Promise.all([
    runProcess('git', ['-c', `safe.directory=${safeRoot}`, '-C', root, 'rev-parse', 'HEAD']),
    runProcess('git', ['-c', `safe.directory=${safeRoot}`, '-C', root, 'branch', '--show-current']),
    runProcess('git', ['-c', `safe.directory=${safeRoot}`, '-C', root, 'status', '--short', '--untracked-files=no']),
    runProcess('git', ['-C', root, 'rev-parse', 'HEAD']),
  ]);
  const localHead = headResult.ok ? headResult.stdout : null;
  const branch = branchResult.stdout || definition.branch;
  const remoteCommit = await fetchJson(`https://api.github.com/repos/${definition.upstream}/commits/${encodeURIComponent(branch || definition.branch)}`);
  const remoteHead = remoteCommit?.sha || null;
  let comparison = null;
  if (localHead && remoteHead && localHead !== remoteHead) {
    comparison = await fetchJson(`https://api.github.com/repos/${definition.upstream}/compare/${localHead}...${remoteHead}`);
  }
  const behindBy = comparison?.status === 'ahead' ? Number(comparison.ahead_by || 0) : 0;
  const aheadBy = comparison?.status === 'behind' ? Number(comparison.behind_by || 0) : 0;
  return {
    ...definition,
    installed: Boolean(localHead),
    root,
    branch,
    localHead,
    remoteHead,
    dirty: Boolean(statusResult.stdout),
    trackedChanges: statusResult.stdout ? statusResult.stdout.split(/\r?\n/).length : 0,
    trustRequired: /dubious ownership|safe\.directory/i.test(`${trustResult.stderr}\n${trustResult.stdout}`),
    updateStatus: !remoteHead ? 'unknown' : localHead === remoteHead ? 'current' : behindBy > 0 ? 'behind' : aheadBy > 0 ? 'ahead' : 'diverged',
    behindBy,
    aheadBy,
    latestDate: remoteCommit?.commit?.committer?.date || null,
  };
}

async function getDiskAudit(comfyRoot) {
  try {
    const info = await statfs(comfyRoot);
    return {
      available: true,
      freeGiB: Math.round(((Number(info.bavail) * Number(info.bsize)) / 1024 ** 3) * 10) / 10,
      totalGiB: Math.round(((Number(info.blocks) * Number(info.bsize)) / 1024 ** 3) * 10) / 10,
    };
  } catch { return { available: false, freeGiB: null, totalGiB: null }; }
}

async function getRunnerProfile(config, render) {
  const runnerPath = path.join(config.comfyRoot, config.workerCommandFragment || '');
  const runnerText = await readFile(runnerPath, 'utf8').catch(() => '');
  let plan = null;
  try { plan = JSON.parse(await readFile(config.planFile, 'utf8')); } catch { /* optional supervisor plan */ }
  const signals = {
    gpuIsolation: /CUDA_VISIBLE_DEVICES/.test(runnerText),
    reserveVram: /--reserve-vram/.test(runnerText),
    disablePinnedMemory: /--disable-pinned-memory/.test(runnerText),
    isolatedRuntimeFolders: /--temp-directory/.test(runnerText) && /--user-directory/.test(runnerText),
    secondaryLtxEnabled: plan?.gpu1?.ltx_enabled === true,
  };
  const safeguards = Object.entries(signals).filter(([key, value]) => key !== 'secondaryLtxEnabled' && value).map(([key]) => key);
  return {
    externalRunner: Boolean(runnerText),
    safeguards,
    secondaryLtxEnabled: signals.secondaryLtxEnabled,
    knownWorking: Boolean(render.active && safeguards.length >= 2),
    automationLevel: runnerText ? 'guided' : 'unavailable',
    message: runnerText
      ? 'Watch detected a custom external runner. It can validate and recommend its GPU policy, but will not rewrite that project-specific script automatically.'
      : 'No configurable LTX runner was found. Watch can still detect the GPU and link to the official setup guidance.',
  };
}

function statusItem(id, label, ok, detail, state = ok ? 'ready' : 'missing') {
  return { id, label, state, detail };
}

export async function buildEnvironmentAudit(config, render = { active: false, worker: false, comfyRunning: 0 }, options = {}) {
  const comfyRoot = config.comfyRoot;
  const comfyInstalled = await exists(path.join(comfyRoot, 'main.py'));
  const customRoot = path.join(comfyRoot, 'custom_nodes');
  const [ggufRoot, ltxCustomRoot, comfyBlenderRoot] = await Promise.all([
    findCustomNode(customRoot, 'ComfyUI-GGUF'),
    findCustomNode(customRoot, 'ComfyUI-LTXVideo'),
    findCustomNode(customRoot, 'ComfyUI-Blender'),
  ]);
  const modelFiles = comfyInstalled ? await listFiles(path.join(comfyRoot, 'models')) : [];
  const modelGroups = Object.fromEntries(Object.entries(MODEL_GROUPS).map(([key, pattern]) => {
    const matches = modelFiles.filter((file) => pattern.test(file.name));
    return [key, { installed: matches.length > 0, count: matches.length, files: matches.slice(0, 4).map((file) => file.name) }];
  }));
  const ltxCore = comfyInstalled && await exists(path.join(comfyRoot, 'comfy_extras', 'nodes_lt.py'));
  const ltxBackend = comfyInstalled && await exists(path.join(comfyRoot, 'comfy', 'ldm', 'lightricks', 'model.py'));
  const samNative = comfyInstalled && await exists(path.join(comfyRoot, 'comfy_extras', 'nodes_sam3.py'));
  const ltxReady = Boolean(comfyInstalled && (ltxCore || ltxCustomRoot) && modelGroups.transformer.installed && modelGroups.textEncoder.installed && modelGroups.videoVae.installed);

  const [python, gpuResult, disk, runnerProfile, comfyRepo, ggufRepo, comfyBlender] = await Promise.all([
    comfyInstalled ? getPythonAudit(comfyRoot) : Promise.resolve({ installed: false, pipHealthy: false, localRequirements: null, latestRequirements: null, packages: [], pipMessage: 'Install ComfyUI first.' }),
    runProcess('nvidia-smi', ['--query-gpu=index,name,driver_version,memory.total,memory.used,memory.free,compute_cap', '--format=csv,noheader,nounits']),
    comfyInstalled ? getDiskAudit(comfyRoot) : Promise.resolve({ available: false, freeGiB: null, totalGiB: null }),
    comfyInstalled ? getRunnerProfile(config, render) : Promise.resolve({ externalRunner: false, safeguards: [], knownWorking: false, automationLevel: 'unavailable', message: 'Install ComfyUI and LTX before configuring a GPU profile.' }),
    getRepositoryAudit(comfyInstalled ? comfyRoot : null, { id: 'comfy', name: 'ComfyUI core', upstream: 'Comfy-Org/ComfyUI', branch: 'master' }),
    getRepositoryAudit(ggufRoot, { id: 'gguf', name: 'ComfyUI-GGUF', upstream: 'city96/ComfyUI-GGUF', branch: 'main' }),
    getComfyBlenderAudit(comfyRoot, comfyBlenderRoot, config.comfyUrl, options.comfyBlenderReceipt),
  ]);
  const gpus = recommendGpuRoles(gpuResult.ok ? parseGpuCsv(gpuResult.stdout) : []);
  const ffmpeg = comfyInstalled && (await exists(path.join(comfyRoot, 'ffmpeg.exe')) || await exists(path.join(comfyRoot, 'ffprobe.exe')));
  const ltxDesktop = Boolean(process.env.LOCALAPPDATA && await exists(path.join(process.env.LOCALAPPDATA, 'LTXDesktop')));
  const dependenciesReady = Boolean(python.installed && python.pipHealthy && python.localRequirements?.satisfied);
  const repositories = [comfyRepo, ggufRepo].filter((repo) => repo.installed);
  const updateCount = repositories.filter((repo) => repo.updateStatus === 'behind').length;

  const checks = [
    statusItem('comfy', 'ComfyUI installation', comfyInstalled, comfyInstalled ? 'main.py and the local runtime were detected.' : 'ComfyUI was not found in the configured folder.'),
    statusItem('ltx', 'LTX 2.5 runtime', ltxReady, ltxReady ? 'Core LTX nodes and the required model components are present.' : 'One or more LTX nodes or required model components are missing.', ltxReady ? 'ready' : comfyInstalled ? 'attention' : 'missing'),
    statusItem('python', 'Python dependencies', dependenciesReady, dependenciesReady ? 'The installed packages satisfy this ComfyUI revision and pip reports no conflicts.' : python.pipMessage, dependenciesReady ? 'ready' : 'attention'),
    statusItem('ffmpeg', 'Video tools', ffmpeg, ffmpeg ? 'A local FFmpeg/FFprobe tool is available to the workflow.' : 'FFmpeg or FFprobe was not detected in the ComfyUI root.', ffmpeg ? 'ready' : 'attention'),
    statusItem('gpu', 'NVIDIA GPU', gpus.length > 0, gpus.length ? `${gpus.length} CUDA-capable NVIDIA GPU${gpus.length === 1 ? '' : 's'} detected.` : 'No NVIDIA GPU telemetry was available.'),
    statusItem('blender', 'ComfyUI-Blender', comfyBlender.ready, comfyBlender.detail, comfyBlender.ready ? 'ready' : comfyBlender.blenderDetected ? 'attention' : 'missing'),
  ];

  const warnings = [];
  if (render.active) warnings.push('A render is active. Installation, updates, dependency changes, and GPU smoke tests must remain locked.');
  if (repositories.some((repo) => repo.trustRequired)) warnings.push('Git requires one-time trust confirmation for at least one exact repository path before an updater can modify it.');
  if (updateCount) warnings.push(`${updateCount} installed component${updateCount === 1 ? ' has' : 's have'} an upstream update available.`);
  if (gpus.some((gpu) => gpu.role === 'auxiliary')) warnings.push('Sub-16 GB cards should not receive a concurrent LTX 2.5 22B job automatically.');
  if (comfyBlender.updateAvailable) warnings.push(`ComfyUI-Blender ${comfyBlender.latestVersion} is available; use the guarded setup action only while rendering is idle.`);

  const actions = [];
  if (!comfyInstalled) actions.push({ id: 'install-comfy', label: 'Open ComfyUI download', url: OFFICIAL_LINKS.comfyDownload, kind: 'primary', reason: 'Install the runtime used by LTX Watch.' });
  if (comfyInstalled && !ltxReady) actions.push({ id: 'install-ltx', label: 'Open official LTX models', url: OFFICIAL_LINKS.ltxModels, kind: 'primary', reason: 'Complete the missing LTX model pack.' });
  if (updateCount || !dependenciesReady) actions.push({ id: 'update-comfy', label: 'Open safe update guide', url: OFFICIAL_LINKS.comfyUpdate, kind: 'secondary', reason: render.active ? 'Review now; apply only after rendering is idle.' : 'Update core and matching Python dependencies together.' });
  if (!gpus.length) actions.push({ id: 'nvidia-driver', label: 'Open NVIDIA drivers', url: OFFICIAL_LINKS.nvidiaDriver, kind: 'secondary', reason: 'Install or repair NVIDIA GPU support.' });
  if (!comfyBlender.blenderDetected) actions.push({ id: 'install-blender', label: 'Open Blender download', url: OFFICIAL_LINKS.blenderDownload, kind: 'secondary', reason: 'Blender is required before the ComfyUI-Blender integration can be configured.' });
  actions.push({ id: 'ltx-desktop', label: ltxDesktop ? 'LTX Desktop releases' : 'Optional LTX Desktop', url: OFFICIAL_LINKS.ltxDesktop, kind: 'secondary', reason: 'Standalone alternative; Watch currently integrates with ComfyUI.' });

  const requiredReady = comfyInstalled && ltxReady && dependenciesReady && gpus.length > 0;
  const summary = !comfyInstalled
    ? { state: 'missing', title: 'ComfyUI setup required', detail: 'Watch can guide you to the official installer and then rescan the local environment.' }
    : requiredReady
      ? { state: updateCount ? 'attention' : 'ready', title: updateCount ? 'Ready, with updates available' : 'LTX environment ready', detail: render.active ? 'The current setup is working and protected while this render runs.' : 'Core runtime, LTX models, dependencies, and GPU support passed the local checks.' }
      : { state: 'attention', title: 'Setup needs attention', detail: 'The doctor found one or more incomplete components. Use the official actions below to repair them.' };

  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    summary,
    render: { ...render, changesLocked: Boolean(render.active) },
    installation: { comfyInstalled, ltxReady, ltxDesktop, root: comfyRoot },
    checks,
    models: { groups: modelGroups, coreNodes: ltxCore, backend: ltxBackend, advancedNodes: Boolean(ltxCustomRoot) },
    python,
    disk,
    repositories,
    gpus,
    runnerProfile,
    tools: {
      sam3: {
        nativeInstalled: samNative,
        modelInstalled: modelGroups.sam3.installed,
        automatedSetupSupported: Boolean(samNative && !modelGroups.sam3.installed),
        downloadBytes: 1_745_546_848,
        state: samNative && modelGroups.sam3.installed ? 'ready' : samNative ? 'model-required' : comfyRepo.updateStatus === 'behind' ? 'core-update-required' : 'unavailable',
        detail: samNative
          ? modelGroups.sam3.installed ? 'Native SAM 3 nodes and a local checkpoint were detected.' : 'Native SAM 3 nodes are ready; the licensed checkpoint still needs to be obtained.'
          : 'Native SAM 3 is available in newer ComfyUI core revisions.',
        links: { model: OFFICIAL_LINKS.sam3, license: OFFICIAL_LINKS.sam3License, guide: OFFICIAL_LINKS.sam3Guide },
      },
      ltxAdvanced: {
        installed: Boolean(ltxCustomRoot),
        detail: ltxCustomRoot ? 'Official Lightricks advanced nodes are installed.' : 'Optional advanced LTX workflows; evaluate VRAM requirements before installing.',
        url: OFFICIAL_LINKS.ltxComfy,
      },
      comfyBlender,
    },
    actions,
    warnings,
    officialLinks: OFFICIAL_LINKS,
  };
}
