"""Run a trusted Python script while hiding its complete subprocess tree on Windows.

LTX Watch uses this adapter only for the configured, server-validated recovery
runner. Recursive wrapping is needed because that supervisor starts another
Python worker which then starts ComfyUI and FFmpeg.
"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import runpy
import subprocess
import sys
from typing import Any, Sequence


WRAPPER_PATH = Path(__file__).resolve()
_ORIGINAL_POPEN = subprocess.Popen


def _python_script_index(command: Sequence[Any]) -> int | None:
    if len(command) < 2:
        return None
    executable = Path(str(command[0]).strip('"')).name.lower()
    if executable not in {"python", "python.exe", "pythonw", "pythonw.exe"}:
        return None
    index = 1
    while index < len(command):
        value = str(command[index])
        if value in {"-c", "-m"}:
            return None
        if value in {"-X", "-W"}:
            index += 2
            continue
        if value.startswith("-") and not value.lower().endswith(".py"):
            index += 1
            continue
        return index if value.lower().endswith(".py") else None
    return None


def _wrap_python_command(command: Any) -> Any:
    if not isinstance(command, (list, tuple)):
        return command
    script_index = _python_script_index(command)
    if script_index is None:
        return command
    script = Path(str(command[script_index]))
    try:
        if script.resolve() == WRAPPER_PATH:
            return command
    except OSError:
        if script.name.lower() == WRAPPER_PATH.name.lower():
            return command
    wrapped = [*command[:script_index], str(WRAPPER_PATH), "--script", str(script), *command[script_index + 1 :]]
    return tuple(wrapped) if isinstance(command, tuple) else wrapped


def _hidden_kwargs(current: dict[str, Any]) -> dict[str, Any]:
    options = dict(current)
    if os.name != "nt":
        return options
    options["creationflags"] = int(options.get("creationflags") or 0) | subprocess.CREATE_NO_WINDOW
    startup = options.get("startupinfo") or subprocess.STARTUPINFO()
    startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startup.wShowWindow = subprocess.SW_HIDE
    options["startupinfo"] = startup
    return options


class _HiddenPopen(_ORIGINAL_POPEN):
    """Drop-in Popen subclass so libraries such as asyncio may subclass it."""

    def __init__(self, *popen_args: Any, **popen_kwargs: Any):
        arguments = list(popen_args)
        if arguments:
            arguments[0] = _wrap_python_command(arguments[0])
        elif "args" in popen_kwargs:
            popen_kwargs["args"] = _wrap_python_command(popen_kwargs["args"])
        super().__init__(*arguments, **_hidden_kwargs(popen_kwargs))


def install_hidden_subprocess_tree() -> None:
    subprocess.Popen = _HiddenPopen


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--script", required=True)
    known, script_arguments = parser.parse_known_args()
    script_path = Path(known.script).resolve()
    if not script_path.is_file() or script_path.suffix.lower() != ".py":
        raise SystemExit("The hidden Python target must be an existing .py file.")
    if script_path == WRAPPER_PATH:
        raise SystemExit("The hidden Python wrapper cannot run itself.")
    install_hidden_subprocess_tree()
    sys.argv = [str(script_path), *script_arguments]
    # Match `python target.py`: imports beside the trusted target must resolve
    # from the target directory, not from this adapter's scripts directory.
    sys.path[0] = str(script_path.parent)
    runpy.run_path(str(script_path), run_name="__main__")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
