'use client';

import {
  ArrowUpToLine,
  Check,
  ChevronRight,
  CircleAlert,
  Clapperboard,
  Film,
  LoaderCircle,
  LockKeyhole,
  Play,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import { useMemo, useState } from 'react';

export type StudioVideo = {
  id: string;
  title: string;
  filename: string;
  kind: 'clip';
  size: number;
  modifiedAt: string;
  mediaUrl: string;
  directory: string;
  duration?: number;
  width?: number;
  height?: number;
  codec?: string;
};

type StudioQueueItem = {
  sceneKey: string;
  position: number;
  section: string;
  track: string;
  slug: string;
  count: number;
  shots: string;
  studioStatus: string;
  acceptedCount: number;
};

type StudioAttempt = {
  id: string;
  status: string;
  correction: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  imported: boolean;
  video: StudioVideo | null;
};

export type StudioView = {
  enabled: boolean;
  adapterReady: boolean;
  canGenerate: boolean;
  blockedReason: string | null;
  activeJob: null | { sceneKey: string; shot: string; startedAt: string };
  queue: StudioQueueItem[];
  selectedScene: null | StudioQueueItem & {
    currentShot: string | null;
    acceptedCount: number;
    status: string;
    shots: { shot: string; status: 'accepted' | 'generating' | 'review' | 'ready' | 'queued'; hasOutput: boolean }[];
    reviewVideo: StudioVideo | null;
    attempts: StudioAttempt[];
  };
};

type Props = {
  studio?: StudioView;
  token?: string;
  apiBase: string;
  onRefresh: () => Promise<void>;
  onToast: (message: string) => void;
  onPlay: (video: StudioVideo) => void;
};

function displayName(value: string) {
  return value.replace(/_full$/i, '').replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function when(value: string | null) {
  if (!value) return 'Pending';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}

export default function StudioWorkspace({ studio, token, apiBase, onRefresh, onToast, onPlay }: Props) {
  const [correction, setCorrection] = useState('');
  const [pendingAction, setPendingAction] = useState('');
  const selected = studio?.selectedScene;
  const currentShot = selected?.currentShot || null;

  const shotPosition = useMemo(() => {
    const index = selected?.shots.findIndex((item) => item.shot === currentShot) ?? -1;
    return index >= 0 ? index + 1 : 0;
  }, [selected?.shots, currentShot]);

  async function studioAction(action: string, extra: Record<string, unknown> = {}) {
    if (!token || pendingAction) return;
    setPendingAction(action);
    try {
      const response = await fetch(`${apiBase}/api/studio`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-LTX-Control-Token': token },
        body: JSON.stringify({ action, sceneKey: selected?.sceneKey, shot: currentShot, ...extra }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Studio action failed');
      onToast(action === 'move-first'
        ? 'Scene moved to the front of the Studio queue'
        : action === 'accept'
          ? 'Shot accepted — advanced to the next shot'
          : action === 'generate'
            ? 'Single-shot generation started in the background'
            : 'Studio scene selected');
      if (action === 'generate' || action === 'accept') setCorrection('');
      await onRefresh();
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Studio action failed');
    } finally {
      setPendingAction('');
    }
  }

  async function selectScene(item: StudioQueueItem) {
    if (!token || pendingAction || item.sceneKey === selected?.sceneKey) return;
    setPendingAction(`select:${item.sceneKey}`);
    try {
      const response = await fetch(`${apiBase}/api/studio`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-LTX-Control-Token': token },
        body: JSON.stringify({ action: 'select', sceneKey: item.sceneKey }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not select the scene');
      setCorrection('');
      await onRefresh();
    } catch (error) {
      onToast(error instanceof Error ? error.message : 'Could not select the scene');
    } finally {
      setPendingAction('');
    }
  }

  if (!studio) {
    return <section className="studio-loading"><LoaderCircle className="spinning" size={24} /><span>Loading Studio workspace…</span></section>;
  }

  return (
    <section className="studio-workspace" id="studio">
      <div className="studio-heading">
        <div><p className="kicker">HUMAN-IN-THE-LOOP GENERATION</p><h2>LTX Watch Studio</h2><p>Render one shot, review it, describe corrections, and advance only when you accept the result.</p></div>
        <div className={`studio-readiness ${studio.canGenerate ? 'ready' : ''}`}>
          {studio.canGenerate ? <Sparkles size={16} /> : <LockKeyhole size={16} />}
          <span><small>{studio.canGenerate ? 'STUDIO READY' : studio.activeJob ? 'SHOT RENDERING' : 'STUDIO WAITING'}</small><b>{studio.canGenerate ? 'GPU and port are available' : studio.blockedReason || 'Checking local runner'}</b></span>
        </div>
      </div>

      <div className="studio-grid">
        <aside className="studio-scenes">
          <div className="studio-panel-head"><span>SCENE QUEUE</span><b>{studio.queue.length}</b></div>
          <div className="studio-scene-list">
            {studio.queue.map((item) => {
              const active = item.sceneKey === selected?.sceneKey;
              return <div className={`studio-scene ${active ? 'selected' : ''}`} key={item.sceneKey}>
                <button className="studio-scene-main" onClick={() => selectScene(item)}>
                  <i>{String(item.position).padStart(2, '0')}</i>
                  <span><b>{displayName(item.slug)}</b><small>{item.acceptedCount}/{item.count} accepted · {item.section.replace(/_/g, ' ')}</small></span>
                  <ChevronRight size={14} />
                </button>
                <button className="move-first" onClick={() => studioAction('move-first', { sceneKey: item.sceneKey })} disabled={item.position === 1 || Boolean(pendingAction)} aria-label={`Move ${displayName(item.slug)} first in queue`} title="Move first in Studio queue"><ArrowUpToLine size={13} /></button>
              </div>;
            })}
            {!studio.queue.length && <div className="studio-empty-mini"><Check size={22} /><b>Studio queue complete</b><span>Every available scene has been accepted or assembled.</span></div>}
          </div>
        </aside>

        <div className="studio-review">
          {selected ? <>
            <div className="studio-review-head">
              <div><span>REVIEWING SCENE</span><h2>{displayName(selected.slug)}</h2><p>{selected.section.replace(/_/g, ' ')} · Shot {shotPosition} of {selected.shots.length}</p></div>
              <button className="secondary-button" onClick={() => studioAction('move-first')} disabled={selected.position === 1 || Boolean(pendingAction)}><ArrowUpToLine size={14} /> Move scene first</button>
            </div>

            <div className={`studio-player ${selected.reviewVideo ? '' : 'empty'}`}>
              {selected.reviewVideo
                ? <video key={selected.reviewVideo.id} src={selected.reviewVideo.mediaUrl} controls playsInline preload="metadata" />
                : <div><span className="studio-shot-number">{currentShot || '—'}</span>{studio.activeJob ? <LoaderCircle size={30} className="spinning" /> : <Clapperboard size={30} />}<b>{studio.activeJob ? `Generating shot ${studio.activeJob.shot}` : 'No review output yet'}</b><p>{studio.activeJob ? 'Studio will show the video here as soon as LTX finishes.' : 'Generate this shot to begin the review loop.'}</p></div>}
              {selected.reviewVideo && <button className="studio-popout" onClick={() => onPlay(selected.reviewVideo!)}><Play size={13} fill="currentColor" /> Open large player</button>}
            </div>

            <div className="studio-correction">
              <div><label htmlFor="studio-correction">NON-SPOKEN DIRECTOR NOTE</label><span>{correction.length}/2000</span></div>
              <textarea id="studio-correction" value={correction} maxLength={2000} onChange={(event) => setCorrection(event.target.value)} placeholder="Example: slow the camera drift, keep the face perfectly stable, and reduce the light flicker…" disabled={Boolean(studio.activeJob)} />
              <p>The note guides performance and staging but is never spoken or shown. For exact speech, begin a separate line with <b>DIALOGUE:</b></p>
            </div>

            <div className="studio-actions">
              <button className="studio-regenerate" onClick={() => studioAction('generate', { correction })} disabled={!studio.canGenerate || Boolean(pendingAction) || !currentShot}>
                {pendingAction === 'generate' || studio.activeJob ? <LoaderCircle className="spinning" size={16} /> : selected.reviewVideo ? <RotateCcw size={16} /> : <Sparkles size={16} />}
                {studio.activeJob ? 'Generating…' : selected.reviewVideo ? 'Regenerate shot' : 'Generate shot'}
              </button>
              <button className="studio-accept" onClick={() => studioAction('accept')} disabled={!selected.reviewVideo || Boolean(pendingAction) || Boolean(studio.activeJob)}><Check size={16} /> Accept & next shot</button>
            </div>

            {selected.attempts.length > 0 && <div className="studio-attempts">
              <div className="studio-panel-head"><span>ATTEMPT HISTORY · SHOT {currentShot}</span><b>{selected.attempts.length}</b></div>
              {selected.attempts.map((attempt, index) => <div className={`studio-attempt ${attempt.status}`} key={attempt.id}>
                <i>{String(selected.attempts.length - index).padStart(2, '0')}</i>
                <span><b>{attempt.imported ? 'Existing output' : attempt.correction || 'Original motion prompt'}</b><small>{attempt.error || `${attempt.status} · ${when(attempt.completedAt || attempt.startedAt)}`}</small></span>
                {attempt.video && <button onClick={() => onPlay(attempt.video!)} aria-label="Play this attempt"><Play size={13} fill="currentColor" /></button>}
              </div>)}
            </div>}
          </> : <div className="studio-empty"><Film size={34} /><h2>No queued scene available</h2><p>Studio will populate from the configured generation plan when scenes are waiting.</p></div>}
        </div>

        <aside className="studio-shots">
          <div className="studio-panel-head"><span>SHOT REVIEW</span><b>{selected?.acceptedCount || 0}/{selected?.shots.length || 0}</b></div>
          <div className="studio-shot-list">
            {(selected?.shots || []).map((item, index) => <div className={`studio-shot ${item.status} ${item.shot === currentShot ? 'current' : ''}`} key={item.shot}>
              <i>{String(index + 1).padStart(2, '0')}</i><span><b>Shot {item.shot}</b><small>{item.status === 'review' ? 'Awaiting approval' : item.status}</small></span>
              {item.status === 'accepted' ? <Check size={14} /> : item.status === 'generating' ? <LoaderCircle size={14} className="spinning" /> : <span className="shot-state" />}
            </div>)}
          </div>
          {!studio.adapterReady && <div className="studio-adapter-warning"><CircleAlert size={15} /><span><b>Adapter unavailable</b>Check the Studio source runner in Settings.</span></div>}
        </aside>
      </div>
    </section>
  );
}
