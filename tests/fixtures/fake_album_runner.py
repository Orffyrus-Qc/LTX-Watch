import argparse
import os


OUTPUT_ROOT = os.environ["LTX_STUDIO_FIXTURE_OUTPUT"]
LOCK_DIR = os.path.join(OUTPUT_ROOT, "locks")
GENERIC_MOTION_PROMPT = "Preserve the source frame and use restrained motion."
CFG = None


def parse_args(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int)
    parser.add_argument("--cuda-device", type=int)
    parser.add_argument("--worker-name")
    parser.add_argument("--log")
    parser.add_argument("--inductor-cache")
    parser.add_argument("--only-tracks", action="append", default=[])
    return parser.parse_args(argv)


def apply_args(args):
    global CFG
    CFG = args


def load_timing():
    return [{"section": "album", "track": "Scene One", "number": "0001", "duration_sec": "2.2"}]


def group_rows(rows):
    return [(('album', 'Scene One'), rows)]


def folder_slug_for(_track):
    return "scene_one_full"


def prepare_track_inputs(_rows, _slug):
    return None


def acquire_lock(_path, _label):
    return True


def release_lock(_path):
    return None


def run_shot(shot, _duration, slug):
    if "slow the camera" not in GENERIC_MOTION_PROMPT:
        raise RuntimeError("Correction text was not applied to the prompt.")
    prompt_path = os.environ.get("LTX_STUDIO_FIXTURE_PROMPT")
    if prompt_path:
        with open(prompt_path, "w", encoding="utf-8") as handle:
            handle.write(GENERIC_MOTION_PROMPT)
    directory = os.path.join(OUTPUT_ROOT, slug)
    os.makedirs(directory, exist_ok=True)
    with open(os.path.join(directory, f"{shot}_00001_.mp4"), "wb") as handle:
        handle.write(b"0" * 150_000)
    return "completed"
