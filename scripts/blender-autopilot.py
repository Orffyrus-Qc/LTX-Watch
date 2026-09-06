#!/usr/bin/env python3
"""Fixed-purpose Blender Auto-Pilot adapter.

Builds an allowlisted scene from a schema-validated JSON spec and records a
beauty/camera backbone. Invoked only by the authenticated local runner.
Never executes model-generated Python and never saves the optional seed scene.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path


ALLOWED_PRIMITIVES = {
    "planet",
    "moon",
    "torus-halo",
    "gothic-machine-cathedral",
    "geodesic-biodome",
    "ship",
    "satellite",
    "laser",
    "camera-orbit",
    "empty-rig",
}


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


def utc_now():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def atomic_json(path, value):
    path = resolved(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def validate_job(job):
    if job.get("kind") != "blender-autopilot" or job.get("animationAuthority") != "blender":
        raise ValueError("Job must declare Blender Auto-Pilot authority")
    runtime = resolved(job.get("runtimeRoot", ""))
    working = resolved(job.get("workingCopyPath", ""))
    spec_path = resolved(job.get("specPath", ""))
    if working.suffix.lower() != ".blend":
        raise ValueError("Working copy must be a .blend file")
    if not is_inside(working, [runtime]) or not is_inside(job.get("outputRoot", ""), [runtime]):
        raise ValueError("Working copy or output escaped the private runtime")
    for key in ("resultPath", "cancelPath", "specPath"):
        if job.get(key) and not is_inside(job.get(key), [runtime]):
            raise ValueError(f"{key} escaped the private runtime")
    source = str(job.get("sourcePath") or "")
    if source:
        source_path = resolved(source)
        if source_path.suffix.lower() != ".blend":
            raise ValueError("Seed must be a .blend file")
        roots = [resolved(item) for item in job.get("allowedSourceRoots", [])]
        if not roots or not is_inside(source_path, roots):
            raise ValueError("Seed is outside its registered root")
        if source_path == working:
            raise ValueError("Working copy cannot be the master scene")
    first = int(job.get("frameStart", 0))
    last = int(job.get("frameEnd", 0))
    if first < 1 or last < first or last - first + 1 > 600:
        raise ValueError("Invalid or excessive frame range")
    if not spec_path.is_file():
        raise ValueError("Scene spec JSON is missing")
    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    objects = spec.get("objects") or []
    if not objects:
        raise ValueError("Scene spec has no objects")
    unknown = [item.get("primitive") for item in objects if item.get("primitive") not in ALLOWED_PRIMITIVES]
    if unknown:
        raise ValueError(f"Scene spec uses non-allowlisted primitives: {', '.join(sorted(set(unknown)))}")
    return {
        "ok": True,
        "kind": "blender-autopilot",
        "frames": last - first + 1,
        "animationAuthority": "blender",
        "objects": len(objects),
        "preset": spec.get("preset") or job.get("preset"),
    }


def make_principled(bpy, name, base, metallic=0.85, roughness=0.28, emission=None, emission_strength=0.0, alpha=1.0):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = base
    if "Metallic" in bsdf.inputs:
        bsdf.inputs["Metallic"].default_value = metallic
    if "Roughness" in bsdf.inputs:
        bsdf.inputs["Roughness"].default_value = roughness
    if emission is not None and "Emission Color" in bsdf.inputs:
        bsdf.inputs["Emission Color"].default_value = emission
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    if "Alpha" in bsdf.inputs:
        bsdf.inputs["Alpha"].default_value = alpha
    if alpha < 0.999:
        mat.blend_method = "BLEND"
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return mat


def assign(obj, mat):
    if obj.type != "MESH":
        return
    obj.data.materials.clear()
    obj.data.materials.append(mat)


def new_empty(bpy, name, loc=(0, 0, 0), parent=None):
    empty = bpy.data.objects.new(name, None)
    empty.empty_display_type = "PLAIN_AXES"
    empty.empty_display_size = 0.08
    empty.location = loc
    bpy.context.scene.collection.objects.link(empty)
    if parent is not None:
        empty.parent = parent
        empty.matrix_parent_inverse.identity()
    return empty


def add_mesh(bpy, op_name, name, loc, scale, mat, parent=None, **kwargs):
    getattr(bpy.ops.mesh, op_name)(**kwargs)
    obj = bpy.context.active_object
    obj.name = name
    obj.location = loc
    obj.scale = scale
    assign(obj, mat)
    if parent is not None:
        obj.parent = parent
        obj.matrix_parent_inverse.identity()
    return obj


def add_cube(bpy, name, loc, scale, mat, parent=None):
    return add_mesh(bpy, "primitive_cube_add", name, loc, scale, mat, parent)


def make_earth_material(bpy, name):
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    noise = nt.nodes.new("ShaderNodeTexNoise")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    noise.inputs["Scale"].default_value = 4.5
    noise.inputs["Detail"].default_value = 8.0
    ramp.color_ramp.elements[0].position = 0.28
    ramp.color_ramp.elements[0].color = (0.02, 0.025, 0.03, 1)
    ramp.color_ramp.elements[1].position = 0.72
    ramp.color_ramp.elements[1].color = (0.04, 0.16, 0.07, 1)
    mid = ramp.color_ramp.elements.new(0.5)
    mid.color = (0.03, 0.05, 0.08, 1)
    emission = nt.nodes.new("ShaderNodeEmission")
    mix = nt.nodes.new("ShaderNodeMixShader")
    emission.inputs["Color"].default_value = (0.12, 0.85, 1.0, 1)
    emission.inputs["Strength"].default_value = 4.5
    cr = nt.nodes.new("ShaderNodeValToRGB")
    cr.color_ramp.elements[0].position = 0.62
    cr.color_ramp.elements[0].color = (0, 0, 0, 1)
    cr.color_ramp.elements[1].position = 0.78
    cr.color_ramp.elements[1].color = (1, 1, 1, 1)
    nt.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(noise.outputs["Fac"], cr.inputs["Fac"])
    nt.links.new(cr.outputs["Color"], mix.inputs["Fac"])
    nt.links.new(bsdf.outputs["BSDF"], mix.inputs[1])
    nt.links.new(emission.outputs["Emission"], mix.inputs[2])
    nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])
    if "Roughness" in bsdf.inputs:
        bsdf.inputs["Roughness"].default_value = 0.55
    return mat


def make_cathedral(bpy, name, loc, rot, scale, hull, glow, parent=None):
    root = new_empty(bpy, name, loc, parent)
    root.rotation_euler = rot
    root.scale = scale
    add_cube(bpy, f"{name}_plinth", (0, 0, 0.15), (1.6, 1.15, 0.18), hull, root)
    add_cube(bpy, f"{name}_nave", (0, 0, 0.7), (1.15, 0.85, 0.7), hull, root)
    add_cube(bpy, f"{name}_deck", (0, 0.15, 1.15), (1.35, 1.05, 0.12), hull, root)
    for index, offset in enumerate(((-0.95, 0.35, 1.05), (0.95, 0.35, 1.05), (-0.55, -0.45, 0.95), (0.55, -0.45, 0.95), (0.0, 0.55, 1.35))):
        add_cube(bpy, f"{name}_tower_{index}", offset, (0.18, 0.18, 0.85 if index < 4 else 1.15), hull, root)
    add_cube(bpy, f"{name}_crown_a", (0, 0.05, 1.85), (0.85, 0.55, 0.12), hull, root)
    add_cube(bpy, f"{name}_crown_b", (0, 0.05, 2.05), (0.55, 0.38, 0.1), hull, root)
    eye = add_mesh(bpy, "primitive_cylinder_add", f"{name}_eye", (0, -0.82, 0.85), (0.42, 0.42, 0.08), glow, root, vertices=24)
    eye.rotation_euler = (1.5708, 0, 0)
    add_cube(bpy, f"{name}_slot_l", (-0.55, -0.78, 0.7), (0.08, 0.04, 0.35), glow, root)
    add_cube(bpy, f"{name}_slot_r", (0.55, -0.78, 0.7), (0.08, 0.04, 0.35), glow, root)
    return root


def make_biodome(bpy, name, loc, rot, scale, glass, vegetation, parent=None):
    root = new_empty(bpy, name, loc, parent)
    root.rotation_euler = rot
    root.scale = scale
    dome = add_mesh(bpy, "primitive_ico_sphere_add", f"{name}_glass", (0, 0, 0.2), (1, 1, 0.85), glass, root, subdivisions=3)
    add_cube(bpy, f"{name}_ring", (0, 0, -0.55), (1.05, 1.05, 0.08), vegetation, root)
    add_cube(bpy, f"{name}_canopy", (0.1, -0.05, 0.05), (0.45, 0.45, 0.35), vegetation, root)
    add_cube(bpy, f"{name}_tree", (-0.2, 0.15, 0.1), (0.12, 0.12, 0.55), vegetation, root)
    dome.hide_render = False
    return root


def make_ship(bpy, name, loc, scale, hull, glow, parent=None):
    root = new_empty(bpy, name, loc, parent)
    root.scale = scale
    add_cube(bpy, f"{name}_hull", (0, 0, 0), (0.22, 0.06, 0.035), hull, root)
    add_cube(bpy, f"{name}_keel", (0.04, 0, -0.03), (0.16, 0.018, 0.012), hull, root)
    add_cube(bpy, f"{name}_fin_l", (0.02, 0.07, 0.0), (0.08, 0.012, 0.05), hull, root)
    add_cube(bpy, f"{name}_fin_r", (0.02, -0.07, 0.0), (0.08, 0.012, 0.05), hull, root)
    add_cube(bpy, f"{name}_glow", (0.18, 0, 0.0), (0.03, 0.018, 0.012), glow, root)
    return root


def make_satellite(bpy, name, loc, scale, hull, glow, parent=None):
    root = new_empty(bpy, name, loc, parent)
    root.scale = scale
    add_cube(bpy, f"{name}_body", (0, 0, 0), (0.028, 0.028, 0.036), hull, root)
    add_cube(bpy, f"{name}_panel_l", (0, 0.07, 0), (0.004, 0.06, 0.03), hull, root)
    add_cube(bpy, f"{name}_panel_r", (0, -0.07, 0), (0.004, 0.06, 0.03), hull, root)
    add_cube(bpy, f"{name}_beacon", (0, 0, 0.04), (0.008, 0.008, 0.01), glow, root)
    return root


def look_at(obj, target):
    from mathutils import Vector
    direction = Vector(target) - obj.location
    if direction.length < 1e-8:
        return
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def key_loc(obj, frame, loc):
    obj.location = loc
    obj.keyframe_insert(data_path="location", frame=frame)


def key_rot(obj, frame, rot):
    obj.rotation_euler = rot
    obj.keyframe_insert(data_path="rotation_euler", frame=frame)


def build_scene(bpy, spec, job):
    scene = bpy.context.scene
    try:
        scene.render.engine = "BLENDER_EEVEE_NEXT"
    except TypeError:
        scene.render.engine = "BLENDER_EEVEE"
    scene.render.fps = int(job["frameRate"])
    scene.render.fps_base = 1.0
    scene.frame_start = int(job["frameStart"])
    scene.frame_end = int(job["frameEnd"])
    scene.render.resolution_x = int(job["width"])
    scene.render.resolution_y = int(job["height"])
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.render.use_compositing = False
    scene.render.use_sequencer = False

    world = bpy.data.worlds.get("AutopilotWorld") or bpy.data.worlds.new("AutopilotWorld")
    world.use_nodes = True
    world.node_tree.nodes.clear()
    bg = world.node_tree.nodes.new("ShaderNodeBackground")
    out = world.node_tree.nodes.new("ShaderNodeOutputWorld")
    kind = (spec.get("world") or {}).get("kind") or "space"
    bg.inputs["Color"].default_value = (0.004, 0.006, 0.01, 1) if kind == "space" else (0.02, 0.015, 0.03, 1)
    bg.inputs["Strength"].default_value = 0.35 if kind != "void" else 0.05
    world.node_tree.links.new(bg.outputs["Background"], out.inputs["Surface"])
    scene.world = world

    for light in list(bpy.data.lights):
        bpy.data.lights.remove(light)
    sun = bpy.data.lights.new("AutopilotSun", "SUN")
    sun.energy = float((spec.get("world") or {}).get("sunEnergy") or 5)
    sun_obj = bpy.data.objects.new("AutopilotSun", sun)
    sun_obj.rotation_euler = (spec.get("world") or {}).get("sunRotation") or (0.85, 0.2, 0.35)
    scene.collection.objects.link(sun_obj)

    hull = make_principled(bpy, "AutopilotHull", (0.012, 0.014, 0.018, 1), 0.92, 0.22)
    glow = make_principled(bpy, "AutopilotGlow", (0.02, 0.55, 0.85, 1), 0.0, 0.18, (0.15, 0.85, 1.0, 1), 14.0)
    glass = make_principled(bpy, "AutopilotGlass", (0.25, 0.55, 0.42, 1), 0.05, 0.08, (0.05, 0.25, 0.12, 1), 0.4, 0.28)
    vegetation = make_principled(bpy, "AutopilotVeg", (0.04, 0.16, 0.06, 1), 0.0, 0.55, (0.02, 0.18, 0.05, 1), 0.6)
    moon_mat = make_principled(bpy, "AutopilotMoon", (0.42, 0.4, 0.36, 1), 0.05, 0.72)
    halo_mat = make_principled(bpy, "AutopilotHalo", (0.018, 0.02, 0.024, 1), 0.95, 0.18, (0.05, 0.4, 0.55, 1), 1.6)
    earth_mat = make_earth_material(bpy, "AutopilotEarth")

    built = {}
    for item in spec.get("objects") or []:
        primitive = item.get("primitive")
        name = str(item.get("id") or "obj")
        loc = tuple(item.get("location") or (0, 0, 0))
        rot = tuple(item.get("rotation") or (0, 0, 0))
        scale = tuple(item.get("scale") or (1, 1, 1))
        parent = built.get(item.get("parent"))
        obj = None
        if primitive == "planet":
            obj = add_mesh(bpy, "primitive_uv_sphere_add", name, loc, scale, earth_mat, parent, segments=48, ring_count=24)
        elif primitive == "moon":
            obj = add_mesh(bpy, "primitive_uv_sphere_add", name, loc, scale, moon_mat, parent, segments=24, ring_count=12)
        elif primitive == "torus-halo":
            obj = add_mesh(bpy, "primitive_torus_add", name, loc, (1, 1, 1), halo_mat, parent, major_radius=max(0.2, scale[0]), minor_radius=max(0.02, scale[2]), major_segments=64, minor_segments=16)
            obj.rotation_euler = rot
        elif primitive == "gothic-machine-cathedral":
            obj = make_cathedral(bpy, name, loc, rot, scale, hull, glow, parent)
        elif primitive == "geodesic-biodome":
            obj = make_biodome(bpy, name, loc, rot, scale, glass, vegetation, parent)
        elif primitive == "ship":
            obj = make_ship(bpy, name, loc, scale, hull, glow, parent)
        elif primitive == "satellite":
            obj = make_satellite(bpy, name, loc, scale, hull, glow, parent)
        elif primitive == "laser":
            obj = add_cube(bpy, name, loc, scale, glow, parent)
            obj.rotation_euler = rot
        elif primitive in {"camera-orbit", "empty-rig"}:
            obj = new_empty(bpy, name, loc, parent)
            obj.rotation_euler = rot
            obj.scale = scale
        if obj is None:
            continue
        built[name] = obj
        animation = item.get("animation") or {}
        first = int(job["frameStart"])
        last = int(job["frameEnd"])
        if animation.get("type") == "spin":
            key_rot(obj, first, (0, 0, 0))
            key_rot(obj, last, (0, 0, math.radians(360.0 * float(animation.get("speed") or 1))))
        elif animation.get("type") == "orbit":
            radius = float(animation.get("radius") or max(abs(loc[0]), 1.0))
            speed = float(animation.get("speed") or 1)
            height = loc[2]
            key_loc(obj, first, (math.cos(0) * radius, math.sin(0) * radius, height))
            key_loc(obj, last, (math.cos(math.tau * speed) * radius, math.sin(math.tau * speed) * radius, height))

    camera_spec = spec.get("camera") or {}
    look_name = str(camera_spec.get("lookAt") or "")
    target = built.get(look_name)
    target_loc = tuple(target.location) if target is not None else (0.0, 0.0, 0.0)
    pivot = new_empty(bpy, "AutopilotCameraPivot", target_loc)
    camera_data = bpy.data.cameras.new("AutopilotCamera")
    camera_data.lens = float(camera_spec.get("lensMm") or 35)
    camera_obj = bpy.data.objects.new("AutopilotCamera", camera_data)
    scene.collection.objects.link(camera_obj)
    camera_obj.parent = pivot
    distance = float(camera_spec.get("distance") or 4.2)
    height = float(camera_spec.get("height") or 0.85)
    closeup = float(camera_spec.get("closeupDistance") or max(1.0, distance * 0.5))
    camera_obj.location = (0.0, -distance, height)
    look_at(camera_obj, (0.0, 0.0, 0.0))
    scene.camera = camera_obj

    first = int(job["frameStart"])
    last = int(job["frameEnd"])
    span = max(1, last - first)
    cam_type = camera_spec.get("type") or "orbit"
    key_rot(pivot, first, (0, 0, 0))
    key_rot(pivot, last, (0, 0, math.tau if cam_type != "lock" else 0.35))
    if cam_type in {"closeup-orbit", "dolly-in", "dolly-out"}:
        start_norm = float(camera_spec.get("closeupStart") or 0.38)
        end_norm = float(camera_spec.get("closeupEnd") or 0.62)
        mid_a = first + int(span * start_norm)
        mid_b = first + int(span * end_norm)
        start_dist = distance if cam_type != "dolly-out" else closeup
        end_dist = distance if cam_type != "dolly-in" else closeup
        peak = closeup if cam_type == "closeup-orbit" else (closeup if cam_type == "dolly-in" else distance)
        key_loc(camera_obj, first, (0.0, -start_dist, height))
        key_loc(camera_obj, mid_a, (0.0, -peak, height * 0.72))
        key_loc(camera_obj, mid_b, (0.0, -peak, height * 0.72))
        key_loc(camera_obj, last, (0.0, -end_dist, height))
    return {"camera": camera_obj.name, "objects": sorted(built)}


def matrix_values(matrix):
    return [float(value) for row in matrix for value in row]


def record(bpy, job, spec):
    output_root = resolved(job["outputRoot"])
    beauty = output_root / "beauty"
    anchors = output_root / "anchors"
    if output_root.exists():
        shutil.rmtree(output_root)
    beauty.mkdir(parents=True, exist_ok=True)
    anchors.mkdir(parents=True, exist_ok=True)
    result_path = resolved(job["resultPath"])
    cancel_path = resolved(job["cancelPath"])
    first = int(job["frameStart"])
    last = int(job["frameEnd"])
    total = last - first + 1
    scene = bpy.context.scene
    camera_path = output_root / "camera.jsonl"
    camera_path.write_text("", encoding="utf-8")
    atomic_json(result_path, {"status": "generating", "kind": "blender-autopilot", "stage": "Recording Blender Auto-Pilot backbone", "progress": 8, "runnerPid": os.getpid()})
    with camera_path.open("a", encoding="utf-8") as camera_file:
        for index, frame in enumerate(range(first, last + 1), start=1):
            if cancel_path.exists():
                atomic_json(result_path, {"status": "canceled", "stage": "Canceled", "progress": max(1, int((index - 1) / total * 100)), "completedAt": utc_now()})
                return None
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
            frame_path = beauty / f"frame_{frame:04d}.png"
            scene.render.filepath = str(frame_path)
            bpy.ops.render.render(write_still=True)
            if frame == first:
                shutil.copyfile(frame_path, anchors / "first.png")
            if frame == last:
                shutil.copyfile(frame_path, anchors / "last.png")
            atomic_json(result_path, {
                "status": "generating",
                "kind": "blender-autopilot",
                "stage": f"Recording Blender-owned frame {frame} of {last}",
                "progress": min(74, 8 + int(index / total * 66)),
                "runnerPid": os.getpid(),
            })
    rendered = [item for item in beauty.glob("frame_*.png") if item.is_file()]
    if len(rendered) != total:
        raise RuntimeError(f"beauty pass is incomplete: expected {total} frames, found {len(rendered)}")
    if not (anchors / "first.png").is_file() or not (anchors / "last.png").is_file():
        raise RuntimeError("Auto-Pilot first/last anchors were not written")
    return {
        "outputRoot": str(output_root),
        "firstFramePath": str(anchors / "first.png"),
        "lastFramePath": str(anchors / "last.png"),
        "cameraPath": str(camera_path),
        "blender": {"version": bpy.app.version_string, "renderEngine": scene.render.engine},
    }


def run_build(job):
    import bpy

    spec = json.loads(resolved(job["specPath"]).read_text(encoding="utf-8"))
    source = str(job.get("sourcePath") or "")
    if source:
        bpy.ops.wm.open_mainfile(filepath=str(resolved(source)))
    else:
        try:
            bpy.ops.wm.read_homefile(use_empty=True)
        except TypeError:
            bpy.ops.wm.read_factory_settings(use_empty=True)
    inventory = build_scene(bpy, spec, job)
    working = resolved(job["workingCopyPath"])
    working.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(working), copy=True)
    recorded = record(bpy, job, spec)
    if recorded is None:
        return
    recorded["inventory"] = inventory
    recorded["identities"] = spec.get("identities") or []
    atomic_json(resolved(job["resultPath"]).with_name("blender-record.json"), recorded)
    atomic_json(resolved(job["resultPath"]), {
        "status": "generating",
        "kind": "blender-autopilot",
        "stage": "Blender backbone recorded",
        "progress": 75,
        "runnerPid": os.getpid(),
        **recorded,
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
        validate_job(job)
        run_build(job)
    except Exception as error:
        result = job.get("resultPath")
        if result:
            atomic_json(result, {"status": "failed", "stage": "Failed", "progress": 0, "error": str(error)[:1000], "completedAt": utc_now()})
        raise


if __name__ == "__main__":
    main()
