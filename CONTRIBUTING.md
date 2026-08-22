# Contributing

Thanks for helping improve LTX / Watch.

## Before opening a change

1. Read `AGENTS.md` and `docs/LTX_COMPATIBILITY.md`.
2. Use official LTX and ComfyUI sources when researching compatibility.
3. Keep all examples sanitized and machine-independent.
4. Do not test pause/resume against a real render.

## Development

```powershell
npm install
npm run dev
```

Before submitting:

```powershell
node --check local-server.mjs
node --check scripts/run-local.mjs
npm run build
```

Include a clear description of the upstream LTX/ComfyUI version or commit when changing compatibility behavior. Explain which input shape changed and how backward compatibility is preserved.

Do not include generated media, prompts, logs, local paths, tokens, `local.config.json`, or `orchestrator.state.json`.

## Pull request scope

Prefer small changes at the adapter boundary. A compatibility update should normally touch:

- The relevant parser/adapter in `local-server.mjs`
- A compatibility document
- `CHANGELOG.md`

Dashboard changes are needed only when the normalized `/api/state` contract intentionally changes or a new user-facing capability is added.

