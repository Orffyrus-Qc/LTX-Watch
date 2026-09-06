# Blender Auto-Pilot

Local AI plans a Blender scene, Blender records the motion backbone, and LTX 2.5 clothes appearance plus smaller animation. The training scene is the **Final Override Introduction**: Earth, black-metal halo, moon, gothic machine-datacenter cathedrals, and glass biodomes.

This is not remote generation. Ollama, Blender, ComfyUI, and LTX Watch stay on the same machine.

## Pipeline

1. **Plan** — loopback **Code World Model** (`facebook/cwm`) is preferred when a local OpenAI-compatible server or an Ollama model named `cwm` is online. Otherwise Ollama emits a schema-validated scene spec. The planner cannot emit Python, `bpy`, shell, or file paths. See [Code World Model](CWM.md).
2. **Build** — `scripts/blender-autopilot.py` constructs only allowlisted kits (planet, halo, moon, cathedral, biodome, ships, lasers, camera).
3. **Record** — Blender writes a private beauty PNG sequence, camera JSONL, and first/last anchors. Optional seed `.blend` files are copied; masters are never saved over.
4. **Clothe** — official LTX 2.5 first/last-frame workflow interpolates appearance and smaller motion while Blender keeps camera and blocking.
5. **Identity** — named identities in the spec (cathedral, Earth, biodome, ships) are injected into every clothing prompt.

```text
Create UI  →  local bridge  →  ltx-autopilot-runner.py
                                  ├─ Ollama 127.0.0.1:11434
                                  ├─ blender.exe --python blender-autopilot.py
                                  └─ ltx-create-runner.py (official FLF2V, optional)
```

## Training preset

`final-override-intro` locks geometry to the Earth-halo intro used as the LTX Watch rehearsal scene:

- Clean Sky Protocol Earth
- Black-metal halo
- Watching moon
- Upright gothic machine-datacenter cathedral + separate biodome
- Inverted sister stack on the far side of the halo
- Gothic-industrial ships and satellites

Ollama may rewrite appearance and identity lock text. It may not add unknown primitives or relocate the landmarks.

`from-prompt` lets Ollama invent a new layout, still constrained to the allowlisted kit.

## What LTX is allowed to change

Allowed: materials, lighting atmosphere, weather, vegetation micro-motion, lights, cloth-like surface motion, identity-consistent restyling.

Forbidden: new camera path, landmark relocation, character/object identity drift, treating first/last frames as physics-preserving.

Full structural passes (depth/normal/flow) remain the separate **Blender animation** physics package. Auto-Pilot clothing is the verified FLF2V appearance path from the intro orbit rehearsal.

## Local services

| Piece | Default | Role |
| --- | --- | --- |
| Ollama | `http://127.0.0.1:11434` | Scene planner |
| Preferred models | `qwen2.5-coder:14b-agent`, then other local coder/chat models | JSON spec |
| n8n | optional `127.0.0.1:5678` | Same spec schema, not a required control plane |
| Docker | optional compose under `docker/local-orchestrator` | Hosts n8n only; Ollama and Watch stay on the host |

Set `ollamaUrl` and `ollamaModel` in ignored `local.config.json`. Non-loopback Ollama URLs are rejected.

Optional n8n does not receive the Watch control token. Import `n8n/blender-autopilot.json` if you want a visual planner; LTX Watch remains the orchestrator that may launch Blender and LTX.

## Safety

- Browser cannot supply scripts, executables, output paths, or ComfyUI graphs.
- Command line is only `--job <private-json>`.
- Tests use `--validate-job` and must never open Blender, Ollama, or ComfyUI.
- Auto-Pilot waits for the same idle lock as Create: no album worker, no occupied ComfyUI port, no Studio job.
- After planning, the runner asks Ollama to unload (`keep_alive: 0`) before Blender/LTX use the GPU.
