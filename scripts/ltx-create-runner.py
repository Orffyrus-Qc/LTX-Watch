"""Guarded local LTX 2.5 creation adapter.

The bridge passes only an ignored JSON job path on the command line. Prompts,
reference paths, and Blender paths never appear in process arguments or git.
"""

from __future__ import annotations

import argparse
import copy
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

VIDEO_SUFFIXES = {".mp4", ".webm", ".mov", ".mkv"}
CONNECTION_TYPES = {
    "MODEL", "CLIP", "VAE", "CONDITIONING", "LATENT", "NOISE", "SAMPLER",
    "SIGMAS", "GUIDER", "IMAGE", "AUDIO", "VIDEO", "LATENT_UPSCALE_MODEL",
    "*", "MASK", "IMAGE,MASK", "COMFY_MATCHTYPE_V3",
}

MODEL_FORMAT_TOKEN = re.compile(r"^(?:(?:int|fp|bf|nf|q)\d+[a-z0-9_]*|convrot|gguf|awq|gptq)$")
GENERIC_FILENAME_TOKENS = {"safetensors", "ckpt", "pt", "pth", "bin", "model", "models"}


def read_json(file_path: Path):
    with file_path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(file_path: Path, value):
    file_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = file_path.with_suffix(file_path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2)
        handle.write("\n")
    temporary.replace(file_path)


def progress(job, stage, percent, **extra):
    write_json(Path(job["resultPath"]), {
        "status": "generating",
        "runnerPid": os.getpid(),
        "stage": stage,
        "progress": max(0, min(99, int(percent))),
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        **extra,
    })


def inside(candidate: Path, roots):
    resolved = candidate.resolve()
    for root in roots:
        try:
            resolved.relative_to(Path(root).resolve())
            return True
        except ValueError:
            continue
    return False


def load_module(file_path: Path, name: str):
    source_directory = str(file_path.parent.resolve())
    if source_directory not in sys.path:
        sys.path.insert(0, source_directory)
    spec = importlib.util.spec_from_file_location(name, file_path)
    if not spec or not spec.loader:
        raise RuntimeError("Could not load the configured local LTX runner.")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _filename_tokens(value):
    filename = str(value or "").replace("\\", "/").rsplit("/", 1)[-1].lower()
    return re.findall(r"[a-z]+\d+[a-z0-9]*|\d+[a-z]+|[a-z]+", filename)


def reconcile_combo_value(value, definition):
    """Reconcile a renamed template enum only when the live match is unambiguous."""
    if not isinstance(definition, list) or not definition or not isinstance(definition[0], list):
        return value
    choices = [item for item in definition[0] if isinstance(item, str)]
    if not isinstance(value, str) or not choices or value in choices:
        return value
    if len(choices) == 1:
        return choices[0]

    source_tokens = _filename_tokens(value)
    source_set = set(source_tokens)
    format_tokens = {token for token in source_set if MODEL_FORMAT_TOKEN.fullmatch(token)}
    family = next((token for token in source_tokens if token not in format_tokens and token not in GENERIC_FILENAME_TOKENS), None)
    candidates = []
    for choice in choices:
        candidate_tokens = set(_filename_tokens(choice))
        if format_tokens and not format_tokens.issubset(candidate_tokens):
            continue
        if family and family not in candidate_tokens:
            continue
        candidates.append(choice)
    return candidates[0] if len(candidates) == 1 else value


def locate_template(comfy_root: Path, mode: str):
    names = {
        "text": "video_ltx2_5_t2v.json",
        "first-frame": "video_ltx2_5_i2v.json",
        "first-last": "video_ltx2_5_flf2v.json",
    }
    name = names[mode]
    candidates = [
        comfy_root / "venv" / "Lib" / "site-packages" / "comfyui_workflow_templates_json" / "templates" / name,
        comfy_root / ".venv" / "Lib" / "site-packages" / "comfyui_workflow_templates_json" / "templates" / name,
        comfy_root / "python_embeded" / "Lib" / "site-packages" / "comfyui_workflow_templates_json" / "templates" / name,
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise RuntimeError(f"ComfyUI's official local {name} workflow is not installed.")


class WorkflowCompiler:
    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")
        self.object_cache = {}

    def object_info(self, class_type):
        if class_type not in self.object_cache:
            with urllib.request.urlopen(f"{self.base_url}/object_info/{class_type}", timeout=30) as response:
                payload = json.load(response)
            if class_type not in payload:
                raise RuntimeError(f"ComfyUI does not provide the required {class_type} node.")
            self.object_cache[class_type] = payload[class_type]
        return self.object_cache[class_type]

    @staticmethod
    def _input_label(item):
        return str(item.get("label") or item.get("name") or "").strip().lower()

    def compile(self, workflow, overrides, reference_names, output_prefix):
        graph = copy.deepcopy(workflow)
        subgraphs = graph.get("definitions", {}).get("subgraphs", [])
        if len(subgraphs) != 1:
            raise RuntimeError("The official LTX workflow structure changed: expected one subgraph.")
        subgraph = subgraphs[0]
        subgraph_node = next((node for node in graph.get("nodes", []) if node.get("type") == subgraph.get("id")), None)
        if not subgraph_node:
            raise RuntimeError("The official LTX workflow subgraph node is missing.")

        sub_inputs = subgraph.get("inputs", [])
        widget_index_by_input = {}
        widget_index = 0
        for index, sub_input in enumerate(sub_inputs):
            input_type = sub_input.get("type", "")
            if not (isinstance(input_type, str) and input_type in CONNECTION_TYPES):
                widget_index_by_input[index] = widget_index
                widget_index += 1

        top_inputs_by_name = {item.get("name"): item for item in subgraph_node.get("inputs", [])}
        for index, sub_input in enumerate(sub_inputs):
            label = self._input_label(sub_input)
            if label == "fram_rate":  # spelling used by the official FLF2V 2.5 template
                label = "frame_rate"
            if label not in overrides or index not in widget_index_by_input:
                continue
            top_input = top_inputs_by_name.get(sub_input.get("name"))
            if top_input:
                top_input["link"] = None
            slot = widget_index_by_input[index]
            widgets = subgraph_node.setdefault("widgets_values", [])
            if slot >= len(widgets):
                raise RuntimeError(f"The official LTX workflow no longer exposes the {label} setting.")
            widgets[slot] = overrides[label]

        load_images = [node for node in graph.get("nodes", []) if node.get("type") == "LoadImage"]
        load_images.sort(key=lambda node: ("first" not in str(node.get("title", "")).lower(), str(node.get("title", "")).lower()))
        if len(reference_names) > len(load_images):
            raise RuntimeError("The selected official workflow does not expose enough reference-frame inputs.")
        for node, reference_name in zip(load_images, reference_names):
            widgets = node.setdefault("widgets_values", [])
            if widgets:
                widgets[0] = reference_name
            else:
                widgets.append(reference_name)

        for node in graph.get("nodes", []):
            if node.get("type") == "SaveVideo":
                widgets = node.setdefault("widgets_values", [])
                if widgets:
                    widgets[0] = output_prefix

        top_links = {link[0]: (link[1], link[2]) for link in graph.get("links", [])}
        internal_links = {link["id"]: (link["origin_id"], link["origin_slot"]) for link in subgraph.get("links", [])}
        connected_top_inputs = {
            item.get("name"): item.get("link")
            for item in subgraph_node.get("inputs", [])
            if item.get("link") is not None
        }

        input_resolution = {}
        widget_index = 0
        for index, sub_input in enumerate(sub_inputs):
            input_type = sub_input.get("type", "")
            is_connection = isinstance(input_type, str) and input_type in CONNECTION_TYPES
            name = sub_input.get("name")
            if name in connected_top_inputs:
                origin_id, origin_slot = top_links[connected_top_inputs[name]]
                input_resolution[index] = ("node", origin_id, origin_slot)
                if not is_connection:
                    widget_index += 1
            else:
                widgets = subgraph_node.get("widgets_values", [])
                if widget_index >= len(widgets):
                    raise RuntimeError("The official LTX workflow input layout changed.")
                input_resolution[index] = ("constant", widgets[widget_index])
                widget_index += 1

        output_resolution = {}
        for link in subgraph.get("links", []):
            if link.get("target_id") == -20:
                output_resolution[link["target_slot"]] = (link["origin_id"], link["origin_slot"])

        def resolve_link(link_id, internal):
            table = internal_links if internal else top_links
            origin_id, origin_slot = table[link_id]
            if origin_id == -10:
                resolved = input_resolution[origin_slot]
                return resolved[1] if resolved[0] == "constant" else [str(resolved[1]), resolved[2]]
            if origin_id == subgraph_node.get("id"):
                real_id, real_slot = output_resolution[origin_slot]
                return [str(real_id), real_slot]
            return [str(origin_id), origin_slot]

        top_nodes = [
            node for node in graph.get("nodes", [])
            if node.get("type") not in {"MarkdownNote", "ResolutionSelector", subgraph.get("id")}
        ]
        all_nodes = [(node, False) for node in top_nodes] + [(node, True) for node in subgraph.get("nodes", [])]
        prompt = {}
        for node, internal in all_nodes:
            class_type = node.get("type")
            metadata = self.object_info(class_type)
            required = metadata.get("input", {}).get("required", {})
            optional = metadata.get("input", {}).get("optional", {})
            parameters = list(required.items()) + list(optional.items())
            linked = {
                item["name"]: resolve_link(item["link"], internal)
                for item in node.get("inputs", [])
                if item.get("link") is not None
            }
            widgets = list(node.get("widgets_values", []))
            compiled_inputs = {}
            for name, definition in parameters:
                parameter_type = definition[0] if isinstance(definition, list) else definition
                is_connection = isinstance(parameter_type, str) and parameter_type in CONNECTION_TYPES
                if parameter_type == "COMFY_AUTOGROW_V3":
                    continue
                if parameter_type == "COMFY_DYNAMICCOMBO_V3":
                    mode = linked[name] if name in linked else widgets.pop(0) if widgets else None
                    compiled_inputs[name] = mode
                    options = definition[1].get("options", []) if isinstance(definition, list) and len(definition) > 1 else []
                    selected = next((option for option in options if option.get("key") == mode), None)
                    for sub_name in (selected or {}).get("inputs", {}).get("required", {}):
                        dotted = f"{name}.{sub_name}"
                        compiled_inputs[dotted] = linked[dotted] if dotted in linked else widgets.pop(0) if widgets else None
                    continue
                if name in linked:
                    compiled_inputs[name] = linked[name]
                    if not is_connection and widgets:
                        widgets.pop(0)
                elif not is_connection and widgets:
                    compiled_inputs[name] = reconcile_combo_value(widgets.pop(0), definition)
            for name, value in linked.items():
                compiled_inputs.setdefault(name, value)
            if class_type == "SaveVideo":
                compiled_inputs["filename_prefix"] = output_prefix
            prompt[str(node["id"])] = {"class_type": class_type, "inputs": compiled_inputs}
        return prompt


def submit(base_url, prompt, client_id):
    request = urllib.request.Request(
        f"{base_url}/prompt",
        data=json.dumps({"prompt": prompt, "client_id": client_id}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:2_000]
        raise RuntimeError(f"ComfyUI rejected the LTX workflow ({error.code}): {detail}") from error


def render_blender_frames(job, runtime_root: Path):
    executable = Path(job["blenderExecutable"])
    backbone = Path(job["blenderProjectPath"])
    allowed = [Path(root) for root in job.get("allowedProjectRoots", [])]
    if not executable.is_file() or executable.name.lower() != "blender.exe":
        raise RuntimeError("The configured Blender executable is unavailable.")
    if not backbone.is_file() or backbone.suffix.lower() != ".blend" or not inside(backbone, allowed):
        raise RuntimeError("The selected Blender backbone is outside the active project.")
    blender_root = runtime_root / "blender"
    blender_root.mkdir(parents=True, exist_ok=True)
    working_copy = blender_root / "backbone.blend"
    shutil.copy2(backbone, working_copy)
    frames = [int(job["blenderFirstFrame"])]
    if job["referenceMode"] == "first-last":
        frames.append(int(job["blenderLastFrame"]))
    rendered = []
    for index, frame in enumerate(frames):
        prefix = blender_root / f"reference_{index + 1}_"
        command = [
            str(executable), "--background", "--disable-autoexec", str(working_copy),
            "--render-output", str(prefix), "--render-format", "PNG",
            "--render-frame", str(frame),
        ]
        completed = subprocess.run(command, cwd=blender_root, capture_output=True, text=True, timeout=900)
        if completed.returncode != 0:
            detail = (completed.stderr or completed.stdout or "Blender render failed.")[-1_500:]
            raise RuntimeError(f"Blender could not render frame {frame}: {detail}")
        candidates = sorted(blender_root.glob(f"reference_{index + 1}_*.png"), key=lambda item: item.stat().st_mtime, reverse=True)
        if not candidates:
            raise RuntimeError(f"Blender finished without producing reference frame {frame}.")
        rendered.append(candidates[0])
    return rendered


def ffmpeg_executable(source_runner, comfy_root: Path):
    configured = Path(str(getattr(source_runner, "FFMPEG", "ffmpeg")))
    if configured.is_file():
        return configured
    local = comfy_root / "ffmpeg.exe"
    return local if local.is_file() else Path("ffmpeg")


def extract_video_references(video_path: Path, runtime_root: Path, mode: str, ffmpeg: Path):
    if not video_path.is_file() or not inside(video_path, [runtime_root]):
        raise RuntimeError("The private context video is unavailable.")
    frame_root = runtime_root / "video-references"
    frame_root.mkdir(parents=True, exist_ok=True)
    first = frame_root / "first.png"
    commands = [[str(ffmpeg), "-y", "-i", str(video_path), "-frames:v", "1", str(first)]]
    outputs = [first]
    if mode == "first-last":
        last = frame_root / "last.png"
        commands.append([str(ffmpeg), "-y", "-sseof", "-0.15", "-i", str(video_path), "-frames:v", "1", str(last)])
        outputs.append(last)
    for command, output in zip(commands, outputs):
        completed = subprocess.run(command, capture_output=True, timeout=300)
        if completed.returncode != 0 or not output.is_file() or output.stat().st_size < 1_000:
            raise RuntimeError("FFmpeg could not extract visual anchors from the context video.")
    return outputs


def prepare_reference_files(job, runtime_root: Path, comfy_root: Path, source_runner):
    references = []
    if job.get("useBlender"):
        references = render_blender_frames(job, runtime_root)
    elif job.get("videoContextPath"):
        references = extract_video_references(Path(job["videoContextPath"]), runtime_root, job["referenceMode"], ffmpeg_executable(source_runner, comfy_root))
    else:
        references = [Path(item) for item in job.get("referencePaths", [])]
        if any(not item.is_file() or not inside(item, [runtime_root]) for item in references):
            raise RuntimeError("A reference frame is missing from the private Create job folder.")
    destination = comfy_root / "input" / "ltx-watch-create" / job["id"]
    destination.mkdir(parents=True, exist_ok=True)
    relative_names = []
    for index, source in enumerate(references):
        suffix = source.suffix.lower() if source.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"} else ".png"
        target = destination / f"reference_{index + 1}{suffix}"
        shutil.copy2(source, target)
        relative_names.append(f"ltx-watch-create/{job['id']}/{target.name}")
    return relative_names


def newest_output(output_root: Path, prefix: str, started_at: float):
    directory = output_root / Path(prefix).parent
    stem = Path(prefix).name
    candidates = []
    if directory.is_dir():
        for item in directory.iterdir():
            if item.is_file() and item.suffix.lower() in VIDEO_SUFFIXES and item.name.startswith(stem):
                stat = item.stat()
                if stat.st_size > 100_000 and stat.st_mtime >= started_at - 3:
                    candidates.append((stat.st_mtime, item))
    return max(candidates, default=(0, None))[1]


def strip_audio(file_path: Path, source_runner):
    ffmpeg = Path(getattr(source_runner, "FFMPEG", "ffmpeg"))
    target = file_path.with_name(file_path.stem + "_silent" + file_path.suffix)
    completed = subprocess.run([str(ffmpeg), "-y", "-i", str(file_path), "-c:v", "copy", "-an", str(target)], capture_output=True, timeout=300)
    if completed.returncode != 0 or not target.is_file() or target.stat().st_size <= 100_000:
        raise RuntimeError("The video rendered, but its audio track could not be removed.")
    target.replace(file_path)


def replace_audio(file_path: Path, soundtrack_path: Path, source_runner, comfy_root: Path, runtime_root: Path):
    if not soundtrack_path.is_file() or not inside(soundtrack_path, [runtime_root]):
        raise RuntimeError("The private soundtrack is unavailable.")
    ffmpeg = ffmpeg_executable(source_runner, comfy_root)
    target = file_path.with_name(file_path.stem + "_soundtrack" + file_path.suffix)
    command = [
        str(ffmpeg), "-y", "-stream_loop", "-1", "-i", str(soundtrack_path), "-i", str(file_path),
        "-map", "1:v:0", "-map", "0:a:0", "-c:v", "copy", "-c:a", "aac", "-shortest", str(target),
    ]
    completed = subprocess.run(command, capture_output=True, timeout=600)
    if completed.returncode != 0 or not target.is_file() or target.stat().st_size <= 100_000:
        raise RuntimeError("The video rendered, but the context soundtrack could not be applied.")
    target.replace(file_path)


def validate_job(job):
    required = ["id", "sourceRunner", "comfyRoot", "resultPath", "runtimeRoot", "prompt", "referenceMode", "outputPrefix"]
    missing = [key for key in required if not job.get(key)]
    if missing:
        raise RuntimeError(f"Create job is missing: {', '.join(missing)}")
    if job["referenceMode"] not in {"text", "first-frame", "first-last"}:
        raise RuntimeError("Unsupported LTX creation mode.")
    runtime_root = Path(job["runtimeRoot"]).resolve()
    if not inside(Path(job["resultPath"]), [runtime_root]):
        raise RuntimeError("Create result path is outside the private runtime folder.")
    for key in ("videoContextPath", "soundtrackPath"):
        if job.get(key) and not inside(Path(job[key]), [runtime_root]):
            raise RuntimeError(f"{key} is outside the private Create job folder.")
    for reference in job.get("referencePaths", []):
        if not inside(Path(reference), [runtime_root]):
            raise RuntimeError("A reference path is outside the private Create job folder.")
    return runtime_root


def run_job(job):
    runtime_root = validate_job(job)
    result_path = Path(job["resultPath"])
    started = time.time()
    progress(job, "Preparing local workflow", 3)
    comfy_root = Path(job["comfyRoot"]).resolve()
    source_path = Path(job["sourceRunner"]).resolve()
    if not source_path.is_file() or not inside(source_path, [comfy_root]):
        raise RuntimeError("The compatible LTX source runner is unavailable.")
    source = load_module(source_path, "ltx_watch_create_source")
    required_functions = ["parse_args", "apply_args", "acquire_lock", "release_lock", "start_comfy_server", "stop_comfy_server", "wait_for_server", "wait_for_history"]
    if any(not callable(getattr(source, name, None)) for name in required_functions):
        raise RuntimeError("The configured source runner does not expose the required guarded server lifecycle.")

    references = prepare_reference_files(job, runtime_root, comfy_root, source)
    mode = job["referenceMode"]
    if job.get("useBlender") and mode == "text":
        mode = "first-frame"
    template = read_json(locate_template(comfy_root, mode))
    base_url = f"http://127.0.0.1:{int(job['port'])}"
    worker_name = f"create-{job['id'][:8]}"
    args = source.parse_args([
        "--port", str(int(job["port"])), "--cuda-device", str(int(job["cudaDevice"])),
        "--worker-name", worker_name,
        "--log", str(runtime_root / "server.log"),
        "--inductor-cache", str(runtime_root / "inductor-cache"),
    ])
    source.apply_args(args)
    lock_root = Path(getattr(source, "LOCK_DIR", runtime_root / "locks"))
    lock_root.mkdir(parents=True, exist_ok=True)
    lock_path = lock_root / f"port_{int(job['port'])}.lock"
    if not source.acquire_lock(str(lock_path), f"LTX Watch Create port {int(job['port'])}"):
        raise RuntimeError("The selected ComfyUI port is already reserved by another local job.")

    server = None
    server_log = None
    try:
        progress(job, "Starting isolated ComfyUI", 8)
        server, server_log = source.start_comfy_server("ltx_watch_create", job["id"][:8], safer=bool(job.get("safer", False)))
        if server is None or not source.wait_for_server(base_url):
            raise RuntimeError("The isolated ComfyUI server could not start.")
        progress(job, "Compiling official LTX 2.5 workflow", 14)
        overrides = {
            "prompt": job["prompt"],
            "prompt_enhance": bool(job.get("promptEnhance")),
            "duration": int(job["duration"]),
            "width": int(job["width"]),
            "height": int(job["height"]),
            "seed": int(job["seed"]),
            "frame_rate": int(job["frameRate"]),
        }
        compiler = WorkflowCompiler(base_url)
        prompt = compiler.compile(template, overrides, list(references), job["outputPrefix"])
        progress(job, "Loading models and sampling frames", 20)
        response = submit(base_url, prompt, f"ltx-watch-create-{job['id']}")
        prompt_id = response.get("prompt_id")
        if not prompt_id:
            raise RuntimeError("ComfyUI did not return a prompt id.")
        progress(job, "Sampling frames", 28, promptId=prompt_id)
        outcome, _history = source.wait_for_history(base_url, prompt_id, timeout=int(job.get("timeoutSeconds", 7_200)))
        if outcome != "completed":
            raise RuntimeError(f"ComfyUI ended the Create job with status: {outcome}.")
        progress(job, "Finalizing video", 96, promptId=prompt_id)
    finally:
        if server is not None:
            source.stop_comfy_server(server, server_log, base_url)
        source.release_lock(str(lock_path))

    output = newest_output(comfy_root / "output", job["outputPrefix"], started)
    if not output:
        raise RuntimeError("ComfyUI completed but no reviewable video was found in the Create output folder.")
    if job.get("audio") == "silent":
        strip_audio(output, source)
    elif job.get("audio") == "soundtrack":
        replace_audio(output, Path(job.get("soundtrackPath", "")), source, comfy_root, runtime_root)
    completed_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    write_json(result_path, {
        "status": "complete", "runnerPid": os.getpid(), "progress": 100,
        "stage": "Complete", "promptId": prompt_id,
        "outputPath": str(output.resolve()), "completedAt": completed_at,
    })


def main(argv=None):
    parser = argparse.ArgumentParser(description="LTX Watch local text-to-video adapter")
    parser.add_argument("--job", type=Path)
    parser.add_argument("--validate-job", type=Path)
    args = parser.parse_args(argv)
    job_path = args.validate_job or args.job
    if not job_path:
        parser.error("--job is required")
    job = read_json(job_path.resolve())
    try:
        runtime_root = validate_job(job)
        if args.validate_job:
            print(json.dumps({"ok": True, "mode": job["referenceMode"], "variations": 1}))
            return 0
        run_job(job)
        return 0
    except Exception as error:  # the bridge turns this private result into a bounded UI message
        if args.job:
            result_path = Path(job.get("resultPath", runtime_root / "invalid.result.json" if "runtime_root" in locals() else job_path.with_suffix(".result.json")))
            write_json(result_path, {
                "status": "failed", "runnerPid": os.getpid(), "progress": 0,
                "stage": "Failed", "error": str(error)[:1_500],
                "completedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            })
        else:
            print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
