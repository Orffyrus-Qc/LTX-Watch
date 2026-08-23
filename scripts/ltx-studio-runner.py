"""Run one reviewed LTX shot through an existing album runner.

The Node bridge writes an ignored local JSON job and launches this adapter with
pythonw.exe. Prompt corrections therefore never appear in the process command
line or in the public repository.
"""

import argparse
import glob
import importlib.util
import json
import math
import os
import sys
import time
import traceback


def iso_now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def write_json(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temp = path + ".tmp"
    with open(temp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
        handle.write("\n")
    os.replace(temp, path)


def load_job(path):
    with open(path, encoding="utf-8") as handle:
        payload = json.load(handle)
    required = ("sourceRunner", "section", "track", "slug", "shot", "resultPath")
    if any(not isinstance(payload.get(key), str) or not payload[key] for key in required):
        raise ValueError("Studio job is missing a required string field.")
    payload["correction"] = str(payload.get("correction") or "").strip()
    if len(payload["correction"]) > 2000:
        raise ValueError("Correction notes exceed 2000 characters.")
    payload["port"] = int(payload.get("port", 8188))
    payload["cudaDevice"] = int(payload.get("cudaDevice", 0))
    return payload


def load_source_runner(source_path):
    source_path = os.path.abspath(source_path)
    spec = importlib.util.spec_from_file_location("ltx_watch_studio_source_runner", source_path)
    if spec is None or spec.loader is None:
        raise RuntimeError("The configured source runner could not be loaded.")
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, os.path.dirname(source_path))
    spec.loader.exec_module(module)
    required = ("parse_args", "apply_args", "load_timing", "group_rows", "folder_slug_for", "prepare_track_inputs", "run_shot", "acquire_lock", "release_lock")
    missing = [name for name in required if not callable(getattr(module, name, None))]
    if missing:
        raise RuntimeError("Source runner does not expose the Studio adapter contract: " + ", ".join(missing))
    return module


def find_shot(module, job):
    for key, rows in module.group_rows(module.load_timing()):
        section, track = key
        slug = module.folder_slug_for(track)
        if section != job["section"] or track != job["track"] or slug != job["slug"]:
            continue
        for row in rows:
            if str(row.get("number")) == job["shot"]:
                return row
    raise RuntimeError("The requested scene/shot was not found in the source runner timing data.")


def configure_runner(module, job):
    comfy_root = os.path.dirname(os.path.abspath(job["sourceRunner"]))
    log_path = os.path.join(comfy_root, "ltx-watch-studio-runner.log")
    cache_path = os.path.join(comfy_root, "runtime", "ltx-watch-studio", "inductor")
    args = module.parse_args([
        "--port", str(job["port"]),
        "--cuda-device", str(job["cudaDevice"]),
        "--worker-name", "ltx-watch-studio",
        "--log", log_path,
        "--inductor-cache", cache_path,
        "--only-tracks", job["slug"],
    ])
    module.apply_args(args)
    base_prompt = str(getattr(module, "GENERIC_MOTION_PROMPT", "")).strip()
    if job["correction"]:
        module.GENERIC_MOTION_PROMPT = (
            base_prompt
            + "\n\nCreator correction for this reviewed attempt. Apply it while preserving the source frame: "
            + job["correction"]
        )


def newest_output(module, slug, shot):
    output_root = os.path.abspath(module.OUTPUT_ROOT)
    candidates = [
        item for item in glob.glob(os.path.join(output_root, slug, shot + "*.mp4"))
        if os.path.isfile(item) and os.path.getsize(item) > 100_000
    ]
    return max(candidates, key=os.path.getmtime) if candidates else None


def run(job):
    module = load_source_runner(job["sourceRunner"])
    configure_runner(module, job)
    row = find_shot(module, job)
    module.prepare_track_inputs([row], job["slug"])
    lock_path = os.path.join(module.LOCK_DIR, f"port_{job['port']}.lock")
    if not module.acquire_lock(lock_path, f"Studio port {job['port']} / cuda {job['cudaDevice']}"):
        raise RuntimeError("The selected GPU/ComfyUI port is still owned by another LTX worker.")
    try:
        duration = max(1, math.ceil(float(row["duration_sec"])))
        outcome = module.run_shot(job["shot"], duration, job["slug"])
    finally:
        module.release_lock(lock_path)
    if outcome != "completed":
        raise RuntimeError(f"Single-shot generation ended with status: {outcome}")
    output_path = newest_output(module, job["slug"], job["shot"])
    if not output_path:
        raise RuntimeError("The runner completed but no playable shot output was found.")
    return {"status": "review", "outputPath": output_path, "completedAt": iso_now()}


def main():
    parser = argparse.ArgumentParser(description="LTX Watch Studio single-shot adapter")
    parser.add_argument("--job", required=True)
    args = parser.parse_args()
    job = None
    result_path = None
    try:
        job = load_job(os.path.abspath(args.job))
        result_path = os.path.abspath(job["resultPath"])
        write_json(result_path, {"status": "generating", "startedAt": iso_now(), "runnerPid": os.getpid()})
        write_json(result_path, run(job))
        return 0
    except Exception as error:
        if result_path:
            write_json(result_path, {
                "status": "failed",
                "completedAt": iso_now(),
                "error": str(error),
                "detail": traceback.format_exc(limit=4),
            })
        return 1


if __name__ == "__main__":
    sys.exit(main())
