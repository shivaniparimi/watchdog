"""Turn a case into a real git repository: base on `main`, the PR on a branch."""

from __future__ import annotations

import subprocess
from pathlib import Path

from .cases import Case

PACKAGE_JSON = '{\n  "name": "bench-case",\n  "private": true,\n  "type": "module",\n  "devDependencies": { "vitest": "*" }\n}\n'
PYTEST_INI = "[pytest]\npythonpath = .\n"


def _git(repo: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-c", "user.name=bench", "-c", "user.email=bench@example.com", *args],
        cwd=repo,
        check=True,
        capture_output=True,
    )


def _write(repo: Path, files: dict[str, str]) -> None:
    for path, content in files.items():
        target = repo / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)


def build_repo(case: Case, workdir: Path, node_modules: Path) -> Path:
    """Create the case's repo under `workdir` and return its path, checked out on the PR branch."""
    repo = workdir / case.id
    repo.mkdir(parents=True)
    _git(repo, "init", "-q", "-b", "main")

    scaffolding = {".gitignore": "node_modules/\n__pycache__/\n.pytest_cache/\n"}
    if case.language == "ts":
        scaffolding["package.json"] = PACKAGE_JSON
    else:
        scaffolding["pytest.ini"] = PYTEST_INI
    _write(repo, {**scaffolding, **case.base})
    if case.language == "ts":
        # Reuse Watchdog's own install so Vitest is available without a network install per case.
        (repo / "node_modules").symlink_to(node_modules, target_is_directory=True)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "base")

    _git(repo, "checkout", "-q", "-b", "pr")
    _write(repo, case.pr)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", case.title)
    return repo
