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
import threading
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
UI_ONLY_NODE_TYPES = {"MarkdownNote", "Note", "ResolutionSelector", "Reroute"}

MODEL_FORMAT_TOKEN = re.compile(r"^(?:(?:int|fp|bf|nf|q)\d+[a-z0-9_]*|convrot|gguf|awq|gptq)$")
GENERIC_FILENAME_TOKENS = {"safetensors", "ckpt", "pt", "pth", "bin", "model", "models"}


class CreateCancelled(RuntimeError):
    pass


def hide_subprocess_windows():
    """Prevent ComfyUI, Blender, FFmpeg, and helper consoles on Windows."""
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


def cancellation_requested(job):
    cancel_path = job.get("cancelPath")
    return bool(cancel_path and Path(cancel_path).is_file())


def require_not_canceled(job):
    if cancellation_requested(job):
        raise CreateCancelled("Create render canceled by user.")


def request_comfy_interrupt(base_url: str):
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/interrupt",
        data=b"{}",
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=3) as response:
        response.read(1)


def watch_for_cancellation(job, base_url: str, stop_event: threading.Event, seen_event: threading.Event):
    while not stop_event.wait(0.5):
        if not cancellation_requested(job):
            continue
        seen_event.set()
        try:
            request_comfy_interrupt(base_url)
        except Exception:
            continue


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


def reconcile_combo_value(value, definition, semantic_role=None):
    """Reconcile a renamed template enum only when the live match is unambiguous."""
    if not isinstance(definition, list) or not definition or not isinstance(definition[0], list):
        return value
    choices = [item for item in definition[0] if isinstance(item, str)]
    if not isinstance(value, str) or not choices:
        return value

    if semantic_role == "prompt_enhance_model":
        # The enhancer and the projected LTX text encoder are both Gemma 4
        # checkpoints, but they are not interchangeable. Prefer the sole
        # dedicated e2b-it checkpoint even when the installed precision differs
        # from the stale template default; never feed the main with-proj encoder
        # into TextGenerateLTX2Prompt.
        role_candidates = []
        for choice in choices:
            candidate_tokens = set(_filename_tokens(choice))
            if {"e2b", "it"}.issubset(candidate_tokens) and not {"with", "proj"}.issubset(candidate_tokens):
                role_candidates.append(choice)
        if len(role_candidates) == 1:
            return role_candidates[0]
        if role_candidates:
            choices = role_candidates
        else:
            return value

    if semantic_role == "ltx_text_encoder":
        # The projected LTX encoder and the standalone e2b-it prompt enhancer
        # are both Gemma 4 files. Only a with-proj LTX checkpoint is valid for
        # CLIPLoader conditioning, even when its installed precision differs.
        role_candidates = []
        for choice in choices:
            candidate_tokens = set(_filename_tokens(choice))
            if {"with", "proj", "ltx"}.issubset(candidate_tokens) and not {"e2b", "it"}.issubset(candidate_tokens):
                role_candidates.append(choice)
        if value in role_candidates:
            return value
        if len(role_candidates) == 1:
            return role_candidates[0]
        if role_candidates:
            choices = role_candidates
        else:
            return value

    if semantic_role == "ltx_checkpoint":
        # GemmaAPITextEncode reads the LTX model id from checkpoint metadata.
        # A models/checkpoints folder may also contain unrelated checkpoints
        # (for example SAM), so select only the sole LTX transformer candidate.
        role_candidates = []
        for choice in choices:
            candidate_tokens = set(_filename_tokens(choice))
            if "ltx" in candidate_tokens and "transformer" in candidate_tokens:
                role_candidates.append(choice)
        if len(role_candidates) == 1:
            return role_candidates[0]
        if role_candidates:
            choices = role_candidates
        else:
            return value

    if value in choices:
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


def reconcile_widget_value(value, definition, semantic_role=None):
    """Never treat an uploaded file selector as a renamed model enum."""
    options = definition[1] if isinstance(definition, list) and len(definition) > 1 and isinstance(definition[1], dict) else {}
    if options.get("image_upload"):
        return value
    return reconcile_combo_value(value, definition, semantic_role)


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


def locate_director_template(job, comfy_root: Path):
    director = job.get("director") or {}
    candidate = Path(str(director.get("workflowPath") or "")).resolve()
    expected_name = "LTX-2.5_ICLoRA_Ingredients_Single_Stage_Distilled.json"
    if candidate.name != expected_name or not candidate.is_file() or not inside(candidate, [comfy_root]):
        raise RuntimeError("The official LTX 2.5 Ingredients workflow is unavailable or outside ComfyUI.")
    return candidate


def director_relay_inputs(job):
    director = job.get("director") or {}
    segments = director.get("segments") or []
    if len(segments) < 2:
        raise RuntimeError("Director mode needs at least two timed segments.")
    durations = [int(segment.get("duration") or 0) for segment in segments]
    prompts = [str(segment.get("prompt") or "").strip().replace("|", "/") for segment in segments]
    if any(duration < 1 or duration > 10 for duration in durations) or any(not prompt for prompt in prompts):
        raise RuntimeError("Director segment durations or prompts are invalid.")
    frame_rate = int(job["frameRate"])
    requested_frames = sum(durations) * frame_rate
    workflow_frames = 1 + (requested_frames // 8) * 8
    frame_lengths = [duration * frame_rate for duration in durations]
    frame_lengths[-1] += workflow_frames - sum(frame_lengths)
    return {
        "global_prompt": str(job["prompt"]),
        "local_prompts": "|".join(prompts),
        "segment_lengths": ",".join(str(length) for length in frame_lengths),
        "epsilon": float(director.get("transition", 0.001)),
    }


def director_conditioning_prompt(job):
    """Match PromptRelay's combined token sequence through ComfyUI's native encoder."""
    relay_inputs = director_relay_inputs(job)
    locals_list = [item.strip() for item in relay_inputs["local_prompts"].split("|") if item.strip()]
    return relay_inputs["global_prompt"] + "".join(f" {item}" for item in locals_list)


def patch_director_prompt(prompt, job):
    relay_inputs = director_relay_inputs(job)

    def keys_for(class_type):
        return [key for key, node in prompt.items() if node.get("class_type") == class_type]

    model_keys = keys_for("LTXICLoRALoaderModelOnly")
    clip_keys = keys_for("CLIPLoader")
    latent_keys = keys_for("EmptyLTXVLatentVideo")
    guide_keys = keys_for("LTXAddVideoICLoRAGuide")
    if not all(len(items) == 1 for items in (model_keys, clip_keys, latent_keys, guide_keys)):
        raise RuntimeError("The official Ingredients workflow structure changed; Director patch points are ambiguous.")
    model_key, clip_key, latent_key, guide_key = model_keys[0], clip_keys[0], latent_keys[0], guide_keys[0]
    guide_positive = prompt[guide_key].get("inputs", {}).get("positive")
    if not isinstance(guide_positive, list) or len(guide_positive) != 2:
        raise RuntimeError("The official Ingredients guide no longer exposes its positive conditioning input.")
    conditioning_key = str(guide_positive[0])
    conditioning = prompt.get(conditioning_key)
    if conditioning is None or conditioning.get("class_type") != "LTXVConditioning":
        raise RuntimeError("The official Ingredients conditioning chain changed.")

    relay_key = "ltx_watch_director_relay"
    if relay_key in prompt:
        raise RuntimeError("The official Ingredients workflow conflicts with the Director relay node id.")
    prompt[relay_key] = {
        "class_type": "PromptRelayEncode",
        "inputs": {
            "model": [model_key, 0],
            "clip": [clip_key, 0],
            "latent": [latent_key, 0],
            **relay_inputs,
        },
    }
    # Keep the official CLIPTextEncode conditioning path. Native LTX 2.5
    # attaches unprocessed AV-embedding metadata there; routing PromptRelay's
    # io.Conditioning output directly can lose that metadata and produce a 4-D
    # tensor at the LTX connector. The compiler feeds this path the identical
    # combined token sequence via director_conditioning_prompt().
    source_model = [model_key, 0]
    for key, node in prompt.items():
        if key != relay_key and node.get("inputs", {}).get("model") == source_model:
            node["inputs"]["model"] = [relay_key, 0]
    strength = float((job.get("director") or {}).get("ingredientsStrength", 1.3))
    prompt[model_key].setdefault("inputs", {})["strength_model"] = strength
    return prompt


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
        definitions = {item.get("id"): item for item in graph.get("definitions", {}).get("subgraphs", [])}

        all_graphs = [graph, *definitions.values()]
        load_images = [node for item in all_graphs for node in item.get("nodes", []) if node.get("type") == "LoadImage"]
        load_images.sort(key=lambda node: ("first" not in str(node.get("title", "")).lower(), str(node.get("title", "")).lower()))
        if len(reference_names) > len(load_images):
            raise RuntimeError("The selected official workflow does not expose enough reference-frame inputs.")
        for node, reference_name in zip(load_images, reference_names):
            widgets = node.setdefault("widgets_values", [])
            if widgets:
                widgets[0] = reference_name
            else:
                widgets.append(reference_name)

        for item in all_graphs:
            for node in item.get("nodes", []):
                if node.get("type") != "SaveVideo":
                    continue
                widgets = node.setdefault("widgets_values", [])
                if widgets:
                    widgets[0] = output_prefix

        primitive_titles = {
            "prompt (positive)": "prompt",
            "prompt (negative)": "negative_prompt",
            "fps (frames per second)": "frame_rate",
            "duration in seconds (determines frames #)": "duration",
        }
        for item in all_graphs:
            for node in item.get("nodes", []):
                override_name = primitive_titles.get(str(node.get("title") or "").strip().lower())
                if override_name in overrides:
                    widgets = node.setdefault("widgets_values", [])
                    if widgets:
                        widgets[0] = overrides[override_name]
                    else:
                        widgets.append(overrides[override_name])

        prompt = {}
        used_keys = set()

        def graph_links(item):
            result = {}
            for link in item.get("links", []):
                if isinstance(link, list):
                    result[link[0]] = (link[1], link[2], link[3], link[4])
                else:
                    result[link["id"]] = (link["origin_id"], link["origin_slot"], link["target_id"], link["target_slot"])
            return result

        def normalize_label(item):
            label = self._input_label(item)
            return "frame_rate" if label == "fram_rate" else label

        def compile_graph(item, scope, external_inputs):
            links = graph_links(item)
            nodes = {node.get("id"): node for node in item.get("nodes", [])}
            instance_cache = {}

            def key_for(node_id):
                preferred = str(node_id)
                if preferred not in used_keys:
                    return preferred
                return f"{scope}_{preferred}"

            ordinary_keys = {}
            for node in item.get("nodes", []):
                if node.get("type") in definitions or node.get("type") in UI_ONLY_NODE_TYPES:
                    continue
                key = key_for(node.get("id"))
                used_keys.add(key)
                ordinary_keys[node.get("id")] = key

            def compile_instance(node):
                instance_id = node.get("id")
                if instance_id in instance_cache:
                    return instance_cache[instance_id]
                definition = definitions[node.get("type")]
                consumed_external_slots = {
                    origin_slot
                    for origin_id, origin_slot, _target_id, _target_slot in graph_links(definition).values()
                    if origin_id == -10
                }
                inputs_by_name = {entry.get("name"): entry for entry in node.get("inputs", [])}
                widgets = list(node.get("widgets_values", []))
                resolved_inputs = {}
                for index, definition_input in enumerate(definition.get("inputs", [])):
                    input_type = definition_input.get("type", "")
                    is_connection = isinstance(input_type, str) and input_type in CONNECTION_TYPES
                    role = normalize_label(definition_input)
                    instance_input = inputs_by_name.get(definition_input.get("name"))
                    linked = instance_input and instance_input.get("link") is not None
                    if not is_connection and role in overrides:
                        resolved_inputs[index] = ("constant", overrides[role], None, role)
                        if widgets:
                            widgets.pop(0)
                    elif linked:
                        resolved_inputs[index] = resolve_link(instance_input["link"])
                        if not is_connection and widgets:
                            widgets.pop(0)
                    elif not is_connection and widgets:
                        resolved_inputs[index] = ("constant", widgets.pop(0), None, role)
                    elif is_connection:
                        resolved_inputs[index] = None
                    elif index not in consumed_external_slots:
                        # Official workflow subgraphs can retain obsolete exposed
                        # settings that are no longer connected to any inner node.
                        # They are UI metadata, not required execution inputs.
                        resolved_inputs[index] = None
                    else:
                        raise RuntimeError(f"The official LTX workflow no longer exposes the {role} setting.")
                instance_scope = f"{scope}_{instance_id}" if scope else str(instance_id)
                outputs = compile_graph(definition, instance_scope, resolved_inputs)
                instance_cache[instance_id] = outputs
                return outputs

            def resolve_link(link_id, visited=None):
                visited = set() if visited is None else set(visited)
                if link_id in visited:
                    raise RuntimeError("The official LTX workflow contains a cyclic reroute link.")
                visited.add(link_id)
                if link_id not in links:
                    raise RuntimeError("The official LTX workflow contains a missing link.")
                origin_id, origin_slot, _target_id, _target_slot = links[link_id]
                if origin_id == -10:
                    resolved = external_inputs.get(origin_slot)
                    if resolved is None:
                        raise RuntimeError("The official LTX workflow has an unconnected required subgraph input.")
                    return resolved
                origin = nodes.get(origin_id)
                if not origin:
                    raise RuntimeError("The official LTX workflow link origin is missing.")
                if origin.get("type") == "Reroute":
                    reroute_links = [
                        entry.get("link") for entry in origin.get("inputs", [])
                        if entry.get("link") is not None
                    ]
                    if len(reroute_links) != 1:
                        raise RuntimeError("The official LTX workflow contains an invalid reroute node.")
                    return resolve_link(reroute_links[0], visited)
                if origin.get("type") in definitions:
                    outputs = compile_instance(origin)
                    if origin_slot not in outputs:
                        raise RuntimeError("The official LTX workflow subgraph output layout changed.")
                    return outputs[origin_slot]
                return ("node", ordinary_keys[origin_id], origin_slot, None)

            for node in item.get("nodes", []):
                if node.get("type") in definitions:
                    compile_instance(node)

            for node in item.get("nodes", []):
                class_type = node.get("type")
                if class_type in definitions or class_type in UI_ONLY_NODE_TYPES:
                    continue
                metadata = self.object_info(class_type)
                required = metadata.get("input", {}).get("required", {})
                optional = metadata.get("input", {}).get("optional", {})
                parameters = list(required.items()) + list(optional.items())
                linked_resolutions = {
                    entry["name"]: resolve_link(entry["link"])
                    for entry in node.get("inputs", [])
                    if entry.get("link") is not None
                }
                linked = {
                    name: resolution[1] if resolution[0] == "constant" else [resolution[1], resolution[2]]
                    for name, resolution in linked_resolutions.items()
                }
                linked_roles = {name: resolution[3] for name, resolution in linked_resolutions.items()}
                widgets = list(node.get("widgets_values", []))
                compiled_inputs = {}
                for name, definition in parameters:
                    parameter_type = definition[0] if isinstance(definition, list) else definition
                    is_connection = isinstance(parameter_type, str) and parameter_type in CONNECTION_TYPES
                    semantic_role = linked_roles.get(name)
                    if class_type == "CLIPLoader" and name == "clip_name" and semantic_role in {"gemma4_12b_encoder", "text_encoder"}:
                        semantic_role = "ltx_text_encoder"
                    if class_type == "GemmaAPITextEncode" and name == "ckpt_name":
                        semantic_role = "ltx_checkpoint"
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
                        compiled_inputs[name] = linked[name] if is_connection else reconcile_widget_value(linked[name], definition, semantic_role)
                        if not is_connection and widgets:
                            widgets.pop(0)
                    elif not is_connection and widgets:
                        compiled_inputs[name] = reconcile_widget_value(widgets.pop(0), definition, semantic_role)
                for name, value in linked.items():
                    compiled_inputs.setdefault(name, value)
                if class_type == "SaveVideo":
                    compiled_inputs["filename_prefix"] = output_prefix
                prompt[ordinary_keys[node.get("id")]] = {"class_type": class_type, "inputs": compiled_inputs}

            outputs = {}
            for link_id, (_origin_id, _origin_slot, target_id, target_slot) in links.items():
                if target_id == -20:
                    outputs[target_slot] = resolve_link(link_id)
            return outputs

        compile_graph(graph, "root", {})
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
    destination = comfy_root / "input"
    destination.mkdir(parents=True, exist_ok=True)
    job_token = re.sub(r"[^a-zA-Z0-9_-]+", "_", str(job["id"]))[:80]
    if not job_token:
        raise RuntimeError("The Create job id cannot stage a reference frame.")
    relative_names = []
    staged_paths = []
    try:
        for index, source in enumerate(references):
            suffix = source.suffix.lower() if source.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp"} else ".png"
            target = destination / f"ltx_watch_create_{job_token}_reference_{index + 1}{suffix}"
            shutil.copy2(source, target)
            staged_paths.append(target)
            relative_names.append(target.name)
    except Exception:
        cleanup_reference_files(staged_paths)
        raise
    return relative_names, staged_paths


def prepare_ingredients_reference(job, runtime_root: Path, comfy_root: Path):
    source = Path(str((job.get("director") or {}).get("ingredientsReferencePath") or ""))
    if not source.is_file() or source.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp"} or not inside(source, [runtime_root]):
        raise RuntimeError("The private Director Ingredients reference sheet is unavailable.")
    destination = comfy_root / "input"
    destination.mkdir(parents=True, exist_ok=True)
    job_token = re.sub(r"[^a-zA-Z0-9_-]+", "_", str(job["id"]))[:80]
    target = destination / f"ltx_watch_director_{job_token}_ingredients{source.suffix.lower()}"
    shutil.copy2(source, target)
    return target.name, target


def cleanup_reference_files(staged_paths):
    for staged_path in staged_paths:
        try:
            Path(staged_path).unlink(missing_ok=True)
        except OSError:
            pass


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
    if job.get("cancelPath") and not inside(Path(job["cancelPath"]), [runtime_root]):
        raise RuntimeError("Create cancellation path is outside the private runtime folder.")
    for key in ("videoContextPath", "soundtrackPath"):
        if job.get(key) and not inside(Path(job[key]), [runtime_root]):
            raise RuntimeError(f"{key} is outside the private Create job folder.")
    for reference in job.get("referencePaths", []):
        if not inside(Path(reference), [runtime_root]):
            raise RuntimeError("A reference path is outside the private Create job folder.")
    director = job.get("director") or {}
    if director.get("enabled"):
        if job.get("useBlender"):
            raise RuntimeError("Director timeline and Blender backbone modes cannot be combined yet.")
        for key in ("workflowPath", "ingredientsReferencePath"):
            if not director.get(key):
                raise RuntimeError(f"Director mode is missing {key}.")
        if not inside(Path(director["ingredientsReferencePath"]), [runtime_root]):
            raise RuntimeError("The Ingredients reference path is outside the private Create job folder.")
        director_relay_inputs(job)
    return runtime_root


def run_job(job):
    hide_subprocess_windows()
    runtime_root = validate_job(job)
    require_not_canceled(job)
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

    mode = job["referenceMode"]
    if job.get("useBlender") and mode == "text":
        mode = "first-frame"
    director_enabled = bool((job.get("director") or {}).get("enabled"))
    template = read_json(locate_director_template(job, comfy_root) if director_enabled else locate_template(comfy_root, mode))
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
    staged_reference_paths = []
    staged_ingredients_path = None
    cancel_stop = threading.Event()
    cancel_seen = threading.Event()
    cancel_watcher = threading.Thread(
        target=watch_for_cancellation,
        args=(job, base_url, cancel_stop, cancel_seen),
        name=f"create-cancel-{job['id'][:8]}",
        daemon=True,
    )
    cancel_watcher.start()
    try:
        require_not_canceled(job)
        if director_enabled:
            ingredients_name, staged_ingredients_path = prepare_ingredients_reference(job, runtime_root, comfy_root)
            references = [ingredients_name]
        else:
            references, staged_reference_paths = prepare_reference_files(job, runtime_root, comfy_root, source)
        progress(job, "Starting isolated ComfyUI", 8)
        server, server_log = source.start_comfy_server("ltx_watch_create", job["id"][:8], safer=bool(job.get("safer", False)))
        if server is None or not source.wait_for_server(base_url):
            raise RuntimeError("The isolated ComfyUI server could not start.")
        require_not_canceled(job)
        progress(job, "Compiling official LTX 2.5 workflow", 14)
        overrides = {
            "prompt": director_conditioning_prompt(job) if director_enabled else job["prompt"],
            "negative_prompt": "",
            "prompt_enhance": bool(job.get("promptEnhance")),
            "duration": int(job["duration"]),
            "width": int(job["width"]),
            "height": int(job["height"]),
            "seed": int(job["seed"]),
            "noise_seed": int(job["seed"]),
            "frame_rate": int(job["frameRate"]),
        }
        compiler = WorkflowCompiler(base_url)
        prompt = compiler.compile(template, overrides, list(references), job["outputPrefix"])
        if director_enabled:
            prompt = patch_director_prompt(prompt, job)
        require_not_canceled(job)
        progress(job, "Loading models and sampling frames", 20)
        response = submit(base_url, prompt, f"ltx-watch-create-{job['id']}")
        prompt_id = response.get("prompt_id")
        if not prompt_id:
            raise RuntimeError("ComfyUI did not return a prompt id.")
        progress(job, "Sampling frames", 28, promptId=prompt_id)
        outcome, _history = source.wait_for_history(base_url, prompt_id, timeout=int(job.get("timeoutSeconds", 7_200)))
        if cancel_seen.is_set() or cancellation_requested(job):
            raise CreateCancelled("Create render canceled by user.")
        if outcome != "completed":
            raise RuntimeError(f"ComfyUI ended the Create job with status: {outcome}.")
        progress(job, "Finalizing video", 96, promptId=prompt_id)
    finally:
        cancel_stop.set()
        cancel_watcher.join(timeout=2)
        try:
            if server is not None:
                source.stop_comfy_server(server, server_log, base_url)
        finally:
            cleanup_reference_files(staged_reference_paths)
            cleanup_reference_files([staged_ingredients_path] if staged_ingredients_path else [])
            source.release_lock(str(lock_path))

    output = newest_output(comfy_root / "output", job["outputPrefix"], started)
    if not output:
        raise RuntimeError("ComfyUI completed but no reviewable video was found in the Create output folder.")
    if job.get("audio") == "silent":
        strip_audio(output, source)
    elif job.get("audio") == "soundtrack":
        replace_audio(output, Path(job.get("soundtrackPath", "")), source, comfy_root, runtime_root)
    require_not_canceled(job)
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
            canceled = "runtime_root" in locals() and (isinstance(error, CreateCancelled) or cancellation_requested(job))
            write_json(result_path, {
                "status": "canceled" if canceled else "failed", "runnerPid": os.getpid(), "progress": 0,
                "stage": "Canceled" if canceled else "Failed", "error": None if canceled else str(error)[:1_500],
                "completedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            })
        else:
            print(str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
