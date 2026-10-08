"""Run Watchdog's local CLI against a case repo and return its JSON output."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path


class WatchdogError(RuntimeError):
    pass


def run_watchdog(
    watchdog_root: Path,
    repo: Path,
    task: str,
    *,
    ai: bool,
    extra: list[str] | None = None,
    timeout: int = 900,
) -> dict:
    """Run `npm run local -- --task <task> --json` and parse what it prints."""
    cmd = [
        "npx",
        "tsx",
        "src/local.ts",
        "--task",
        task,
        "--repo",
        str(repo),
        "--base",
        "main",
        "--json",
    ]
    if not ai:
        cmd.append("--no-ai")
    cmd += extra or []

    env = dict(os.environ)
    # Put this interpreter's bin dir first, so Watchdog finds a python that has pytest installed.
    env["PATH"] = f"{Path(sys.executable).parent}{os.pathsep}{env.get('PATH', '')}"
    result = subprocess.run(
        cmd, cwd=watchdog_root, env=env, capture_output=True, text=True, timeout=timeout
    )
    if result.returncode != 0:
        raise WatchdogError(f"{task} failed ({result.returncode}): {result.stderr[-2000:]}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as err:
        raise WatchdogError(f"{task} printed invalid JSON: {result.stdout[:500]}") from err
