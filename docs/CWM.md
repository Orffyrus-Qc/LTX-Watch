# Code World Model in LTX Watch

LTX Watch uses Meta FAIR **Code World Model (CWM)** as the preferred Auto-Pilot planner. CWM is a 32B research LLM trained to reason about how code and commands change the state of a program or system. Watch uses it only to emit a schema-validated Blender scene spec. It never executes model-generated Python.

## Official sources

- GitHub: https://github.com/facebookresearch/cwm
- Hugging Face: https://huggingface.co/facebook/cwm
- License: https://ai.meta.com/resources/models-and-libraries/cwm-license/
- Paper: https://arxiv.org/abs/2510.02387

CWM is **research-only and non-commercial**. Accept the license on Hugging Face before downloading or serving weights.

## This machine

Official facebook/cwm needs about **80 GB VRAM** with quantization (Meta's published requirement). A 16 GB + 12 GB pair cannot load the official 32B checkpoint.

Hugging Face sign-in is enough to *access* the gated repo. Serving still needs either:

1. A loopback OpenAI-compatible server (`http://127.0.0.1:8000`) running `facebook/cwm` on a host with enough VRAM, or
2. An Ollama model whose name contains `cwm` (local GGUF import). Watch will then use the official CWM system prompt (`<think>…</think>`) and parse JSON after the think block.

## Hugging Face

Watch reads the local Hugging Face token from `%USERPROFILE%\.cache\huggingface\token`. It never writes the token to git, logs, or the browser.

1. Open https://huggingface.co/facebook/cwm while signed in.
2. Accept the CWM research license. Approval can take up to an hour.
3. Rescan **Environment**. The Code World Model card should show Hugging Face access.

Do not paste tokens into Watch settings.

## Local vLLM (official path)

On a machine with enough VRAM:

```powershell
vllm serve facebook/cwm --tensor-parallel-size=2
```

Point Watch at loopback only:

```json
"cwmUrl": "http://127.0.0.1:8000",
"cwmModel": "facebook/cwm"
```

Auto-Pilot prefers this server over Ollama when it answers `/v1/models`.

## Auto-Pilot behavior

1. CWM (loopback OpenAI) if online
2. Else Ollama, preferring a `cwm` model
3. Else other local Ollama coder models
4. Final Override intro still builds from the canned Earth/halo/cathedral kit if no planner is online

CWM may rewrite appearance and identity locks. Geometry for the intro preset stays locked.
