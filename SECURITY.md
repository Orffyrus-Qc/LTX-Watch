# Security policy

## Scope

LTX / Watch is a local application with filesystem, media-streaming, Explorer, and process-control capabilities. Security reports involving path validation, loopback exposure, control-token handling, process targeting, or media serving are especially important.

## Reporting

Please report a potential vulnerability privately through GitHub's security advisory feature for this repository. Do not open a public issue containing exploit details, local paths, tokens, prompts, or generated media.

## Security invariants

- The bridge must bind only to `127.0.0.1`.
- Process controls must require the ephemeral session token.
- The root worker command line must be verified before suspension/resumption.
- Media and Explorer targets must remain inside configured roots.
- Local configuration and runtime state must not be committed.
- Error responses must not expose tokens, prompts, or full upstream payloads.
- `GET /api/environment` must remain read-only, avoid CUDA initialization, and contact only hard-coded official upstream endpoints.
- Mutating environment actions must use a separate authenticated endpoint, require explicit confirmation, revalidate an idle worker and queue, and never restart ComfyUI automatically.
- ComfyUI-Blender automation must accept only loopback server URLs and official `alexisrolland/ComfyUI-Blender` release assets, verify the published digest when present, preserve local changes, and retain a rollback backup.
- ComfyUI Manager automation must use the in-root official requirement file, patch only the recognized backed-up launcher assignment, and archive only a clean official legacy repository.
- SAM 3.1 automation must require explicit SAM License confirmation, native core-node presence, an exact official Comfy-Org URL, pinned size and SHA-256 validation, and backup/rollback for an existing unverified checkpoint.
- A live worker or running/pending ComfyUI queue item must keep maintenance actions locked.
- Git trust must be scoped to an exact repository path; never configure `safe.directory=*`.

If a proposed change weakens one of these invariants, treat it as a security-sensitive design change and document the rationale explicitly.
