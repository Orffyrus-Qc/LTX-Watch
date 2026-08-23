import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';

export function parseManagerInstallerResult(output) {
  const lines = String(output || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const marker = [...lines].reverse().find((line) => line.startsWith('LTX_WATCH_MANAGER_RESULT:'));
  if (!marker) return null;
  try { return JSON.parse(marker.slice('LTX_WATCH_MANAGER_RESULT:'.length)); } catch { return null; }
}

function resolveRunnerPath(comfyRoot, runnerFragment) {
  const root = path.resolve(comfyRoot);
  const runner = path.resolve(root, String(runnerFragment || ''));
  const relative = path.relative(root, runner);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('The configured Manager launcher must be a file inside the ComfyUI root.');
  }
  return runner;
}

export async function installComfyUiManager({ scriptPath, comfyRoot, runnerFragment, backupRoot, onStage = () => {} }) {
  if (process.platform !== 'win32') throw new Error('Automated ComfyUI Manager setup currently supports Windows only.');
  const root = path.resolve(String(comfyRoot || ''));
  const runnerPath = resolveRunnerPath(root, runnerFragment);
  await access(path.join(root, 'main.py')).catch(() => { throw new Error('The configured ComfyUI root is not a valid installation.'); });
  await access(path.join(root, 'manager_requirements.txt')).catch(() => { throw new Error('This ComfyUI revision does not include the built-in Manager. Update ComfyUI core first.'); });
  await access(runnerPath).catch(() => { throw new Error('The configured ComfyUI launcher was not found.'); });
  await access(scriptPath).catch(() => { throw new Error('The bundled ComfyUI Manager setup script is missing.'); });

  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    '-ComfyRoot', root,
    '-RunnerPath', runnerPath,
    '-BackupRoot', path.resolve(backupRoot),
  ];

  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let buffered = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('ComfyUI Manager setup exceeded ten minutes and was stopped.'));
    }, 600_000);

    child.stdout.on('data', (chunk) => {
      const value = String(chunk);
      stdout += value;
      buffered += value;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('LTX_WATCH_STAGE:')) onStage(line.slice('LTX_WATCH_STAGE:'.length).trim());
      }
      if (stdout.length > 2_000_000) stdout = stdout.slice(-1_000_000);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 1_000_000) stderr = stderr.slice(-500_000);
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      const result = parseManagerInstallerResult(`${stdout}\n${buffered}`);
      if (code !== 0 || !result?.ok) {
        reject(new Error(result?.error || stderr.trim() || 'ComfyUI Manager setup failed. File changes were restored when possible.'));
        return;
      }
      resolve(result);
    });
  });
}
