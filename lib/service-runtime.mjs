import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const WATCH_SERVICE_FRAGMENTS = [
  'local-server.mjs',
  'scripts\\run-local.mjs',
  'scripts/run-local.mjs',
  'scripts\\run-studio.mjs',
  'scripts/run-studio.mjs',
  'scripts\\run-installed.mjs',
  'scripts/run-installed.mjs',
  'scripts\\serve-production.mjs',
  'scripts/serve-production.mjs',
  'scripts\\start-hidden.vbs',
  'scripts/start-hidden.vbs',
  'vinext',
  'site:dev',
  'site:start',
];

const PROTECTED_FRAGMENTS = [
  'run_full_album',
  'comfyui',
  'python',
  'grok.exe',
  'blender',
];

export function isWatchServiceCommand(commandLine) {
  const text = String(commandLine || '').toLowerCase();
  if (!text.trim()) return false;
  if (PROTECTED_FRAGMENTS.some((fragment) => text.includes(fragment))) return false;
  return WATCH_SERVICE_FRAGMENTS.some((fragment) => text.includes(fragment.toLowerCase()));
}

export async function listeningPids(port) {
  const numeric = Number(port);
  if (!Number.isInteger(numeric) || numeric < 1) return [];
  try {
    const { stdout } = await execFileAsync('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, timeout: 5_000 });
    const pids = new Set();
    const matchPort = new RegExp(`[:\\[]${numeric}\\]?\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'i');
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.match(matchPort);
      if (match) pids.add(Number(match[1]));
    }
    return [...pids].filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

export async function commandLineForPid(pid) {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`],
      { windowsHide: true, timeout: 5_000 },
    );
    return String(stdout || '').trim();
  } catch {
    return '';
  }
}

export async function stopWatchService({ apiPort, sitePort } = {}) {
  const pids = new Set();
  for (const port of [sitePort, apiPort]) {
    for (const pid of await listeningPids(port)) pids.add(pid);
  }
  const stopped = [];
  for (const pid of pids) {
    if (pid === process.pid) continue;
    const commandLine = await commandLineForPid(pid);
    if (!isWatchServiceCommand(commandLine)) continue;
    try {
      process.kill(pid);
      stopped.push(pid);
    } catch {
      /* already gone */
    }
  }
  return stopped;
}
