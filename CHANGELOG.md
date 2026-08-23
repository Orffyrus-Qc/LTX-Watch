# Changelog

All notable changes to LTX / Watch are documented here.

## 1.4.0 — Studio branch

### Added

- LTX Watch Studio workspace for sequential, human-reviewed shot generation.
- Per-shot correction notes, regenerate-until-accepted workflow, and automatic advance after acceptance.
- Playable attempt history with rejected outputs archived instead of deleted.
- Persistent Studio queue ordering with a **Move first** action for any waiting scene.
- A dedicated single-shot Python adapter that reuses a compatible local album runner without placing prompt text in process command lines.
- Separate `npm run dev:studio` launch on ports 3001/4312 for isolated testing beside Watch.
- Safety locks that refuse Studio generation while the album worker, ComfyUI port, or another Studio job is active.
- Local Project Library with reference-in-place and managed-copy folder imports.
- Visual shot/version indexing, multi-select acceptance and review controls, project/context uploads, and per-shot context attachments.
- Persistent selective-regeneration queue that reuses Studio's guarded single-shot adapter and can pause safely between shots.
- First-class Blender and 3D project assets with a designated master backbone scene for shared camera, animation blocking, and spatial continuity.
- Range-enabled project media previews and Explorer actions constrained to registered local roots.
- Guarded **Install model** button for native SAM 3.1 with explicit license confirmation, idle-state locking, official Comfy-Org download, pinned size/SHA-256 verification, backup, and failure cleanup.

### Fixed

- SAM 3.1 checkpoint verification now works even when the installer process cannot auto-load PowerShell's `Get-FileHash` command.

## 1.3.0 — 2026-08-23

### Added

- Read-only detection of built-in, legacy, pending, and migration-ready ComfyUI Manager states.
- Guarded, authenticated, idle-only migration to ComfyUI's built-in Manager using the official `manager_requirements.txt`.
- Recognized-launcher backup and `--enable-manager` configuration, plus clean legacy-node archival and file rollback.

### Changed

- Environment maintenance now supports separate allowlisted Manager and Blender actions.
- MSI staging and AI maintainer guidance include the Manager adapter.

## 1.2.0 — 2026-08-23

### Added

- Guarded one-click ComfyUI-Blender installation, update, enablement, and loopback server configuration.
- Blender 5/latest-release and Blender 4.5/v3.3.4 compatibility selection.
- Official release checksum verification, existing-install backup, failure rollback, dirty-checkout protection, progress state, and restart-required reporting.
- Authenticated, confirmation-gated, idle-only `/api/environment/maintenance` endpoint.
- Environment Doctor detection for Blender, both integration halves, saved configuration, and available compatible updates.

### Changed

- MSI staging now includes the ComfyUI-Blender maintenance adapter and PowerShell installer.
- Maintenance safety now locks on both running and pending ComfyUI queue items.

## 1.1.0 — 2026-08-23

### Added

- Read-only Environment & Setup center for ComfyUI, LTX 2.5 model components, Python packages, official upstream revisions, disk space, FFmpeg, and NVIDIA GPUs.
- Distinct detection for ComfyUI-based LTX and the optional standalone LTX Desktop application.
- Render-aware maintenance lock that keeps diagnostics available but blocks unsafe update/setup expectations during active generation.
- Official allowlisted installation, update, model, driver, and optional-tool links.
- Native SAM 3.1 node/model readiness and official advanced LTX node guidance.
- Guarded multi-GPU role recommendations and detection of external-runner safeguards without importing CUDA or rewriting the runner.
- Automated tests for dependency parsing, version comparison, and GPU role selection.

### Changed

- MSI staging now includes the environment audit adapter.
- Maintainer documentation now defines the environment audit contract and future LTX update workflow.

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
