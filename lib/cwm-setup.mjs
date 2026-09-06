import { homedir } from 'node:os';
import path from 'node:path';
import { access, readFile } from 'node:fs/promises';

export const CWM_OFFICIAL = Object.freeze({
  modelId: 'facebook/cwm',
  github: 'https://github.com/facebookresearch/cwm',
  huggingface: 'https://huggingface.co/facebook/cwm',
  license: 'https://ai.meta.com/resources/models-and-libraries/cwm-license/',
  paper: 'https://arxiv.org/abs/2510.02387',
  promptingGuide: 'https://github.com/facebookresearch/cwm/blob/main/PROMPTING_GUIDE.md',
  officialVramGb: 80,
  researchOnly: true,
  defaultServerUrl: 'http://127.0.0.1:8000',
});

export const CWM_SYSTEM_PROMPT = [
  'You are a helpful AI assistant. You always reason before responding, using the following format:',
  '',
  '<think>',
  'your internal reasoning',
  '</think>',
  'your external response',
].join('\n');

export function isCwmModelName(name) {
  const value = String(name || '').trim().toLowerCase();
  if (!value) return false;
  if (value === 'cwm' || value === 'facebook/cwm' || value === 'facebook/cwm-sft') return true;
  return /(^|[:/_-])cwm([:-]|$)/.test(value) || value.includes('facebook/cwm');
}

export function isLoopbackHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1');
  } catch {
    return false;
  }
}

export function normalizeCwmUrl(value) {
  const raw = String(value || CWM_OFFICIAL.defaultServerUrl).trim() || CWM_OFFICIAL.defaultServerUrl;
  if (!isLoopbackHttpUrl(raw)) throw new Error('Code World Model must stay on loopback (127.0.0.1 or localhost).');
  return raw.replace(/\/+$/, '');
}

export function stripCwmThink(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
}

export function huggingfaceTokenPath() {
  return path.join(homedir(), '.cache', 'huggingface', 'token');
}

export function cwmWeightsRoot(appRoot) {
  return path.join(appRoot, '.ltx-watch-cwm', 'facebook-cwm');
}

export async function huggingfaceTokenPresent() {
  try {
    const raw = (await readFile(huggingfaceTokenPath(), 'utf8')).trim();
    return raw.length > 8;
  } catch {
    return false;
  }
}

async function readHuggingFaceToken() {
  try {
    const raw = (await readFile(huggingfaceTokenPath(), 'utf8')).trim();
    return raw.length > 8 ? raw : '';
  } catch {
    return '';
  }
}

export function cwmCapability({
  huggingfaceConnected = false,
  huggingfaceAccess = false,
  huggingfaceUser = null,
  serverOnline = false,
  serverModel = null,
  ollamaCwm = null,
  weightsInstalled = false,
  maxVramGb = 0,
} = {}) {
  const canLoadOfficial = Number(maxVramGb) >= CWM_OFFICIAL.officialVramGb;
  const plannerReady = Boolean(serverOnline || ollamaCwm);
  let blockedReason = '';
  if (!huggingfaceConnected) blockedReason = 'Sign in to Hugging Face locally, then accept the CWM research license on facebook/cwm.';
  else if (!huggingfaceAccess) blockedReason = 'Hugging Face is signed in, but this account has not been granted facebook/cwm yet. Open the model page and accept the CWM research license.';
  else if (!plannerReady && !canLoadOfficial) {
    blockedReason = `CWM access is granted. Official facebook/cwm needs about ${CWM_OFFICIAL.officialVramGb} GB VRAM; this machine's largest GPU is ${Number(maxVramGb) || 0} GB. Serve CWM on loopback vLLM, or import a local GGUF into Ollama named cwm for Auto-Pilot planning.`;
  } else if (!plannerReady) {
    blockedReason = 'CWM weights or a loopback OpenAI-compatible server are not running. Start vLLM on 127.0.0.1:8000 or load an Ollama model named cwm.';
  } else {
    blockedReason = 'Code World Model will plan Auto-Pilot scene specs. It may emit JSON only; Watch never executes model-generated Python. CWM is research-only and non-commercial.';
  }
  return {
    schemaVersion: 1,
    modelId: CWM_OFFICIAL.modelId,
    github: CWM_OFFICIAL.github,
    huggingface: CWM_OFFICIAL.huggingface,
    license: CWM_OFFICIAL.license,
    paper: CWM_OFFICIAL.paper,
    researchOnly: true,
    huggingfaceConnected,
    huggingfaceAccess,
    huggingfaceUser: huggingfaceUser || null,
    serverOnline,
    serverModel: serverModel || null,
    ollamaCwm: ollamaCwm || null,
    weightsInstalled,
    canLoadOfficial,
    officialVramGb: CWM_OFFICIAL.officialVramGb,
    plannerReady,
    planner: serverOnline ? 'cwm-openai' : ollamaCwm ? 'ollama-cwm' : null,
    blockedReason,
    links: {
      github: CWM_OFFICIAL.github,
      huggingface: CWM_OFFICIAL.huggingface,
      license: CWM_OFFICIAL.license,
      paper: CWM_OFFICIAL.paper,
      promptingGuide: CWM_OFFICIAL.promptingGuide,
    },
  };
}

export async function probeCwmOpenAiServer(url) {
  let normalized = '';
  try { normalized = normalizeCwmUrl(url); } catch { return { online: false, url: '', model: null }; }
  try {
    const response = await fetch(`${normalized}/v1/models`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return { online: false, url: normalized, model: null };
    const payload = await response.json();
    const names = (payload.data || []).map((item) => String(item.id || '').trim()).filter(Boolean);
    const model = names.find((name) => isCwmModelName(name)) || names[0] || CWM_OFFICIAL.modelId;
    return { online: true, url: normalized, model };
  } catch {
    return { online: false, url: normalized, model: null };
  }
}

export async function probeFacebookCwmAccess() {
  const token = await readHuggingFaceToken();
  if (!token) return { connected: false, access: false, user: null };
  try {
    const who = await fetch('https://huggingface.co/api/whoami-v2', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(4000),
    });
    if (!who.ok) return { connected: false, access: false, user: null };
    const identity = await who.json();
    const user = String(identity.name || identity.fullname || '').slice(0, 80) || 'signed-in';
    const model = await fetch('https://huggingface.co/api/models/facebook/cwm', {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(4000),
    });
    if (model.status === 401 || model.status === 403) return { connected: true, access: false, user };
    if (!model.ok) return { connected: true, access: false, user };
    return { connected: true, access: true, user };
  } catch {
    return { connected: Boolean(token), access: false, user: null };
  }
}

export async function localCwmWeightsInstalled(appRoot) {
  const root = cwmWeightsRoot(appRoot);
  try {
    await access(path.join(root, 'config.json'));
    return true;
  } catch {
    return false;
  }
}

export function parseCwmInstallerResult(output) {
  const lines = String(output || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const marker = [...lines].reverse().find((line) => line.startsWith('LTX_WATCH_CWM_RESULT:'));
  if (!marker) return null;
  try { return JSON.parse(marker.slice('LTX_WATCH_CWM_RESULT:'.length)); } catch { return null; }
}
