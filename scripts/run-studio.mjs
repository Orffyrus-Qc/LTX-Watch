import { spawn } from 'node:child_process';

const child = spawn(process.execPath, ['scripts/run-local.mjs', 'dev'], {
  cwd: process.cwd(),
  stdio: 'inherit',
  env: {
    ...process.env,
    LTX_WATCH_API_PORT: process.env.LTX_WATCH_STUDIO_API_PORT || '4312',
    LTX_WATCH_SITE_PORT: process.env.LTX_WATCH_STUDIO_SITE_PORT || '3001',
    NEXT_PUBLIC_LTX_WATCH_API: process.env.NEXT_PUBLIC_LTX_WATCH_API || 'http://127.0.0.1:4312',
  },
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('exit', (code) => process.exit(code ?? 0));
