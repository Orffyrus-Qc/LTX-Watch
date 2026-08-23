'use client';

import {
  Aperture,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  ExternalLink,
  Film,
  FolderOpen,
  Gauge,
  HardDrive,
  History,
  ListVideo,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  TimerReset,
  X,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

const API_BASE = 'http://127.0.0.1:4311';

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
  const [queueOpen, setQueueOpen] = useState(false);
  const [settings, setSettings] = useState<Config | null>(null);
  const [filter, setFilter] = useState<'all' | 'final' | 'clip'>('final');
  const [search, setSearch] = useState('');
  const [visibleCount, setVisibleCount] = useState(9);
  const [toast, setToast] = useState('');

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
      if (event.key === 'Escape') { setSelectedVideo(null); setSettingsOpen(false); setQueueOpen(false); }
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
        <button className="brand" onClick={() => document.getElementById('overview')?.scrollIntoView({ behavior: 'smooth' })}>
          <span className="brand-mark"><Aperture size={17} /></span><span>LTX / WATCH</span>
        </button>
        <nav aria-label="Main navigation">
          <button className="nav-item active" onClick={() => document.getElementById('overview')?.scrollIntoView({ behavior: 'smooth' })}><Gauge size={18} />Overview</button>
          <button className="nav-item" onClick={() => document.getElementById('history')?.scrollIntoView({ behavior: 'smooth' })}><History size={18} />History</button>
          <button className="nav-item" onClick={() => setQueueOpen(true)}><ListVideo size={18} />Queue <span className="nav-count">{state?.queue.length || 0}</span></button>
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
          <div><p className="kicker">LOCAL GENERATION MONITOR</p><h1>{greeting}, {state?.config.displayName || 'Creator'}.</h1></div>
          <div className="header-actions">
            <button className="icon-button" onClick={() => loadState()} aria-label="Refresh data" title="Refresh data"><RefreshCw size={16} className={refreshing ? 'spinning' : ''} /></button>
            <button className="secondary-button" onClick={() => state?.config.finalsDirectory && openInExplorer(state.config.finalsDirectory)}><FolderOpen size={15} /> Open outputs</button>
            <button className={`control-button ${isPaused ? 'resume' : 'pause'}`} onClick={toggleGenerator} disabled={!state?.control?.canControl || controlPending} title={recoveryRequired ? 'Restart the interrupted shot from the beginning' : isPaused ? 'Resume the suspended LTX worker' : 'Suspend the active LTX worker and its ComfyUI subprocesses'}>
              {controlPending ? <LoaderCircle size={15} className="spinning" /> : isPaused ? <Play size={15} fill="currentColor" /> : <Pause size={15} fill="currentColor" />}
              <span>{controlPending ? 'Working…' : recoveryRequired ? 'Retry interrupted shot' : isPaused ? 'Resume render' : 'Pause render'}</span>
            </button>
            <div className={`sync ${error ? 'sync-error' : ''}`}><span className="status-dot" /> {error ? 'BRIDGE OFFLINE' : 'LIVE · AUTO REFRESH'}</div>
          </div>
        </header>

        {error && <div className="error-banner" role="alert"><CircleAlert size={16} /><span><strong>Local bridge unavailable.</strong> Start the monitor with <code>npm run dev</code> and this page will reconnect automatically.</span></div>}

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

        <footer><span>LTX / WATCH</span><p>Private local monitor · Your files never leave this computer.</p><button onClick={() => setSettingsOpen(true)}>Configure sources <ExternalLink size={12} /></button></footer>
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

      {settingsOpen && settings && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
        <section className="drawer-modal settings-modal" role="dialog" aria-modal="true" aria-label="Monitor settings">
          <div className="modal-head"><div><p className="kicker">LOCAL SOURCES</p><h2>Monitor settings</h2></div><button className="icon-button" onClick={() => setSettingsOpen(false)} aria-label="Close settings"><X size={18} /></button></div>
          <p className="settings-intro">Point the monitor at your ComfyUI/LTX folders and status files. Changes stay on this computer.</p>
          <div className="settings-fields">
            {([
              ['displayName', 'Display name'],
              ['modelLabel', 'Model label'], ['workerCommandFragment', 'Worker command match'], ['recoveryScript', 'Recovery restart script'],
              ['comfyRoot', 'ComfyUI root'], ['finalsDirectory', 'Final videos folder'], ['clipsDirectory', 'Generated clips folder'],
              ['logFile', 'Progress log'], ['statusFile', 'Worker status JSON'], ['planFile', 'Queue plan JSON'], ['comfyUrl', 'ComfyUI address'],
            ] as const).map(([key, label]) => <label key={key}><span>{label}</span><input value={settings[key]} onChange={(event) => setSettings({ ...settings, [key]: event.target.value })} /></label>)}
            <div className="settings-row"><label><span>Refresh every</span><div className="input-unit"><input type="number" min="2" max="60" value={settings.refreshSeconds} onChange={(event) => setSettings({ ...settings, refreshSeconds: Number(event.target.value) })} /><i>seconds</i></div></label><label><span>Max videos</span><input type="number" min="20" max="500" value={settings.maxVideos} onChange={(event) => setSettings({ ...settings, maxVideos: Number(event.target.value) })} /></label></div>
          </div>
          <div className="settings-actions"><button className="secondary-button" onClick={() => setSettingsOpen(false)}>Cancel</button><button className="primary-button" onClick={saveSettings}>Save & reconnect</button></div>
        </section>
      </div>}

      {toast && <div className="toast" role="status"><Check size={15} />{toast}</div>}
    </main>
  );
}
