'use client';

import {
  ArrowUpToLine,
  Box,
  Check,
  CircleAlert,
  Clock3,
  Film,
  FileBox,
  FolderOpen,
  ImagePlus,
  LoaderCircle,
  Music2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  Upload,
  Video,
  WandSparkles,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StudioVideo } from './studio-workspace';

type CreateDraft = {
  title: string;
  prompt: string;
  avoid: string;
  resolution: string;
  duration: number;
  frameRate: number;
  seedMode: 'random' | 'fixed';
  seed: number;
  variations: number;
  promptEnhance: boolean;
  camera: string;
  motion: string;
  style: string;
  customStyle: string;
  audio: string;
  referenceMode: 'text' | 'first-frame' | 'first-last';
  firstFramePath: string;
  lastFramePath: string;
  contextVideoPath: string;
  soundtrackPath: string;
  useBlender: boolean;
  blenderProjectId: string;
  blenderUploadPath: string;
  blenderFirstFrame: number;
  blenderLastFrame: number;
  contextAssets: { id: string; name: string; kind: 'image' | 'video' | 'audio' | 'blend'; path: string; size: number }[];
};

type CreateJob = {
  id: string;
  title: string;
  status: 'queued' | 'generating' | 'complete' | 'failed';
  stage: string | null;
  progress: number;
  seed: number;
  variation: number;
  variations: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  summary: string;
  mode: string;
  video: StudioVideo | null;
};

type CreateView = {
  enabled: boolean;
  adapterReady: boolean;
  canStart: boolean;
  blockedReason: string | null;
  queuePaused: boolean;
  queued: number;
  activeJobId: string | null;
  draft: CreateDraft;
  resolutions: { id: string; width: number; height: number; label: string }[];
  templates: { text: boolean; firstFrame: boolean; firstLast: boolean };
  blender: { installed: boolean; version: string | null; backbones: { projectId: string; projectName: string; assetName: string }[] };
  jobs: CreateJob[];
};

type Props = {
  token?: string;
  apiBase: string;
  refreshSeconds?: number;
  onToast: (message: string) => void;
  onOpen: (path: string) => void;
  onPlay: (video: StudioVideo) => void;
};

const CHUNK_SIZE = 4 * 1024 * 1024;

function when(value: string | null) {
  if (!value) return 'Waiting';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}

export default function CreateWorkspace({ token, apiBase, refreshSeconds = 5, onToast, onOpen, onPlay }: Props) {
  const [view, setView] = useState<CreateView | null>(null);
  const [draft, setDraft] = useState<CreateDraft | null>(null);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [advanced, setAdvanced] = useState(true);
  const [dragging, setDragging] = useState(false);
  const initialized = useRef(false);

  const load = useCallback(async (quiet = false) => {
    try {
      const response = await fetch(`${apiBase}/api/create`, { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Create workspace could not refresh');
      setView(payload as CreateView);
      if (!initialized.current) {
        setDraft((payload as CreateView).draft);
        initialized.current = true;
      }
      setError('');
    } catch (requestError) {
      if (!quiet) setError(requestError instanceof Error ? requestError.message : 'Create workspace could not refresh');
    }
  }, [apiBase]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    const interval = window.setInterval(() => void load(true), Math.max(2, refreshSeconds) * 1000);
    return () => { window.clearTimeout(timer); window.clearInterval(interval); };
  }, [load, refreshSeconds]);

  async function action(actionName: string, extra: Record<string, unknown> = {}, success?: string) {
    if (!token || pending) return null;
    setPending(actionName);
    try {
      const response = await fetch(`${apiBase}/api/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-LTX-Control-Token': token },
        body: JSON.stringify({ action: actionName, ...extra }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Create action failed');
      if (payload.create) setView(payload.create as CreateView);
      if (success) onToast(success);
      setError('');
      return payload;
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'Create action failed';
      setError(message);
      onToast(message);
      return null;
    } finally {
      setPending('');
    }
  }

  function update<K extends keyof CreateDraft>(key: K, value: CreateDraft[K]) {
    setDraft((current) => current ? { ...current, [key]: value } : current);
  }

  async function uploadContext(files: File[], field?: 'firstFramePath' | 'lastFramePath') {
    if (!token || pending) return;
    const selectedFiles = files.slice(0, field ? 1 : 12);
    setPending(field || 'context-upload');
    try {
      for (const file of selectedFiles) {
        const startResponse = await fetch(`${apiBase}/api/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-LTX-Control-Token': token },
          body: JSON.stringify({ action: 'upload-start', fileName: file.name, size: file.size }),
        });
        const started = await startResponse.json();
        if (!startResponse.ok) throw new Error(started.error || 'Context upload could not start');
        const uploadId = String(started.upload.id);
        for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
          const chunkResponse = await fetch(`${apiBase}/api/create-upload/${uploadId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream', 'X-LTX-Control-Token': token, 'X-LTX-Upload-Offset': String(offset) },
            body: file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size)),
          });
          const chunkPayload = await chunkResponse.json();
          if (!chunkResponse.ok) throw new Error(chunkPayload.error || 'Context upload was interrupted');
        }
        const finishResponse = await fetch(`${apiBase}/api/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-LTX-Control-Token': token },
          body: JSON.stringify({ action: 'upload-finish', uploadId }),
        });
        const finished = await finishResponse.json();
        if (!finishResponse.ok) throw new Error(finished.error || 'Context upload could not finish');
        const uploaded = finished.upload as { id: string; fileName: string; kind: 'image' | 'video' | 'audio' | 'blend'; path: string; size: number };
        setDraft((current) => {
          if (!current) return current;
          const asset = { id: uploaded.id, name: uploaded.fileName, kind: uploaded.kind, path: uploaded.path, size: uploaded.size };
          const next = { ...current, contextAssets: [...current.contextAssets.filter((item) => item.id !== asset.id), asset] };
          if (field) {
            next[field] = uploaded.path;
            next.contextVideoPath = '';
            next.useBlender = false;
            next.referenceMode = field === 'lastFramePath' ? 'first-last' : current.referenceMode === 'text' ? 'first-frame' : current.referenceMode;
          } else if (uploaded.kind === 'image') {
            next.useBlender = false;
            next.contextVideoPath = '';
            if (!current.firstFramePath) {
              next.firstFramePath = uploaded.path;
              next.referenceMode = 'first-frame';
            } else {
              next.lastFramePath = uploaded.path;
              next.referenceMode = 'first-last';
            }
          } else if (uploaded.kind === 'video') {
            next.useBlender = false;
            next.firstFramePath = '';
            next.lastFramePath = '';
            next.contextVideoPath = uploaded.path;
            next.referenceMode = 'first-last';
          } else if (uploaded.kind === 'audio') {
            next.soundtrackPath = uploaded.path;
            next.audio = 'soundtrack';
          } else if (uploaded.kind === 'blend') {
            next.useBlender = true;
            next.blenderProjectId = '';
            next.blenderUploadPath = uploaded.path;
            if (next.referenceMode === 'text') next.referenceMode = 'first-frame';
          }
          return next;
        });
      }
      onToast(`${selectedFiles.length} context ${selectedFiles.length === 1 ? 'file' : 'files'} uploaded privately`);
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'Reference upload failed';
      setError(message);
      onToast(message);
    } finally {
      setPending('');
    }
  }

  function removeContext(asset: CreateDraft['contextAssets'][number]) {
    setDraft((current) => current ? {
      ...current,
      contextAssets: current.contextAssets.filter((item) => item.id !== asset.id),
      firstFramePath: current.firstFramePath === asset.path ? '' : current.firstFramePath,
      lastFramePath: current.lastFramePath === asset.path ? '' : current.lastFramePath,
      contextVideoPath: current.contextVideoPath === asset.path ? '' : current.contextVideoPath,
      soundtrackPath: current.soundtrackPath === asset.path ? '' : current.soundtrackPath,
      blenderUploadPath: current.blenderUploadPath === asset.path ? '' : current.blenderUploadPath,
      audio: current.soundtrackPath === asset.path ? 'generate' : current.audio,
      useBlender: current.blenderUploadPath === asset.path ? false : current.useBlender,
    } : current);
  }

  const active = useMemo(() => view?.jobs.find((job) => job.id === view.activeJobId) || null, [view]);
  const completed = useMemo(() => view?.jobs.filter((job) => job.status === 'complete') || [], [view]);
  const referenceReady = draft?.useBlender
    ? Boolean(view?.blender.installed && (draft.blenderProjectId || draft.blenderUploadPath))
    : draft?.referenceMode === 'text' || Boolean((draft?.firstFramePath || draft?.contextVideoPath) && (draft.referenceMode !== 'first-last' || draft.lastFramePath || draft.contextVideoPath));
  const templateReady = draft?.referenceMode === 'text' ? view?.templates.text : draft?.referenceMode === 'first-last' ? view?.templates.firstLast : view?.templates.firstFrame;
  const enqueueReady = Boolean(draft?.prompt.trim() && referenceReady && templateReady && !pending);

  function contextRole(asset: CreateDraft['contextAssets'][number]) {
    if (draft.firstFramePath === asset.path) return 'First frame';
    if (draft.lastFramePath === asset.path) return 'Last frame';
    if (draft.contextVideoPath === asset.path) return 'Video anchors';
    if (draft.soundtrackPath === asset.path) return 'Final soundtrack';
    if (draft.blenderUploadPath === asset.path) return 'Blender backbone';
    return 'Stored context';
  }

  if (!view || !draft) return <section className="studio-loading"><LoaderCircle className="spinning" size={24} /><span>Loading Create workspace…</span></section>;

  return (
    <section className="create-workspace" id="create">
      <div className="create-heading">
        <div><p className="kicker">LOCAL TEXT-TO-VIDEO LAB</p><h2>Imagine it. Queue it. Render it.</h2><p>Start from text, references, or a project’s Blender camera backbone. Every variation waits safely for the local GPU.</p></div>
        <div className={`studio-readiness ${view.canStart ? 'ready' : ''}`}>
          {view.canStart ? <WandSparkles size={17} /> : active ? <LoaderCircle className="spinning" size={17} /> : <Clock3 size={17} />}
          <span><small>{active ? 'CREATE RENDERING' : view.canStart ? 'CREATE READY' : view.queued ? `${view.queued} WAITING` : 'SAFE WAIT'}</small><b>{view.canStart ? 'Official local LTX 2.5 workflow is available' : view.blockedReason || 'Checking local adapter'}</b></span>
        </div>
      </div>

      {error && <div className="project-error"><CircleAlert size={15} /><span>{error}</span><button onClick={() => setError('')}>Dismiss</button></div>}

      {active && <div className="create-active">
        <span className="create-active-icon"><LoaderCircle className="spinning" size={19} /></span>
        <div><small>GENERATING NOW</small><b>{active.title}{active.variations > 1 ? ` · variation ${active.variation}/${active.variations}` : ''}</b><span>{active.stage || 'Sampling frames'}</span></div>
        <div className="create-active-progress"><div><span>{active.mode} · seed {active.seed}</span><b>{Math.round(active.progress)}%</b></div><div><span style={{ width: `${active.progress}%` }} /></div></div>
      </div>}

      <div className="create-layout">
        <div className="create-composer">
          <div className="create-card create-prompt-card">
            <div className="create-card-head"><span><Sparkles size={14} /> STORY & DIRECTION</span><small>{draft.prompt.length}/8000</small></div>
            <div className="create-fields">
              <label><span>PROJECT TITLE <small>optional</small></span><input value={draft.title} maxLength={120} placeholder="Neon harbor arrival" onChange={(event) => update('title', event.target.value)} /></label>
              <label><span>WHAT SHOULD HAPPEN?</span><textarea value={draft.prompt} maxLength={8000} placeholder="A lone astronaut walks through a flooded greenhouse at sunrise…" onChange={(event) => update('prompt', event.target.value)} /></label>
              <label><span>AVOID <small>production constraints, not spoken dialogue</small></span><textarea className="compact" value={draft.avoid} maxLength={1000} placeholder="logos, captions, deformed hands, camera shake…" onChange={(event) => update('avoid', event.target.value)} /></label>
              <label className="create-check"><input type="checkbox" checked={draft.promptEnhance} onChange={(event) => update('promptEnhance', event.target.checked)} /><span><b>Enhance prompt locally</b><small>Uses the optional Gemma prompt-enhancer model and adds startup time.</small></span></label>
            </div>
          </div>

          <div className="create-card create-context-card">
            <div className="create-card-head"><span><Upload size={14} /> CONTEXT DROP</span><small>Images · video · audio · .blend</small></div>
            <label className={`create-drop-zone ${dragging ? 'dragging' : ''}`} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); if (event.dataTransfer.files.length) void uploadContext([...event.dataTransfer.files]); }}>
              <input type="file" multiple accept="image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime,video/x-matroska,audio/wav,audio/mpeg,audio/flac,audio/mp4,audio/ogg,audio/aac,.blend" onChange={(event) => { const files = event.target.files ? [...event.target.files] : []; event.target.value = ''; if (files.length) void uploadContext(files); }} />
              {pending === 'context-upload' ? <LoaderCircle className="spinning" size={24} /> : <Upload size={24} />}
              <span><b>{pending === 'context-upload' ? 'Copying context locally…' : 'Drop production context here'}</b><small>or click to browse · files stay on this computer</small></span>
              <div><em><ImagePlus size={13} /> Image anchors</em><em><Video size={13} /> Video first/end frames</em><em><Music2 size={13} /> Soundtrack</em><em><FileBox size={13} /> Blender scene</em></div>
            </label>
            {draft.contextAssets.length > 0 && <div className="create-context-assets">{draft.contextAssets.map((asset) => <div key={asset.id} className={`create-context-asset ${asset.kind}`}>
              <span>{asset.kind === 'image' ? <ImagePlus size={14} /> : asset.kind === 'video' ? <Video size={14} /> : asset.kind === 'audio' ? <Music2 size={14} /> : <FileBox size={14} />}</span>
              <div><b>{asset.name}</b><small>{contextRole(asset)} · {(asset.size / 1024 / 1024).toFixed(asset.size < 10 * 1024 * 1024 ? 1 : 0)} MB</small></div>
              <button onClick={() => removeContext(asset)} aria-label={`Remove ${asset.name}`} title="Remove from this draft"><Trash2 size={13} /></button>
            </div>)}</div>}
            <div className="create-context-note"><CircleAlert size={13} /><span>Images and video provide visual anchors. Audio replaces the generated soundtrack; it does not change the image model. A `.blend` is rendered to reference frames from a private copy.</span></div>
          </div>

          <div className="create-card">
            <div className="create-card-head"><span><Film size={14} /> FORMAT</span><small>One local video per variation</small></div>
            <div className="create-option-grid">
              <label><span>RESOLUTION</span><select value={draft.resolution} onChange={(event) => update('resolution', event.target.value)}>{view.resolutions.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
              <label><span>DURATION</span><select value={draft.duration} onChange={(event) => update('duration', Number(event.target.value))}>{[3, 5, 8, 10, 12, 15, 20].map((value) => <option key={value} value={value}>{value} seconds</option>)}</select></label>
              <label><span>FRAME RATE</span><select value={draft.frameRate} onChange={(event) => update('frameRate', Number(event.target.value))}>{[16, 24, 25, 30].map((value) => <option key={value} value={value}>{value} fps</option>)}</select></label>
              <label><span>VARIATIONS</span><select value={draft.variations} onChange={(event) => update('variations', Number(event.target.value))}>{[1, 2, 3, 4].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
              <label><span>SEED</span><select value={draft.seedMode} onChange={(event) => update('seedMode', event.target.value as CreateDraft['seedMode'])}><option value="random">Random each batch</option><option value="fixed">Fixed / repeatable</option></select></label>
              <label><span>SEED VALUE</span><input type="number" min={0} max={2147483647} disabled={draft.seedMode !== 'fixed'} value={draft.seed} onChange={(event) => update('seed', Number(event.target.value))} /></label>
            </div>
          </div>

          <div className="create-card">
            <div className="create-card-head"><span><ImagePlus size={14} /> VISUAL BACKBONE</span><small>{draft.useBlender ? 'Rendered from an immutable .blend copy' : 'Optional'}</small></div>
            <div className="create-source-tabs">
              {(['text', 'first-frame', 'first-last'] as const).map((mode) => <button key={mode} className={!draft.useBlender && draft.referenceMode === mode ? 'selected' : ''} onClick={() => { update('useBlender', false); update('referenceMode', mode); }} disabled={mode === 'text' ? !view.templates.text : mode === 'first-last' ? !view.templates.firstLast : !view.templates.firstFrame}>{mode === 'text' ? 'Text only' : mode === 'first-frame' ? 'Start frame' : 'Start + end'}</button>)}
              <button className={draft.useBlender ? 'selected' : ''} onClick={() => { update('useBlender', true); if (draft.referenceMode === 'text') update('referenceMode', 'first-frame'); }}><Box size={13} /> Use Blender</button>
            </div>
            {draft.useBlender ? <div className="create-blender">
              <div className={`create-capability ${view.blender.installed ? 'ready' : ''}`}><Box size={17} /><span><b>{view.blender.installed ? `Blender ${view.blender.version || ''} detected` : 'Blender is not detected'}</b><small>The master scene is copied before background rendering; LTX Watch never saves over it.</small></span></div>
              <label><span>PROJECT BACKBONE</span><select value={draft.blenderProjectId} disabled={Boolean(draft.blenderUploadPath)} onChange={(event) => { update('blenderProjectId', event.target.value); update('blenderUploadPath', ''); }}><option value="">{draft.blenderUploadPath ? 'Using dropped .blend context' : 'Choose a .blend assigned in Projects'}</option>{view.blender.backbones.map((item) => <option key={item.projectId} value={item.projectId}>{item.projectName} · {item.assetName}</option>)}</select></label>
              <div className="create-frame-grid"><label><span>FIRST FRAME</span><input type="number" min={1} value={draft.blenderFirstFrame} onChange={(event) => update('blenderFirstFrame', Number(event.target.value))} /></label>{draft.referenceMode === 'first-last' && <label><span>LAST FRAME</span><input type="number" min={1} value={draft.blenderLastFrame} onChange={(event) => update('blenderLastFrame', Number(event.target.value))} /></label>}</div>
              <label className="create-check"><input type="checkbox" checked={draft.referenceMode === 'first-last'} onChange={(event) => update('referenceMode', event.target.checked ? 'first-last' : 'first-frame')} /><span><b>Anchor the final frame too</b><small>Renders both timeline frames and uses the official first/last-frame LTX workflow.</small></span></label>
            </div> : draft.referenceMode !== 'text' ? <div className="create-reference-grid">
              <label className={draft.firstFramePath ? 'uploaded' : ''}><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void uploadContext([file], 'firstFramePath'); }} /><Upload size={18} /><b>{pending === 'firstFramePath' ? 'Uploading…' : draft.firstFramePath ? 'First frame ready' : 'Upload first frame'}</b><small>PNG, JPEG, or WebP · private local copy</small></label>
              {draft.referenceMode === 'first-last' && <label className={draft.lastFramePath ? 'uploaded' : ''}><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void uploadContext([file], 'lastFramePath'); }} /><Upload size={18} /><b>{pending === 'lastFramePath' ? 'Uploading…' : draft.lastFramePath ? 'Last frame ready' : 'Upload last frame'}</b><small>Controls where the motion should finish</small></label>}
            </div> : <div className="create-text-source"><WandSparkles size={20} /><span><b>Pure text-to-video</b><small>LTX 2.5 invents the visual scene from your direction without a source frame.</small></span></div>}
          </div>

          <div className="create-card">
            <button className="create-card-head create-advanced-toggle" onClick={() => setAdvanced((value) => !value)}><span><WandSparkles size={14} /> CREATIVE CONTROLS</span><small>{advanced ? 'Hide' : 'Show'} options</small></button>
            {advanced && <div className="create-option-grid create-creative-grid">
              <label><span>CAMERA</span><select value={draft.camera} onChange={(event) => update('camera', event.target.value)}><option value="none">Let LTX decide</option><option value="locked">Locked tripod</option><option value="dolly_in">Dolly in</option><option value="dolly_out">Dolly out</option><option value="orbit">Orbit subject</option><option value="tracking">Tracking shot</option><option value="handheld">Subtle handheld</option><option value="aerial">Aerial glide</option></select></label>
              <label><span>MOTION</span><select value={draft.motion} onChange={(event) => update('motion', event.target.value)}><option value="subtle">Subtle</option><option value="balanced">Balanced</option><option value="dynamic">Dynamic</option></select></label>
              <label><span>VISUAL STYLE</span><select value={draft.style} onChange={(event) => update('style', event.target.value)}><option value="cinematic">Cinematic</option><option value="documentary">Documentary realism</option><option value="animation">Animated film</option><option value="product">Product film</option><option value="custom">Custom</option></select></label>
              <label><span>AUDIO</span><select value={draft.audio} onChange={(event) => update('audio', event.target.value)}><option value="generate">Synchronized scene audio</option><option value="ambient">Ambience / effects only</option>{draft.soundtrackPath && <option value="soundtrack">Use dropped soundtrack</option>}<option value="silent">Strip audio from result</option></select></label>
              {draft.style === 'custom' && <label className="span-two"><span>CUSTOM STYLE</span><input value={draft.customStyle} maxLength={600} placeholder="Describe lighting, lenses, color palette, materials…" onChange={(event) => update('customStyle', event.target.value)} /></label>}
            </div>}
          </div>

          <div className="create-submit">
            <div><b>{draft.variations} {draft.variations === 1 ? 'video' : 'variations'} will join the private Create queue</b><span>{draft.resolution} · {draft.duration}s · {draft.frameRate} fps · {draft.useBlender ? 'Blender-backed' : draft.referenceMode}</span></div>
            <div className="create-submit-actions"><button className="secondary-button" disabled={Boolean(pending)} onClick={() => void action('save-draft', { draft }, 'Create draft saved locally')}>Save draft</button><button className="project-primary" disabled={!enqueueReady} onClick={() => void action('enqueue', { draft }, `${draft.variations} Create ${draft.variations === 1 ? 'job' : 'jobs'} queued safely`)}>{pending === 'enqueue' ? <LoaderCircle className="spinning" size={15} /> : <Plus size={15} />} Queue creation</button></div>
          </div>
        </div>

        <aside className="create-rail">
          <div className="create-card create-queue-card">
            <div className="create-card-head"><span><Clock3 size={14} /> CREATE QUEUE</span><button onClick={() => void action('toggle-queue', { paused: !view.queuePaused }, view.queuePaused ? 'Create queue resumed' : 'Create queue paused')}>{view.queuePaused ? <Play size={12} /> : <Pause size={12} />} {view.queuePaused ? 'Resume' : 'Pause'}</button></div>
            <div className="create-job-list">
              {view.jobs.filter((job) => job.status !== 'complete').map((job) => <div className={`create-job ${job.status}`} key={job.id}>
                <span>{job.status === 'generating' ? <LoaderCircle className="spinning" size={14} /> : job.status === 'failed' ? <CircleAlert size={14} /> : <Clock3 size={14} />}</span>
                <div><b>{job.title}</b><small>{job.summary} · {job.mode}</small>{job.status === 'generating' && <><div className="create-job-progress-label"><span>{job.stage}</span><b>{Math.round(job.progress)}%</b></div><div className="create-job-progress"><span style={{ width: `${job.progress}%` }} /></div></>}{job.error && <p>{job.error}</p>}</div>
                <div className="create-job-actions">{job.status === 'queued' && <button title="Move first" onClick={() => void action('move-first', { jobId: job.id }, 'Create job moved first')}><ArrowUpToLine size={12} /></button>}{job.status === 'failed' && <button title="Retry" onClick={() => void action('retry', { jobId: job.id }, 'Create job queued again')}><RotateCcw size={12} /></button>}{job.status !== 'generating' && <button title="Remove" onClick={() => void action('remove', { jobId: job.id }, 'Create job removed')}><Trash2 size={12} /></button>}</div>
              </div>)}
              {!view.jobs.some((job) => job.status !== 'complete') && <div className="project-empty-small"><Check size={20} /><b>Queue is clear</b><span>New text-to-video jobs appear here.</span></div>}
            </div>
          </div>
          <div className="create-card create-safety-card"><div className="create-card-head"><span><Box size={14} /> LOCAL SAFETY</span></div><ul><li>Uses official local ComfyUI workflows.</li><li>Never launches beside Studio, the album worker, or an occupied port.</li><li>Prompts and job files stay in git-ignored local state.</li><li>Blender renders a working copy of the master scene.</li></ul></div>
        </aside>
      </div>

      <section className="create-history">
        <div className="create-history-head"><div><p className="kicker">CREATE LIBRARY</p><h3>Generated from scratch</h3></div><button className="secondary-button" onClick={() => void load()}><RefreshCw size={13} /> Refresh</button></div>
        <div className="create-history-grid">
          {completed.map((job) => <article className="create-output" key={job.id}>
            <button className="create-output-preview" onClick={() => job.video && onPlay(job.video)}>{job.video ? <video src={job.video.mediaUrl} muted playsInline preload="metadata" /> : <Film size={28} />}<span><Play size={16} fill="currentColor" /></span></button>
            <div><b>{job.title}</b><small>{job.summary} · seed {job.seed}</small><span>{when(job.completedAt)}</span></div>
            <button title="Show in Explorer" disabled={!job.video} onClick={() => job.video && onOpen(job.video.directory)}><FolderOpen size={15} /></button>
          </article>)}
          {!completed.length && <div className="create-history-empty"><WandSparkles size={26} /><b>Your new worlds will appear here</b><span>Queue a first text-to-video creation when the GPU is ready.</span></div>}
        </div>
      </section>
    </section>
  );
}
