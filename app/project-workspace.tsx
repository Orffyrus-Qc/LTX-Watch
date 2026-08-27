'use client';
/* eslint-disable @next/next/no-img-element */

import {
  Box,
  BookOpen,
  Check,
  ChevronRight,
  CircleAlert,
  FileBox,
  FileText,
  Film,
  FolderInput,
  FolderOpen,
  Image as ImageIcon,
  Layers3,
  Lock,
  LoaderCircle,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  Video,
  X,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StudioVideo } from './studio-workspace';

type ProjectAsset = {
  id: string;
  fullPath: string;
  directory: string;
  name: string;
  relativePath: string;
  kind: 'video' | 'image' | 'audio' | 'text' | 'data' | 'scene3d' | 'other';
  extension: string;
  size: number;
  modifiedAt: string;
  mediaUrl: string | null;
  generated?: boolean;
};

type ProjectShot = {
  shotKey: string;
  shot: string;
  sceneSlug: string | null;
  title: string;
  versions: ProjectAsset[];
  currentAssetId: string | null;
  status: string;
  contextAssetIds: string[];
  regeneratable: boolean;
  mappedTrack: string | null;
  attempts: { id: string; status: string; correction: string; outputPath: string | null }[];
};

type ProjectQueueItem = {
  id: string;
  shotKey: string;
  track: string;
  shot: string;
  correction: string;
  status: string;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  stage?: string;
  progress?: number;
  elapsedSeconds?: number;
  remainingSeconds?: number;
};

type ProjectSummary = {
  id: string;
  name: string;
  mode: 'reference' | 'managed';
  sourcePath: string;
  queued: number;
  review: number;
};

type ContinuityElement = {
  id: string;
  kind: 'character' | 'location' | 'prop' | 'wardrobe' | 'vehicle' | 'style';
  name: string;
  description: string;
  referenceAssetIds: string[];
  locked: boolean;
};

type ContinuityBible = {
  premise: string;
  visualLanguage: string;
  invariants: string;
  negativeRules: string;
  elements: ContinuityElement[];
  revision: number;
  updatedAt: string | null;
};

type LongSceneClip = {
  id: string;
  order: number;
  title: string;
  prompt: string;
  duration: number;
  transition: 'continuous' | 'cut';
  status: 'planned' | 'prepared' | 'queued' | 'generating' | 'review' | 'accepted' | 'failed';
  outputPath: string | null;
  lastFramePath: string | null;
  ingredientsReferencePath?: string | null;
  continuityAnchorPath?: string | null;
  error: string | null;
  video: StudioVideo | null;
};

type LongScene = {
  id: string;
  title: string;
  direction: string;
  ingredientsAssetId: string | null;
  status: 'planning' | 'active' | 'complete';
  clips: LongSceneClip[];
  createdAt: string;
  updatedAt: string;
};

export type ProjectsView = {
  selectedProjectId: string | null;
  projects: ProjectSummary[];
  project: null | {
    id: string;
    name: string;
    mode: 'reference' | 'managed';
    sourcePath: string;
    rootPath: string;
    uploadRoot: string;
    queuePaused: boolean;
    contextAssetIds: string[];
    blenderBackboneAssetId: string | null;
    blenderBackbone: ProjectAsset | null;
    continuityBible: ContinuityBible;
    longScenes: LongScene[];
    assets: ProjectAsset[];
    contextAssets: ProjectAsset[];
    blenderAssets: ProjectAsset[];
    shots: ProjectShot[];
    queue: ProjectQueueItem[];
    counts: { assets: number; shots: number; mapped: number; selectedContext: number; queued: number; generating: number; review: number; continuityElements: number; longSceneClips: number };
  };
};

type Props = {
  token?: string;
  apiBase: string;
  refreshSeconds?: number;
  onToast: (message: string) => void;
  onOpen: (path: string) => Promise<void>;
  onPlay: (video: StudioVideo) => void;
  onOpenCreate: () => void;
};

function displayName(value: string) {
  return value.replace(/_full$/i, '').replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatBytes(bytes: number) {
  if (!bytes) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
}

function formatQueueTime(seconds = 0) {
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainder = rounded % 60;
  if (hours) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  if (minutes) return `${minutes}m ${String(remainder).padStart(2, '0')}s`;
  return `${remainder}s`;
}

const EMPTY_CONTINUITY_BIBLE: ContinuityBible = { premise: '', visualLanguage: '', invariants: '', negativeRules: '', elements: [], revision: 1, updatedAt: null };

const SHOT_BATCH_SIZE = 36;

function withContinuityDefaults(input: ProjectsView): ProjectsView {
  if (!input.project) return input;
  return {
    ...input,
    project: {
      ...input.project,
      continuityBible: input.project.continuityBible || { ...EMPTY_CONTINUITY_BIBLE },
      longScenes: input.project.longScenes || [],
      counts: {
        ...input.project.counts,
        continuityElements: input.project.counts?.continuityElements || 0,
        longSceneClips: input.project.counts?.longSceneClips || 0,
      },
    },
  };
}

function projectViewSignature(view: ProjectsView) {
  const project = view.project;
  return JSON.stringify({
    selectedProjectId: view.selectedProjectId,
    projects: view.projects.map((item) => [item.id, item.name, item.queued, item.review]),
    project: project ? {
      id: project.id,
      queuePaused: project.queuePaused,
      contextAssetIds: project.contextAssetIds,
      blenderBackboneAssetId: project.blenderBackboneAssetId,
      continuity: [project.continuityBible.revision, project.longScenes.map((scene) => [scene.id, scene.status, scene.updatedAt, scene.clips.map((clip) => [clip.id, clip.status, clip.outputPath, clip.lastFramePath])])],
      counts: project.counts,
      shots: project.shots.map((shot) => [shot.shotKey, shot.status, shot.currentAssetId, shot.versions.length, shot.contextAssetIds.length]),
      queue: project.queue.map((item) => [item.id, item.status, item.completedAt, item.error, item.stage, item.progress]),
    } : null,
  });
}

function AssetIcon({ kind, size = 16 }: { kind: ProjectAsset['kind']; size?: number }) {
  if (kind === 'scene3d') return <Box size={size} />;
  if (kind === 'video') return <Video size={size} />;
  if (kind === 'image') return <ImageIcon size={size} />;
  if (kind === 'text' || kind === 'data') return <FileText size={size} />;
  return <FileBox size={size} />;
}

function LazyProjectPreview({ asset }: { asset?: ProjectAsset }) {
  const previewRef = useRef<HTMLSpanElement>(null);
  const [nearViewport, setNearViewport] = useState(false);

  useEffect(() => {
    const preview = previewRef.current;
    if (!preview) return;
    if (!('IntersectionObserver' in window)) {
      const timer = window.setTimeout(() => setNearViewport(true), 0);
      return () => window.clearTimeout(timer);
    }
    const observer = new IntersectionObserver(([entry]) => {
      setNearViewport(Boolean(entry?.isIntersecting));
    }, { rootMargin: '320px 0px' });
    observer.observe(preview);
    return () => observer.disconnect();
  }, []);

  return <span className="project-media-slot" ref={previewRef}>
    {nearViewport && asset?.kind === 'video' && asset.mediaUrl
      ? <video src={`${asset.mediaUrl}#t=0.1`} muted playsInline preload="metadata" />
      : nearViewport && asset?.kind === 'image' && asset.mediaUrl
        ? <img src={asset.mediaUrl} alt="" loading="lazy" decoding="async" />
        : <span className="project-file-preview"><AssetIcon kind={asset?.kind || 'other'} size={28} /></span>}
  </span>;
}

export default function ProjectWorkspace({ token, apiBase, refreshSeconds = 5, onToast, onOpen, onPlay, onOpenCreate }: Props) {
  const [view, setView] = useState<ProjectsView | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [folderPath, setFolderPath] = useState('');
  const [projectName, setProjectName] = useState('');
  const [importMode, setImportMode] = useState<'reference' | 'managed'>('reference');
  const [selectedShots, setSelectedShots] = useState<string[]>([]);
  const [selectedContext, setSelectedContext] = useState<string[]>([]);
  const [correction, setCorrection] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'mapped' | 'review' | 'accepted'>('all');
  const [visibleCount, setVisibleCount] = useState(SHOT_BATCH_SIZE);
  const [projectMode, setProjectMode] = useState<'shots' | 'continuity'>('shots');
  const [bibleDraft, setBibleDraft] = useState<ContinuityBible | null>(null);
  const [scenesDraft, setScenesDraft] = useState<LongScene[]>([]);
  const [selectedLongSceneId, setSelectedLongSceneId] = useState('');
  const [continuityDirty, setContinuityDirty] = useState(false);
  const loadedContinuityProject = useRef('');
  const fileInput = useRef<HTMLInputElement>(null);
  const viewSignature = useRef('');

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setPending('refresh');
    try {
      const response = await fetch(`${apiBase}/api/projects`, { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not load projects');
      const nextView = withContinuityDefaults(payload as ProjectsView);
      const nextSignature = projectViewSignature(nextView);
      if (!quiet || nextSignature !== viewSignature.current) {
        viewSignature.current = nextSignature;
        setView(nextView);
      }
      setError('');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not load projects');
    } finally {
      if (!quiet) setPending('');
    }
  }, [apiBase]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  useEffect(() => {
    const interval = window.setInterval(() => void load(true), Math.max(2, refreshSeconds) * 1000);
    return () => window.clearInterval(interval);
  }, [load, refreshSeconds]);

  async function action(name: string, body: Record<string, unknown>, message?: string) {
    if (!token) throw new Error('Local control token is not ready yet.');
    setPending(name);
    try {
      const response = await fetch(`${apiBase}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-LTX-Control-Token': token },
        body: JSON.stringify({ action: name, projectId: view?.selectedProjectId, ...body }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Project action failed');
      if (payload.projects) {
        const nextView = withContinuityDefaults(payload.projects as ProjectsView);
        viewSignature.current = projectViewSignature(nextView);
        setView(nextView);
        if (name === 'select-project' || name === 'import-folder') {
          setSelectedShots([]);
          setSelectedContext([]);
          setVisibleCount(SHOT_BATCH_SIZE);
        }
        if (['save-continuity-bible', 'save-long-scenes', 'prepare-continuity-clip', 'accept-continuity-clip'].includes(name) && nextView.project) {
          setBibleDraft(nextView.project.continuityBible || EMPTY_CONTINUITY_BIBLE);
          setScenesDraft(nextView.project.longScenes || []);
          setSelectedLongSceneId((current) => current && nextView.project?.longScenes.some((scene) => scene.id === current) ? current : nextView.project?.longScenes[0]?.id || '');
          setContinuityDirty(false);
        }
      }
      setError('');
      if (message) onToast(message);
      return payload;
    } catch (requestError) {
      const messageText = requestError instanceof Error ? requestError.message : 'Project action failed';
      setError(messageText);
      throw requestError;
    } finally { setPending(''); }
  }

  async function importFolder() {
    if (!folderPath.trim()) return;
    try {
      await action('import-folder', { path: folderPath, name: projectName, mode: importMode }, 'Project indexed locally');
      setImportOpen(false);
      setFolderPath('');
      setProjectName('');
    } catch { /* the action surfaces its own error */ }
  }

  async function uploadFiles(files: FileList | null) {
    if (!files?.length || !view?.project || !token) return;
    setPending('upload');
    try {
      for (const file of Array.from(files)) {
        const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
        const startResponse = await fetch(`${apiBase}/api/projects`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-LTX-Control-Token': token },
          body: JSON.stringify({ action: 'upload-start', projectId: view.project.id, fileName: file.name, relativePath, size: file.size }),
        });
        const started = await startResponse.json();
        if (!startResponse.ok) throw new Error(started.error || `Could not upload ${file.name}`);
        const uploadId = started.upload.id as string;
        const chunkSize = 2 * 1024 * 1024;
        for (let offset = 0; offset < file.size; offset += chunkSize) {
          const chunk = file.slice(offset, Math.min(file.size, offset + chunkSize));
          const chunkResponse = await fetch(`${apiBase}/api/project-upload/${uploadId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream', 'X-LTX-Control-Token': token, 'X-LTX-Upload-Offset': String(offset) },
            body: chunk,
          });
          if (!chunkResponse.ok) throw new Error((await chunkResponse.json()).error || `Upload failed for ${file.name}`);
        }
        const finishResponse = await fetch(`${apiBase}/api/projects`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-LTX-Control-Token': token },
          body: JSON.stringify({ action: 'upload-finish', projectId: view.project.id, uploadId }),
        });
        const finished = await finishResponse.json();
        if (!finishResponse.ok) throw new Error(finished.error || `Could not finish ${file.name}`);
        if (finished.projects) {
          const nextView = withContinuityDefaults(finished.projects as ProjectsView);
          viewSignature.current = projectViewSignature(nextView);
          setView(nextView);
        }
      }
      onToast(`${files.length} context file${files.length === 1 ? '' : 's'} added`);
      setError('');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'File upload failed');
    } finally {
      setPending('');
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  const project = view?.project;
  useEffect(() => {
    if (!project) return;
    if (loadedContinuityProject.current !== project.id || !continuityDirty) {
      loadedContinuityProject.current = project.id;
      setBibleDraft(project.continuityBible || EMPTY_CONTINUITY_BIBLE);
      setScenesDraft(project.longScenes || []);
      setSelectedLongSceneId((current) => current && project.longScenes?.some((scene) => scene.id === current) ? current : project.longScenes?.[0]?.id || '');
    }
  }, [project, continuityDirty]);
  const filteredShots = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (project?.shots || []).filter((shot) => {
      if (filter === 'mapped' && !shot.regeneratable) return false;
      if (filter === 'review' && !['review', 'generating', 'queued', 'failed'].includes(shot.status)) return false;
      if (filter === 'accepted' && shot.status !== 'accepted') return false;
      return !term || `${shot.title} ${shot.shotKey} ${shot.mappedTrack || ''}`.toLowerCase().includes(term);
    });
  }, [project?.shots, search, filter]);
  const visibleShots = useMemo(() => filteredShots.slice(0, visibleCount), [filteredShots, visibleCount]);
  const selectedMapped = selectedShots.filter((key) => project?.shots.find((shot) => shot.shotKey === key)?.regeneratable);
  const selectedUnmapped = selectedShots.filter((key) => !project?.shots.find((shot) => shot.shotKey === key)?.regeneratable);
  const activeRegeneration = project?.queue.find((item) => item.status === 'generating');

  function toggleShot(shotKey: string) {
    setSelectedShots((current) => current.includes(shotKey) ? current.filter((key) => key !== shotKey) : [...current, shotKey]);
  }

  function playAsset(asset: ProjectAsset, title: string) {
    if (asset.kind !== 'video' || !asset.mediaUrl) return;
    onPlay({ id: asset.id, title, filename: asset.name, kind: 'clip', size: asset.size, modifiedAt: asset.modifiedAt, mediaUrl: asset.mediaUrl, directory: asset.directory });
  }

  async function markSelectedStatus(status: 'accepted' | 'review') {
    if (!selectedShots.length) return;
    if (status === 'accepted') {
      const confirmed = window.confirm(`Approve the current result for ${selectedShots.length} selected shot${selectedShots.length === 1 ? '' : 's'}?\n\nThis does not submit the correction or create a regeneration job.`);
      if (!confirmed) return;
    }
    await action('mark-status', { shotKeys: selectedShots, status }, status === 'accepted' ? 'Current shot results approved' : 'Selected shots returned to review');
  }

  function updateBible<K extends keyof ContinuityBible>(key: K, value: ContinuityBible[K]) {
    setBibleDraft((current) => ({ ...(current || EMPTY_CONTINUITY_BIBLE), [key]: value }));
    setContinuityDirty(true);
  }

  function addContinuityElement() {
    const id = `element-${Date.now().toString(36)}`;
    updateBible('elements', [...(bibleDraft?.elements || []), { id, kind: 'character', name: '', description: '', referenceAssetIds: [], locked: true }]);
  }

  function updateContinuityElement(id: string, changes: Partial<ContinuityElement>) {
    updateBible('elements', (bibleDraft?.elements || []).map((element) => element.id === id ? { ...element, ...changes } : element));
  }

  function createLongSceneDraft() {
    const now = new Date().toISOString();
    const id = `scene-${Date.now().toString(36)}`;
    const scene: LongScene = { id, title: 'New long scene', direction: '', ingredientsAssetId: null, status: 'planning', clips: [], createdAt: now, updatedAt: now };
    setScenesDraft((current) => [...current, scene]);
    setSelectedLongSceneId(id);
    setContinuityDirty(true);
  }

  function updateLongScene(id: string, changes: Partial<LongScene>) {
    setScenesDraft((current) => current.map((scene) => scene.id === id ? { ...scene, ...changes, updatedAt: new Date().toISOString() } : scene));
    setContinuityDirty(true);
  }

  function addLongSceneClip(sceneId: string) {
    setScenesDraft((current) => current.map((scene) => {
      if (scene.id !== sceneId || scene.clips.length >= 500) return scene;
      const order = scene.clips.length + 1;
      const clip: LongSceneClip = { id: `clip-${Date.now().toString(36)}-${order}`, order, title: `Clip ${order}`, prompt: '', duration: 8, transition: order === 1 ? 'cut' : 'continuous', status: 'planned', outputPath: null, lastFramePath: null, error: null, video: null };
      return { ...scene, clips: [...scene.clips, clip], updatedAt: new Date().toISOString() };
    }));
    setContinuityDirty(true);
  }

  function updateLongSceneClip(sceneId: string, clipId: string, changes: Partial<LongSceneClip>) {
    setScenesDraft((current) => current.map((scene) => scene.id === sceneId ? { ...scene, clips: scene.clips.map((clip) => clip.id === clipId ? { ...clip, ...changes } : clip), updatedAt: new Date().toISOString() } : scene));
    setContinuityDirty(true);
  }

  async function saveContinuity() {
    if (!bibleDraft) return;
    await action('save-continuity-bible', { bible: bibleDraft }, 'Project continuity bible saved');
    await action('save-long-scenes', { scenes: scenesDraft }, 'Long-scene plan saved');
  }

  async function prepareContinuityClip(sceneId: string, clipId: string) {
    try {
      if (continuityDirty) await saveContinuity();
      await action('prepare-continuity-clip', { sceneId, clipId }, 'Long-scene clip prepared in Create');
      onOpenCreate();
    } catch { /* action already surfaces its error */ }
  }

  const selectedLongScene = scenesDraft.find((scene) => scene.id === selectedLongSceneId) || scenesDraft[0] || null;
  const projectImages = project?.assets.filter((asset) => asset.kind === 'image') || [];

  if (!view && !error) return <div className="projects-loading"><LoaderCircle className="spinning" /><b>Indexing project workspace…</b></div>;

  return <div className="projects-workspace">
    <section className="projects-heading">
      <div><p className="kicker">PROJECT & ASSET CONTROL</p><h2>Build the complete edit.</h2><p>Index scenes, review every shot, attach production context, and send only selected shots back through LTX.</p></div>
      <div className="projects-heading-actions">
        <button className="secondary-button" onClick={() => void load()} disabled={pending === 'refresh'}><RefreshCw size={14} className={pending === 'refresh' ? 'spinning' : ''} /> Refresh index</button>
        <button className="project-primary" onClick={() => setImportOpen(true)}><FolderInput size={15} /> Import project</button>
      </div>
    </section>

    {error && <div className="project-error"><CircleAlert size={15} /><span>{error}</span><button onClick={() => setError('')} aria-label="Dismiss error"><X size={14} /></button></div>}

    {importOpen && <section className="project-import">
      <div className="project-import-head"><div><FolderInput size={19} /><span><b>Import a production folder</b><small>Use an absolute Windows folder path. Reference mode leaves every source file in place.</small></span></div><button onClick={() => setImportOpen(false)} aria-label="Close import"><X size={15} /></button></div>
      <div className="project-import-grid">
        <label><span>FOLDER PATH</span><input value={folderPath} onChange={(event) => setFolderPath(event.target.value)} placeholder="C:\\Projects\\My Film\\shots" /></label>
        <label><span>PROJECT NAME <small>OPTIONAL</small></span><input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="My Film" /></label>
        <label><span>IMPORT MODE</span><select value={importMode} onChange={(event) => setImportMode(event.target.value as 'reference' | 'managed')}><option value="reference">Reference in place</option><option value="managed">Copy supported assets</option></select></label>
        <button className="project-primary" disabled={!folderPath.trim() || Boolean(pending)} onClick={importFolder}>{pending === 'import-folder' ? <LoaderCircle size={15} className="spinning" /> : <FolderInput size={15} />} Index folder</button>
      </div>
    </section>}

    {!project ? <section className="project-empty">
      <Layers3 size={30} /><p className="kicker">NO PROJECT INDEXED</p><h2>Start with the folder that contains your edit.</h2><p>LTX Watch recognizes generated video, stills, prompts, subtitles, audio, JSON/YAML metadata, Blender scenes, and common interchange formats.</p><button className="project-primary" onClick={() => setImportOpen(true)}><Plus size={15} /> Import first project</button>
    </section> : <>
      <section className="project-switcher">
        <div className="project-tabs">
          {view?.projects.map((item) => <button key={item.id} className={item.id === view.selectedProjectId ? 'selected' : ''} onClick={() => { setVisibleCount(SHOT_BATCH_SIZE); void action('select-project', { projectId: item.id }); }}><span>{item.name}</span><small>{item.queued ? `${item.queued} queued` : item.mode}</small></button>)}
        </div>
        <button className="project-path" onClick={() => void onOpen(project.rootPath)} title={project.rootPath}><FolderOpen size={14} /><span>{project.rootPath}</span></button>
      </section>

      <div className="project-mode-tabs"><button className={projectMode === 'shots' ? 'selected' : ''} onClick={() => setProjectMode('shots')}><Film size={14} /> Shot library</button><button className={projectMode === 'continuity' ? 'selected' : ''} onClick={() => setProjectMode('continuity')}><BookOpen size={14} /> Continuity & long scenes <span>{project.counts.continuityElements + project.counts.longSceneClips}</span></button></div>

      {projectMode === 'continuity' ? <section className="continuity-workspace">
        <div className="continuity-heading"><div><p className="kicker">PERSISTENT PROJECT MEMORY</p><h2>Continuity Bible</h2><p>Define canonical elements once, attach the best local references, and reuse the same locked description across every future clip. Memory remains local in this project.</p></div><button className="project-primary" disabled={!continuityDirty || Boolean(pending)} onClick={() => void saveContinuity().catch(() => undefined)}>{pending.startsWith('save-') ? <LoaderCircle size={14} className="spinning" /> : <Check size={14} />} Save continuity</button></div>
        <div className="continuity-grid">
          <section className="continuity-card bible-card">
            <div className="continuity-card-head"><span><BookOpen size={15} /> CANONICAL PROJECT BIBLE</span><b>REV {bibleDraft?.revision || 1}</b></div>
            <div className="bible-fields">
              <label><span>WORLD / PREMISE</span><textarea value={bibleDraft?.premise || ''} maxLength={4000} placeholder="The permanent story-world facts, era, scale, atmosphere, and physical reality…" onChange={(event) => updateBible('premise', event.target.value)} /></label>
              <label><span>LOCKED VISUAL LANGUAGE</span><textarea value={bibleDraft?.visualLanguage || ''} maxLength={4000} placeholder="Lens family, aspect, lighting logic, palette, material treatment, rendering style…" onChange={(event) => updateBible('visualLanguage', event.target.value)} /></label>
              <label><span>NON-NEGOTIABLE CONTINUITY</span><textarea value={bibleDraft?.invariants || ''} maxLength={4000} placeholder="Screen direction, proportions, scars, costume details, geography, damage state, time of day…" onChange={(event) => updateBible('invariants', event.target.value)} /></label>
              <label><span>NEVER CHANGE OR INTRODUCE</span><textarea value={bibleDraft?.negativeRules || ''} maxLength={2000} placeholder="No logos, no costume changes, no unexplained props, no new characters…" onChange={(event) => updateBible('negativeRules', event.target.value)} /></label>
            </div>
            <div className="continuity-elements-head"><span>CANONICAL ELEMENTS</span><button className="secondary-button" onClick={addContinuityElement}><Plus size={12} /> Add element</button></div>
            <div className="continuity-elements">{(bibleDraft?.elements || []).map((element) => <article className="continuity-element" key={element.id}>
              <div className="continuity-element-top"><select value={element.kind} onChange={(event) => updateContinuityElement(element.id, { kind: event.target.value as ContinuityElement['kind'] })}><option value="character">Character</option><option value="location">Location</option><option value="prop">Prop</option><option value="wardrobe">Wardrobe</option><option value="vehicle">Vehicle</option><option value="style">Style</option></select><input value={element.name} maxLength={120} placeholder="Canonical name" onChange={(event) => updateContinuityElement(element.id, { name: event.target.value })} /><label className="continuity-lock"><input type="checkbox" checked={element.locked} onChange={(event) => updateContinuityElement(element.id, { locked: event.target.checked })} /><Lock size={12} /></label><button title="Remove element" onClick={() => updateBible('elements', (bibleDraft?.elements || []).filter((item) => item.id !== element.id))}><Trash2 size={13} /></button></div>
              <textarea value={element.description} maxLength={2000} placeholder="Exact appearance, proportions, materials, colors, behavior, and details that must remain identical…" onChange={(event) => updateContinuityElement(element.id, { description: event.target.value })} />
              <label className="continuity-reference"><span>PRIMARY REFERENCE</span><select value={element.referenceAssetIds[0] || ''} onChange={(event) => updateContinuityElement(element.id, { referenceAssetIds: event.target.value ? [event.target.value] : [] })}><option value="">Description only</option>{project.contextAssets.filter((asset) => ['image', 'scene3d'].includes(asset.kind)).map((asset) => <option key={asset.id} value={asset.id}>{asset.relativePath}</option>)}</select></label>
            </article>)}</div>
            {!bibleDraft?.elements.length && <div className="continuity-empty"><BookOpen size={23} /><b>No canonical elements yet</b><span>Add the recurring characters, places, props, wardrobe, vehicles, and style rules that future generations must remember.</span></div>}
          </section>

          <section className="continuity-card long-scene-card">
            <div className="continuity-card-head"><span><Layers3 size={15} /> LONG-SCENE SEQUENCES</span><button onClick={createLongSceneDraft}><Plus size={12} /> New scene</button></div>
            <div className="long-scene-tabs">{scenesDraft.map((scene) => <button key={scene.id} className={scene.id === selectedLongScene?.id ? 'selected' : ''} onClick={() => setSelectedLongSceneId(scene.id)}><span><b>{scene.title}</b><small>{scene.clips.length} clips · {scene.clips.reduce((total, clip) => total + clip.duration, 0)}s · {scene.status}</small></span><ChevronRight size={12} /></button>)}</div>
            {selectedLongScene ? <div className="long-scene-editor">
              <label><span>SCENE TITLE</span><input value={selectedLongScene.title} maxLength={160} onChange={(event) => updateLongScene(selectedLongScene.id, { title: event.target.value })} /></label>
              <label><span>GLOBAL SCENE DIRECTION</span><textarea value={selectedLongScene.direction} maxLength={4000} placeholder="The dramatic objective, geography, camera strategy, time progression, and facts shared by every clip…" onChange={(event) => updateLongScene(selectedLongScene.id, { direction: event.target.value })} /></label>
              <label><span>CANONICAL INGREDIENTS SHEET</span><select value={selectedLongScene.ingredientsAssetId || ''} onChange={(event) => updateLongScene(selectedLongScene.id, { ingredientsAssetId: event.target.value || null })}><option value="">Choose an image asset</option>{projectImages.map((asset) => <option value={asset.id} key={asset.id}>{asset.relativePath}</option>)}</select><small>The first clip and every new cut use this curated identity sheet. Continuous clips use the previous accepted ending as their exact start-frame handoff.</small></label>
              <div className="long-scene-rule"><Lock size={14} /><span><b>Review-gated visual continuation</b><small>A continuous clip cannot be prepared until the previous clip is accepted. Acceptance extracts its final frame; the next clip receives that image as its real first-frame input.</small></span></div>
              <div className="long-clip-list">{selectedLongScene.clips.map((clip, index) => {
                const previous = index > 0 ? selectedLongScene.clips[index - 1] : null;
                const blocked = clip.transition === 'continuous' && Boolean(previous && previous.status !== 'accepted');
                return <article className={`long-clip ${clip.status}`} key={clip.id}>
                  <div className="long-clip-number"><b>{String(index + 1).padStart(2, '0')}</b><span>{clip.status}</span></div>
                  <div className="long-clip-fields"><div><input value={clip.title} maxLength={160} onChange={(event) => updateLongSceneClip(selectedLongScene.id, clip.id, { title: event.target.value })} /><select value={clip.transition} disabled={index === 0} onChange={(event) => updateLongSceneClip(selectedLongScene.id, clip.id, { transition: event.target.value as LongSceneClip['transition'] })}><option value="continuous">Continue previous</option><option value="cut">New cut</option></select><label><input type="number" min={5} max={20} value={clip.duration} onChange={(event) => updateLongSceneClip(selectedLongScene.id, clip.id, { duration: Number(event.target.value) })} /><span>sec</span></label></div><textarea value={clip.prompt} maxLength={4000} placeholder="What changes and happens during this clip? Keep permanent identity details in the Bible above." onChange={(event) => updateLongSceneClip(selectedLongScene.id, clip.id, { prompt: event.target.value })} />{clip.error && <p>{clip.error}</p>}{blocked && <small className="long-clip-blocked"><Lock size={11} /> Accept clip {index} before continuing.</small>}</div>
                  <div className="long-clip-actions">{clip.video && <button title="Play clip" onClick={() => clip.video && onPlay(clip.video)}><Play size={13} /></button>}{clip.status === 'review' && <button title="Accept and memorize ending" onClick={() => void action('accept-continuity-clip', { sceneId: selectedLongScene.id, clipId: clip.id }, 'Clip accepted · ending anchor memorized').catch(() => undefined)}><Check size={13} /></button>}{['planned', 'prepared', 'review', 'failed'].includes(clip.status) && <button title={clip.status === 'review' ? 'Revise and regenerate in Create' : 'Prepare in Create'} disabled={blocked || !clip.prompt.trim() || !selectedLongScene.ingredientsAssetId || Boolean(pending)} onClick={() => void prepareContinuityClip(selectedLongScene.id, clip.id)}>{clip.status === 'review' ? <RefreshCw size={13} /> : <Zap size={13} />}</button>}{clip.status === 'planned' && <button title="Remove planned clip" onClick={() => updateLongScene(selectedLongScene.id, { clips: selectedLongScene.clips.filter((item) => item.id !== clip.id).map((item, itemIndex) => ({ ...item, order: itemIndex + 1 })) })}><Trash2 size={13} /></button>}</div>
                </article>;
              })}</div>
              <button className="long-scene-add" onClick={() => addLongSceneClip(selectedLongScene.id)}><Plus size={14} /> Add another clip — sequence length is open-ended</button>
            </div> : <div className="continuity-empty"><Layers3 size={25} /><b>No long scene planned</b><span>Create a scene, split it into manageable 5–20 second clips, then prepare and review them sequentially.</span><button className="secondary-button" onClick={createLongSceneDraft}><Plus size={13} /> Create first scene</button></div>}
          </section>
        </div>
        <div className="continuity-limit-note"><CircleAlert size={14} /><span><b>Consistency can be extended indefinitely as a managed process, not guaranteed infinitely by the model.</b> The Bible, Ingredients sheet, accepted endings, and optional Blender backbone reduce drift. Review gates remain necessary, and exact camera/geometry continuity still requires Blender authority.</span></div>
      </section> : <>

      <section className="project-stats">
        <div><small>INDEXED ASSETS</small><b>{project.counts.assets}</b></div><div><small>DISCOVERED SHOTS</small><b>{project.counts.shots}</b></div><div><small>LTX MAPPED</small><b>{project.counts.mapped}</b></div><div><small>REGEN QUEUE</small><b>{project.counts.queued + project.counts.generating}</b></div>
      </section>

      {activeRegeneration && activeRegeneration.progress != null && <section className="project-active-render">
        <div className="project-active-render-shot">
          <span className="project-active-render-icon"><LoaderCircle size={16} className="spinning" /></span>
          <span><small>REGENERATING NOW</small><b>{displayName(activeRegeneration.track)} · SHOT {activeRegeneration.shot}</b></span>
        </div>
        <div className="project-active-render-progress">
          <div><span>{activeRegeneration.stage || 'Generating shot'}</span><b>{activeRegeneration.progress}%</b></div>
          <div className="project-active-render-track" role="progressbar" aria-label={`Shot ${activeRegeneration.shot} regeneration progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={activeRegeneration.progress}><span style={{ width: `${activeRegeneration.progress}%` }} /></div>
        </div>
        <div className="project-active-render-time"><span><small>ELAPSED</small><b>{formatQueueTime(activeRegeneration.elapsedSeconds)}</b></span><span><small>EST. REMAINING</small><b>~{formatQueueTime(activeRegeneration.remainingSeconds)}</b></span></div>
      </section>}

      <section className="project-layout">
        <div className="project-library">
          <div className="project-tools">
            <label className="search-box"><Search size={14} /><input value={search} onChange={(event) => { setVisibleCount(SHOT_BATCH_SIZE); setSearch(event.target.value); }} placeholder="Search shots" /></label>
            <div className="filter-tabs">{(['all', 'mapped', 'review', 'accepted'] as const).map((value) => <button key={value} className={filter === value ? 'selected' : ''} onClick={() => { setVisibleCount(SHOT_BATCH_SIZE); setFilter(value); }}>{value}</button>)}</div>
            <button className="context-upload" onClick={() => fileInput.current?.click()} disabled={pending === 'upload'}>{pending === 'upload' ? <LoaderCircle size={14} className="spinning" /> : <Upload size={14} />} Add files</button>
            <input ref={fileInput} type="file" multiple hidden onChange={(event) => void uploadFiles(event.target.files)} />
          </div>
          <div className="project-select-row"><label><input type="checkbox" checked={visibleShots.length > 0 && visibleShots.every((shot) => selectedShots.includes(shot.shotKey))} onChange={(event) => setSelectedShots(event.target.checked ? [...new Set([...selectedShots, ...visibleShots.map((shot) => shot.shotKey)])] : selectedShots.filter((key) => !visibleShots.some((shot) => shot.shotKey === key)))} /> Select visible</label><span>{selectedShots.length} selected · {selectedMapped.length} ready for LTX</span></div>

          <div className="project-shot-grid">
            {visibleShots.map((shot) => {
              const asset = shot.versions.find((item) => item.id === shot.currentAssetId) || shot.versions[0];
              return <article className={`project-shot-card ${selectedShots.includes(shot.shotKey) ? 'selected' : ''}`} key={shot.shotKey}>
                <button className="project-shot-select" onClick={() => toggleShot(shot.shotKey)} aria-label={`Select ${shot.title}`}><span>{selectedShots.includes(shot.shotKey) ? <Check size={12} /> : null}</span></button>
                <button className="project-preview" onClick={() => asset && (asset.kind === 'video' ? playAsset(asset, shot.title) : toggleShot(shot.shotKey))}>
                  <LazyProjectPreview key={asset?.id || 'empty'} asset={asset} />
                  {asset?.kind === 'video' && <span className="project-play"><Play size={16} fill="currentColor" /></span>}
                  <span className={`project-status ${shot.status}`}>{shot.status}</span>
                </button>
                <div className="project-shot-copy"><div><h3>{shot.title}</h3><span>{shot.regeneratable ? <><Zap size={11} /> LTX MAPPED</> : 'REFERENCE ONLY · NOT QUEUEABLE'}</span></div><p>{asset?.name || 'No current asset'}</p><div><small>{shot.versions.length} version{shot.versions.length === 1 ? '' : 's'} · {shot.contextAssetIds.length} context</small>{asset && <button onClick={() => void onOpen(asset.fullPath)} title="Show in Explorer"><FolderOpen size={14} /></button>}</div></div>
              </article>;
            })}
          </div>
          {filteredShots.length > 0 && <div className="project-library-progress"><span>Showing {visibleShots.length} of {filteredShots.length} shots</span>{visibleShots.length < filteredShots.length && <button onClick={() => setVisibleCount((count) => Math.min(count + SHOT_BATCH_SIZE, filteredShots.length))}>Load {Math.min(SHOT_BATCH_SIZE, filteredShots.length - visibleShots.length)} more</button>}</div>}
          {!filteredShots.length && <div className="project-empty-small"><Film size={24} /><b>No shots match this view</b><span>Shot files are detected by a leading number or “shot_####” in the filename.</span></div>}
        </div>

        <aside className="project-inspector">
          <section className="project-panel project-bulk">
            <div className="project-panel-head"><span><Zap size={14} /> SELECTIVE REGENERATION</span><b>{selectedMapped.length}</b></div>
            <textarea disabled={!selectedMapped.length && !correction} value={correction} onChange={(event) => setCorrection(event.target.value)} maxLength={2000} placeholder={selectedShots.length && !selectedMapped.length ? 'This selection has no compatible LTX scene mapping.' : 'Non-spoken director note: keep the same camera move, reduce motion, preserve character silhouette…'} />
            <p className="panel-note">The note is production direction, never spoken or shown. For exact speech, begin a separate line with <b>DIALOGUE:</b></p>
            {Boolean(selectedUnmapped.length) && <div className="project-selection-warning"><CircleAlert size={13} /><span><b>{selectedUnmapped.length} reference-only shot{selectedUnmapped.length === 1 ? '' : 's'} cannot be queued.</b> Only shots matching a scene and shot number reported by the compatible LTX source runner can regenerate.</span></div>}
            <button className="project-primary wide" disabled={!selectedMapped.length || Boolean(pending)} onClick={() => void action('queue-regeneration', { shotKeys: selectedMapped, correction }, `${selectedMapped.length} shot${selectedMapped.length === 1 ? '' : 's'} queued for regeneration`).then(() => { setSelectedShots([]); setCorrection(''); }).catch(() => undefined)}>{pending === 'queue-regeneration' ? <LoaderCircle size={14} className="spinning" /> : <Zap size={14} />} {!selectedShots.length ? 'Select mapped shots to regenerate' : !selectedMapped.length ? 'No mapped shots to regenerate' : `Submit correction & queue ${selectedMapped.length} shot${selectedMapped.length === 1 ? '' : 's'}`}</button>
            <div className="project-review-label">REVIEW THE CURRENT RESULT <span>Does not queue a render</span></div>
            <div className="bulk-secondary"><button disabled={!selectedShots.length || Boolean(pending) || Boolean(correction.trim())} title={correction.trim() ? 'Clear the correction before approving the current result.' : 'Approve the current result without creating a render job.'} onClick={() => void markSelectedStatus('accepted').catch(() => undefined)}><Check size={13} /> Approve current</button><button disabled={!selectedShots.length || Boolean(pending)} onClick={() => void markSelectedStatus('review').catch(() => undefined)}><RefreshCw size={13} /> Keep in review</button></div>
          </section>

          <section className="project-panel blender-panel">
            <div className="project-panel-head"><span><Box size={14} /> BLENDER BACKBONE</span><b>{project.blenderAssets.length}</b></div>
            {project.blenderAssets.length ? <><select value={project.blenderBackboneAssetId || ''} onChange={(event) => void action('set-blender-backbone', { assetId: event.target.value || null }, event.target.value ? 'Blender backbone assigned' : 'Blender backbone cleared').catch(() => undefined)}><option value="">No master scene</option>{project.blenderAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.relativePath}</option>)}</select>{project.blenderBackbone && <button className="backbone-file" onClick={() => void onOpen(project.blenderBackbone!.fullPath)}><Box size={15} /><span><b>{project.blenderBackbone.name}</b><small>Master camera & blocking scene</small></span><ChevronRight size={14} /></button>}</> : <div className="panel-empty"><Box size={20} /><span>Upload or index a <code>.blend</code>, USD, FBX, GLTF, or OBJ file to establish the shared 3D scene.</span></div>}
            <p className="panel-note">The project keeps this scene and per-shot 3D context attached. The Blender render-pass adapter is the next production layer; current LTX regeneration uses the mapped source scene and correction.</p>
          </section>

          <section className="project-panel">
            <div className="project-panel-head"><span><Layers3 size={14} /> CONTEXT ASSETS</span><b>{project.contextAssets.length}</b></div>
            <div className="context-list">
              {project.contextAssets.slice(0, 60).map((asset) => <label key={asset.id}><input type="checkbox" checked={selectedContext.includes(asset.id)} onChange={(event) => setSelectedContext((current) => event.target.checked ? [...current, asset.id] : current.filter((id) => id !== asset.id))} /><AssetIcon kind={asset.kind} size={13} /><span><b>{asset.name}</b><small>{asset.kind} · {formatBytes(asset.size)}</small></span></label>)}
              {!project.contextAssets.length && <div className="panel-empty"><FileBox size={20} /><span>Add prompts, reference images, audio, metadata, or 3D files.</span></div>}
            </div>
            <button className="inspector-action" disabled={!selectedShots.length || !selectedContext.length || Boolean(pending)} onClick={() => void action('attach-context', { shotKeys: selectedShots, assetIds: selectedContext }, 'Context attached to selected shots').then(() => setSelectedContext([])).catch(() => undefined)}><Layers3 size={13} /> Attach to {selectedShots.length || 0} selected</button>
          </section>

          <section className="project-panel queue-panel">
            <div className="project-panel-head"><span><Film size={14} /> REGENERATION QUEUE</span><button onClick={() => void action('toggle-queue', { paused: !project.queuePaused }, project.queuePaused ? 'Project queue resumed' : 'Project queue paused').catch(() => undefined)}>{project.queuePaused ? <><Play size={12} /> Resume</> : <><Pause size={12} /> Pause</>}</button></div>
            <div className="project-queue-list">
              {project.queue.slice(0, 12).map((item) => <div className={`project-queue-item ${item.status}`} key={item.id}>
                <span>{item.status === 'generating' ? <LoaderCircle size={13} className="spinning" /> : item.status === 'review' ? <Check size={13} /> : item.status === 'failed' ? <CircleAlert size={13} /> : <Film size={13} />}</span>
                <div><b>{displayName(item.track)} · {item.shot}</b>{item.status === 'generating' && item.progress != null ? <>
                  <div className="project-queue-progress-label"><span>{item.stage || 'Generating shot'}</span><b>{item.progress}%</b></div>
                  <div className="project-queue-progress" role="progressbar" aria-label={`Shot ${item.shot} regeneration progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={item.progress}><span style={{ width: `${item.progress}%` }} /></div>
                  <small>{formatQueueTime(item.elapsedSeconds)} elapsed · ~{formatQueueTime(item.remainingSeconds)} remaining</small>
                </> : <small>{item.error || item.correction || item.status}</small>}</div>
                {item.status === 'queued' && <button onClick={() => void action('remove-queued', { queueId: item.id }).catch(() => undefined)} aria-label="Remove queued shot"><X size={12} /></button>}
              </div>)}
              {!project.queue.length && <div className="panel-empty"><Film size={20} /><span>No selective regenerations queued.</span></div>}
            </div>
          </section>
        </aside>
      </section>
      </>}
    </>}
  </div>;
}
