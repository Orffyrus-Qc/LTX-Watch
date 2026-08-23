# Changelog

All notable changes to LTX / Watch are documented here.

## 1.1.0 — Studio branch

### Added

- LTX Watch Studio workspace for sequential, human-reviewed shot generation.
- Per-shot correction notes, regenerate-until-accepted workflow, and automatic advance after acceptance.
- Playable attempt history with rejected outputs archived instead of deleted.
- Persistent Studio queue ordering with a **Move first** action for any waiting scene.
- A dedicated single-shot Python adapter that reuses a compatible local album runner without placing prompt text in process command lines.
- Separate `npm run dev:studio` launch on ports 3001/4312 for isolated testing beside Watch.
- Safety locks that refuse Studio generation while the album worker, ComfyUI port, or another Studio job is active.

## 1.0.2 — 2026-08-23

### Fixed

- Start interrupted-shot recovery with Windows' background Python launcher so Resume does not leave a black console window open.

## 1.0.1 — 2026-08-23

### Fixed

- Detect paused worker records that became stale after a Windows restart or worker exit.
- Replace impossible native resume with an explicit interrupted-shot recovery action.
- Archive any interrupted-shot video and restart that same shot from the beginning while preserving earlier completed shots.
- Ignore stale status-file PIDs and report recovery state clearly in the dashboard.

## 1.0.0 — 2026-08-22

### Added

- Live LTX/ComfyUI job dashboard with active track, shot, progress, timing, queue, GPU telemetry, and activity.
- Searchable final-video and raw-clip library with local browser playback.
- Range-enabled local media streaming and Windows Explorer actions.
- Persistent Windows process-tree pause/resume with command-line verification and paused-time accounting.
- Editable local settings and common ComfyUI path auto-detection.
- Legacy `/queue` and newer `/api/queue` ComfyUI route support.
- Configurable model label and worker command fragment for future LTX releases.
- Public documentation, compatibility contract, and AI maintainer instructions.
- Self-contained per-user MSI packaging with a bundled Node.js runtime and Windows shortcuts.
