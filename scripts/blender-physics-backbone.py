#!/usr/bin/env python3
"""Fixed-purpose Blender adapter for versioned physics-backbone passes.

This file is invoked only by the authenticated local bridge. It receives one
server-created JSON job path and never saves the source .blend file.
"""

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path


PASS_IDS = {"beauty", "depth", "normal", "flow", "camera"}


def resolved(value):
    return Path(value).expanduser().resolve()


def is_inside(candidate, roots):
    candidate = resolved(candidate)
    for root in roots:
        try:
            candidate.relative_to(resolved(root))
            return True
        except ValueError:
            continue
    return False


def validate_job(job):
    if job.get("kind") != "physics-backbone" or job.get("animationAuthority") != "blender":
        raise ValueError("Job must declare Blender as animation authority")
    runtime = resolved(job.get("runtimeRoot", ""))
    source = resolved(job.get("sourcePath", ""))
    working = resolved(job.get("workingCopyPath", ""))
    if source.suffix.lower() != ".blend" or working.suffix.lower() != ".blend":
        raise ValueError("Source and working copy must be .blend files")
    roots = [resolved(item) for item in job.get("allowedSourceRoots", [])]
    if not roots or not is_inside(source, roots):
        raise ValueError("Source is outside its registered root")
    for key in ("workingCopyPath", "outputRoot", "resultPath", "cancelPath"):
        if not is_inside(job.get(key, ""), [runtime]):
            raise ValueError(f"{key} escaped the private runtime")
    if source == working:
        raise ValueError("Working copy cannot be the master scene")
    first = int(job.get("frameStart", 0))
    last = int(job.get("frameEnd", 0))
    if first < 1 or last < first or last - first + 1 > 10000:
        raise ValueError("Invalid or excessive frame range")
    if set(job.get("passes", [])) != PASS_IDS:
        raise ValueError("Required pass contract is incomplete")
    return {
        "ok": True,
        "kind": "physics-backbone",
        "frames": last - first + 1,
        "animationAuthority": "blender",
    }


def atomic_json(path, value):
    path = resolved(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def utc_now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def output_node(nodes, name, base_path, file_format, color_mode="RGBA"):
    node = nodes.new("CompositorNodeOutputFile")
    node.name = f"LTX Watch {name}"
    node.label = node.name
    node.base_path = str(base_path)
    node.file_slots[0].path = "frame_"
    node.format.file_format = file_format
    node.format.color_mode = color_mode
    if file_format == "OPEN_EXR":
        node.format.color_depth = "32"
        node.format.exr_codec = "ZIP"
    return node


def matrix_values(matrix):
    return [float(value) for row in matrix for value in row]


def dynamics_inventory(bpy):
    rigid = 0
    cloth = 0
    soft = 0
    collision = 0
    for obj in bpy.context.scene.objects:
        if getattr(obj, "rigid_body", None) is not None:
            rigid += 1
        for modifier in obj.modifiers:
            if modifier.type == "CLOTH":
                cloth += 1
            elif modifier.type == "SOFT_BODY":
                soft += 1
            elif modifier.type == "COLLISION":
                collision += 1
    return {"rigidBodies": rigid, "clothModifiers": cloth, "softBodyModifiers": soft, "collisionObjects": collision}


def render(job):
    import bpy  # Imported only inside Blender.

    validate_job(job)
    output_root = resolved(job["outputRoot"])
    result_path = resolved(job["resultPath"])
    cancel_path = resolved(job["cancelPath"])
    manifest_path = output_root / "manifest.json"
    output_root.mkdir(parents=True, exist_ok=True)

    scene = bpy.context.scene
    if scene.camera is None:
        raise RuntimeError("The Blender scene has no active camera")
    if scene.render.engine not in {"BLENDER_EEVEE_NEXT", "BLENDER_EEVEE", "CYCLES"}:
        raise RuntimeError("Physics passes require Eevee or Cycles in the working copy")

    original_frame_start = int(scene.frame_start)
    scene.render.fps = int(job["frameRate"])
    scene.render.resolution_x = int(job["width"])
    scene.render.resolution_y = int(job["height"])
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True

    view_layer = bpy.context.view_layer
    view_layer.use_pass_z = True
    view_layer.use_pass_normal = True
    view_layer.use_pass_vector = True

    scene.use_nodes = True
    tree = scene.node_tree
    tree.nodes.clear()
    render_layers = tree.nodes.new("CompositorNodeRLayers")
    beauty = output_node(tree.nodes, "Beauty", output_root / "beauty", "PNG", "RGBA")
    depth = output_node(tree.nodes, "Depth", output_root / "depth", "OPEN_EXR", "BW")
    normal = output_node(tree.nodes, "Normal", output_root / "normal", "OPEN_EXR", "RGB")
    flow = output_node(tree.nodes, "Flow", output_root / "flow", "OPEN_EXR", "RGBA")
    tree.links.new(render_layers.outputs["Image"], beauty.inputs[0])
    tree.links.new(render_layers.outputs["Depth"], depth.inputs[0])
    tree.links.new(render_layers.outputs["Normal"], normal.inputs[0])
    tree.links.new(render_layers.outputs["Vector"], flow.inputs[0])

    first = int(job["frameStart"])
    last = int(job["frameEnd"])
    total = last - first + 1
    simulation_start = min(first, original_frame_start)
    pre_roll = first - simulation_start
    if pre_roll > 10000:
        raise RuntimeError("The Blender simulation pre-roll exceeds the 10,000-frame safety limit")
    work_total = max(1, pre_roll + total)
    camera_path = output_root / "camera.jsonl"
    camera_path.write_text("", encoding="utf-8")
    atomic_json(result_path, {"status": "generating", "stage": "Evaluating Blender physics", "progress": 1, "runnerPid": os.getpid()})

    for index, frame in enumerate(range(simulation_start, first), start=1):
        if cancel_path.exists():
            atomic_json(result_path, {"status": "canceled", "stage": "Canceled", "progress": max(1, int((index - 1) / work_total * 100)), "completedAt": utc_now()})
            return
        scene.frame_set(frame)
        bpy.context.view_layer.update()
        atomic_json(result_path, {
            "status": "generating",
            "stage": f"Pre-rolling Blender simulation at frame {frame}",
            "progress": min(20, max(1, int(index / work_total * 100))),
            "runnerPid": os.getpid(),
        })

    with camera_path.open("a", encoding="utf-8") as camera_file:
        for index, frame in enumerate(range(first, last + 1), start=1):
            if cancel_path.exists():
                atomic_json(result_path, {"status": "canceled", "stage": "Canceled", "progress": max(1, int((pre_roll + index - 1) / work_total * 100)), "completedAt": utc_now()})
                return
            scene.frame_set(frame)
            bpy.context.view_layer.update()
            camera = scene.camera
            camera_file.write(json.dumps({
                "frame": frame,
                "matrixWorld": matrix_values(camera.matrix_world),
                "lensMm": float(camera.data.lens),
                "sensorWidthMm": float(camera.data.sensor_width),
                "clipStart": float(camera.data.clip_start),
                "clipEnd": float(camera.data.clip_end),
            }) + "\n")
            camera_file.flush()
            bpy.ops.render.render(write_still=False)
            atomic_json(result_path, {
                "status": "generating",
                "stage": f"Rendering Blender-owned frame {frame} of {last}",
                "progress": min(99, int((pre_roll + index) / work_total * 100)),
                "runnerPid": os.getpid(),
            })

    master = resolved(job["sourcePath"])
    expected_outputs = {
        "beauty": (output_root / "beauty", ".png"),
        "depth": (output_root / "depth", ".exr"),
        "normal": (output_root / "normal", ".exr"),
        "flow": (output_root / "flow", ".exr"),
    }
    for pass_name, (directory, suffix) in expected_outputs.items():
        rendered = [item for item in directory.glob("frame_*") if item.is_file() and item.suffix.lower() == suffix]
        if len(rendered) != total:
            raise RuntimeError(f"{pass_name} pass is incomplete: expected {total} frames, found {len(rendered)}")
    camera_rows = [line for line in camera_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    if len(camera_rows) != total:
        raise RuntimeError(f"camera pass is incomplete: expected {total} frames, found {len(camera_rows)}")
    dynamics = dynamics_inventory(bpy)
    manifest = {
        "schemaVersion": 1,
        "kind": "ltx-watch-physics-backbone",
        "animationAuthority": "blender",
        "refinementAuthority": "appearance-only",
        "source": {
            "masterPath": str(master),
            "workingCopyPath": str(resolved(job["workingCopyPath"])),
            "masterModifiedAt": datetime.fromtimestamp(master.stat().st_mtime, timezone.utc).isoformat().replace("+00:00", "Z"),
            "masterSize": master.stat().st_size,
        },
        "timeline": {"simulationStart": simulation_start, "frameStart": first, "frameEnd": last, "frameCount": total, "frameRate": int(job["frameRate"])},
        "resolution": {"width": int(job["width"]), "height": int(job["height"])},
        "passes": [
            {"id": "beauty", "format": "PNG", "pattern": "beauty/frame_####.png", "frameCount": total},
            {"id": "depth", "format": "OpenEXR 32-bit", "pattern": "depth/frame_####.exr", "frameCount": total},
            {"id": "normal", "format": "OpenEXR 32-bit", "pattern": "normal/frame_####.exr", "frameCount": total},
            {"id": "flow", "format": "OpenEXR 32-bit", "pattern": "flow/frame_####.exr", "frameCount": total},
            {"id": "camera", "format": "JSON Lines", "pattern": "camera.jsonl", "frameCount": total},
        ],
        "dynamics": dynamics,
        "blender": {"version": bpy.app.version_string, "renderEngine": scene.render.engine},
        "createdAt": utc_now(),
        "compatibility": {
            "ltxVersion": "2.5",
            "refinementReady": False,
            "reason": "No verified LTX 2.5 adapter is configured to consume every structural pass while preserving Blender motion exactly.",
        },
    }
    atomic_json(manifest_path, manifest)
    atomic_json(result_path, {
        "status": "complete",
        "kind": "physics-backbone",
        "stage": "Physics backbone ready",
        "progress": 100,
        "manifestPath": str(manifest_path),
        "outputRoot": str(output_root),
        "completedAt": utc_now(),
    })


def parse_arguments(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("--job")
    parser.add_argument("--validate-job")
    return parser.parse_args(argv)


def main():
    arguments = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    args = parse_arguments(arguments)
    job_path = args.validate_job or args.job
    if not job_path:
        raise ValueError("A private job JSON path is required")
    job = json.loads(resolved(job_path).read_text(encoding="utf-8"))
    if args.validate_job:
        print(json.dumps(validate_job(job)))
        return
    try:
        render(job)
    except Exception as error:
        result = job.get("resultPath")
        if result:
            atomic_json(result, {"status": "failed", "stage": "Failed", "progress": 0, "error": str(error)[:1000], "completedAt": utc_now()})
        raise


if __name__ == "__main__":
    main()
