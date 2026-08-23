# Changelog

All notable changes to LTX / Watch are documented here.

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
