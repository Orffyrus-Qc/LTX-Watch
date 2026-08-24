# AGENTS.md — LTX / Watch maintainer instructions

These instructions apply to the entire repository. Human instructions in the current task take precedence.

## Mission

Maintain a safe, local-first monitoring dashboard for LTX Video jobs running through ComfyUI. Preserve three user promises:

1. Generated media and machine details stay local.
2. Monitoring never interferes with an active render.
3. Pause/resume is reversible and targets only the verified generator process tree.

## Read first

Before changing compatibility behavior, read these files in order:

1. `README.md`
2. `docs/LTX_COMPATIBILITY.md`
3. `docs/AI_MAINTAINER_GUIDE.md`
4. `local-server.mjs`
5. `lib/environment-audit.mjs`
6. `app/dashboard.tsx`
7. `scripts/process-orchestrator.ps1`

Use official upstream sources when investigating LTX or ComfyUI changes:

- `https://github.com/Lightricks/LTX-2`
- `https://github.com/Lightricks/ComfyUI-LTXVideo`
- `https://github.com/Comfy-Org/ComfyUI`
- `https://github.com/Comfy-Org/ComfyUI/blob/master/openapi.yaml`

Do not rely on blog posts or copied endpoint lists when the upstream source or OpenAPI specification is available.

## Hard safety rules

- Never call the real `/api/control` pause/resume action during an automated check.
- Never call a real `/api/studio` generate action during an automated check. Use the fixture runner under `tests/fixtures`.
- Never enqueue a mapped shot through `/api/projects` during an automated or live UI check; a queued item may start a real Studio generation when the GPU is idle.
- Never enqueue through `/api/create` or press **Queue creation** during an automated or live UI check; an authorized Create item may start a real local LTX workflow when the GPU becomes idle.
- Never suspend, interrupt, terminate, restart, or clear a real ComfyUI/LTX job unless the user explicitly asks for that action.
- Test `process-orchestrator.ps1` only against a temporary process created for the test.
- Never replace pause/resume with process termination or ComfyUI `/interrupt` without explicit user approval and a documented migration.
- Keep the local bridge bound to `127.0.0.1`. Do not change it to `0.0.0.0`.
- Keep `/api/environment` read-only and safe while a real render is active. A live worker or running/pending ComfyUI queue item must lock maintenance guidance.
- Keep `/api/environment/maintenance` token-protected, confirmation-gated, and limited to allowlisted actions. Revalidate that workers and both running/pending ComfyUI queues are idle immediately before changing files.
- Never invoke the real `install-sam3` maintenance action during automated validation; it downloads a licensed 1.63 GiB checkpoint.
- Preserve the per-session `X-LTX-Control-Token` check.
- Validate decoded media and Explorer paths against configured roots before access.
- Keep `local.config.json`, `.env*`, generated media, logs, status files, queue plans, and `orchestrator.state.json` out of Git.
- Keep `studio.state.json`, `.ltx-watch-studio`, Studio prompt jobs, corrections, and attempt media out of Git.
- Keep `projects.state.json`, `.ltx-watch-projects`, project uploads, context relationships, private paths, and regeneration notes out of Git.
- Keep `create.state.json`, `.ltx-watch-create`, Create prompts, references, Blender working copies, result files, and runner logs out of Git.
- Never commit absolute paths, usernames, tokens, prompts, generated media, or real job IDs from a user's machine.
- Do not expose the control token in logs, persistent files, URLs, or error messages.
- Preserve HTTP range support in `/media/:id`; browser playback depends on it.

## Architecture boundaries

### `app/dashboard.tsx`

Owns rendering and browser interactions. It consumes the `/api/state` contract and must not directly access ComfyUI, the filesystem, or OS process APIs.

### `local-server.mjs`

Owns local configuration, source aggregation, log parsing, filesystem indexing, FFprobe metadata, ComfyUI HTTP reads, video streaming, Explorer actions, and authenticated process-control requests.

Compatibility-sensitive functions:

- `getComfyQueue`
- `parseLog`
- `parseGpuSnapshot`
- `countCompletedShots`
- `walkVideos`
- `friendlyName`
- `videoTitle`
- `getWorkerPids`
- `getControlView`
- `controlGenerator`

Prefer changing one adapter function over changing the dashboard contract.

### Studio adapter

`studio-core.mjs` owns pure queue/range/review-state invariants. `scripts/ltx-studio-runner.py` is the only layer allowed to translate a Studio job into calls on a compatible local album runner. The browser must never submit prompts directly to ComfyUI.

Studio must refuse generation while the normal worker is alive, the configured ComfyUI port is online, another Studio job is active, or the runner contract cannot be validated. Queue promotion changes only Studio's ignored local ordering overlay; never rewrite a live supervisor plan.

### Create adapter

`create-core.mjs` owns pure option, prompt, seed, draft, and queue invariants. `app/create-workspace.tsx` owns the original-video UI. `local-server.mjs` validates capabilities, registered roots, uploads, private jobs, queue transitions, and the shared generation launch claim. `scripts/ltx-create-runner.py` is the only layer allowed to compile ComfyUI's official local LTX 2.5 T2V/I2V/FLF2V templates and submit them to the isolated loopback server.

The browser must never provide a workflow path/graph, output prefix, Blender executable/project path, Python script/expression, model filename, ComfyUI command, or arbitrary runner argument. Prompt and paths go only into a bridge-created ignored JSON job; process arguments contain only `--job <path>`. Create must not launch while the worker, configured ComfyUI port, Studio/Projects regeneration, or shared launch claim is active. Preserve the upstream port lock.

Context intake accepts only the documented image/video/audio/`.blend` extensions through authenticated ordered chunks into the ignored Create runtime. Revalidate kind, size, final byte count, containment, and existence before launch. Video currently supplies extracted first/end anchors; audio replaces the rendered soundtrack and must never be presented as visual-model conditioning. Keep FFmpeg arguments fixed and server-owned.

First/last image references must retain their exact server-created identity. Stage unique copies directly in ComfyUI's enumerated input root before its isolated server starts, never pass `image_upload` selectors through model-enum reconciliation, and remove the staged copies after the server stops. Tests must prove the compiled selector is not replaced by a sample such as `example.png` without launching a real workflow.

Blender mode accepts either a designated `.blend` inside a registered Project root or an authenticated dropped `.blend` inside the private Create runtime, plus a detected local Blender executable. Copy the source into the per-job runtime before fixed-argument background PNG rendering, with auto-execution disabled. Never save over the source or accept arbitrary Blender scripts. Automated tests use `--validate-job` and static safety assertions only; never invoke real Blender, ComfyUI, or a model.

Create cancellation must remain authenticated and scoped to the active private job. The bridge writes a server-derived marker beneath that job; the owning runner may interrupt only the isolated loopback ComfyUI server it launched, then must stop it and release the existing lock. Never cancel with an unverified process kill or by interrupting the user's ordinary ComfyUI instance. Automated checks must never request cancellation against a real render.

Create output deletion must accept only a completed job ID, derive the stored output path server-side, revalidate the configured clip root and video extension, and move the file to the Windows Recycle Bin before removing its history record. Never accept a browser-supplied deletion path or permanently delete a real generated video during automated checks.

### Project and Blender backbone adapter

`project-core.mjs` owns pure asset classification, shot identity/mapping, manifest normalization, upload-path validation, and selective-regeneration queue invariants. `app/project-workspace.tsx` owns project UI only. `local-server.mjs` owns scanning, chunked intake, registered-root media access, and translation from a project queue item to the guarded Studio adapter.

Preserve these invariants:

- Reference imports never move or rewrite source files. Managed imports copy only allowlisted asset types into `.ltx-watch-projects`.
- Project media and Explorer paths are validated against registered project/upload roots or existing Studio/Comfy roots.
- Upload relative paths reject traversal and reserved Windows filename characters; chunks must match the expected offset and declared size.
- Keep the shot library batched and mount video/image previews only near the viewport; large projects may contain hundreds of local videos.
- A project regeneration starts only when it was explicitly queued, the normal worker is absent, ComfyUI is offline, and no Studio job is active.
- Source-runner plan inspection is metadata-only: it may expose completed scene slugs and shot numbers for explicit Project regeneration, but it must never prepare inputs, launch ComfyUI, initialize the GPU, expose prompts/paths, or add completed scenes to the unattended Studio queue.
- Context and Blender-backbone relationships are metadata. Do not send files or prompts to a paid provider without a separate provider adapter and explicit user action.
- Treat `.blend` as a master production asset. A future Blender render adapter must create backups/versioned outputs, constrain scripts and paths, and never overwrite the master scene silently.

### `lib/environment-audit.mjs`

Owns read-only ComfyUI/LTX installation detection, model filename grouping, Python package checks, upstream revision comparison, disk checks, optional-tool readiness, and NVIDIA GPU role recommendations. It may run metadata commands, but it must never import Torch, initialize CUDA, mutate Git, install packages, download models, accept licenses, change drivers, rewrite an external runner, or launch a workflow. Keep official outbound URLs allowlisted in this module.

### ComfyUI-Blender maintenance adapter

`lib/comfyui-blender-setup.mjs` and `scripts/install-comfyui-blender.ps1` own the one allowlisted automated environment mutation. Preserve these invariants:

- Accept only a valid configured ComfyUI root and loopback HTTP(S) server address.
- Use only official `alexisrolland/ComfyUI-Blender` GitHub release/tag URLs.
- Match Blender 5 to the latest release and Blender 4.5 to the last compatible v3.3.4 release.
- Verify GitHub's published SHA-256 digest when present, refuse unrecognized targets or dirty Git checkouts, and back up existing files before replacement.
- Require Blender to be closed, enable the add-on through Blender's background preferences API, save `server_address`, and never start a workflow.
- Roll back changed files when setup fails and never restart ComfyUI automatically.

### SAM 3.1 maintenance adapter

`lib/sam3-setup.mjs` and `scripts/install-sam3.ps1` own the one allowlisted model download. Preserve these invariants:

- Require native `comfy_extras/nodes_sam3.py`, explicit SAM License confirmation, the local control token, and an idle worker plus running/pending ComfyUI queue.
- Download only the exact official Comfy-Org checkpoint URL documented by ComfyUI.
- Pin and verify both the 1,745,546,848-byte size and SHA-256 digest before moving the checkpoint into `models/checkpoints`.
- Download into a uniquely named partial file, remove it on failure, back up an existing unverified canonical checkpoint, and restore it if installation fails.
- Never update ComfyUI core, accept a gated Hugging Face agreement, restart ComfyUI, weaken the URL allowlist, or run the real download during tests.

### `scripts/process-orchestrator.ps1`

Owns Windows-native process-tree suspension and resumption. It must verify the root command line before controlling it. Suspend roots before descendants; resume descendants before roots. Keep operations idempotent at the HTTP layer so native suspend counts stay balanced.

### Runtime files

`local.config.json` stores user-local settings. `orchestrator.state.json` stores pause state and timing adjustments. `projects.state.json` stores project manifests and `.ltx-watch-projects` stores managed/uploaded assets. All are ignored and must remain local.

Post-reboot recovery is a distinct state, not a native resume. A recovery action must validate the saved shot scope, keep earlier completed shots, archive rather than delete interrupted-shot files, constrain `recoveryScript` to `comfyRoot`, and wait for a fresh live worker PID. Automated checks must use a fixture supervisor and must never start the user's real generation script.

### Windows installer

`scripts/build-msi.ps1` is the installer source of truth. It runs the production build, stages only runtime files, bundles the current Node.js executable and license, generates WiX source, and builds a per-user MSI with WiX Toolset 6.0.2. `scripts/serve-production.mjs` serves the bundled Vinext output without `node_modules`, while `scripts/run-installed.mjs` coordinates the installed UI and local bridge.

When a framework or LTX compatibility update changes runtime files, rebuild the MSI with `npm run build:msi`. Never commit `installer/.build`, `installer/.tools`, or `release`; publish the MSI as a release artifact instead.

## `/api/state` compatibility contract

Do not rename or remove existing fields without updating the dashboard and documenting a contract version change. Important fields include:

- `connection`
- `current`
- `control`
- `queue`
- `comfyQueue`
- `videos`
- `activity`
- `gpus`
- `stats`
- `config`

New upstream fields should normally be normalized into this contract rather than passed through raw.

## LTX or ComfyUI upgrade workflow

1. Identify the changed layer: model label only, ComfyUI API, output layout, log format, supervisor schemas, or worker launch command.
2. Capture sanitized examples. Remove prompts, usernames, paths, IDs, and media.
3. Compare the examples to `docs/LTX_COMPATIBILITY.md`.
4. Update the narrowest adapter function.
5. Keep legacy parsing when it is cheap and unambiguous.
6. Update `modelLabel` defaults only when the repository intentionally changes its primary supported version.
7. Update filename cleanup to accept old and new version suffixes.
8. If the worker command changes, update the configurable `workerCommandFragment`; do not weaken process verification.
9. Update README, compatibility docs, and changelog in the same change.
10. Run the validation checklist below.

## Validation checklist

Always run:

```powershell
node --check local-server.mjs
node --check lib/environment-audit.mjs
node --check lib/comfyui-blender-setup.mjs
node --check scripts/run-local.mjs
node --check scripts/run-studio.mjs
node --check scripts/run-installed.mjs
node --check scripts/serve-production.mjs
npm test
npm run build
npm run build:msi
npm run test:studio
```

With the local bridge running, validate only non-destructive routes:

- `GET /api/health` returns 200.
- `GET /api/state` returns the documented top-level fields.
- `GET /api/environment` returns the documented diagnostic fields and does not change local state.
- `GET /api/projects` may refresh an explicitly queued project workflow, so ensure the project fixture contains no queued items before validation.
- `GET /api/create` may advance an explicitly authorized Create queue, so ensure `create.state.json` is absent or the fixture queue is empty/paused before validation.
- An unauthorized `POST /api/environment/maintenance` is rejected with 403. Do not run a real maintenance action as an automated check.
- An authenticated `install-sam3` request without `licenseAccepted: true` is rejected. Do not submit an accepted request during validation.
- An unauthorized `POST /api/control` is rejected with 403.
- An authenticated invalid control action is rejected with 400.
- A media range request returns 206 and the requested byte count.
- The root page returns 200.

To test native pause/resume, create a temporary hidden CPU-loop process, suspend it, confirm its CPU time stops, resume it, confirm CPU time advances, and terminate only that temporary process.

Do not click or call the real pause button as part of validation.

## Coding conventions

- Keep the dashboard accessible: labels for icon buttons, keyboard-dismissable dialogs, visible focus states, and reduced-motion support.
- Prefer platform APIs and existing dependencies. Avoid adding a dependency for small utilities.
- Keep the bridge dependency-free and ESM-compatible.
- Use `path` helpers for filesystem construction and case-insensitive root checks on Windows.
- Treat files as mutable while generation runs; handle missing/moving files without crashing state aggregation.
- Keep network timeouts short so an offline/restarting ComfyUI server does not block the UI.
- Avoid logging entire upstream payloads because they may contain prompts or local paths.
- Preserve responsive behavior and the current visual language unless the task requests a redesign.

## Documentation and release hygiene

- Keep example paths generic.
- Link to primary upstream documentation.
- Note known compatibility limits explicitly.
- Update `CHANGELOG.md` for user-visible behavior.
- Keep `package.json` and the root package entry in `package-lock.json` at the same version.
- Before a public push, scan tracked files for credentials, personal paths, generated media, runtime state, and build output.
