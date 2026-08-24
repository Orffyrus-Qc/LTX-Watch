# LTX and ComfyUI compatibility contract

This document defines what LTX / Watch reads and what a future maintainer must preserve when LTX Video, ComfyUI, or a custom batch runner changes.

## Compatibility layers

LTX / Watch has four independent compatibility layers:

1. **Model label** — presentation only; configured with `modelLabel`.
2. **ComfyUI HTTP** — standard running/pending queue availability.
3. **Filesystem media** — final videos, clips, metadata, and playback.
4. **Supervisor adapter** — optional detailed track/shot progress, GPU snapshot, planned queue, and worker PID.

A model checkpoint update does not automatically require an app update. Code changes are needed only when one of the consumed interfaces changes.

## Studio single-shot adapter

LTX Watch Studio launches `scripts/ltx-studio-runner.py` with an ignored local JSON job. The job identifies one section, track slug, numeric shot, correction note, GPU, and port. Correction text is never placed in the process command line. The adapter wraps ordinary corrections as non-spoken director metadata and reserves separate lines beginning with `DIALOGUE:` for exact spoken words.

The configured `studioSourceRunner` must resolve inside `comfyRoot` and expose these Python callables:

```text
parse_args
apply_args
load_timing
group_rows
folder_slug_for
prepare_track_inputs
run_shot
acquire_lock
release_lock
```

It must also expose `OUTPUT_ROOT`, `LOCK_DIR`, and `GENERIC_MOTION_PROMPT`. Studio temporarily extends `GENERIC_MOTION_PROMPT` for the requested attempt, prepares only the selected input, acquires the same port lock used by the batch, and calls `run_shot` once. The adapter accepts completion only when a video larger than 100 KB appears beneath the configured clip root.

The adapter's read-only `--inspect-source` mode calls `load_timing`, `group_rows`, and `folder_slug_for` to return scene/slug/shot metadata. Projects merges that complete source index with the active remaining-work plan so a completed scene can still receive an explicitly requested one-shot correction. Inspection does not call `prepare_track_inputs`, `run_shot`, ComfyUI, or the GPU. Keep its output free of prompts and filesystem paths.

If a future runner removes one of these functions, add a narrow adapter for the new runner. Do not import its private prompt schema into the React dashboard and do not weaken the path, worker, or port checks.

### Studio runtime state

Ignored local files hold:

- Scene order and accepted-shot state in `studio.state.json`.
- Private prompt jobs/results in `.ltx-watch-studio/jobs`.
- Superseded attempt videos in `.ltx-watch-studio/attempts`.
- Adapter stdout/stderr in `studio.log`.

Archived attempts are served only after the media path is validated against the Studio runtime root. The `POST /api/studio` endpoint uses the same ephemeral `X-LTX-Control-Token` as pause/resume.

Studio queue ordering is an overlay over the normalized plan. It never rewrites the upstream plan or a running supervisor assignment.

## Create text-to-video adapter

Create is intentionally separate from Studio. It creates new videos without requiring a scene or shot in the album plan. `create-core.mjs` owns pure prompt, option, seed, draft, and queue invariants; `app/create-workspace.tsx` owns the browser UI; `local-server.mjs` owns authenticated orchestration; and `scripts/ltx-create-runner.py` is the only layer allowed to compile and submit a workflow.

The adapter supports ComfyUI's official local full-workflow templates:

| Mode | Template |
| --- | --- |
| Text only | `video_ltx2_5_t2v.json` |
| First frame | `video_ltx2_5_i2v.json` |
| First + last frame | `video_ltx2_5_flf2v.json` |

Do not substitute the `LtxApi*` cloud nodes: Create is a local-first adapter. Template discovery is constrained to the installed `comfyui_workflow_templates_json/templates` package beneath the configured ComfyUI Python environment.

The compiler identifies the template's single subgraph by its definition ID, maps exposed inputs by `label`/`name`, detaches the `ResolutionSelector` width/height links when needed, resolves top-level and internal subgraph links, and queries the isolated loopback server's `/object_info/<class_type>` route to preserve ComfyUI's current required/optional input order. It handles `COMFY_AUTOGROW_V3` and `COMFY_DYNAMICCOMBO_V3`, ignores notes and UI-only resolution selectors, and constrains `SaveVideo.filename_prefix` to `video/ltx-watch-create/<job-id>`. Node numeric IDs are not an API and must not become constants.

Static template enum values can lag renamed local model files. For ordinary ComfyUI combo inputs, including constants linked through an exposed subgraph input, the compiler preserves a value that still exists. If it is missing, it may select a live value only when the filename family plus precision/format markers such as `int8` and `convrot` leave exactly one candidate, or when the node exposes only one choice. Ambiguous substitutions remain invalid and fail visibly; the adapter must never silently switch precision or choose an arbitrary checkpoint.

The compatible `studioSourceRunner` is reused only for these guarded server-lifecycle functions:

```text
parse_args
apply_args
acquire_lock
release_lock
start_comfy_server
stop_comfy_server
wait_for_server
wait_for_history
```

Create configures a unique worker name and private log/cache directory, binds ComfyUI to loopback through the source runner, acquires the same port lock, starts one isolated server, submits one official workflow, waits for history completion, stops that server, and accepts only a video larger than 100 KB beneath the configured clip root. If the source runner changes these call signatures, add a versioned adapter rather than importing its whole batch policy into the UI.

### Create runtime and privacy

- `create.state.json` stores the private draft, queue, and bounded job history.
- `.ltx-watch-create/uploads` stores allowlisted image, video, audio, and `.blend` context received in ordered 4 MiB chunks.
- `.ltx-watch-create/jobs/<id>/job.json` contains the private prompt and paths; only this job path appears in process arguments.
- `.ltx-watch-create/jobs/<id>/result.json` carries bounded status, stage, progress, prompt ID, and the validated output path.
- The browser cannot submit a raw ComfyUI prompt graph, workflow path, Blender executable, Blender project path, output prefix, Python arguments, or arbitrary command.

Create queue polling may advance an already-authorized queued job, so automated fixtures must use an empty or paused Create queue. Never call the real enqueue action during UI or API validation.

An active Create cancellation is an authenticated request written only to that job's private runtime folder. The owning Python runner watches the marker, posts `/interrupt` only to its own isolated loopback ComfyUI server, stops that server through the normal lifecycle, and releases the existing port lock. The bridge never kills an unverified PID or interrupts the user's ordinary ComfyUI instance. Canceled is a distinct terminal state and can be retried after the marker is cleared at the next guarded launch. Automated checks must inspect fixtures/static contracts only and never cancel a real render.

Create output deletion is also authenticated. It accepts only a completed job's server-stored output path, revalidates that the video exists beneath the configured clip root with an allowlisted video extension, and sends it to the Windows Recycle Bin. The job record is removed only after that recoverable operation succeeds. The browser cannot supply a deletion path, and automated checks must never delete a real generated video.

### Create context contract

The authenticated context tray accepts PNG/JPEG/WebP images, MP4/WebM/MOV/MKV video, WAV/MP3/FLAC/M4A/OGG/AAC audio, and `.blend` files. The bridge chooses the private destination and validates extension, bounded size, ordered chunk offsets, final byte count, ignored-runtime containment, and existence again at enqueue and launch. The browser never supplies a destination path.

- The first dropped image becomes the first-frame anchor and the second becomes the last-frame anchor.
- A dropped video is copied into the private job and FFmpeg extracts its first and final frames for the official I2V/FLF2V workflow. It is not full-video motion conditioning.
- Dropped audio is copied into the private job and replaces the rendered video's audio with fixed FFmpeg mapping, AAC encoding, looping, and `-shortest`. It does not condition the visual model.
- A dropped `.blend` is treated as the job's private backbone and follows the Blender contract below.

### Blender reference-frame contract

Blender mode is available for either a selected Project whose designated backbone resolves to a `.blend` inside that project's registered roots or a `.blend` uploaded into the private Create runtime, and only when a supported local `blender.exe` is detected. The bridge supplies those validated paths in an ignored private job. The Python adapter copies the backbone to the per-job runtime folder, disables auto-execution, invokes only fixed background-render arguments, and renders PNG frame anchors from that copy. It never uses `--python-expr`, accepts a browser-provided script, opens the original for saving, or overwrites the original.

Text, I2V, FLF2V, Studio, and Projects regeneration share one in-process launch claim plus the upstream port lock. A Create job must wait while a worker PID is alive, the configured ComfyUI port responds, Studio/Projects has an active job, or another launch is being claimed.

## Project manifest and Blender backbone contract

Project state is normalized by `project-core.mjs` and stored only in ignored `projects.state.json`. A project record contains its import mode and registered roots, project-wide context IDs, optional Blender-backbone asset ID, saved shot decisions, and the selective-regeneration queue. Binary uploads and managed copies live beneath ignored `.ltx-watch-projects`.

Supported indexed asset classes are:

- video: MP4, WebM, MOV, MKV, AVI
- image: PNG, JPEG, WebP, EXR, TIFF
- audio: WAV, MP3, FLAC, M4A, OGG
- text/data: TXT, Markdown, RTF, SRT, VTT, CSV, JSON, YAML, TOML
- 3D: Blender, FBX, OBJ, GLTF/GLB, and USD variants

A shot identity comes from a leading number or `shot_####` pattern. Its parent folder is normalized as the scene slug. Regeneration is available only when that slug matches the active plan or the compatible source runner's inspected scene index and the shot belongs to that item's parsed shot range. Keep this mapping narrow; do not guess a source scene from media similarity or prompt text.

The Blender-backbone ID records the master scene used for shared camera animation, blocking, scale, and spatial continuity. It does not grant permission to run Blender scripts or overwrite that file. Future Blender automation should use a separate authenticated adapter with versioned outputs, explicit actions, path constraints, backup/rollback, and tests that never touch a real production scene.

Project queue items reuse the Studio single-shot launch boundary and inherit all worker, port, path, and adapter readiness locks. Reading project state can advance an already-authorized queue after a prior shot finishes, so automated fixtures must contain an empty or paused regeneration queue.

## Environment Doctor contract

`GET /api/environment` is a separate, read-only compatibility surface implemented by `lib/environment-audit.mjs`. It must remain safe to call during an active render.

The audit may:

- Check for known files and folders under the configured ComfyUI root
- Enumerate model filenames without opening model contents
- Run `python --version`, `python -m pip list --format=json`, and `python -m pip check`
- Run non-mutating Git status/revision commands with an exact `safe.directory` override
- Query official GitHub commit/compare endpoints and the official upstream `requirements.txt`
- Run `nvidia-smi` CSV queries that do not initialize CUDA
- Read only the runner text needed to detect known launch safeguards

The audit must not:

- Import `torch`, initialize CUDA, or launch ComfyUI
- Run `git fetch`, Git merges, package installation, model downloads, driver installers, or custom-node installers (the separate authenticated maintenance endpoint owns its narrow allowlisted actions)
- Accept model licenses or persist credentials
- Return prompts, media, log contents, machine names, or absolute model file paths
- Modify a custom external runner or enable a secondary LTX worker

The response root keys are:

```text
schemaVersion
updatedAt
summary
render
installation
checks
models
python
disk
repositories
gpus
runnerProfile
tools
actions
warnings
officialLinks
maintenance
```

Add optional fields freely, but change `schemaVersion` when renaming or removing fields consumed by `app/dashboard.tsx`.

### LTX installation detection

ComfyUI-based LTX readiness requires:

1. A valid ComfyUI root containing `main.py`.
2. Native LTX core files or the official Lightricks custom-node directory.
3. A matching LTX 2.5 transformer, Gemma 4 text encoder, and video VAE.

Audio VAE and latent upscaler files are reported separately because some workflows do not require them. LTX Desktop is a separate installation and must never be treated as proof that the ComfyUI workflow is ready.

When Lightricks changes checkpoint filenames or splits/combines components, update `MODEL_GROUPS` in `lib/environment-audit.mjs` and add sanitized filename fixtures to `tests/environment-audit.test.mjs`. Prefer official model-card filenames and retain older unambiguous patterns.

### GPU policy

The doctor selects the largest card with at least approximately 16 GB as the primary LTX candidate. Cards below that threshold are marked auxiliary-only for LTX 2.5 22B. This is a safety recommendation, not a performance guarantee, and never means VRAM is pooled across cards.

Project-specific runner editing remains outside the generic adapter. The doctor may recognize safeguards such as device isolation, VRAM reservation, pinned-memory protection, and isolated runtime folders, but it must not rewrite the runner or launch a smoke workflow while another job is active.

### Optional tools

Prefer native ComfyUI SAM 3 support over community wrappers when available. A native node file and licensed model checkpoint are separate checks. The guarded `install-sam3` action may download only ComfyUI's documented Comfy-Org checkpoint after the user explicitly confirms the SAM License; it must not automate access to Meta's gated repository. Keep advanced LTX nodes optional and link to the official Lightricks repository.

### SAM 3.1 model installation

The `install-sam3` maintenance action requires the session token, `{ "confirmed": true, "licenseAccepted": true }`, native SAM 3.1 core nodes, and an idle worker plus running/pending ComfyUI queue. It downloads `sam3.1_multiplex_fp16.safetensors` from the exact Comfy-Org URL documented in the official ComfyUI workflow template, validates the pinned 1,745,546,848-byte size and SHA-256 digest, and only then moves it to `models/checkpoints`.

The separate `update-comfyui-core` action requires the session token, `{ "confirmed": true }`, and the same idle-state revalidation. It accepts only the official ComfyUI GitHub origins on `master`, scopes Git trust to the exact configured checkout, refuses tracked changes or non-fast-forward histories, records the previous commit, installs the fetched revision's requirements into the detected ComfyUI Python environment, and validates with `pip check`. On dependency failure it restores the previous tracked commit and requirements. Untracked local production files are never cleaned or reset.

If the canonical destination already contains an unverified file, the installer moves it to the maintenance backup directory first and restores it when download or verification fails. Partial downloads use a unique `.part` name and are removed on failure. If the model filename, digest, size, license, repository, or native node path changes, update the adapter and its parser/constants test against official ComfyUI and Comfy-Org sources; never silently follow a redirect to an unofficial mirror.

### ComfyUI-Blender integration

The audit separately detects Blender, `custom_nodes\ComfyUI-Blender`, the per-version Blender add-on, the installed versions, the supported release channel, and a local receipt proving that Watch saved the configured loopback server address. Detection alone is read-only and safe during a render.

For the `install-comfyui-blender` action, `POST /api/environment/maintenance` requires the session control token and `{ "confirmed": true }`, then revalidates that there is no live worker and no running or pending ComfyUI queue item. The installer:

1. Selects the latest official release for Blender 5, or v3.3.4 for Blender 4.5.
2. Downloads only from the official `alexisrolland/ComfyUI-Blender` repository and verifies GitHub's SHA-256 asset digest when available.
3. Refuses unrecognized target folders and Git checkouts with local changes.
4. Backs up recognized existing custom nodes and add-on files.
5. Installs matching custom nodes, enables the Blender add-on, and saves the configured loopback `comfyUrl` in `server_address`.
6. Rolls files back on failure and reports whether a later ComfyUI restart is required. It never restarts ComfyUI itself.

Blender must be closed during the action. Blender versions below 4.5 are not automated. If upstream changes the release archive layout, add-on module name, preference property, or compatibility boundary, update the dedicated adapter and its parser tests without weakening URL, idle-state, backup, or confirmation checks.

## Supported baseline

The v1 adapter was built for:

- LTX Video 2.5 as the displayed model generation
- ComfyUI on loopback HTTP
- Windows process control
- Video outputs in `.mp4`, `.webm`, `.mov`, or `.mkv`
- A custom album runner that emits the log/status/plan shapes below

The official LTX and ComfyUI projects evolve independently. Treat this document as an adapter contract, not as a claim that every LTX workflow emits these custom supervisor files.

## Standard ComfyUI queue

The bridge tries these endpoints in order:

1. `GET /queue`
2. `GET /api/queue`

Accepted response shape:

```json
{
  "queue_running": [],
  "queue_pending": []
}
```

The bridge normalizes this into:

```json
{
  "online": true,
  "running": 0,
  "pending": 0,
  "route": "/queue"
}
```

If a future ComfyUI version changes the route or payload, update `getComfyQueue` and preserve the normalized output.

## Media folders

The bridge recursively scans configured final and clip directories to a depth of five. It ignores `trimmed` directories and files smaller than 100 KB.

Supported extensions:

- `.mp4`
- `.webm`
- `.mov`
- `.mkv`

Media IDs are base64url-encoded absolute paths. They are not treated as authorization; every decoded path is checked against the configured output roots before streaming.

### Filename normalization

Recognized suffixes include:

```text
_concat
_FULL
_LTX25_FULL
_LTX2.5_FULL
_LTX26_FULL
_00001_
```

The implementation uses a generic `_LTX[version]_FULL` cleanup pattern so later numeric version suffixes remain readable.

Raw numbered clips use the parent directory as the track name:

```text
output/video/example_track_full/0006_00001_.mp4
→ Example Track · Shot 0006
```

If a new workflow stops using numeric shot filenames, update `videoTitle` without changing the `VideoItem` contract.

## Progress log adapter

`parseLog` accepts timestamped lines in this family:

```text
[2026-01-01 12:00:00] --- starting track album_a/example_track -> example_track_full (9 shots) worker=gpu0 ---
[2026-01-01 12:00:03] === example_track_full/0001: attempt 1/3, fresh server gpu=0 port=8188 safer=False (duration=25s) ===
[2026-01-01 12:00:12] === example_track_full/0001: queued 00000000-0000-0000-0000-000000000000 ===
[2026-01-01 12:11:18] === example_track_full/0001: completed gpu=0, Example GPU, 8000 MiB, 97 % ===
[2026-01-01 13:42:00] === example_track_full: assembled final -> C:\ComfyUI\output\assembled\EXAMPLE_TRACK_FULL_LTX25_FULL.mp4 ===
[2026-01-01 13:42:02] --- finished track album_a/example_track ---
```

Recognized events:

- Track start
- Shot attempt/start
- Prompt queued
- Shot completed
- Final assembly
- Track finished
- Warning/failure/OOM/error

Average shot duration is estimated from queued-to-completed pairs. Values below 30 seconds or above one hour are excluded. When no usable samples exist, the fallback is 690 seconds.

If future logs are JSON or structured events, replace the input parser but keep the normalized `current`, `averageShotSeconds`, and `activities` result.

## Supervisor status JSON

Accepted worker forms:

```json
{
  "updated": "2026-01-01 12:00:00",
  "workers": {
    "gpu0": 12345,
    "gpu1": {
      "pid": 23456,
      "alive": true,
      "returncode": null
    }
  },
  "gpu_snapshot": "0, Example GPU, 8000 MiB, 97 % | 1, Example GPU 2, 0 MiB, 0 %"
}
```

Worker PIDs enable pause/resume. GPU entries are parsed as:

```text
device index, GPU name, allocated MiB, utilization percent
```

If the upstream source exposes structured GPU JSON, prefer it and retain the string parser as a legacy fallback.

## Planned queue JSON

Accepted plan shape:

```json
{
  "gpu0": {
    "device": 0,
    "port": 8188,
    "card": "Example GPU 16GB",
    "shot_count": 18,
    "tracks": [
      {
        "section": "album_a",
        "track": "example_track",
        "slug": "example_track_full",
        "shots": "0001-0009",
        "count": 9
      }
    ]
  },
  "gpu1": {
    "device": 1,
    "tracks": []
  }
}
```

The bridge concatenates `gpu0.tracks` and `gpu1.tracks`, removes the active track and tracks with an assembled final, then assigns display positions.

If a future scheduler supports arbitrary workers, normalize all worker track arrays instead of hard-coding two more GPU keys in the dashboard.

## Worker process control

The status file provides root worker PIDs. The configured `workerCommandFragment` must match each root command line before native control occurs.

Default fragment:

```text
run_full_album_auto.py
```

This value is intentionally specific. For a new runner, configure a unique script or module fragment such as `my_ltx_orchestrator.py` or `-m my_project.ltx_worker`. Never use `python`, `node`, or another generic executable name.

Pause state is persisted in `orchestrator.state.json` with:

- Mode (`running`, `paused`, or `recovery`)
- Root and affected PIDs
- Pause/change timestamps
- Track and shot scopes
- Accumulated paused milliseconds

This state keeps progress estimates frozen and balances native suspend/resume calls.

If Windows restarts or every recorded paused root PID disappears, the bridge moves the controller into `recovery` instead of trying to resume a stale PID. When the user confirms **Retry interrupted shot**, the bridge:

1. Reads the exact track/shot scope captured when Pause was pressed.
2. Moves matching current-shot video files into `<ComfyUI>\.ltx-watch-recovery` without deleting them.
3. Launches the configured `recoveryScript` with the ComfyUI virtual-environment `pythonw.exe` when available (falling back to `python.exe`) so recovery stays in the background.
4. Waits for a fresh status-file worker PID.
5. Returns to `running` only after the new worker is alive.

The recovery supervisor must follow skip-if-valid-output semantics so completed earlier shots stay intact and the interrupted shot is generated from frame one. If an upstream runner no longer supports that contract, disable `recoveryScript` until a dedicated adapter is implemented.

## Dashboard state contract

The root keys returned from `GET /api/state` are:

```text
updatedAt
connection
current
control
queue
comfyQueue
videos
studio
activity
gpus
stats
config
```

Treat these as a stable internal API. Add fields freely when optional. Renaming or removing a field requires a coordinated dashboard change and a documented version bump.

## Upgrade checklist

For each new LTX/ComfyUI release:

- [ ] Confirm whether the change is model-only or interface-affecting.
- [ ] Update `modelLabel` if presentation should change.
- [ ] Verify `/queue` and `/api/queue` status and payloads.
- [ ] Verify output extensions, directory depth, and final/clip filenames.
- [ ] Verify FFprobe still reads the output container.
- [ ] Verify progress start/queued/completed/final events.
- [ ] Verify status timestamp, worker PID, and GPU snapshot.
- [ ] Verify plan worker/track arrays.
- [ ] Verify the worker command fragment remains unique.
- [ ] Verify the Studio source runner still satisfies the single-shot adapter contract.
- [ ] Run Studio fixture tests and confirm correction text reaches only the fake prompt.
- [ ] Confirm Studio remains locked while a real worker or configured ComfyUI port is active.
- [ ] Confirm all three official local LTX 2.5 templates still have one compilable subgraph and semantic prompt/duration/width/height/seed/frame-rate inputs.
- [ ] Run Create core and `--validate-job` fixture tests; do not submit a real workflow.
- [ ] Confirm prompts remain only in ignored JSON, Create and Studio share the launch claim, and queued Create work cannot start beside a worker or occupied ComfyUI port.
- [ ] Confirm dropped context extensions, size/offset/final-length checks, and private-runtime containment; never upload a real private asset in automated tests.
- [ ] Confirm Blender mode renders only a copied `.blend` with auto-execution disabled and fixed background arguments, and keeps the source byte-for-byte unchanged.
- [ ] Confirm paused processes retain correct parent/child relationships.
- [ ] Run non-destructive API and media range checks.
- [ ] Test native control only on a temporary process.
- [ ] Update README, this document, the AI guide, and changelog.

## Upstream references

- `https://github.com/Lightricks/LTX-2`
- `https://github.com/Lightricks/ComfyUI-LTXVideo`
- `https://github.com/Comfy-Org/ComfyUI`
- `https://github.com/Comfy-Org/ComfyUI/blob/master/openapi.yaml`
