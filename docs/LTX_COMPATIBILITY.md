# LTX and ComfyUI compatibility contract

This document defines what LTX / Watch reads and what a future maintainer must preserve when LTX Video, ComfyUI, or a custom batch runner changes.

## Compatibility layers

LTX / Watch has four independent compatibility layers:

1. **Model label** — presentation only; configured with `modelLabel`.
2. **ComfyUI HTTP** — standard running/pending queue availability.
3. **Filesystem media** — final videos, clips, metadata, and playback.
4. **Supervisor adapter** — optional detailed track/shot progress, GPU snapshot, planned queue, and worker PID.

A model checkpoint update does not automatically require an app update. Code changes are needed only when one of the consumed interfaces changes.

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
- Run `git fetch`, `git pull`, package installation, model downloads, driver installers, or custom-node installers
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

The sole launcher-editing exception is the Manager maintenance adapter. It recognizes one exact, versioned `args.server_extra_args = []` assignment, backs the file up, and changes it to include `--enable-manager`. Unknown launcher shapes remain manual.

### Optional tools

Prefer native ComfyUI SAM 3 support over community wrappers when available. A native node file and a licensed model checkpoint are separate checks. Do not automate model access or license acceptance. Keep advanced LTX nodes optional and link to the official Lightricks repository.

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

### ComfyUI Manager integration

The audit distinguishes the current built-in Manager from the legacy `custom_nodes\ComfyUI-Manager` form. It checks `manager_requirements.txt`, the `comfyui-manager` package, `--enable-manager` in the configured launcher, legacy Git state, and whether the launcher is a recognized automatic target.

The `install-comfyui-manager` maintenance action is token-protected, confirmation-gated, and idle-only. It installs the official Manager requirement with ComfyUI's Python, backs up the recognized launcher, enables the flag, and moves a clean official legacy checkout into the LTX Watch maintenance backup directory. It refuses dirty, unrecognized, or non-official legacy folders and never restarts ComfyUI. If core no longer exposes the official requirement file or flag, update the adapter against current Comfy-Org documentation rather than guessing.

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
- [ ] Confirm paused processes retain correct parent/child relationships.
- [ ] Run non-destructive API and media range checks.
- [ ] Test native control only on a temporary process.
- [ ] Update README, this document, the AI guide, and changelog.

## Upstream references

- `https://github.com/Lightricks/LTX-2`
- `https://github.com/Lightricks/ComfyUI-LTXVideo`
- `https://github.com/Comfy-Org/ComfyUI`
- `https://github.com/Comfy-Org/ComfyUI/blob/master/openapi.yaml`
