import { createHash } from 'node:crypto';
import path from 'node:path';

export const BROWSER_PLAYBACK_CACHE_LIMIT = 8;

export function browserPlaybackKey(sourcePath, info) {
  const identity = `${path.resolve(sourcePath).toLowerCase()}\0${Number(info?.size) || 0}\0${Math.trunc(Number(info?.mtimeMs) || 0)}`;
  return createHash('sha256').update(identity).digest('hex').slice(0, 32);
}

export function browserPlaybackPaths(cacheRoot, key, processId = process.pid) {
  if (!/^[a-f0-9]{32}$/.test(key)) throw new Error('Invalid browser playback cache key.');
  return {
    targetPath: path.join(cacheRoot, `${key}.browser.mp4`),
    temporaryPath: path.join(cacheRoot, `${key}.${Math.max(0, Math.trunc(Number(processId) || 0))}.partial.mp4`),
  };
}

export function browserPlaybackArguments(sourcePath, temporaryPath) {
  if (path.resolve(sourcePath) === path.resolve(temporaryPath)) throw new Error('Browser playback output must not overwrite its source.');
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-fflags', '+genpts', '-i', sourcePath,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-map_metadata', '0',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-fps_mode', 'cfr',
    '-c:a', 'copy', '-movflags', '+faststart',
    temporaryPath,
  ];
}
