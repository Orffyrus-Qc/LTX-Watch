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
| Status JSON changes | Update `parseGpuSnapshot`, `getWorkerPids`, or both |
| Queue plan JSON changes | Normalize the new plan before building `queued` |
| Worker launch command changes | Change `workerCommandFragment`; preserve command verification |
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

## Preserve the adapter boundary

The browser should continue to consume a normalized `/api/state` object. Do not teach `app/dashboard.tsx` every upstream payload shape.

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

## Timing behavior while paused

`orchestrator.state.json` tracks accumulated pause duration scoped to the active track and shot. Progress and elapsed time should freeze while paused and exclude prior paused intervals after resume.

If upstream changes shot identifiers, update the scope keys in `controlGenerator` and `buildState` together. A scope mismatch should reset shot-specific paused time rather than subtracting an unrelated pause.

## Validation without disrupting a render

Run syntax and build checks:

```powershell
node --check local-server.mjs
node --check scripts/run-local.mjs
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

