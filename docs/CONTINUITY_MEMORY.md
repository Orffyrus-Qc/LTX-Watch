# Project Continuity memory and long-scene workflow

LTX Watch treats long-form consistency as a persistent, review-gated production process. It does not claim that a probabilistic video model can preserve identity or geometry perfectly for an unlimited duration.

## User workflow

1. Import or select a project, then open **Continuity & long scenes**.
2. Build the local **Continuity Bible**:
   - world and premise;
   - locked visual language;
   - non-negotiable continuity facts;
   - negative rules;
   - named characters, locations, props, wardrobe, vehicles, and style elements.
3. Attach a primary project asset to each canonical element where useful. These relationships remain available in the project manifest for later workflow/provider adapters.
4. Create a long scene, define its global direction, and choose a curated Ingredients image containing only the identities and production elements needed by the scene.
5. Add 5–20 second clips. A scene can keep growing without a fixed narrative endpoint; persisted safety bounds are 200 long scenes per project and 500 clips per scene.
6. Prepare the first clip or a new cut in **Create**. It uses the canonical Ingredients sheet and Director timeline.
7. Review the result. Accepting it extracts the final decoded frame with FFmpeg into the project’s ignored local upload area.
8. Prepare the next **Continue previous** clip. LTX Watch copies the accepted ending into the private Create runtime and uses it as the official I2V workflow’s actual first-frame input. The server also rebuilds the prompt from the latest Bible, scene direction, and clip action.
9. Repeat the review → accept → handoff loop. A continuous clip cannot bypass the accepted previous clip.

Use **New cut** when the camera, time, or place changes. New cuts return to the canonical Ingredients sheet instead of inheriting the previous final frame.

## What is memorized

`projects.state.json` uses project schema version 2 and stores:

- the normalized Continuity Bible and revision;
- stable canonical-element IDs and their project asset IDs;
- long-scene and clip IDs, order, transition, direction, duration, and status;
- the linked Create job ID and reviewed output path;
- the accepted final-frame path used for the next visual handoff;
- the private prepared Ingredients/anchor paths needed for server-side validation.

The state file, accepted anchors, managed copies, and uploads are ignored by Git and remain local. Reference-in-place source files are never moved or rewritten.

## Orchestration and trust boundaries

The browser can edit normalized text, IDs, durations, transitions, and asset selections. It cannot choose a workflow graph/path, model filename, output path, executable, script, or command arguments.

On prepare and again on enqueue, the bridge resolves the project, scene, and clip by server-owned IDs. It rebuilds the canonical prompt from persisted state and chooses exactly one visual contract:

- **First clip / new cut:** capability-gated Director Ingredients workflow with Prompt Relay.
- **Continuous clip:** official LTX 2.5 first-frame workflow using the previous accepted ending.

The bridge validates every visual input against the registered project roots or private Create runtime. Create, Studio, Projects regeneration, the album worker, and the configured ComfyUI port continue to share the existing launch locks.

Saving an edited scene plan preserves server-owned render state so a stale browser draft cannot turn a generating or accepted clip back into a planned clip.

## Current limits

- Canonical element reference attachments are persistent manifest relationships. The selected scene Ingredients sheet is the visual identity input for Director cuts; element references are not yet submitted individually.
- Continuous clips prioritize exact boundary continuity through the accepted start frame and do not simultaneously use the Director Ingredients graph. The Bible prompt carries canonical identity rules into that I2V job.
- Director and Blender cannot currently run in one LTX job. Use the designated Blender backbone as the authority for exact camera, geometry, scale, trajectories, collisions, and deformation, then use the existing versioned Blender package workflow.
- Review gates, corrective regeneration, and occasional new cuts remain necessary. “Indefinitely” describes an extensible workflow and persistent memory, not a mathematical model guarantee.
- No paid provider receives project files. A future provider adapter needs its own explicit user action, credentials boundary, asset allowlist, retention disclosure, and tests.

## Updating for a future LTX or ComfyUI release

Keep the project manifest and UI stable when possible; change the narrow generation adapter.

1. Verify the current official T2V/I2V/FLF2V templates and the Director dependencies listed in `docs/LTX_COMPATIBILITY.md`.
2. If a verified workflow can consume both an Ingredients identity sheet and an explicit start frame, add a new versioned continuity visual contract. Do not silently reinterpret the existing modes.
3. Patch graphs only in `scripts/ltx-create-runner.py`, using semantic class/consumer relationships and fixture graphs. Never accept graph structure from the browser.
4. Preserve the server-side Project Continuity identity check and canonical prompt rebuild in `local-server.mjs`.
5. Update `project-core.mjs` normalization before adding persistent fields. Optional fields can migrate forward; renames/removals require a schema-version change and migration coverage.
6. Add pure tests for prompt composition, segment bounds, state migration, stale-save protection, path containment, and each workflow contract.
7. Never run a real enqueue, installation, cancellation, pause/resume, Blender job, or GPU workflow as an automated test.

