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

If a proposed change weakens one of these invariants, treat it as a security-sensitive design change and document the rationale explicitly.
