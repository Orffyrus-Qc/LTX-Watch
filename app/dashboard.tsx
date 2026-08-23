'use client';

import {
  Aperture,
  Check,
  ChevronRight,
  CircleAlert,
  Clapperboard,
  Clock3,
  Cpu,
  Download,
  ExternalLink,
  Film,
  FolderKanban,
  FolderOpen,
  Gauge,
  HardDrive,
  History,
  ListVideo,
  LoaderCircle,
  Pause,
  PackageCheck,
  Play,
  RefreshCw,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  TimerReset,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import StudioWorkspace, { type StudioView, type StudioVideo } from './studio-workspace';
import ProjectWorkspace from './project-workspace';

const API_BASE = process.env.NEXT_PUBLIC_LTX_WATCH_API || 'http://127.0.0.1:4311';

type VideoItem = {
  id: string;
  title: string;
  filename: string;
  kind: 'final' | 'clip';
  size: number;
  modifiedAt: string;
  mediaUrl: string;
  directory: string;
  duration?: number;
  width?: number;
  height?: number;
  codec?: string;
};

type QueueItem = {
  position: number;
  section: string;
  track: string;
  slug: string;
  count: number;
  shots: string;
};

type Config = {
  displayName: string;
  modelLabel: string;
  workerCommandFragment: string;
  recoveryScript: string;
  studioSourceRunner: string;
  studioGpu: number;
  studioPort: number;
  comfyRoot: string;
  finalsDirectory: string;
  clipsDirectory: string;
  logFile: string;
  statusFile: string;
  planFile: string;
  comfyUrl: string;
  refreshSeconds: number;
  maxVideos: number;
};

type MonitorState = {
  updatedAt: string;
  connection: { comfy: boolean; worker: boolean; apiUrl: string };
  current: null | {
    section: string;
    track: string;
    slug: string;
    totalShots: number;
    worker: string;
    startedAt: string | null;
    currentShot: string | null;
    stage: string;
    outputSeconds?: number;
    completedShots: number;
    progress: number;
    remainingSeconds: number;
    averageShotSeconds: number;
    elapsedSeconds: number;
  };
  control: {
    state: 'running' | 'paused' | 'recovery';
    canControl: boolean;
    workerPids: number[];
    affectedPids: number[];
    changedAt: string | null;
    recoveryReason: 'system-restarted' | 'process-ended' | null;
    recoveryAvailable: boolean;
    restartedShot: string | null;
    message: string;
    token: string;
  };
  queue: QueueItem[];
  videos: VideoItem[];
  activity: { type: 'started' | 'queued' | 'complete' | 'final' | 'error' | 'paused' | 'resumed' | 'recovery' | 'recovered'; time?: string; title: string; detail: string }[];
  gpus: { device: number; name: string; memoryMb: number; utilization: number; totalMemoryGb: number | null }[];
  stats: { finals: number; clips: number; todayFinals: number; queued: number };
  config: Config;
  studio: StudioView;
};

type EnvironmentState = {
  schemaVersion: number;
  updatedAt: string;
  summary: { state: 'ready' | 'attention' | 'missing'; title: string; detail: string };
  render: { active: boolean; worker: boolean; comfyRunning: number; comfyPending?: number; changesLocked: boolean };
  installation: { comfyInstalled: boolean; ltxReady: boolean; ltxDesktop: boolean; root: string };
  checks: { id: string; label: string; state: 'ready' | 'attention' | 'missing'; detail: string }[];
  models: {
    groups: Record<string, { installed: boolean; count: number; files: string[] }>;
    coreNodes: boolean;
    backend: boolean;
    advancedNodes: boolean;
  };
  python: {
    installed: boolean;
    version?: string | null;
    pipHealthy: boolean;
    pipMessage: string;
    packages: { name: string; version: string }[];
    localRequirements?: { total: number; missing: string[]; mismatched: { requirement: string; installed: string }[]; satisfied: boolean } | null;
    latestRequirements?: { total: number; missing: string[]; mismatched: { requirement: string; installed: string }[]; satisfied: boolean } | null;
  };
  disk: { available: boolean; freeGiB: number | null; totalGiB: number | null };
  repositories: {
    id: string;
    name: string;
    localHead: string | null;
    remoteHead: string | null;
    branch: string;
    dirty: boolean;
    trustRequired: boolean;
    updateStatus: 'current' | 'behind' | 'ahead' | 'diverged' | 'unknown';
    behindBy: number;
    aheadBy: number;
  }[];
  gpus: {
    device: number;
    name: string;
    driver: string;
    memoryTotalMb: number;
    memoryUsedMb: number;
    memoryFreeMb: number;
    computeCapability: string;
    totalMemoryGb: number;
    role: 'primary' | 'auxiliary' | 'candidate';
    title: string;
    recommendation: string;
  }[];
  runnerProfile: {
    externalRunner: boolean;
    safeguards: string[];
    secondaryLtxEnabled?: boolean;
    knownWorking: boolean;
    automationLevel: 'guided' | 'unavailable';
    message: string;
  };
  tools: {
    sam3: {
      nativeInstalled: boolean;
      modelInstalled: boolean;
      automatedSetupSupported: boolean;
      downloadBytes: number;
      state: 'ready' | 'model-required' | 'core-update-required' | 'unavailable';
      detail: string;
      links: { model: string; license: string; guide: string };
    };
    ltxAdvanced: { installed: boolean; detail: string; url: string };
    comfyBlender?: {
      ready: boolean;
      state: 'ready' | 'blender-required' | 'unsupported' | 'install-required' | 'update-available' | 'configuration-required';
      detail: string;
      blenderDetected: boolean;
      blenderVersion: string | null;
      supported: boolean;
      customNodesInstalled: boolean;
      customNodesVersion: string | null;
      addonInstalled: boolean;
      addonVersion: string | null;
      configured: boolean;
      serverAddress: string | null;
      latestVersion: string | null;
      updateAvailable: boolean;
      releaseUrl: string;
      projectUrl: string;
    };
  };
  maintenance?: {
    status: 'idle' | 'running' | 'complete' | 'failed';
    action: string | null;
    stage: string | null;
    startedAt: string | null;
    completedAt: string | null;
    result: { comfyRestartRequired?: boolean; updated?: boolean; currentCommit?: string; error?: string } | null;
  };
  actions: { id: string; label: string; url: string; kind: 'primary' | 'secondary'; reason: string }[];
  warnings: string[];
};

function formatBytes(bytes: number) {
  if (!bytes) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
}

function formatDuration(seconds = 0, compact = false) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  if (compact && hours) return `${hours}h ${minutes}m`;
  if (compact && minutes) return `${minutes}m ${secs}s`;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : `${minutes}:${String(secs).padStart(2, '0')}`;
}

function formatWhen(value?: string) {
  if (!value) return 'Just now';
  const date = new Date(value);
  const today = new Date();
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date);
  if (date.toDateString() === today.toDateString()) return `Today, ${time}`;
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}

function titleFromSlug(value: string) {
  return value.replace(/_full$/i, '').replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function shortHash(value?: string | null) {
  return value ? value.slice(0, 8) : 'offline';
}

function profileSignal(value: string) {
  const labels: Record<string, string> = {
    gpuIsolation: 'GPU isolated',
    reserveVram: 'VRAM reserved',
    disablePinnedMemory: 'Pinned RAM guarded',
    isolatedRuntimeFolders: 'Runtime folders isolated',
  };
  return labels[value] || value;
}

function ActivityIcon({ type }: { type: MonitorState['activity'][number]['type'] }) {
  if (type === 'complete' || type === 'final') return <Check size={14} />;
  if (type === 'error' || type === 'recovery' || type === 'recovered') return <CircleAlert size={14} />;
  if (type === 'queued') return <TimerReset size={14} />;
  if (type === 'paused') return <Pause size={14} />;
  if (type === 'resumed') return <Play size={14} />;
  return <Zap size={14} />;
}

export default function Dashboard() {
  const [state, setState] = useState<MonitorState | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [controlPending, setControlPending] = useState(false);
  const [selectedVideo, setSelectedVideo] = useState<VideoItem | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  const [environment, setEnvironment] = useState<EnvironmentState | null>(null);
  const [environmentLoading, setEnvironmentLoading] = useState(false);
  const [maintenancePending, setMaintenancePending] = useState(false);
  const [maintenanceAction, setMaintenanceAction] = useState('');
  const [environmentError, setEnvironmentError] = useState('');
  const [queueOpen, setQueueOpen] = useState(false);
  const [settings, setSettings] = useState<Config | null>(null);
  const [filter, setFilter] = useState<'all' | 'final' | 'clip'>('final');
  const [search, setSearch] = useState('');
  const [visibleCount, setVisibleCount] = useState(9);
  const [toast, setToast] = useState('');
  const [workspace, setWorkspace] = useState<'watch' | 'studio' | 'projects'>('watch');

  const loadState = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true);
    try {
      const response = await fetch(`${API_BASE}/api/state`, { cache: 'no-store' });
      if (!response.ok) throw new Error('Local bridge is not responding');
      const next = await response.json() as MonitorState;
      setState(next);
      setSettings((current) => current || next.config);
      setError('');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Unable to read LTX status');
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => loadState(), 0);
    return () => window.clearTimeout(timer);
  }, [loadState]);
  useEffect(() => {
    const interval = window.setInterval(() => loadState(true), (state?.config.refreshSeconds || 5) * 1000);
    return () => window.clearInterval(interval);
  }, [loadState, state?.config.refreshSeconds]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setSelectedVideo(null); setSettingsOpen(false); setEnvironmentOpen(false); setQueueOpen(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const videos = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (state?.videos || []).filter((video) => (filter === 'all' || video.kind === filter) && (!term || `${video.title} ${video.filename}`.toLowerCase().includes(term)));
  }, [state?.videos, filter, search]);

  async function openInExplorer(target: string) {
    try {
      const response = await fetch(`${API_BASE}/api/open`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: target }) });
      if (!response.ok) throw new Error((await response.json()).error || 'Could not open Explorer');
      setToast('Opened in Windows Explorer');
    } catch (requestError) { setToast(requestError instanceof Error ? requestError.message : 'Could not open Explorer'); }
  }

  async function loadEnvironment(force = false) {
    setEnvironmentLoading(true);
    try {
      const response = await fetch(`${API_BASE}/api/environment${force ? '?refresh=1' : ''}`, { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Environment scan failed');
      setEnvironment(payload as EnvironmentState);
      setEnvironmentError('');
    } catch (requestError) {
      setEnvironmentError(requestError instanceof Error ? requestError.message : 'Environment scan failed');
    } finally {
      setEnvironmentLoading(false);
    }
  }

  function openEnvironment() {
    setEnvironmentOpen(true);
    void loadEnvironment(false);
  }

  async function setupComfyBlender() {
    const integration = environment?.tools.comfyBlender;
    if (!integration || !state?.control.token || maintenancePending || environment?.render.changesLocked) return;
    const verb = integration.updateAvailable ? 'update' : integration.ready ? 'reconfigure' : integration.customNodesInstalled && integration.addonInstalled ? 'verify and configure' : 'install';
    const confirmed = window.confirm(`LTX Watch will ${verb} ComfyUI-Blender using the official release, enable it in Blender, and save ${state.config.comfyUrl} as its server address. Blender must be closed. Continue?`);
    if (!confirmed) return;
    setMaintenanceAction('install-comfyui-blender');
    setMaintenancePending(true);
    setEnvironmentError('');
    try {
      const response = await fetch(`${API_BASE}/api/environment/maintenance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-LTX-Control-Token': state.control.token },
        body: JSON.stringify({ action: 'install-comfyui-blender', confirmed: true }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'ComfyUI-Blender setup failed');
      setEnvironment(payload.environment as EnvironmentState);
      setToast(payload.result?.comfyRestartRequired
        ? 'ComfyUI-Blender configured — restart ComfyUI after your work is idle'
        : 'ComfyUI-Blender enabled and configured');
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'ComfyUI-Blender setup failed';
      await loadEnvironment(true);
      setEnvironmentError(message);
    } finally {
      setMaintenancePending(false);
      setMaintenanceAction('');
    }
  }

  async function setupSam3() {
    const sam3 = environment?.tools.sam3;
    if (!sam3?.automatedSetupSupported || !state?.control.token || maintenancePending || environment?.render.changesLocked) return;
    const confirmed = window.confirm(`LTX Watch will download the official 1.63 GiB SAM 3.1 checkpoint from Comfy-Org into ${state.config.comfyRoot}\\models\\checkpoints and verify its pinned size and SHA-256 digest. An existing unverified file will be backed up. The model is provided under Meta's SAM License; by continuing, you confirm that you reviewed and accept that license. ComfyUI must be restarted afterward. Continue?`);
    if (!confirmed) return;
    setMaintenanceAction('install-sam3');
    setMaintenancePending(true);
    setEnvironmentError('');
    try {
      const response = await fetch(`${API_BASE}/api/environment/maintenance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-LTX-Control-Token': state.control.token },
        body: JSON.stringify({ action: 'install-sam3', confirmed: true, licenseAccepted: true }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'SAM 3.1 setup failed');
      setEnvironment(payload.environment as EnvironmentState);
      setToast(payload.result?.installed ? 'SAM 3.1 installed and verified — restart ComfyUI when idle' : 'SAM 3.1 checkpoint verified');
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'SAM 3.1 setup failed';
      await loadEnvironment(true);
      setEnvironmentError(message);
    } finally {
      setMaintenancePending(false);
      setMaintenanceAction('');
    }
  }

  async function updateComfyCore() {
    const repository = environment?.repositories.find((repo) => repo.id === 'comfy');
    if (!repository || repository.updateStatus !== 'behind' || repository.dirty || !state?.control.token || maintenancePending || environment?.render.changesLocked) return;
    const confirmed = window.confirm(`LTX Watch will fast-forward ComfyUI Core from ${shortHash(repository.localHead)} to the official ${shortHash(repository.remoteHead)} revision, install that revision's Python requirements, and validate them.\n\nTracked local changes block the update. Untracked workflows, scripts, models, outputs, and logs are preserved. Git trust is scoped only to ${state.config.comfyRoot}; no global wildcard is added. If dependency setup fails, Watch will restore the previous tracked revision and requirements.\n\nComfyUI must be idle and restarted afterward. Continue?`);
    if (!confirmed) return;
    setMaintenanceAction('update-comfyui-core');
    setMaintenancePending(true);
    setEnvironmentError('');
    try {
      const response = await fetch(`${API_BASE}/api/environment/maintenance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-LTX-Control-Token': state.control.token },
        body: JSON.stringify({ action: 'update-comfyui-core', confirmed: true }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'ComfyUI Core update failed');
      setEnvironment(payload.environment as EnvironmentState);
      setToast(payload.result?.updated ? 'ComfyUI Core updated — restart ComfyUI before rendering' : 'ComfyUI Core is already current');
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'ComfyUI Core update failed';
      await loadEnvironment(true);
      setEnvironmentError(message);
    } finally {
      setMaintenancePending(false);
      setMaintenanceAction('');
    }
  }

  async function saveSettings() {
    if (!settings) return;
    try {
      const response = await fetch(`${API_BASE}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings) });
      if (!response.ok) throw new Error('Settings were not saved');
      setSettingsOpen(false);
      setToast('Monitor settings saved');
      await loadState();
    } catch (requestError) { setToast(requestError instanceof Error ? requestError.message : 'Settings were not saved'); }
  }

  async function toggleGenerator() {
    if (!state?.control?.canControl || controlPending) return;
    const action = state.control.state === 'paused' || state.control.state === 'recovery' ? 'resume' : 'pause';
    setControlPending(true);
    try {
      const response = await fetch(`${API_BASE}/api/control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-LTX-Control-Token': state.control.token },
        body: JSON.stringify({ action }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `Could not ${action} the generator`);
      setToast(payload.control?.recoveryReason || payload.control?.restartedShot
        ? payload.control.message
        : action === 'pause' ? 'Generation paused — VRAM is preserved' : 'Generation resumed');
      await loadState(true);
    } catch (requestError) {
      setToast(requestError instanceof Error ? requestError.message : `Could not ${action} the generator`);
    } finally { setControlPending(false); }
  }

  const current = state?.current;
  const active = Boolean(current);
  const elapsedSeconds = current?.elapsedSeconds || 0;
  const mainGpu = state?.gpus[0];
  const live = Boolean(state?.connection.worker || state?.connection.comfy);
  const recoveryRequired = state?.control?.state === 'recovery';
  const isPaused = state?.control?.state === 'paused' || recoveryRequired;
  const greeting = new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 18 ? 'Good afternoon' : 'Good evening';

  return (
    <main className="shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => setWorkspace('watch')}>
          <span className="brand-mark"><Aperture size={17} /></span><span>{workspace === 'studio' ? 'LTX / WATCH STUDIO' : workspace === 'projects' ? 'LTX / WATCH PROJECTS' : 'LTX / WATCH'}</span>
        </button>
        <nav aria-label="Main navigation">
          <button className={`nav-item ${workspace === 'watch' ? 'active' : ''}`} onClick={() => setWorkspace('watch')}><Gauge size={18} />Overview</button>
          <button className={`nav-item ${workspace === 'studio' ? 'active' : ''}`} onClick={() => setWorkspace('studio')}><Clapperboard size={18} />Studio <span className="studio-nav-dot">BETA</span></button>
          <button className={`nav-item ${workspace === 'projects' ? 'active' : ''}`} onClick={() => setWorkspace('projects')}><FolderKanban size={18} />Projects <span className="studio-nav-dot">NEW</span></button>
          <button className="nav-item" onClick={() => { setWorkspace('watch'); window.setTimeout(() => document.getElementById('history')?.scrollIntoView({ behavior: 'smooth' }), 0); }}><History size={18} />History</button>
          <button className="nav-item" onClick={() => { setWorkspace('watch'); setQueueOpen(true); }}><ListVideo size={18} />Queue <span className="nav-count">{state?.queue.length || 0}</span></button>
          <button className="nav-item" onClick={openEnvironment}><Wrench size={18} />Environment {environment?.summary.state === 'attention' || environment?.summary.state === 'missing' ? <span className="nav-alert">!</span> : null}</button>
          <button className="nav-item" onClick={() => setSettingsOpen(true)}><Settings2 size={18} />Settings</button>
        </nav>
        <div className="system-card">
          <div className={`eyebrow ${live ? '' : 'offline'}`}><span className="status-dot" /> {live ? 'SYSTEM ONLINE' : 'SYSTEM IDLE'}</div>
          <p>ComfyUI · {state?.connection.apiUrl?.replace(/^https?:\/\//, '') || '127.0.0.1:8188'}</p>
          {mainGpu ? <>
            <div className="gpu-line"><span>GPU {mainGpu.device}</span><strong>{mainGpu.utilization}%</strong></div>
            <div className="mini-meter"><span style={{ width: `${mainGpu.utilization}%` }} /></div>
            <small>{mainGpu.name.replace('NVIDIA GeForce ', '')} · {(mainGpu.memoryMb / 1024).toFixed(1)} GB allocated</small>
          </> : <small>Waiting for GPU telemetry</small>}
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <div><p className="kicker">{workspace === 'studio' ? 'SHOT REVIEW & DIRECTION' : workspace === 'projects' ? 'PROJECT & ASSET CONTROL' : 'LOCAL GENERATION MONITOR'}</p><h1>{workspace === 'studio' ? 'Direct every shot.' : workspace === 'projects' ? 'Manage the complete edit.' : `${greeting}, ${state?.config.displayName || 'Creator'}.`}</h1></div>
          <div className="header-actions">
            <button className="icon-button" onClick={() => loadState()} aria-label="Refresh data" title="Refresh data"><RefreshCw size={16} className={refreshing ? 'spinning' : ''} /></button>
            <button className="secondary-button" onClick={() => state?.config.finalsDirectory && openInExplorer(state.config.finalsDirectory)}><FolderOpen size={15} /> Open outputs</button>
            {workspace === 'watch' && <button className={`control-button ${isPaused ? 'resume' : 'pause'}`} onClick={toggleGenerator} disabled={!state?.control?.canControl || controlPending} title={recoveryRequired ? 'Restart the interrupted shot from the beginning' : isPaused ? 'Resume the suspended LTX worker' : 'Suspend the active LTX worker and its ComfyUI subprocesses'}>
              {controlPending ? <LoaderCircle size={15} className="spinning" /> : isPaused ? <Play size={15} fill="currentColor" /> : <Pause size={15} fill="currentColor" />}
              <span>{controlPending ? 'Working…' : recoveryRequired ? 'Retry interrupted shot' : isPaused ? 'Resume render' : 'Pause render'}</span>
            </button>}
            <div className={`sync ${error ? 'sync-error' : ''}`}><span className="status-dot" /> {error ? 'BRIDGE OFFLINE' : workspace === 'studio' ? state?.studio.canGenerate ? 'STUDIO READY' : 'STUDIO SAFE WAIT' : workspace === 'projects' ? 'PROJECTS · LOCAL' : 'LIVE · AUTO REFRESH'}</div>
          </div>
        </header>

        {error && <div className="error-banner" role="alert"><CircleAlert size={16} /><span><strong>Local bridge unavailable.</strong> Start the monitor with <code>npm run dev</code> and this page will reconnect automatically.</span></div>}

        {workspace === 'studio' ? <StudioWorkspace studio={state?.studio} token={state?.control.token} apiBase={API_BASE} onRefresh={() => loadState(true)} onToast={setToast} onPlay={(video: StudioVideo) => setSelectedVideo(video)} /> : workspace === 'projects' ? <ProjectWorkspace token={state?.control.token} apiBase={API_BASE} refreshSeconds={state?.config.refreshSeconds} onToast={setToast} onOpen={openInExplorer} onPlay={(video: StudioVideo) => setSelectedVideo(video)} /> : <>
        <section className={`hero ${active ? '' : 'hero-idle'} ${isPaused ? 'hero-paused' : ''}`} id="overview">
          <div className="hero-copy">
            <div className="job-label"><span className="pulse" /> {recoveryRequired ? 'SHOT RESTART REQUIRED' : isPaused ? 'GENERATION PAUSED' : active ? 'GENERATING NOW' : state?.connection.worker ? 'WORKER TRANSITIONING' : 'NO ACTIVE JOB'} <span>{current ? `SHOT ${Math.min(current.completedShots + 1, current.totalShots)} OF ${current.totalShots}` : 'STANDING BY'}</span></div>
            <h2>{current ? titleFromSlug(current.slug) : state?.queue[0] ? `Next: ${titleFromSlug(state.queue[0].slug)}` : 'Render queue complete'}</h2>
            <p>{current ? `${current.section.replace(/_/g, ' ')} · ${state?.config.modelLabel || 'LTX Video'} · Worker ${current.worker.toUpperCase()}` : `${state?.config.modelLabel || 'LTX Video'} · Local output monitor`}</p>
            <div className="progress-row"><span>{recoveryRequired ? `Resume will retry shot ${current?.currentShot || ''} from the beginning` : isPaused ? 'Paused in place · VRAM remains allocated' : current?.stage || 'Waiting for the next generation event'}</span><strong>{current ? `${Math.round(current.progress)}%` : '—'}</strong></div>
            <div className="progress"><span style={{ width: `${current?.progress || 0}%` }} /></div>
            <div className="metrics">
              <div><Clock3 size={18} /><span><small>ELAPSED</small><b>{current ? formatDuration(elapsedSeconds, true) : '—'}</b></span></div>
              <div><Sparkles size={18} /><span><small>EST. REMAINING</small><b>{current ? formatDuration(current.remainingSeconds, true) : '—'}</b></span></div>
              <div><Film size={18} /><span><small>CURRENT SHOT</small><b>{current?.currentShot || '—'}{current?.outputSeconds ? ` · ${current.outputSeconds}s` : ''}</b></span></div>
            </div>
          </div>
          <div className="queue-card">
            <div><span>UP NEXT</span><strong>{state?.queue.length || 0} queued</strong></div>
            <ol>
              {(state?.queue || []).slice(0, 4).map((item) => (
                <li key={`${item.section}-${item.slug}`}><i>{String(item.position).padStart(2, '0')}</i><span><b>{titleFromSlug(item.slug)}</b><small>{item.count} shots · {item.section.replace(/_/g, ' ')}</small></span></li>
              ))}
              {!state && [0, 1, 2].map((item) => <li className="queue-skeleton" key={item}><i /><span><b /><small /></span></li>)}
            </ol>
            <button className="queue-more" onClick={() => setQueueOpen(true)}>View full queue <ChevronRight size={14} /></button>
          </div>
        </section>

        <section className="stat-strip" aria-label="Generation summary">
          <div><span className="stat-icon"><Film size={16} /></span><p><small>FINAL VIDEOS</small><strong>{state?.stats.finals ?? '—'}</strong></p></div>
          <div><span className="stat-icon"><Zap size={16} /></span><p><small>FINISHED TODAY</small><strong>{state?.stats.todayFinals ?? '—'}</strong></p></div>
          <div><span className="stat-icon"><HardDrive size={16} /></span><p><small>RAW CLIPS INDEXED</small><strong>{state?.stats.clips ?? '—'}</strong></p></div>
          <div><span className="stat-icon"><TimerReset size={16} /></span><p><small>PLANNED JOBS</small><strong>{state?.stats.queued ?? '—'}</strong></p></div>
        </section>

        <section className="workspace-grid" id="history">
          <div className="history-panel">
            <div className="section-title">
              <div><p className="kicker">OUTPUT LIBRARY</p><h2>Recently generated</h2></div>
              <div className="library-tools">
                <label className="search-box"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search outputs" aria-label="Search outputs" /></label>
                <div className="filter-tabs" role="group" aria-label="Video type filter">
                  {(['final', 'clip', 'all'] as const).map((value) => <button className={filter === value ? 'selected' : ''} key={value} onClick={() => { setFilter(value); setVisibleCount(9); }}>{value === 'final' ? 'Finals' : value === 'clip' ? 'Clips' : 'All'}</button>)}
                </div>
              </div>
            </div>
            <div className="video-grid">
              {videos.slice(0, visibleCount).map((video) => (
                <article className="video-card" key={video.id}>
                  <button className="poster" onClick={() => setSelectedVideo(video)} aria-label={`Play ${video.title}`}>
                    <video src={`${video.mediaUrl}#t=0.1`} muted playsInline preload="metadata" aria-hidden="true" />
                    <span className="format-badge">{video.kind === 'final' ? 'FINAL CUT' : 'LTX CLIP'}</span>
                    <span className="play-button"><Play size={18} fill="currentColor" /></span>
                    {video.duration ? <span className="duration-badge">{formatDuration(video.duration)}</span> : null}
                  </button>
                  <div className="card-copy"><h3 title={video.title}>{video.title}</h3><p>{formatWhen(video.modifiedAt)}</p><div><span>{formatBytes(video.size)}{video.width ? ` · ${video.width}×${video.height}` : ''}</span><button onClick={() => openInExplorer(video.directory)} aria-label={`Show ${video.title} in Explorer`} title="Show in Explorer"><FolderOpen size={17} /></button></div></div>
                </article>
              ))}
              {!state && [0, 1, 2, 3, 4, 5].map((item) => <article className="video-card loading-card" key={item}><div className="poster" /><div className="card-copy"><h3 /><p /></div></article>)}
            </div>
            {state && videos.length === 0 && <div className="empty-state"><Film size={28} /><h3>No matching videos</h3><p>Try another filter, or check the output paths in Settings.</p></div>}
            {videos.length > visibleCount && <button className="load-more" onClick={() => setVisibleCount((count) => count + 9)}>Show more outputs <ChevronRight size={14} /></button>}
          </div>

          <aside className="activity-panel">
            <div className="activity-heading"><div><p className="kicker">LIVE FEED</p><h2>Activity</h2></div><span>{state ? formatWhen(state.updatedAt) : 'Connecting'}</span></div>
            <div className="activity-list">
              {(state?.activity || []).slice(0, 8).map((item, index) => (
                <div className={`activity-item ${item.type}`} key={`${item.time}-${item.title}-${index}`}><span className="activity-icon"><ActivityIcon type={item.type} /></span><div><b>{item.title}</b><p>{item.detail}</p><small>{formatWhen(item.time)}</small></div></div>
              ))}
              {state && state.activity.length === 0 && <div className="activity-empty"><Pause size={18} /><span>No recent generation events</span></div>}
              {!state && [0, 1, 2, 3].map((item) => <div className="activity-item activity-skeleton" key={item}><span /><div><b /><p /></div></div>)}
            </div>
          </aside>
        </section>

        </>}

        <footer><span>{workspace === 'studio' ? 'LTX / WATCH STUDIO' : workspace === 'projects' ? 'LTX / WATCH PROJECTS' : 'LTX / WATCH'}</span><p>Private local production workspace · Your files never leave this computer.</p><button onClick={openEnvironment}>Check environment <ShieldCheck size={12} /></button><button onClick={() => setSettingsOpen(true)}>Configure sources <ExternalLink size={12} /></button></footer>
      </section>

      {selectedVideo && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedVideo(null); }}>
        <section className="player-modal" role="dialog" aria-modal="true" aria-label={`Playing ${selectedVideo.title}`}>
          <div className="modal-head"><div><p className="kicker">{selectedVideo.kind === 'final' ? 'FINAL OUTPUT' : 'GENERATED CLIP'}</p><h2>{selectedVideo.title}</h2></div><button className="icon-button" onClick={() => setSelectedVideo(null)} aria-label="Close player"><X size={18} /></button></div>
          <video className="main-player" src={selectedVideo.mediaUrl} controls autoPlay playsInline />
          <div className="player-meta"><span>{selectedVideo.filename}</span><span>{formatBytes(selectedVideo.size)}{selectedVideo.duration ? ` · ${formatDuration(selectedVideo.duration)}` : ''}</span><button className="secondary-button" onClick={() => openInExplorer(selectedVideo.directory)}><FolderOpen size={15} /> Show in Explorer</button></div>
        </section>
      </div>}

      {queueOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setQueueOpen(false); }}>
        <section className="drawer-modal queue-modal" role="dialog" aria-modal="true" aria-label="Full generation queue">
          <div className="modal-head"><div><p className="kicker">GENERATION PLAN</p><h2>Queued jobs <span>{state?.queue.length || 0}</span></h2></div><button className="icon-button" onClick={() => setQueueOpen(false)} aria-label="Close queue"><X size={18} /></button></div>
          <div className="full-queue">
            {(state?.queue || []).map((item) => <div className="full-queue-item" key={`${item.section}-${item.slug}`}><i>{String(item.position).padStart(2, '0')}</i><div><b>{titleFromSlug(item.slug)}</b><span>{item.section.replace(/_/g, ' ')}</span></div><small>{item.count} shots</small></div>)}
            {state?.queue.length === 0 && <div className="empty-state"><Check size={28} /><h3>Queue complete</h3><p>There are no planned tracks waiting.</p></div>}
          </div>
        </section>
      </div>}

      {environmentOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setEnvironmentOpen(false); }}>
        <section className="environment-modal" role="dialog" aria-modal="true" aria-label="Environment and setup">
          <div className="modal-head environment-head">
            <div><p className="kicker">ENVIRONMENT DOCTOR</p><h2>Environment & setup</h2></div>
            <div className="environment-head-actions">
              <span className="read-only-badge"><ShieldCheck size={12} /> GUARDED SETUP</span>
              <button className="icon-button" onClick={() => loadEnvironment(true)} disabled={environmentLoading} aria-label="Rescan environment" title="Rescan environment"><RefreshCw size={16} className={environmentLoading ? 'spinning' : ''} /></button>
              <button className="icon-button" onClick={() => setEnvironmentOpen(false)} aria-label="Close environment"><X size={18} /></button>
            </div>
          </div>

          {environmentError && <div className="environment-error" role="alert"><CircleAlert size={16} /><span>{environmentError}</span></div>}
          {environmentLoading && !environment && <div className="environment-loading"><LoaderCircle size={24} className="spinning" /><b>Checking the local LTX environment…</b><span>The scan does not import CUDA or change files. Setup actions require an explicit confirmation and an idle render queue.</span></div>}

          {environment && <div className="environment-body">
            <section className={`environment-summary ${environment.summary.state}`}>
              <span className="summary-icon">{environment.summary.state === 'ready' ? <ShieldCheck size={24} /> : <CircleAlert size={24} />}</span>
              <div><p className="kicker">{environment.summary.state === 'ready' ? 'ALL CORE CHECKS PASSED' : environment.summary.state === 'missing' ? 'INSTALLATION REQUIRED' : 'REVIEW RECOMMENDED'}</p><h3>{environment.summary.title}</h3><span>{environment.summary.detail}</span></div>
              <div className="summary-meta"><small>COMFY ROOT</small><b title={environment.installation.root}>{environment.installation.root}</b><small>FREE SPACE</small><b>{environment.disk.freeGiB != null ? `${environment.disk.freeGiB} GB` : 'Unknown'}</b></div>
            </section>

            {environment.render.changesLocked && <div className="maintenance-lock"><Pause size={15} /><div><b>Maintenance changes are locked while rendering</b><span>Diagnostics and official links remain available. Do not update ComfyUI, packages, models, drivers, or GPU profiles until the current job stops.</span></div></div>}
            {(maintenancePending || environment.maintenance?.status === 'running') && <div className="maintenance-progress" role="status"><LoaderCircle size={15} className="spinning" /><div><b>{(maintenanceAction || environment.maintenance?.action) === 'update-comfyui-core' ? 'Updating ComfyUI Core' : (maintenanceAction || environment.maintenance?.action) === 'install-comfyui-blender' ? 'Configuring ComfyUI-Blender' : (maintenanceAction || environment.maintenance?.action) === 'install-sam3' ? 'Installing SAM 3.1' : 'Preparing guarded setup'}</b><span>{environment.maintenance?.stage || 'Validating the official integration…'}</span></div></div>}

            <div className="doctor-grid" aria-label="Environment checks">
              {environment.checks.map((check) => <article className={`doctor-card ${check.state}`} key={check.id}>
                <span>{check.state === 'ready' ? <Check size={15} /> : <CircleAlert size={15} />}</span>
                <div><small>{check.state === 'ready' ? 'READY' : check.state === 'missing' ? 'MISSING' : 'ATTENTION'}</small><b>{check.label}</b><p>{check.detail}</p></div>
              </article>)}
            </div>

            <div className="environment-detail-grid">
              <section className="environment-section">
                <div className="environment-section-head"><div><Server size={16} /><span><small>VERSION CONTROL</small><h3>Updates</h3></span></div><b>{environment.repositories.filter((repo) => repo.updateStatus === 'behind').length} available</b></div>
                <div className="repository-list">
                  {environment.repositories.map((repo) => <div className="repository-row" key={repo.id}>
                    <span className={`repo-status ${repo.updateStatus}`}>{repo.updateStatus === 'current' ? <Check size={13} /> : <RefreshCw size={13} />}</span>
                    <div><b>{repo.name}</b><small>{repo.updateStatus === 'behind' ? `${repo.behindBy} commits behind` : repo.updateStatus === 'current' ? 'Current upstream revision' : `Status: ${repo.updateStatus}`}{repo.dirty ? ' · local changes' : ''}{repo.trustRequired ? ' · trust confirmation required' : ''}</small></div>
                    <div className="repository-actions"><code>{shortHash(repo.localHead)} → {shortHash(repo.remoteHead)}</code>{repo.id === 'comfy' && repo.updateStatus === 'behind' && <button className="tool-setup-button" onClick={updateComfyCore} disabled={maintenancePending || environment.render.changesLocked || repo.dirty} title={repo.dirty ? 'Tracked local changes must be committed or restored before updating.' : 'Fast-forward official ComfyUI Core and install matching Python requirements.'}><RefreshCw size={11} /> Update core</button>}</div>
                  </div>)}
                  {!environment.repositories.length && <p className="section-empty">No Git-managed ComfyUI repositories were detected.</p>}
                </div>
              </section>

              <section className="environment-section">
                <div className="environment-section-head"><div><PackageCheck size={16} /><span><small>PYTHON ENVIRONMENT</small><h3>Dependencies</h3></span></div><b>{environment.python.version ? `Python ${environment.python.version}` : 'Not found'}</b></div>
                <div className="dependency-summary">
                  <div><span className={environment.python.pipHealthy ? 'ok' : 'warn'}>{environment.python.pipHealthy ? <Check size={14} /> : <CircleAlert size={14} />}</span><p><b>Package consistency</b><small>{environment.python.pipMessage}</small></p></div>
                  <div><span className={environment.python.localRequirements?.satisfied ? 'ok' : 'warn'}>{environment.python.localRequirements?.satisfied ? <Check size={14} /> : <CircleAlert size={14} />}</span><p><b>Current ComfyUI requirements</b><small>{environment.python.localRequirements?.satisfied ? `${environment.python.localRequirements.total} requirements satisfied` : `${environment.python.localRequirements?.missing.length || 0} missing · ${environment.python.localRequirements?.mismatched.length || 0} mismatched`}</small></p></div>
                  <div><span className={environment.python.latestRequirements?.satisfied ? 'ok' : 'warn'}>{environment.python.latestRequirements?.satisfied ? <Check size={14} /> : <RefreshCw size={14} />}</span><p><b>Latest core requirements</b><small>{environment.python.latestRequirements?.satisfied ? 'Already compatible with upstream' : environment.python.latestRequirements ? `${environment.python.latestRequirements.missing.length + environment.python.latestRequirements.mismatched.length} package changes expected with the update` : 'Could not check upstream requirements'}</small></p></div>
                </div>
                <div className="package-pills">{environment.python.packages.map((item) => <span key={item.name}>{item.name}<b>{item.version}</b></span>)}</div>
              </section>
            </div>

            <section className="environment-section gpu-section">
              <div className="environment-section-head"><div><Cpu size={16} /><span><small>HARDWARE PROFILE</small><h3>GPU setup policy</h3></span></div><b>{environment.runnerProfile.knownWorking ? 'Known working profile' : environment.runnerProfile.automationLevel === 'guided' ? 'Guided configuration' : 'Manual setup'}</b></div>
              <p className="section-description">{environment.runnerProfile.message}</p>
              <div className="gpu-audit-grid">
                {environment.gpus.map((gpu) => <article className={`gpu-audit-card ${gpu.role}`} key={gpu.device}>
                  <div><span>GPU {gpu.device}</span><b>{gpu.title}</b></div>
                  <h4>{gpu.name.replace('NVIDIA GeForce ', '')}</h4>
                  <p>{gpu.totalMemoryGb} GB VRAM · Compute {gpu.computeCapability} · Driver {gpu.driver}</p>
                  <div className="gpu-memory"><span style={{ width: `${Math.min(100, (gpu.memoryUsedMb / gpu.memoryTotalMb) * 100)}%` }} /></div>
                  <small>{gpu.recommendation}</small>
                </article>)}
                {!environment.gpus.length && <p className="section-empty">No NVIDIA GPU was detected. Use the official driver and PyTorch actions below.</p>}
              </div>
              {environment.runnerProfile.safeguards.length > 0 && <div className="profile-signals">{environment.runnerProfile.safeguards.map((item) => <span key={item}><Check size={12} />{profileSignal(item)}</span>)}{environment.runnerProfile.secondaryLtxEnabled === false ? <span><Check size={12} />12 GB LTX worker disabled</span> : null}</div>}
            </section>

            <section className="environment-section tools-section">
              <div className="environment-section-head"><div><Wrench size={16} /><span><small>OPTIONAL CAPABILITIES</small><h3>Useful ComfyUI tools</h3></span></div><b>Curated only</b></div>
              <div className="tool-grid">
                <article className="tool-card"><span className="tool-icon"><Sparkles size={18} /></span><div><small>NATIVE COMFYUI</small><h4>SAM 3.1 masks & tracking</h4><p>{environment.tools.sam3.detail}</p><div className="tool-card-actions"><span className={`tool-state ${environment.tools.sam3.state}`}>{environment.tools.sam3.state.replaceAll('-', ' ')}</span><button className="tool-setup-button" onClick={setupSam3} disabled={maintenancePending || environment.render.changesLocked || !environment.tools.sam3.automatedSetupSupported} title={!environment.tools.sam3.nativeInstalled ? 'Update ComfyUI core before installing the model.' : environment.tools.sam3.modelInstalled ? 'The SAM 3.1 checkpoint is already installed.' : 'Downloads and verifies the official 1.63 GiB checkpoint.'}>{maintenancePending ? <LoaderCircle size={12} className="spinning" /> : environment.tools.sam3.modelInstalled ? <Check size={12} /> : <Download size={12} />}{environment.tools.sam3.modelInstalled ? 'Installed' : 'Install model'}</button><a href={environment.tools.sam3.links.license} target="_blank" rel="noreferrer">License <ExternalLink size={12} /></a><a href={environment.tools.sam3.links.guide} target="_blank" rel="noreferrer">Guide <ExternalLink size={12} /></a></div></div></article>
                <article className="tool-card"><span className="tool-icon"><Film size={18} /></span><div><small>OFFICIAL LIGHTRICKS</small><h4>Advanced LTX nodes</h4><p>{environment.tools.ltxAdvanced.detail}</p><div><span className={`tool-state ${environment.tools.ltxAdvanced.installed ? 'ready' : 'optional'}`}>{environment.tools.ltxAdvanced.installed ? 'installed' : 'optional'}</span><a href={environment.tools.ltxAdvanced.url} target="_blank" rel="noreferrer">Review project <ExternalLink size={12} /></a></div></div></article>
                {environment.tools.comfyBlender && <article className="tool-card comfy-blender-card"><span className="tool-icon"><PackageCheck size={18} /></span><div><small>BLENDER BRIDGE</small><h4>ComfyUI-Blender</h4><p>{environment.tools.comfyBlender.detail}</p><div className="tool-card-actions"><span className={`tool-state ${environment.tools.comfyBlender.ready ? 'ready' : environment.tools.comfyBlender.state}`}>{environment.tools.comfyBlender.state.replaceAll('-', ' ')}</span><button className="tool-setup-button" onClick={setupComfyBlender} disabled={maintenancePending || environment.render.changesLocked || !environment.tools.comfyBlender.blenderDetected || !environment.tools.comfyBlender.supported}>{maintenancePending ? <LoaderCircle size={12} className="spinning" /> : <Download size={12} />}{environment.tools.comfyBlender.updateAvailable ? 'Update & configure' : environment.tools.comfyBlender.ready ? 'Reconfigure' : environment.tools.comfyBlender.customNodesInstalled && environment.tools.comfyBlender.addonInstalled ? 'Verify & configure' : 'Install & configure'}</button><a href={environment.tools.comfyBlender.projectUrl} target="_blank" rel="noreferrer">Project <ExternalLink size={12} /></a></div></div></article>}
              </div>
            </section>

            {environment.warnings.length > 0 && <section className="warning-list" aria-label="Environment warnings">{environment.warnings.map((warning) => <div key={warning}><CircleAlert size={14} /><span>{warning}</span></div>)}</section>}

            <section className="official-actions">
              <div><p className="kicker">SAFE NEXT STEPS</p><h3>Official setup actions</h3><span>Links open verified upstream pages. Automated setup requires confirmation and an idle renderer/queue; Blender setup also requires Blender to be closed.</span></div>
              <div>{environment.actions.map((action) => <a className={action.kind === 'primary' ? 'primary-button' : 'secondary-button'} href={action.url} target="_blank" rel="noreferrer" key={action.id} title={action.reason}>{action.kind === 'primary' ? <Download size={14} /> : <ExternalLink size={14} />}{action.label}</a>)}</div>
            </section>
          </div>}
        </section>
      </div>}

      {settingsOpen && settings && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
        <section className="drawer-modal settings-modal" role="dialog" aria-modal="true" aria-label="Monitor settings">
          <div className="modal-head"><div><p className="kicker">LOCAL SOURCES</p><h2>Monitor settings</h2></div><button className="icon-button" onClick={() => setSettingsOpen(false)} aria-label="Close settings"><X size={18} /></button></div>
          <p className="settings-intro">Point the monitor at your ComfyUI/LTX folders and status files. Changes stay on this computer.</p>
          <div className="settings-fields">
            {([
              ['displayName', 'Display name'],
              ['modelLabel', 'Model label'], ['workerCommandFragment', 'Worker command match'], ['recoveryScript', 'Recovery restart script'], ['studioSourceRunner', 'Studio source runner'],
              ['comfyRoot', 'ComfyUI root'], ['finalsDirectory', 'Final videos folder'], ['clipsDirectory', 'Generated clips folder'],
              ['logFile', 'Progress log'], ['statusFile', 'Worker status JSON'], ['planFile', 'Queue plan JSON'], ['comfyUrl', 'ComfyUI address'],
            ] as const).map(([key, label]) => <label key={key}><span>{label}</span><input value={settings[key]} onChange={(event) => setSettings({ ...settings, [key]: event.target.value })} /></label>)}
            <div className="settings-row"><label><span>Studio GPU</span><input type="number" min="0" max="15" value={settings.studioGpu} onChange={(event) => setSettings({ ...settings, studioGpu: Number(event.target.value) })} /></label><label><span>Studio port</span><input type="number" min="1024" max="65535" value={settings.studioPort} onChange={(event) => setSettings({ ...settings, studioPort: Number(event.target.value) })} /></label></div>
            <div className="settings-row"><label><span>Refresh every</span><div className="input-unit"><input type="number" min="2" max="60" value={settings.refreshSeconds} onChange={(event) => setSettings({ ...settings, refreshSeconds: Number(event.target.value) })} /><i>seconds</i></div></label><label><span>Max videos</span><input type="number" min="20" max="500" value={settings.maxVideos} onChange={(event) => setSettings({ ...settings, maxVideos: Number(event.target.value) })} /></label></div>
          </div>
          <div className="settings-actions"><button className="secondary-button" onClick={() => setSettingsOpen(false)}>Cancel</button><button className="primary-button" onClick={saveSettings}>Save & reconnect</button></div>
        </section>
      </div>}

      {toast && <div className="toast" role="status"><Check size={15} />{toast}</div>}
    </main>
  );
}
