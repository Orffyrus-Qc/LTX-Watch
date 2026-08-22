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
5. `app/dashboard.tsx`
6. `scripts/process-orchestrator.ps1`

Use official upstream sources when investigating LTX or ComfyUI changes:

- `https://github.com/Lightricks/LTX-2`
- `https://github.com/Lightricks/ComfyUI-LTXVideo`
- `https://github.com/Comfy-Org/ComfyUI`
- `https://github.com/Comfy-Org/ComfyUI/blob/master/openapi.yaml`

Do not rely on blog posts or copied endpoint lists when the upstream source or OpenAPI specification is available.

## Hard safety rules

- Never call the real `/api/control` pause/resume action during an automated check.
- Never suspend, interrupt, terminate, restart, or clear a real ComfyUI/LTX job unless the user explicitly asks for that action.
- Test `process-orchestrator.ps1` only against a temporary process created for the test.
- Never replace pause/resume with process termination or ComfyUI `/interrupt` without explicit user approval and a documented migration.
- Keep the local bridge bound to `127.0.0.1`. Do not change it to `0.0.0.0`.
- Preserve the per-session `X-LTX-Control-Token` check.
- Validate decoded media and Explorer paths against configured roots before access.
- Keep `local.config.json`, `.env*`, generated media, logs, status files, queue plans, and `orchestrator.state.json` out of Git.
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

### `scripts/process-orchestrator.ps1`

Owns Windows-native process-tree suspension and resumption. It must verify the root command line before controlling it. Suspend roots before descendants; resume descendants before roots. Keep operations idempotent at the HTTP layer so native suspend counts stay balanced.

### Runtime files

`local.config.json` stores user-local settings. `orchestrator.state.json` stores pause state and timing adjustments. Both are ignored and must remain local.

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
node --check scripts/run-local.mjs
node --check scripts/run-installed.mjs
node --check scripts/serve-production.mjs
npm run build
npm run build:msi
```

With the local bridge running, validate only non-destructive routes:

- `GET /api/health` returns 200.
- `GET /api/state` returns the documented top-level fields.
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
