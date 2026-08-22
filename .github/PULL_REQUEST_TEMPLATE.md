## Summary

Describe the user-visible change and the compatibility layer affected.

## Upstream reference

- LTX version/commit:
- ComfyUI version/commit:
- Primary source link:

## Safety checklist

- [ ] I did not test pause/resume against a real render.
- [ ] The bridge still binds only to `127.0.0.1`.
- [ ] Process control still requires a token and a specific command-line match.
- [ ] Media and Explorer paths remain restricted to configured roots.
- [ ] No personal paths, prompts, tokens, logs, job IDs, or generated media are included.
- [ ] Legacy input formats are preserved when practical.

## Validation

- [ ] `node --check local-server.mjs`
- [ ] `node --check scripts/run-local.mjs`
- [ ] `npm run build`
- [ ] Unauthorized control request returns 403.
- [ ] Invalid authenticated control action returns 400.
- [ ] Media range request returns 206.
- [ ] Documentation and changelog updated.
