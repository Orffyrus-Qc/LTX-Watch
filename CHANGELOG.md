# Changelog

All notable changes to LTX / Watch are documented here.

## Unreleased — `feature/continuity-memory`

### Added

- Overview **Pause after current** control. It keeps the existing immediate **Pause render** behavior and, when armed, lets the active album job finish, then suspends the worker so the next queued job does not start.
- Pause controls stay available while the album worker process is still alive, even if the supervisor status timestamp is stale.
- Starting LTX Watch now waits for the local bridge to become healthy before opening the UI, and keeps the bridge running if the UI is already open.
- README screenshots for Overview (including Pause after current), Create, Director timeline, context intake, and Projects.
- Experimental **Create** workspace for original local LTX 2.5 text-to-video, first-frame, and first/last-frame generation using ComfyUI's official full-workflow templates.
- Private persistent drafts, one-to-four variation queue, random/fixed seeds, prompt enhancement, format, camera, motion, style, audio, progress, history, playback, Explorer, retry, pause-between-jobs, and **Move first** controls.
- Unified drag-and-drop context intake for images, video, songs, and `.blend` scenes, with private chunked uploads, video frame extraction, final-soundtrack replacement, and optional Blender-backed anchors.
- Guarded workflow compiler that resolves semantic subgraph inputs and current ComfyUI node schemas without hardcoding template node IDs.
- Shared generation launch claim across Create, Studio, and Projects regeneration, backed by the existing upstream ComfyUI port lock.
- Separate **Physics authority** mode for Blender-backed Create jobs. It prepares versioned beauty, depth, surface-normal, motion-vector, and per-frame camera passes while declaring Blender as the sole animation authority.
- The full-frame mode is now exposed directly as **Blender animation** in Visual Backbone, separate from the creative first/end-frame option, so a queued job clearly records whether Blender owns the complete animation.
- Completed **Generated from scratch** videos can be renamed in place from their history card. The local filename and displayed title change together, with Windows-safe normalization and collision protection.
- A fixed-purpose background Blender adapter with sequential physics evaluation, job-scoped progress/cancellation, immutable master scenes, and reviewable backbone-package history.
- Explicit LTX 2.5 refinement gate: strict physics packages remain preparation-only until a verified 2.5 adapter consumes every structural pass without inventing or retiming motion.
- Capability-gated **Director timeline** with a persistent global continuity prompt, two-to-eight timed action segments, private Ingredients reference sheet, IC-LoRA strength, transition epsilon, setup diagnostics, and truthful upstream limitations.
- Recursive ComfyUI subgraph compilation plus a verified Prompt Relay patch that routes timed conditioning through Lightricks' official LTX 2.5 Ingredients guide and the patched model to sampling without hardcoded node IDs.
- Persistent project **Continuity Bible** with canonical world, look, invariants, negative rules, reusable elements, local asset relationships, revisions, and defensive schema-v2 migration.
- Open-ended long-scene planning with 5–20 second clips, review gates, Create preparation, linked render status/history, and reusable server-built prompts.
- Accepted-ending visual handoffs: approval extracts the final decoded frame, and the next continuous clip uses it as the official I2V first-frame input; first clips and new cuts use the canonical Director Ingredients sheet.

### Security

- Create prompts and local paths live only in ignored state/runtime JSON; process arguments contain only the private job path.
- The browser cannot supply workflow graphs, workflow paths, output prefixes, model files, Python/Blender scripts, executables, or arbitrary command arguments.
- Blender automation validates a registered or privately uploaded `.blend`, copies it before rendering, disables auto-execution, and uses fixed background-render arguments without touching the source.
- Physics jobs accept no browser-supplied script, executable, workflow, output path, or command arguments; the authenticated bridge builds and launches the bundled adapter only after all normal worker and port locks are clear.

### Fixed

- The development server no longer watches private Create, Projects, or Studio runtime files, preventing Windows `EBUSY` crashes when an uploaded Ingredients image is still locked during generation setup.
- Director now compiles the current official Ingredients workflow's UI reroutes, notes, and obsolete unconsumed subgraph inputs; reconciles transformer, projected text-encoder, and prompt-enhancer model roles independently; preserves native LTX audio/video conditioning metadata while Prompt Relay patches the sampler model; and reports incompatible Kornia installations before queueing. A private idle-GPU smoke render completed successfully against the verified public dependency set.
- Long-scene plans now split 13–20 second Director actions into valid bounded segments, and stale browser saves preserve newer queued, generating, review, accepted, failed, output, and anchor state.

- Recovery-launched album workers now run through an app-owned recursive hidden-process adapter, preventing short-lived ComfyUI, Python, and FFmpeg console flashes from descendant processes on Windows.
- Assembled finals now use a lazily prepared, idle-only continuous H.264 browser cache. This removes Chromium flashes at stream-copy shot boundaries without changing the original scene file.
- Dashboard GPU utilization and VRAM now come from live `nvidia-smi` sampling instead of a frozen supervisor-file snapshot; legacy snapshot data is labeled and used only as a fallback.
- Create now protects the prompt-enhancer model role during official-template reconciliation. A stale `gemma4_e2b_it_*` enum resolves only to the dedicated installed enhancer and can no longer be replaced by the main projected LTX text encoder, which previously caused enhancement-enabled prompts to drift away from the request.
- Active Create renders can be canceled through an authenticated private marker. The owning runner interrupts only its isolated ComfyUI server, releases its lock, records a distinct Canceled state, and permits a clean Retry.
- Completed Create cards can move their generated video to the Windows Recycle Bin after confirmation; the history record is removed only after the recoverable file operation succeeds.
- Windows Recycle Bin deletion now passes the video path outside the PowerShell command expression, so drive-letter paths cannot be parsed as code.
- Create and Studio now force no-window process creation for descendant ComfyUI, Blender, FFmpeg, and helper processes, preventing background Python console popups.
- First-frame and first/last-frame Create jobs now stage unique root-level ComfyUI inputs, preserve upload selectors exactly instead of reconciling them as model enums, and remove the staged copies after generation.

## 1.4.0 — 2026-08-23

### Added

- Guarded **Update core** action for official ComfyUI Git checkouts with exact-path Git trust, tracked-change and divergence locks, fast-forward-only updates, matching Python requirements, validation, restart notice, and rollback.
- Projects regeneration queue progress with live render stage, percentage, elapsed time, and estimated remaining time derived from existing Studio logs.
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

### Changed

- Studio and Projects are now part of the official application rather than a separate test branch.
- ComfyUI Manager integration and its project dependency were removed; LTX Watch now uses narrow, guarded maintenance adapters for supported actions.

### Fixed

- Correction notes are now isolated as non-spoken director metadata, preventing characters, narration, captions, or screens from repeating production instructions; explicit `DIALOGUE:` lines remain available for intended speech.
- Studio-launched ComfyUI subprocesses no longer open a visible Python console window on Windows.
- Shot regeneration can now archive an existing ComfyUI output when the output and LTX Watch history folders are on different Windows drives.
- Completed source scenes can now be mapped for one-shot project regeneration even after the active remaining-work plan has dropped them.
- Project correction and review controls now clearly separate queueing a regeneration from approving the current result; reference-only shots show why they have no compatible source mapping.
- Projects now renders shots in batches and mounts media previews only near the viewport, preventing large libraries from freezing browser scrolling.
- SAM 3.1 checkpoint verification now works even when the installer process cannot auto-load PowerShell's `Get-FileHash` command.
- ComfyUI-Blender release verification uses the same module-independent .NET SHA-256 path.
- ComfyUI-Blender setup receipts now recognize equivalent Blender versions such as `5.2` and `5.2.0`.
- Active selective-regeneration progress is now visible at the top of Projects instead of only inside the queue panel below the fold.

## 1.3.0 — 2026-08-23

### Added

- Read-only detection of built-in, legacy, pending, and migration-ready ComfyUI Manager states.
- Guarded migration to ComfyUI's built-in Manager, later removed in 1.4.0 in favor of narrower maintenance adapters.

### Changed

- Environment maintenance supported separate Manager and Blender actions in this release.

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
