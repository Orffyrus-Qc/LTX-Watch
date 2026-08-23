import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';

export const SAM3_MODEL = Object.freeze({
  filename: 'sam3.1_multiplex_fp16.safetensors',
  url: 'https://huggingface.co/Comfy-Org/sam3.1/resolve/main/checkpoints/sam3.1_multiplex_fp16.safetensors',
  sha256: '9ba99c92703c2e8b4f47de2d34a539bb8e18923049e238b780d70dbe6368eb03',
  size: 1_745_546_848,
});

export function parseSam3InstallerResult(output) {
  const lines = String(output || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const marker = [...lines].reverse().find((line) => line.startsWith('LTX_WATCH_SAM3_RESULT:'));
  if (!marker) return null;
  try { return JSON.parse(marker.slice('LTX_WATCH_SAM3_RESULT:'.length)); } catch { return null; }
}

export async function installSam3Model({ scriptPath, comfyRoot, backupRoot, onStage = () => {} }) {
  if (process.platform !== 'win32') throw new Error('Automated SAM 3.1 setup currently supports Windows only.');
  const root = path.resolve(String(comfyRoot || ''));
  await access(path.join(root, 'main.py')).catch(() => { throw new Error('The configured ComfyUI root is not a valid installation.'); });
  await access(path.join(root, 'comfy_extras', 'nodes_sam3.py')).catch(() => { throw new Error('This ComfyUI revision does not include native SAM 3.1 nodes. Update ComfyUI core first.'); });
  await access(scriptPath).catch(() => { throw new Error('The bundled SAM 3.1 setup script is missing.'); });

  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    '-ComfyRoot', root,
    '-BackupRoot', path.resolve(backupRoot),
    '-ModelUrl', SAM3_MODEL.url,
    '-ExpectedSha256', SAM3_MODEL.sha256,
    '-ExpectedSize', String(SAM3_MODEL.size),
  ];

  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let buffered = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('SAM 3.1 model download exceeded 45 minutes and was stopped.'));
    }, 2_700_000);

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
      const result = parseSam3InstallerResult(`${stdout}\n${buffered}`);
      if (code !== 0 || !result?.ok) {
        reject(new Error(result?.error || stderr.trim() || 'SAM 3.1 setup failed. The partial download was removed.'));
        return;
      }
      resolve(result);
    });
  });
}
