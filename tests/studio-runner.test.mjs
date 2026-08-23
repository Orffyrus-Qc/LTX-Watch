import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.dirname(testRoot);

test('single-shot adapter applies a correction and returns a review output', async (context) => {
  const python = process.env.LTX_STUDIO_TEST_PYTHON || (process.platform === 'win32' ? 'python.exe' : 'python3');
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), 'ltx-watch-studio-'));
  try {
    const resultPath = path.join(fixtureRoot, 'result.json');
    const jobPath = path.join(fixtureRoot, 'job.json');
    const promptPath = path.join(fixtureRoot, 'prompt.txt');
    await writeFile(jobPath, JSON.stringify({
      sourceRunner: path.join(testRoot, 'fixtures', 'fake_album_runner.py'),
      section: 'album',
      track: 'Scene One',
      slug: 'scene_one_full',
      shot: '0001',
      correction: 'slow the camera and reduce the flicker\nDIALOGUE: Stay with me.',
      port: 18188,
      cudaDevice: 0,
      resultPath,
    }), 'utf8');
    const run = spawnSync(python, [path.join(appRoot, 'scripts', 'ltx-studio-runner.py'), '--job', jobPath], {
      cwd: fixtureRoot,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, LTX_STUDIO_FIXTURE_OUTPUT: path.join(fixtureRoot, 'output'), LTX_STUDIO_FIXTURE_PROMPT: promptPath },
    });
    if (run.error?.code === 'ENOENT') {
      context.skip(`Python executable not available: ${python}`);
      return;
    }
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const result = JSON.parse(await readFile(resultPath, 'utf8'));
    assert.equal(result.status, 'review');
    assert.match(result.outputPath, /0001_00001_\.mp4$/);
    const prompt = await readFile(promptPath, 'utf8');
    assert.match(prompt, /NON-SPOKEN DIRECTOR REVISION/);
    assert.match(prompt, /<director_note>\s*slow the camera and reduce the flicker\s*<\/director_note>/);
    assert.match(prompt, /<spoken_dialogue>\s*Stay with me\.\s*<\/spoken_dialogue>/);
    assert.doesNotMatch(prompt, /<director_note>[\s\S]*DIALOGUE:/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test('single-shot adapter exposes completed source scenes for project mapping', (context) => {
  const python = process.env.LTX_STUDIO_TEST_PYTHON || (process.platform === 'win32' ? 'python.exe' : 'python3');
  const run = spawnSync(python, [path.join(appRoot, 'scripts', 'ltx-studio-runner.py'), '--inspect-source', path.join(testRoot, 'fixtures', 'fake_album_runner.py')], {
    cwd: testRoot,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, LTX_STUDIO_FIXTURE_OUTPUT: path.join(tmpdir(), 'ltx-watch-studio-inspect-output') },
  });
  if (run.error?.code === 'ENOENT') {
    context.skip(`Python executable not available: ${python}`);
    return;
  }
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const [scene] = JSON.parse(run.stdout);
  assert.deepEqual(scene, { section: 'album', track: 'Scene One', slug: 'scene_one_full', shots: '0001', count: 1 });
});
