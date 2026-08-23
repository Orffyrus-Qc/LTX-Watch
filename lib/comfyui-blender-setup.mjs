import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function normalizeLoopbackComfyUrl(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw new Error('The ComfyUI address is not a valid URL.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('The ComfyUI address must use HTTP or HTTPS.');
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) throw new Error('ComfyUI-Blender setup is restricted to a loopback ComfyUI address.');
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function parseInstallerResult(output) {
  const lines = String(output || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const marker = [...lines].reverse().find((line) => line.startsWith('LTX_WATCH_RESULT:'));
  if (!marker) return null;
  try { return JSON.parse(marker.slice('LTX_WATCH_RESULT:'.length)); } catch { return null; }
}

export async function installComfyUiBlender({ scriptPath, comfyRoot, comfyUrl, onStage = () => {} }) {
  if (process.platform !== 'win32') throw new Error('Automated ComfyUI-Blender setup currently supports Windows only.');
  const root = path.resolve(String(comfyRoot || ''));
  await access(path.join(root, 'main.py')).catch(() => { throw new Error('The configured ComfyUI root is not a valid installation.'); });
  await access(scriptPath).catch(() => { throw new Error('The bundled ComfyUI-Blender setup script is missing.'); });
  const serverAddress = normalizeLoopbackComfyUrl(comfyUrl);

  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
    '-ComfyRoot', root,
    '-ComfyUrl', serverAddress,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let buffered = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('ComfyUI-Blender setup exceeded five minutes and was stopped.'));
    }, 300_000);

    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      stdout += text;
      buffered += text;
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
      const result = parseInstallerResult(`${stdout}\n${buffered}`);
      if (code !== 0 || !result?.ok) {
        reject(new Error(result?.error || stderr.trim() || 'ComfyUI-Blender setup failed. Existing files were restored when possible.'));
        return;
      }
      resolve(result);
    });
  });
}
