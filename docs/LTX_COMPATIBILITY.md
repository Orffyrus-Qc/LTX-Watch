# LTX and ComfyUI compatibility contract

This document defines what LTX / Watch reads and what a future maintainer must preserve when LTX Video, ComfyUI, or a custom batch runner changes.

## Compatibility layers

LTX / Watch has four independent compatibility layers:

1. **Model label** — presentation only; configured with `modelLabel`.
2. **ComfyUI HTTP** — standard running/pending queue availability.
3. **Filesystem media** — final videos, clips, metadata, and playback.
4. **Supervisor adapter** — optional detailed track/shot progress, GPU snapshot, planned queue, and worker PID.

A model checkpoint update does not automatically require an app update. Code changes are needed only when one of the consumed interfaces changes.

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

- Mode
- Root and affected PIDs
- Pause/change timestamps
- Track and shot scopes
- Accumulated paused milliseconds

This state keeps progress estimates frozen and balances native suspend/resume calls.

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

