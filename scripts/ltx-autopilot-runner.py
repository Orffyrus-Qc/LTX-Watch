#!/usr/bin/env python3
"""Local Auto-Pilot orchestrator: Ollama plans, Blender builds, LTX clothes.

The bridge passes only an ignored JSON job path. The planner may emit a scene
spec JSON, never Python. Blender is spawned with the bundled fixed adapter.
Optional LTX clothing reuses the official Create FLF2V runner.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


ALLOWED_PRIMITIVES = {
    "planet", "moon", "torus-halo", "gothic-machine-cathedral", "geodesic-biodome",
    "ship", "satellite", "laser", "camera-orbit", "empty-rig",
}


class AutopilotCancelled(RuntimeError):
    pass


def hide_subprocess_windows():
    if os.name != "nt" or getattr(subprocess, "_ltx_watch_hidden", False):
        return
    original_popen = subprocess.Popen

    def hidden_popen(*args, **kwargs):
        kwargs["creationflags"] = int(kwargs.get("creationflags", 0)) | subprocess.CREATE_NO_WINDOW
        startupinfo = kwargs.get("startupinfo") or subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = subprocess.SW_HIDE
        kwargs["startupinfo"] = startupinfo
        return original_popen(*args, **kwargs)

    subprocess.Popen = hidden_popen
    subprocess._ltx_watch_hidden = True


def utc_now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def resolved(value):
    return Path(value).expanduser().resolve()


def inside(candidate: Path, roots):
    candidate = candidate.resolve()
    for root in roots:
        try:
            candidate.relative_to(Path(root).resolve())
            return True
        except ValueError:
            continue
    return False


def write_json(file_path: Path, value):
    file_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = file_path.with_suffix(file_path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2)
        handle.write("\n")
    temporary.replace(file_path)


def progress(job, stage, percent, **extra):
    payload = {
        "status": extra.pop("status", "generating"),
        "kind": "blender-autopilot",
        "runnerPid": os.getpid(),
        "stage": stage,
        "progress": max(0, min(99, int(percent))),
        "updatedAt": utc_now(),
        **extra,
    }
    write_json(Path(job["resultPath"]), payload)


def cancellation_requested(job):
    cancel_path = job.get("cancelPath")
    return bool(cancel_path and Path(cancel_path).is_file())


def require_not_canceled(job):
    if cancellation_requested(job):
        raise AutopilotCancelled("Auto-Pilot canceled by user.")


def is_loopback(url: str):
    try:
        from urllib.parse import urlparse
        parsed = urlparse(url)
        return parsed.scheme == "http" and parsed.hostname in {"127.0.0.1", "localhost", "::1"}
    except Exception:
        return False


def validate_job(job):
    if job.get("kind") != "blender-autopilot" or job.get("animationAuthority") != "blender":
        raise RuntimeError("Job must declare Blender Auto-Pilot authority")
    runtime = resolved(job.get("runtimeRoot", ""))
    for key in ("specPath", "workingCopyPath", "outputRoot", "resultPath", "cancelPath"):
        if not job.get(key) or not inside(resolved(job[key]), [runtime]):
            raise RuntimeError(f"{key} escaped the private runtime")
    if job.get("sourcePath"):
        if resolved(job["sourcePath"]) == resolved(job["workingCopyPath"]):
            raise RuntimeError("Working copy cannot be the master scene")
    if job.get("ollamaUrl") and not is_loopback(str(job["ollamaUrl"])):
        raise RuntimeError("Ollama must stay on loopback")
    if job.get("clothWithLtx"):
        for key in ("createRunnerPath", "comfyRoot", "sourceRunner", "outputPrefix"):
            if not job.get(key):
                raise RuntimeError(f"LTX clothing is missing {key}")
    first = int(job.get("frameStart", 0))
    last = int(job.get("frameEnd", 0))
    if first < 1 or last < first or last - first + 1 > 600:
        raise RuntimeError("Invalid Auto-Pilot frame range")
    return {
        "ok": True,
        "kind": "blender-autopilot",
        "frames": last - first + 1,
        "animationAuthority": "blender",
        "preset": job.get("preset"),
        "clothWithLtx": bool(job.get("clothWithLtx")),
    }


def http_json(url, payload=None, timeout=120):
    data = None
    headers = {"Accept": "application/json"}
    method = "GET"
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
        method = "POST"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read()
    return json.loads(body.decode("utf-8") or "{}")


def extract_json_object(text: str):
    raw = str(text or "").strip()
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw.lower().startswith("json"):
            raw = raw[4:]
        raw = raw.strip()
    try:
        value = json.loads(raw)
        if isinstance(value, dict):
            return value
    except json.JSONDecodeError:
        pass
    start = raw.find("{")
    end = raw.rfind("}")
    if start >= 0 and end > start:
        value = json.loads(raw[start:end + 1])
        if isinstance(value, dict):
            return value
    raise RuntimeError("Local planner did not return JSON.")


def unload_ollama(job):
    url = str(job.get("ollamaUrl") or "").rstrip("/")
    model = str(job.get("ollamaModel") or "")
    if not url or not model or not is_loopback(url):
        return
    try:
        http_json(f"{url}/api/generate", {"model": model, "prompt": "", "keep_alive": 0}, timeout=10)
    except Exception:
        return


def plan_with_ollama(job, spec):
    url = str(job.get("ollamaUrl") or "").rstrip("/")
    model = str(job.get("ollamaModel") or "")
    if not url or not model:
        return spec, {"status": "skipped", "reason": "Ollama was not configured"}
    if not is_loopback(url):
        raise RuntimeError("Ollama must stay on loopback")
    lock_geometry = spec.get("preset") == "final-override-intro"
    user = {
        "task": "plan-blender-autopilot-scene",
        "lockGeometry": lock_geometry,
        "userPrompt": job.get("prompt") or "",
        "avoid": job.get("avoid") or "",
        "baseSpec": spec if lock_geometry else {
            "kind": "blender-autopilot-scene",
            "preset": "from-prompt",
            "allowedPrimitives": sorted(ALLOWED_PRIMITIVES),
        },
        "rules": [
            "Return one JSON object only.",
            "Use only allowlisted primitives.",
            "If lockGeometry is true, keep objects, camera blocking, and world; rewrite appearancePrompt, identities.lock, and shot prompts.",
            "Do not emit Python or file paths.",
        ],
    }
    payload = {
        "model": model,
        "stream": False,
        "format": "json",
        "keep_alive": 0,
        "options": {"temperature": 0.2},
        "messages": [
            {
                "role": "system",
                "content": "You are the local LTX Watch scene planner. Return only JSON for a blender-autopilot-scene. Never emit Python, bpy, or shell.",
            },
            {"role": "user", "content": json.dumps(user)},
        ],
    }
    try:
        response = http_json(f"{url}/api/chat", payload, timeout=180)
    except Exception as error:
        if lock_geometry:
            return spec, {"status": "degraded", "reason": f"Ollama planning failed; using canned intro spec ({error})"}
        raise RuntimeError(f"Local Ollama planning failed: {error}") from error
    message = ((response.get("message") or {}).get("content")) or response.get("response") or ""
    planned = extract_json_object(message)
    if lock_geometry:
        merged = json.loads(json.dumps(spec))
        if planned.get("appearancePrompt"):
            merged["appearancePrompt"] = str(planned["appearancePrompt"])[:4000]
        if planned.get("logline"):
            merged["logline"] = str(planned["logline"])[:400]
        planned_identities = {str(item.get("id")): item for item in (planned.get("identities") or []) if isinstance(item, dict)}
        for identity in merged.get("identities") or []:
            overlay = planned_identities.get(str(identity.get("id")))
            if overlay and overlay.get("lock"):
                identity["lock"] = str(overlay["lock"])[:800]
        planned_shots = {str(item.get("id")): item for item in (planned.get("shots") or []) if isinstance(item, dict)}
        for shot in merged.get("shots") or []:
            overlay = planned_shots.get(str(shot.get("id")))
            if overlay and overlay.get("prompt"):
                shot["prompt"] = str(overlay["prompt"])[:2000]
        return merged, {"status": "ok", "model": model, "geometryLocked": True}
    objects = [item for item in (planned.get("objects") or []) if isinstance(item, dict) and item.get("primitive") in ALLOWED_PRIMITIVES]
    if not objects:
        raise RuntimeError("Local planner returned no allowlisted objects.")
    planned["objects"] = objects[:24]
    planned["kind"] = "blender-autopilot-scene"
    planned["preset"] = "from-prompt"
    return planned, {"status": "ok", "model": model, "geometryLocked": False}


def compose_cloth_prompt(spec, job):
    identities = spec.get("identities") or []
    identity_block = "\n".join(
        f"- {item.get('name') or item.get('id')} ({item.get('role')}): {item.get('lock')}"
        for item in identities
        if item.get("lock")
    )
    shots = spec.get("shots") or []
    beat = " ".join(item.get("prompt") or "" for item in shots)
    parts = [
        spec.get("appearancePrompt") or job.get("prompt") or "",
        f"Beat: {beat}" if beat else "",
        f"Identity lock:\n{identity_block}" if identity_block else "",
        "Authority: Blender owns camera path, object placement, and large motion. LTX may only clothe materials, lighting atmosphere, and smaller secondary animation. Do not invent a new camera move or change landmark identity.",
        f"Avoid: {spec.get('avoid') or job.get('avoid')}" if (spec.get("avoid") or job.get("avoid")) else "",
    ]
    return "\n\n".join(part for part in parts if part)


def encode_backbone_mp4(job, first, last):
    output_root = resolved(job["outputRoot"])
    beauty = output_root / "beauty"
    target = output_root / "blender_backbone.mp4"
    comfy_root = resolved(job["comfyRoot"]) if job.get("comfyRoot") else None
    ffmpeg = Path("ffmpeg")
    if comfy_root and (comfy_root / "ffmpeg.exe").is_file():
        ffmpeg = comfy_root / "ffmpeg.exe"
    command = [
        str(ffmpeg), "-y",
        "-framerate", str(int(job["frameRate"])),
        "-start_number", str(int(first)),
        "-i", str(beauty / "frame_%04d.png"),
        "-frames:v", str(int(last) - int(first) + 1),
        "-c:v", "libx264", "-pix_fmt", "yuv420p",
        str(target),
    ]
    completed = subprocess.run(command, capture_output=True, timeout=600)
    if completed.returncode == 0 and target.is_file() and target.stat().st_size > 10_000:
        return str(target)
    return None


def run_blender(job):
    blender = Path(str(job.get("blenderExecutable") or ""))
    script = Path(str(job.get("blenderScriptPath") or ""))
    if not blender.is_file() or not script.is_file():
        raise RuntimeError("Blender executable or Auto-Pilot adapter is missing.")
    blender_job = {
        "kind": "blender-autopilot",
        "animationAuthority": "blender",
        "id": job["id"],
        "preset": job.get("preset"),
        "runtimeRoot": job["runtimeRoot"],
        "specPath": job["specPath"],
        "sourcePath": job.get("sourcePath") or "",
        "allowedSourceRoots": job.get("allowedSourceRoots") or [],
        "workingCopyPath": job["workingCopyPath"],
        "outputRoot": job["outputRoot"],
        "resultPath": str(resolved(job["runtimeRoot"]) / "blender-result.json"),
        "cancelPath": job["cancelPath"],
        "frameStart": job["frameStart"],
        "frameEnd": job["frameEnd"],
        "frameRate": job["frameRate"],
        "width": job["width"],
        "height": job["height"],
    }
    blender_job_path = resolved(job["runtimeRoot"]) / "blender-job.json"
    write_json(blender_job_path, blender_job)
    command = [
        str(blender),
        "--background",
        "--disable-autoexec",
        "--python", str(script),
        "--",
        "--job", str(blender_job_path),
    ]
    require_not_canceled(job)
    completed = subprocess.run(command, capture_output=True, timeout=14_400)
    result_path = resolved(blender_job["resultPath"])
    payload = {}
    if result_path.is_file():
        payload = json.loads(result_path.read_text(encoding="utf-8"))
    if completed.returncode != 0 and payload.get("status") != "canceled":
        detail = (completed.stderr or completed.stdout or b"").decode("utf-8", "replace")[-800:]
        raise RuntimeError(payload.get("error") or detail or "Blender Auto-Pilot failed.")
    if payload.get("status") == "canceled":
        raise AutopilotCancelled("Auto-Pilot canceled by user.")
    record_path = resolved(job["runtimeRoot"]) / "blender-record.json"
    if record_path.is_file():
        payload.update(json.loads(record_path.read_text(encoding="utf-8")))
    if not payload.get("firstFramePath"):
        raise RuntimeError("Blender Auto-Pilot did not write first/last anchors.")
    return payload


def run_cloth(job, spec, blender_result):
    create_runner = Path(str(job["createRunnerPath"]))
    if not create_runner.is_file():
        raise RuntimeError("The official Create runner is missing.")
    runtime = resolved(job["runtimeRoot"])
    cloth_root = runtime / "cloth"
    cloth_root.mkdir(parents=True, exist_ok=True)
    first = cloth_root / "first.png"
    last = cloth_root / "last.png"
    first.write_bytes(Path(blender_result["firstFramePath"]).read_bytes())
    last.write_bytes(Path(blender_result["lastFramePath"]).read_bytes())
    soundtrack = ""
    if job.get("soundtrackPath") and Path(job["soundtrackPath"]).is_file():
        suffix = Path(job["soundtrackPath"]).suffix.lower()
        target = cloth_root / f"soundtrack{suffix}"
        target.write_bytes(Path(job["soundtrackPath"]).read_bytes())
        soundtrack = str(target)
    cloth_job = {
        "id": f"{job['id']}-cloth",
        "sourceRunner": job["sourceRunner"],
        "comfyRoot": job["comfyRoot"],
        "runtimeRoot": str(cloth_root),
        "resultPath": str(cloth_root / "result.json"),
        "cancelPath": job["cancelPath"],
        "prompt": compose_cloth_prompt(spec, job),
        "promptEnhance": False,
        "duration": max(3, int(round((int(job["frameEnd"]) - int(job["frameStart"]) + 1) / float(job["frameRate"])))),
        "width": job["width"],
        "height": job["height"],
        "frameRate": job["frameRate"],
        "seed": job.get("seed") or 0,
        "audio": job.get("audio") or "generate",
        "referenceMode": "first-last",
        "referencePaths": [str(first), str(last)],
        "videoContextPath": None,
        "soundtrackPath": soundtrack or None,
        "director": None,
        "useBlender": False,
        "port": job.get("port") or 8188,
        "cudaDevice": job.get("cudaDevice") or 0,
        "safer": False,
        "outputPrefix": job["outputPrefix"],
        "timeoutSeconds": 7_200,
    }
    cloth_job_path = cloth_root / "job.json"
    write_json(cloth_job_path, cloth_job)
    write_json(Path(cloth_job["resultPath"]), {"status": "generating", "stage": "Starting LTX clothing", "progress": 0})
    require_not_canceled(job)
    completed = subprocess.run([sys.executable, str(create_runner), "--job", str(cloth_job_path)], timeout=14_400)
    payload = {}
    if Path(cloth_job["resultPath"]).is_file():
        payload = json.loads(Path(cloth_job["resultPath"]).read_text(encoding="utf-8"))
    if payload.get("status") == "canceled":
        raise AutopilotCancelled("Auto-Pilot canceled by user.")
    if completed.returncode != 0 or payload.get("status") != "complete" or not payload.get("outputPath"):
        raise RuntimeError(payload.get("error") or "LTX clothing did not produce a reviewable video.")
    return payload


def write_manifest(job, spec, blender_result, planner):
    frame_count = int(job["frameEnd"]) - int(job["frameStart"]) + 1
    manifest = {
        "schemaVersion": 1,
        "kind": "ltx-watch-blender-autopilot",
        "animationAuthority": "blender",
        "refinementAuthority": "appearance-only",
        "preset": job.get("preset"),
        "source": {
            "seedPath": job.get("sourcePath") or None,
            "workingCopyPath": job["workingCopyPath"],
            "specPath": job["specPath"],
        },
        "timeline": {
            "frameStart": int(job["frameStart"]),
            "frameEnd": int(job["frameEnd"]),
            "frameCount": frame_count,
            "frameRate": int(job["frameRate"]),
        },
        "resolution": {"width": int(job["width"]), "height": int(job["height"])},
        "identities": spec.get("identities") or [],
        "planner": planner,
        "blender": blender_result.get("blender"),
        "createdAt": utc_now(),
        "compatibility": {
            "ltxVersion": "2.5",
            "clothMode": "official-flf2v" if job.get("clothWithLtx") else "backbone-only",
            "refinementReady": False,
            "reason": "LTX clothing uses official first/last-frame appearance interpolation. Blender still owns camera and blocking.",
        },
    }
    path = resolved(job["outputRoot"]) / "manifest.json"
    write_json(path, manifest)
    return str(path)


def run_job(job):
    hide_subprocess_windows()
    validate_job(job)
    require_not_canceled(job)
    spec_path = resolved(job["specPath"])
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    progress(job, "Local AI is planning the Blender scene", 4)
    spec, planner = plan_with_ollama(job, spec)
    write_json(spec_path, spec)
    unload_ollama(job)
    require_not_canceled(job)
    progress(job, "Blender Auto-Pilot is building and recording the backbone", 8, planner=planner)
    blender_result = run_blender(job)
    require_not_canceled(job)
    video = encode_backbone_mp4(job, job["frameStart"], job["frameEnd"])
    manifest_path = write_manifest(job, spec, blender_result, planner)
    if job.get("clothWithLtx"):
        progress(job, "LTX is clothing the Blender backbone", 78, planner=planner, **{k: blender_result.get(k) for k in ("firstFramePath", "lastFramePath", "outputRoot")})
        unload_ollama(job)
        cloth = run_cloth(job, spec, blender_result)
        write_json(Path(job["resultPath"]), {
            "status": "complete",
            "kind": "blender-autopilot",
            "stage": "Complete",
            "progress": 100,
            "outputPath": cloth.get("outputPath"),
            "packagePath": blender_result.get("outputRoot"),
            "manifestPath": manifest_path,
            "backboneVideoPath": video,
            "planner": planner,
            "completedAt": utc_now(),
        })
        return
    write_json(Path(job["resultPath"]), {
        "status": "complete",
        "kind": "blender-autopilot",
        "stage": "Blender Auto-Pilot backbone ready",
        "progress": 100,
        "outputPath": video,
        "packagePath": blender_result.get("outputRoot"),
        "manifestPath": manifest_path,
        "backboneVideoPath": video,
        "planner": planner,
        "completedAt": utc_now(),
    })


def parse_arguments(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--job")
    parser.add_argument("--validate-job")
    return parser.parse_args(argv)


def main():
    args = parse_arguments(sys.argv[1:])
    job_path = args.validate_job or args.job
    if not job_path:
        raise SystemExit("A private job JSON path is required")
    job = json.loads(resolved(job_path).read_text(encoding="utf-8"))
    if args.validate_job:
        print(json.dumps(validate_job(job)))
        return
    try:
        run_job(job)
    except AutopilotCancelled:
        write_json(Path(job["resultPath"]), {"status": "canceled", "kind": "blender-autopilot", "stage": "Canceled", "progress": 0, "completedAt": utc_now()})
    except Exception as error:
        write_json(Path(job["resultPath"]), {
            "status": "failed",
            "kind": "blender-autopilot",
            "stage": "Failed",
            "progress": 0,
            "error": str(error)[:1000],
            "completedAt": utc_now(),
        })
        raise


if __name__ == "__main__":
    main()
