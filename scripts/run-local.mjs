import { spawn } from 'node:child_process';

const mode = process.argv[2] === 'start' ? 'start' : 'dev';
const siteCommand = process.platform === 'win32'
  ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm run site:${mode}`]]
  : ['npm', ['run', `site:${mode}`]];
const children = [
  spawn(process.execPath, ['local-server.mjs'], { stdio: 'inherit' }),
  spawn(siteCommand[0], siteCommand[1], { stdio: 'inherit' }),
];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  setTimeout(() => process.exit(code), 150).unref();
}

for (const child of children) {
  child.on('exit', (code) => {
    if (!stopping && code && code !== 0) stop(code);
  });
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
