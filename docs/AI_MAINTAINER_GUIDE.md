# AI maintainer guide

This guide is for coding agents asked to update LTX / Watch after an LTX Video, ComfyUI, or local workflow change.

## Goal

Adapt upstream changes without breaking local privacy, video playback, current-job visibility, or reversible pause/resume. Most upgrades should be a narrow adapter change in `local-server.mjs`, not a dashboard rewrite.

## Establish the change type

Classify the request before editing:

| Change | Likely work |
| --- | --- |
| New LTX checkpoint with unchanged workflow | Change local `modelLabel`; no repository code change may be necessary |
| New default repository-supported LTX version | Update default label, metadata, README, compatibility doc, changelog |
| ComfyUI route prefix changes | Update `getComfyQueue` with backward-compatible route fallback |
| ComfyUI queue response changes | Normalize the new shape inside `getComfyQueue` |
| Output folder or extension changes | Update configuration defaults and `walkVideos` |
| Final filename suffix changes | Update generic suffix cleanup in `friendlyName` and final-slug detection |
| Progress log format changes | Update `parseLog` and preserve legacy patterns |
| Status JSON changes | Update `parseLegacyGpuSnapshot`, `getWorkerPids`, or both; preserve live `nvidia-smi` telemetry |
| Queue plan JSON changes | Normalize the new plan before building `queued` |
| Worker launch command changes | Change `workerCommandFragment`; preserve command verification |
| LTX model component/filename changes | Update `MODEL_GROUPS` in `lib/environment-audit.mjs` and keep legacy matches |
| ComfyUI ships a formerly custom tool natively | Prefer the native node and update its readiness check |
| New GPU family or memory profile | Extend the read-only role recommendation and validate on an idle fixture workflow |
| Linux/macOS process control requested | Add a separate platform adapter; do not silently reuse the Windows implementation |

## Collect sanitized evidence

Ask for or inspect the smallest useful samples:

- ComfyUI version/commit and LTX model label
- `GET /queue` and/or `GET /api/queue`
- One completed history record if history integration is changing
- Ten to twenty progress log lines around start, queue, completion, assembly, and failure
- Supervisor status JSON
- Queue plan JSON with two tracks
- Two final filenames and two raw clip filenames
- Worker process command line and parent/child shape

Sanitize before adding any fixture or documentation:

- Replace usernames and drive roots with `C:\ComfyUI`.
- Replace prompt UUIDs with `00000000-0000-0000-0000-000000000000`.
- Remove prompt text, media, API keys, tokens, and private project names.
- Keep timestamps only if timing behavior is under test.

## Inspect upstream primary sources

Check current official sources before changing assumptions:

1. LTX-2 releases and README: `https://github.com/Lightricks/LTX-2`
2. LTX ComfyUI nodes/workflows: `https://github.com/Lightricks/ComfyUI-LTXVideo`
3. ComfyUI OpenAPI: `https://github.com/Comfy-Org/ComfyUI/blob/master/openapi.yaml`
4. ComfyUI server routes when OpenAPI is incomplete: `server.py` in the official ComfyUI repository

Record the upstream release, commit, or schema version in the PR/commit description and `CHANGELOG.md` when material.

## Preserve the Environment Doctor boundary

`lib/environment-audit.mjs` owns installation, model, package, revision, disk, optional-tool, and GPU readiness. The browser consumes its normalized `/api/environment` response and must not run local commands itself.

For an LTX or ComfyUI update:

1. Compare official model-card filenames to `MODEL_GROUPS`.
2. Confirm native LTX and optional-tool node locations in current ComfyUI core.
3. Keep Python verification metadata-only: `pip list` and `pip check`; never import Torch during a diagnostic.
4. Keep repository comparison non-mutating. Do not replace it with `git fetch` or `git pull`.
5. Keep exact Git trust warnings visible. Never set `safe.directory=*`.
6. Keep official links allowlisted in `OFFICIAL_LINKS`; never accept a URL supplied by a browser request.
7. Treat a live worker or running ComfyUI queue item as a maintenance lock.
8. Keep external runner setup guided; do not rewrite project-specific launch arguments automatically.
9. Add or update parser tests in `tests/environment-audit.test.mjs`.

Any updater or installer must be implemented as a separate authenticated maintenance adapter with explicit confirmation, idle-state revalidation, backup, progress reporting, validation, and rollback. Do not turn the read-only audit route into a mutating endpoint.

The maintenance endpoint allowlists `update-comfyui-core`, `install-comfyui-blender`, and `install-sam3` only.

For ComfyUI Core updates:

1. Accept only the official `comfyanonymous/ComfyUI` or `Comfy-Org/ComfyUI` origin and the official `master` branch.
2. Scope Git trust to the exact configured ComfyUI folder with `git -c safe.directory=<path>`; never write `safe.directory=*` or silently change global Git configuration.
3. Refuse tracked local changes and divergent/ahead histories. Preserve untracked workflows, scripts, models, outputs, logs, and runtime files.
4. Fetch first, record the previous and target commits, and merge only with `--ff-only`.
5. Install the fetched revision's `requirements.txt` in the detected ComfyUI Python environment and validate with `pip check`.
6. On failure after the fast-forward, restore the previous tracked commit and its requirements, reporting an incomplete rollback explicitly if either restoration step fails.
7. Never run the real updater in automated tests; inject a fake process runner and verify allowlisting, trust scoping, dependency validation, and rollback calls.

For ComfyUI-Blender:

1. Confirm the official release asset naming, tag compatibility, add-on module name, and `server_address` preference against `alexisrolland/ComfyUI-Blender`.
2. Keep the latest-release channel only for Blender 5 and retain v3.3.4 for Blender 4.5 unless the upstream compatibility statement changes.
3. Keep URLs hard-coded to the official repository and validate dynamic asset URLs before download.
4. Never overwrite an unrecognized folder or a Git checkout with local changes.
5. Preserve backup, rollback, closed-Blender, loopback-address, explicit-confirmation, token, and idle running/pending queue checks.
6. Never import Torch, start a workflow, restart ComfyUI, or test the real POST action during automated validation.
7. Update `chooseComfyBlenderChannel` tests and the MSI staging list whenever the adapter layout changes.

For SAM 3.1:

1. Confirm the native node path, checkpoint URL, filename, byte size, SHA-256 digest, and SAM License against the official ComfyUI guide, workflow template, and Comfy-Org model repository.
2. Keep the model URL and verification values pinned in `lib/sam3-setup.mjs`; pass those values to the PowerShell adapter rather than accepting browser-supplied URLs or digests.
3. Require `licenseAccepted: true` in addition to confirmation, token, native-node, disk-space, and idle running/pending queue checks.
4. Download to a unique partial file. Back up an existing unverified canonical file and restore it on any failure.
5. Never automate gated Meta account access or license acceptance, invoke the separate ComfyUI core updater, restart ComfyUI, load the checkpoint, or run the real download during tests.
6. Test the result marker, pinned constants, PowerShell syntax, and MSI staging only.

## Preserve the adapter boundary

The browser should continue to consume a normalized `/api/state` object. Do not teach `app/dashboard.tsx` every upstream payload shape.

### Project Library and Blender evolution

Project behavior is split across `project-core.mjs` (pure invariants), `local-server.mjs` (filesystem and queue orchestration), and `app/project-workspace.tsx` (UI). Keep `GET /api/projects` normalized instead of passing raw directory entries to React.

When adding Blender as an active camera/animation backbone:

1. Treat the selected `.blend` as immutable input by default and render into a versioned project-owned directory.
2. Put Blender command construction and result validation in a dedicated adapter; never expose arbitrary script or command execution through the browser.
3. Require the local token, explicit user action, validated registered roots, a supported Blender executable, and an idle/conflict-free render target.
4. Store derived camera, depth, normal, mask, and reference passes as new project asset versions with provenance; do not replace accepted LTX media.
5. Preserve project and shot context IDs so paid-provider adapters can consume the same relationships without changing the manifest schema.
6. Add fixture-only tests. Never open or save the user's real `.blend` during automated validation.

When adding a paid AI provider, keep credentials in OS-backed local storage, send only files explicitly selected for that request, show the destination/provider and estimated cost before submission, normalize provider jobs behind one adapter contract, and import results as new shot versions. Do not put provider payload shapes or keys in the project manifest or React tree.

### Create workspace and LTX template evolution

Create is the original-video path. Keep its responsibilities split between `create-core.mjs`, `app/create-workspace.tsx`, `local-server.mjs`, and `scripts/ltx-create-runner.py`. The browser chooses normalized creative options; it must never construct a ComfyUI graph or pass an arbitrary workflow/script/path/command to Python.

When LTX or ComfyUI updates the official full-workflow templates:

1. Fetch the official `video_ltx2_5_t2v.json`, `video_ltx2_5_i2v.json`, and `video_ltx2_5_flf2v.json` from the installed `comfyui_workflow_templates_json` package and compare their semantic subgraph inputs and node classes. Do not use a user's saved workflow as the compatibility contract.
2. Keep template discovery beneath the configured ComfyUI Python environment. Never fall back to similarly named API/cloud templates.
3. Match prompt, enhancer, duration, resolution, seed, and frame rate by subgraph labels/names. Do not hardcode node IDs or model filenames. Preserve the generic `/object_info/<class_type>` compiler for input ordering and dynamic nodes.
   Preserve conservative combo reconciliation: keep valid template values, permit a renamed live model only when family and precision/format markers produce one unique match, and leave ambiguous values invalid. Never resolve a missing INT8/FP8/BF16 choice by silently changing precision.
4. If the template gains multiple subgraphs or changes link semantics, add fixture copies of sanitized official structure and update the compiler deliberately. Do not silently choose a graph.
5. Keep `SaveVideo.filename_prefix` constrained to the per-job Create output prefix and accept results only inside the configured clip root.
6. Keep prompts and references in ignored JSON/runtime files. The command line contains only `ltx-create-runner.py --job <private-job-path>`.
7. Preserve the shared launch claim: Create, Studio, and Projects regeneration cannot race for the GPU/port. The source runner's port lock remains the second line of defense.
8. Test `create-core.mjs` and `ltx-create-runner.py --validate-job` only. Never press **Queue creation** or submit `/api/create` `enqueue` during automated validation.
9. Keep Create cancellation job-scoped: the authenticated bridge writes only the private marker; the owning runner interrupts only its isolated loopback server and releases the normal lock. Never implement cancellation as an unverified PID kill or a request to an arbitrary configured ComfyUI instance.
10. Keep Create deletion recoverable and server-owned: accept only a completed job ID, derive its stored output path, revalidate the configured clip root and video extension, move it to the Windows Recycle Bin, and remove history only after success. Never accept a browser-supplied delete path.
11. Treat reference uploads as exact file identities, never as model enums. Stage unique first/last images directly in ComfyUI's enumerated input root before server startup, preserve `image_upload` widget values verbatim, and remove staged copies after the server stops.

Context uploads are an explicit local contract. Preserve the extension allowlist, kind-specific size limits, ordered 4 MiB offsets, exact final length, server-selected destination, and private-runtime revalidation. Image files are I2V/FLF2V anchors; video is reduced to first/end anchors through fixed FFmpeg arguments; audio replaces the final soundtrack and must never be described as visual conditioning. Do not add arbitrary transcoder flags from the browser.

For Blender mode, validate either the designated Project `.blend` against registered roots or the dropped `.blend` against the private Create runtime in Node and again in Python. Copy it into the per-job runtime before rendering. Keep auto-execution disabled and the argument list fixed to background open, output prefix, PNG format, and numeric frame; do not add browser-supplied Python expressions or scripts. A real Blender invocation is excluded from automated tests.

### Queue normalization

`getComfyQueue` currently tries legacy `/queue` and newer `/api/queue`. Return:

```json
{
  "online": true,
  "running": 1,
  "pending": 2,
  "route": "/api/queue"
}
```

If upstream renames arrays or moves counts, normalize them here. Use short timeouts and keep an offline fallback.

### Progress normalization

`parseLog` returns:

```json
{
  "current": {
    "section": "album_a",
    "track": "example_track",
    "slug": "example_track_full",
    "totalShots": 9,
    "worker": "gpu0",
    "startedAt": "2026-01-01T12:00:00.000Z",
    "currentShot": "0006",
    "shotStartedAt": "2026-01-01T12:45:00.000Z",
    "stage": "Sampling frames"
  },
  "averageShotSeconds": 680,
  "activities": []
}
```

Preserve this output even if the input changes from text logs to JSON events.

### Media normalization

Every dashboard video needs:

```json
{
  "id": "opaque-local-id",
  "title": "Example Track · Shot 0006",
  "filename": "0006_00001_.mp4",
  "kind": "clip",
  "size": 8123456,
  "modifiedAt": "2026-01-01T12:56:00.000Z",
  "mediaUrl": "http://127.0.0.1:4311/media/...",
  "directory": "C:\\ComfyUI\\output\\video\\example_track_full"
}
```

FFprobe fields are optional. Do not make playback depend on them.

## Process-control safety

Pause/resume is the highest-risk feature.

The HTTP layer is idempotent: a second pause request while already paused must not call `NtSuspendProcess` again, because native suspend counts would become unbalanced. A resume request while already running must be a no-op.

The PowerShell layer:

- Finds descendants from the verified root worker PID.
- Excludes `conhost.exe`.
- Suspends roots before descendants to prevent new child creation.
- Resumes descendants before roots.
- Verifies the root command line contains `workerCommandFragment`.

When adapting a new worker launcher:

1. Use a fragment unique to the intended LTX runner.
2. Confirm the status source points to the true long-lived worker root.
3. Confirm active ComfyUI and encoder subprocesses are descendants.
4. Test on a temporary look-alike process first.
5. Never weaken verification to a generic value such as `python.exe`.

If the new runner does not expose a stable PID, disable pause/resume (`canControl: false`) until a safe adapter exists.

### Studio generation

Studio generation is separate from native pause/resume. Preserve these invariants:

1. `studioSourceRunner` resolves inside `comfyRoot` and exposes the documented adapter callables.
2. Source inspection returns only scene/slug/shot metadata and never calls input preparation, generation, ComfyUI, or GPU APIs. Completed-source metadata may supplement Project mapping but must not silently add scenes to the unattended Studio queue.
3. The standard worker PID list is empty and the configured ComfyUI port is offline before launch.
4. The single-shot adapter acquires the upstream port lock and generates exactly one validated scene/shot.
5. Correction text is limited, stored only in an ignored job file, and never included in process arguments or logs.
6. A rejected/current output is moved to the Studio attempt archive before regeneration; it is never deleted.
7. Acceptance requires a playable current output and is the only action that advances the shot pointer.
8. Queue promotion updates only the Studio overlay and never mutates a running supervisor plan.

### Create generation

Create is separate from native pause/resume and Studio correction generation. Preserve these invariants:

1. A user explicitly enqueues a normalized draft; GET polling may advance only that already-authorized queue.
2. The normal worker is absent, the configured ComfyUI port is offline, Studio/Projects has no active job, and the shared launch claim is free immediately before launch.
3. The adapter uses an official local LTX workflow template and the configured source runner's guarded server lifecycle and port lock.
4. Prompt, reference, Blender, and output paths are private server-created values and never browser-controlled command arguments.
5. Queue pause applies between jobs and never pretends to suspend an active ComfyUI sampling process.
6. Blender opens a job-local copy of the master scene and produces new reference PNGs.
7. A complete job requires a playable video larger than 100 KB inside the configured clip root; runner death or invalid output becomes a bounded failed job.

Run Create tests with `--validate-job` and pure core fixtures. A real `/api/create` enqueue requires explicit user direction and an idle GPU.

Run `npm run test:studio` with a fixture Python interpreter. Real `/api/studio` generation requires explicit user direction and an idle GPU.

### Restart recovery

A suspended process cannot survive a Windows reboot. Never call native resume on a PID recorded before the current system boot. The bridge must enter `recovery` and require a user action before launching anything.

Recovery is allowed only when the pause record contains a validated `trackScope` and numeric shot ID, `recoveryScript` resolves inside `comfyRoot`, and a known ComfyUI Python environment exists. Archive current-shot videos instead of deleting them, then wait for a fresh status timestamp and live worker PID before reporting success. Test this flow with a fixture recovery script; never launch the real generator during automated validation.

## Timing behavior while paused

`orchestrator.state.json` tracks accumulated pause duration scoped to the active track and shot. Progress and elapsed time should freeze while paused and exclude prior paused intervals after resume.

If upstream changes shot identifiers, update the scope keys in `controlGenerator` and `buildState` together. A scope mismatch should reset shot-specific paused time rather than subtracting an unrelated pause.

## Validation without disrupting a render

Run syntax and build checks:

```powershell
node --check local-server.mjs
node --check scripts/run-local.mjs
npm test
npm run build
```

Run non-destructive bridge checks:

```powershell
Invoke-RestMethod http://127.0.0.1:4311/api/health
Invoke-RestMethod http://127.0.0.1:4311/api/state
```

Verify security behavior:

- `POST /api/control` without the token returns 403.
- An authenticated unsupported action returns 400.
- Do not submit `pause` or `resume` to a live bridge during testing.
- `GET /api/environment` remains safe during a render and reports `render.changesLocked: true`.
- Environment actions contain only the allowlisted official URLs from `OFFICIAL_LINKS`.
- An unauthenticated `POST /api/environment/maintenance` returns 403; do not invoke the authenticated installer during an automated or active-render check.

Verify media behavior with a range request against a known test video:

```powershell
curl.exe -r 0-127 -o NUL -w "%{http_code} %{size_download}" http://127.0.0.1:4311/media/TEST_ID
```

Expected: `206 128`.

For native orchestration, spawn a temporary hidden CPU-loop process, record its CPU time, suspend it, confirm CPU time stops, resume it, confirm CPU time advances, then terminate only the temporary process.

## UI compatibility review

After the adapter works, check that:

- Active/idle/paused hero states remain coherent.
- Progress stays between 0 and 99 until completion.
- Queue items have stable unique keys.
- Missing optional data produces an empty or fallback state, not a crash.
- Old bridge responses without a new optional field do not crash during hot reload.
- Studio shows a clear safety lock while the worker or ComfyUI port is active.
- Create exposes text/reference/Blender modes, keeps Queue creation disabled until required input is present, and shows its safety wait, queue progress, retry, pause-between-jobs, playback, and Explorer controls.
- Studio queue selection, move-first, correction counting, attempt playback, and Accept & Next remain keyboard accessible.
- Dialogs still close with Escape.
- Icon-only buttons have accessible labels.
- Responsive CSS does not hide the pause/resume affordance completely.

## Documentation and release steps

Update these together:

- `README.md` for user-visible behavior or setup
- `docs/LTX_COMPATIBILITY.md` for schema/pattern changes
- `AGENTS.md` for safety or architecture changes
- `CHANGELOG.md` for the release summary
- `package.json` and `package-lock.json` for a version change

Before pushing publicly:

1. Inspect `git status`.
2. Inspect the staged file list.
3. Search tracked files for tokens, personal paths, usernames, prompts, UUIDs, logs, and generated media.
4. Confirm `local.config.json` and `orchestrator.state.json` are ignored.
5. Build from the exact staged source state.
6. Push the commit and verify the public repository/default branch.
