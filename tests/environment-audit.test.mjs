import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  analyzeRequirements,
  chooseComfyBlenderChannel,
  compareVersions,
  parseBlenderVersion,
  parseGpuCsv,
  parseRequirements,
  recommendGpuRoles,
} from '../lib/environment-audit.mjs';
import { normalizeLoopbackComfyUrl, parseInstallerResult } from '../lib/comfyui-blender-setup.mjs';
import { parseManagerInstallerResult } from '../lib/comfyui-manager-setup.mjs';
import { SAM3_MODEL, parseSam3InstallerResult } from '../lib/sam3-setup.mjs';

test('requirements are normalized and checked without importing packages', () => {
  const requirements = [
    'comfyui-frontend-package==1.49.6',
    'numpy>=1.25.0',
    'pydantic~=2.0',
    '# ignored',
  ].join('\n');
  const installed = [
    { name: 'comfyui_frontend_package', version: '1.48.7' },
    { name: 'numpy', version: '2.4.4' },
    { name: 'pydantic', version: '2.12.0' },
  ];

  assert.equal(parseRequirements(requirements).length, 3);
  const result = analyzeRequirements(requirements, installed);
  assert.deepEqual(result.missing, []);
  assert.equal(result.mismatched.length, 1);
  assert.equal(result.mismatched[0].requirement, 'comfyui-frontend-package==1.49.6');
  assert.equal(result.satisfied, false);
});

test('numeric package versions compare independently of CUDA build suffixes', () => {
  assert.equal(compareVersions('2.13.0+cu130', '2.13.0'), 0);
  assert.equal(compareVersions('1.49.6', '1.48.7'), 1);
  assert.equal(compareVersions('0.5.9', '0.5.10'), -1);
});

test('GPU policy keeps sub-16 GB cards out of the primary LTX role', () => {
  const csv = [
    '0, NVIDIA GeForce RTX 5060 Ti, 610.88, 16311, 10418, 5634, 12.0',
    '1, NVIDIA GeForce RTX 3060, 610.88, 12288, 0, 12115, 8.6',
  ].join('\n');
  const gpus = recommendGpuRoles(parseGpuCsv(csv));

  assert.equal(gpus[0].role, 'primary');
  assert.equal(gpus[1].role, 'auxiliary');
  assert.equal(gpus[0].totalMemoryGb, 15.9);
});

test('ComfyUI-Blender release selection follows the supported Blender generation', () => {
  assert.deepEqual(parseBlenderVersion('Blender 5.2.0 LTS'), { major: 5, minor: 2, patch: 0, text: '5.2.0' });
  assert.equal(chooseComfyBlenderChannel('5.2.0').releaseTag, null);
  assert.equal(chooseComfyBlenderChannel('4.5.3').releaseTag, 'v3.3.4');
  assert.equal(chooseComfyBlenderChannel('4.4.0').supported, false);
});

test('automated Blender setup accepts loopback ComfyUI addresses only', () => {
  assert.equal(normalizeLoopbackComfyUrl('http://127.0.0.1:8188/'), 'http://127.0.0.1:8188');
  assert.equal(normalizeLoopbackComfyUrl('http://localhost:8188'), 'http://localhost:8188');
  assert.throws(() => normalizeLoopbackComfyUrl('https://example.com:8188'), /loopback/i);
});

test('PowerShell setup results are parsed only from the explicit result marker', () => {
  const payload = parseInstallerResult('Blender output\nLTX_WATCH_RESULT:{"ok":true,"version":"4.5.1"}\n');
  assert.deepEqual(payload, { ok: true, version: '4.5.1' });
  assert.equal(parseInstallerResult('ordinary output'), null);
});

test('Manager setup results use a separate explicit result marker', () => {
  const payload = parseManagerInstallerResult('pip output\nLTX_WATCH_MANAGER_RESULT:{"ok":true,"mode":"built-in","version":"4.2.2"}\n');
  assert.deepEqual(payload, { ok: true, mode: 'built-in', version: '4.2.2' });
  assert.equal(parseManagerInstallerResult('LTX_WATCH_RESULT:{"ok":true}'), null);
});

test('SAM 3.1 setup pins the official checkpoint and parses only its result marker', () => {
  assert.equal(SAM3_MODEL.url, 'https://huggingface.co/Comfy-Org/sam3.1/resolve/main/checkpoints/sam3.1_multiplex_fp16.safetensors');
  assert.equal(SAM3_MODEL.size, 1_745_546_848);
  assert.match(SAM3_MODEL.sha256, /^[a-f0-9]{64}$/);
  const payload = parseSam3InstallerResult('download output\nLTX_WATCH_SAM3_RESULT:{"ok":true,"verified":true}\n');
  assert.deepEqual(payload, { ok: true, verified: true });
  assert.equal(parseSam3InstallerResult('LTX_WATCH_MANAGER_RESULT:{"ok":true}'), null);
});

test('SAM 3.1 installer hashes with .NET without relying on Get-FileHash module loading', async () => {
  const script = await readFile(new URL('../scripts/install-sam3.ps1', import.meta.url), 'utf8');
  assert.match(script, /System\.Security\.Cryptography\.SHA256/);
  assert.doesNotMatch(script, /Get-FileHash/);
});

test('ComfyUI-Blender installer hashes with .NET without relying on Get-FileHash module loading', async () => {
  const script = await readFile(new URL('../scripts/install-comfyui-blender.ps1', import.meta.url), 'utf8');
  assert.match(script, /System\.Security\.Cryptography\.SHA256/);
  assert.doesNotMatch(script, /Get-FileHash/);
});
