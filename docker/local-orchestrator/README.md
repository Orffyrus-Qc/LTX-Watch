# Optional local n8n sidecar

LTX Watch already orchestrates Auto-Pilot through loopback Ollama. Use this compose file only if you want a visual n8n canvas on `127.0.0.1:5678`.

```powershell
docker compose -f docker/local-orchestrator/docker-compose.yml up -d
```

Import `n8n/blender-autopilot.json`. Point HTTP nodes at `http://host.docker.internal:11434` for Ollama.

Do not expose n8n beyond loopback. Do not paste the LTX Watch control token into n8n. Watch remains the only process allowed to launch Blender or LTX.
