import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CWM_OFFICIAL,
  CWM_SYSTEM_PROMPT,
  cwmCapability,
  isCwmModelName,
  normalizeCwmUrl,
  stripCwmThink,
} from '../lib/cwm-setup.mjs';
import { chooseOllamaModel } from '../lib/blender-autopilot.mjs';

test('CWM official identity stays on Meta GitHub and Hugging Face', () => {
  assert.equal(CWM_OFFICIAL.modelId, 'facebook/cwm');
  assert.equal(CWM_OFFICIAL.github, 'https://github.com/facebookresearch/cwm');
  assert.equal(CWM_OFFICIAL.huggingface, 'https://huggingface.co/facebook/cwm');
  assert.match(CWM_OFFICIAL.license, /cwm-license/i);
  assert.equal(CWM_OFFICIAL.researchOnly, true);
  assert.equal(CWM_OFFICIAL.officialVramGb, 80);
  assert.match(CWM_SYSTEM_PROMPT, /<think>/);
});

test('CWM server URLs stay on loopback', () => {
  assert.equal(normalizeCwmUrl('http://127.0.0.1:8000/'), 'http://127.0.0.1:8000');
  assert.throws(() => normalizeCwmUrl('http://192.168.1.10:8000'), /loopback/i);
});

test('CWM think blocks are stripped before JSON parse', () => {
  const raw = '<think>reason about halo placement</think>\n{"kind":"blender-autopilot-scene","objects":[]}';
  assert.match(stripCwmThink(raw), /blender-autopilot-scene/);
  assert.doesNotMatch(stripCwmThink(raw), /<think>/);
});

test('CWM model names are recognized for Ollama and OpenAI servers', () => {
  assert.equal(isCwmModelName('facebook/cwm'), true);
  assert.equal(isCwmModelName('cwm'), true);
  assert.equal(isCwmModelName('hf.co/PsiPi/cwm-Q3_K_M-GGUF:Q3_K_M'), true);
  assert.equal(isCwmModelName('qwen2.5-coder:14b-agent'), false);
});

test('Auto-Pilot prefers an installed CWM Ollama model over generic coder models', () => {
  assert.equal(chooseOllamaModel(['qwen2.5-coder:14b-agent', 'cwm'], ''), 'cwm');
});

test('this 16 GB class GPU cannot load official 32B CWM', () => {
  const capability = cwmCapability({
    huggingfaceConnected: true,
    huggingfaceAccess: true,
    huggingfaceUser: 'fixture',
    maxVramGb: 16.3,
  });
  assert.equal(capability.canLoadOfficial, false);
  assert.equal(capability.plannerReady, false);
  assert.match(capability.blockedReason, /80 GB/i);
  assert.equal(capability.researchOnly, true);
});
