import { spawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OFFICIAL_REPOSITORIES = new Set([
  'github.com/comfyanonymous/comfyui',
  'github.com/comfy-org/comfyui',
]);

function normalizeRemote(value) {
  const raw = String(value || '').trim().replace(/\.git$/i, '');
  const expanded = raw.replace(/^git@github\.com:/i, 'https://github.com/').replace(/^ssh:\/\/git@github\.com\//i, 'https://github.com/');
  try {
    const url = new URL(expanded);
    return `${url.hostname.toLowerCase()}${url.pathname.toLowerCase().replace(/\/+$/, '')}`;
  } catch {
    return '';
  }
}

export function isOfficialComfyUiRemote(value) {
  return OFFICIAL_REPOSITORIES.has(normalizeRemote(value));
}

function defaultRunProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, code: null, stdout, stderr: `${stderr}\nCommand timed out.`.trim() });
    }, options.timeout || 120_000);
    child.stdout.on('data', (chunk) => { stdout = `${stdout}${chunk}`.slice(-2_000_000); });
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-1_000_000); });
    child.once('error', (error) => finish({ ok: false, code: null, stdout, stderr: error.message }));
    child.once('close', (code) => finish({ ok: code === 0, code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}

function requireSuccess(result, message) {
  if (!result?.ok) throw new Error(result?.stderr || result?.stdout || message);
  return result.stdout.trim();
}

async function findPython(root) {
  const candidates = [
    path.join(root, 'venv', 'Scripts', 'python.exe'),
    path.join(root, '.venv', 'Scripts', 'python.exe'),
    path.join(root, 'python_embeded', 'python.exe'),
    path.join(root, 'python', 'python.exe'),
  ];
  for (const candidate of candidates) {
    if (await access(candidate).then(() => true).catch(() => false)) return candidate;
  }
  throw new Error('No ComfyUI Python environment was detected. Core files were not changed.');
}

export async function updateComfyUiCore({ comfyRoot, backupRoot, onStage = () => {}, runProcess = defaultRunProcess }) {
  const root = path.resolve(String(comfyRoot || ''));
  await access(path.join(root, 'main.py')).catch(() => { throw new Error('The configured ComfyUI root is not a valid installation.'); });
  await access(path.join(root, '.git')).catch(() => { throw new Error('ComfyUI core is not a Git checkout and cannot be updated automatically.'); });
  const python = await findPython(root);
  const safeRoot = root.replaceAll('\\', '/');
  const git = (args, timeout = 120_000) => runProcess('git', ['-c', `safe.directory=${safeRoot}`, '-C', root, ...args], { timeout });

  onStage('Validating the official ComfyUI checkout');
  const remote = requireSuccess(await git(['remote', 'get-url', 'origin']), 'Could not read the ComfyUI origin remote.');
  if (!isOfficialComfyUiRemote(remote)) throw new Error('Automatic update refused: the ComfyUI origin is not an official ComfyUI GitHub repository.');
  const branch = requireSuccess(await git(['branch', '--show-current']), 'Could not read the ComfyUI branch.');
  if (branch !== 'master') throw new Error(`Automatic update requires the official master branch. Current branch: ${branch || 'detached HEAD'}.`);
  const trackedChanges = requireSuccess(await git(['status', '--porcelain', '--untracked-files=no']), 'Could not inspect the ComfyUI worktree.');
  if (trackedChanges) throw new Error('Automatic update refused because ComfyUI has tracked local changes. Commit or restore them first; untracked workflows and render files are preserved.');
  const previousCommit = requireSuccess(await git(['rev-parse', 'HEAD']), 'Could not read the current ComfyUI commit.');

  onStage('Fetching the official ComfyUI update');
  requireSuccess(await git(['fetch', '--prune', 'origin', 'master'], 300_000), 'Could not fetch the official ComfyUI update.');
  const targetCommit = requireSuccess(await git(['rev-parse', 'FETCH_HEAD']), 'Could not resolve the fetched ComfyUI revision.');
  if (targetCommit === previousCommit) {
    return { ok: true, updated: false, previousCommit, currentCommit: previousCommit, dependenciesUpdated: false, comfyRestartRequired: false };
  }
  requireSuccess(await git(['merge-base', '--is-ancestor', previousCommit, targetCommit]), 'The local ComfyUI history has diverged; only fast-forward updates are allowed.');

  const receiptDirectory = path.resolve(backupRoot, 'comfyui-core');
  await mkdir(receiptDirectory, { recursive: true });
  const receiptPath = path.join(receiptDirectory, `${previousCommit.slice(0, 12)}.json`);
  await writeFile(receiptPath, `${JSON.stringify({ root, remote, branch, previousCommit, targetCommit, createdAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');

  let coreUpdated = false;
  try {
    onStage('Fast-forwarding ComfyUI core');
    requireSuccess(await git(['merge', '--ff-only', targetCommit], 300_000), 'ComfyUI could not be fast-forwarded.');
    coreUpdated = true;
    onStage('Installing matching Python requirements');
    requireSuccess(await runProcess(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', path.join(root, 'requirements.txt')], { cwd: root, timeout: 1_800_000 }), 'ComfyUI requirements could not be installed.');
    onStage('Validating Python dependencies');
    requireSuccess(await runProcess(python, ['-m', 'pip', 'check'], { cwd: root, timeout: 120_000 }), 'Python dependency validation failed.');
    return { ok: true, updated: true, previousCommit, currentCommit: targetCommit, dependenciesUpdated: true, comfyRestartRequired: true, backupReceipt: receiptPath };
  } catch (error) {
    if (!coreUpdated) throw error;
    onStage('Rolling back the ComfyUI update');
    const reset = await git(['reset', '--hard', previousCommit], 300_000);
    const restore = reset.ok
      ? await runProcess(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', path.join(root, 'requirements.txt')], { cwd: root, timeout: 1_800_000 })
      : { ok: false, stderr: reset.stderr || reset.stdout };
    if (!reset.ok || !restore.ok) throw new Error(`${error.message} Automatic rollback was incomplete: ${restore.stderr || restore.stdout || 'Git reset failed.'}`);
    throw new Error(`${error.message} ComfyUI core and its previous requirements were restored.`);
  }
}
