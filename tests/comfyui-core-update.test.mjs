import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isOfficialComfyUiRemote, updateComfyUiCore } from '../lib/comfyui-core-update.mjs';

const previousCommit = 'a'.repeat(40);
const targetCommit = 'b'.repeat(40);

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'ltx-watch-comfy-update-'));
  await mkdir(path.join(root, '.git'));
  await mkdir(path.join(root, 'venv', 'Scripts'), { recursive: true });
  await writeFile(path.join(root, 'main.py'), '', 'utf8');
  await writeFile(path.join(root, 'requirements.txt'), 'example==1.0\n', 'utf8');
  await writeFile(path.join(root, 'venv', 'Scripts', 'python.exe'), '', 'utf8');
  return root;
}

function successfulRunner(calls, remote = 'https://github.com/comfyanonymous/ComfyUI.git') {
  return async (command, args) => {
    calls.push([command, ...args]);
    const joined = args.join(' ');
    if (joined.includes('remote get-url origin')) return { ok: true, stdout: remote, stderr: '' };
    if (joined.includes('branch --show-current')) return { ok: true, stdout: 'master', stderr: '' };
    if (joined.includes('status --porcelain')) return { ok: true, stdout: '', stderr: '' };
    if (joined.includes('rev-parse HEAD')) return { ok: true, stdout: previousCommit, stderr: '' };
    if (joined.includes('rev-parse FETCH_HEAD')) return { ok: true, stdout: targetCommit, stderr: '' };
    return { ok: true, stdout: '', stderr: '' };
  };
}

test('official ComfyUI remotes are allowlisted without accepting lookalikes', () => {
  assert.equal(isOfficialComfyUiRemote('https://github.com/comfyanonymous/ComfyUI.git'), true);
  assert.equal(isOfficialComfyUiRemote('git@github.com:Comfy-Org/ComfyUI.git'), true);
  assert.equal(isOfficialComfyUiRemote('https://github.com/example/ComfyUI.git'), false);
});

test('ComfyUI updater performs a scoped, fast-forward update and dependency validation', async () => {
  const root = await fixture();
  const calls = [];
  const stages = [];
  try {
    const result = await updateComfyUiCore({
      comfyRoot: root,
      backupRoot: path.join(root, 'backups'),
      onStage: (stage) => stages.push(stage),
      runProcess: successfulRunner(calls),
    });
    assert.equal(result.updated, true);
    assert.equal(result.previousCommit, previousCommit);
    assert.equal(result.currentCommit, targetCommit);
    assert.equal(result.comfyRestartRequired, true);
    assert.match(await readFile(result.backupReceipt, 'utf8'), new RegExp(previousCommit));
    assert.ok(calls.some((call) => call.join(' ').includes(`safe.directory=${root.replaceAll('\\', '/')}`)));
    assert.ok(calls.some((call) => call.join(' ').includes('merge --ff-only')));
    assert.ok(calls.some((call) => call.join(' ').includes('-m pip install')));
    assert.ok(calls.some((call) => call.join(' ').includes('-m pip check')));
    assert.ok(stages.includes('Installing matching Python requirements'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ComfyUI updater rejects an unofficial origin before changing files', async () => {
  const root = await fixture();
  const calls = [];
  try {
    await assert.rejects(() => updateComfyUiCore({
      comfyRoot: root,
      backupRoot: path.join(root, 'backups'),
      runProcess: successfulRunner(calls, 'https://github.com/example/ComfyUI.git'),
    }), /not an official ComfyUI GitHub repository/);
    assert.equal(calls.some((call) => call.includes('fetch')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ComfyUI updater restores the previous core revision when dependency installation fails', async () => {
  const root = await fixture();
  const calls = [];
  let pipInstalls = 0;
  const baseRunner = successfulRunner(calls);
  try {
    await assert.rejects(() => updateComfyUiCore({
      comfyRoot: root,
      backupRoot: path.join(root, 'backups'),
      runProcess: async (command, args, options) => {
        if (args.join(' ').includes('-m pip install')) {
          calls.push([command, ...args]);
          pipInstalls += 1;
          if (pipInstalls === 1) return { ok: false, stdout: '', stderr: 'dependency conflict' };
          return { ok: true, stdout: '', stderr: '' };
        }
        return baseRunner(command, args, options);
      },
    }), /previous requirements were restored/);
    assert.ok(calls.some((call) => call.join(' ').includes(`reset --hard ${previousCommit}`)));
    assert.equal(pipInstalls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
