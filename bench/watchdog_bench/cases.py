"""Load benchmark cases: a base repo, a PR on top of it, and the answer key."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

# Case sources are stored with a .txt suffix so linters and test runners in this repo ignore them.
SUFFIX = ".txt"


@dataclass(frozen=True)
class Location:
    """A line in the PR version of a file, found by a unique snippet of its text."""

    path: str
    contains: str
    note: str = ""


@dataclass
class Case:
    id: str
    language: str
    title: str
    description: str
    tags: list[str]
    base: dict[str, str]
    pr: dict[str, str]
    bugs: list[Location] = field(default_factory=list)
    weak: list[Location] = field(default_factory=list)
    untested: list[str] = field(default_factory=list)
    tested: list[str] = field(default_factory=list)

    def pr_file(self, path: str) -> str:
        """Contents of a file after the PR (the PR overlay, else the base)."""
        if path in self.pr:
            return self.pr[path]
        return self.base[path]

    def line_of(self, loc: Location) -> int:
        """1-based line number of `loc` in the PR version of its file."""
        lines = self.pr_file(loc.path).splitlines()
        hits = [i + 1 for i, line in enumerate(lines) if loc.contains in line]
        if len(hits) != 1:
            raise ValueError(f"{self.id}: {loc.contains!r} matches {len(hits)} lines in {loc.path}")
        return hits[0]


def _read_tree(root: Path) -> dict[str, str]:
    files = {}
    for p in sorted(root.rglob("*")):
        if p.is_file():
            rel = p.relative_to(root).as_posix()
            files[rel.removesuffix(SUFFIX)] = p.read_text()
    return files


def load_case(directory: Path) -> Case:
    meta = json.loads((directory / "case.json").read_text())
    case = Case(
        id=meta["id"],
        language=meta["language"],
        title=meta["title"],
        description=meta["description"],
        tags=meta.get("tags", []),
        base=_read_tree(directory / "base"),
        pr=_read_tree(directory / "pr") if (directory / "pr").exists() else {},
        bugs=[Location(**b) for b in meta.get("bugs", [])],
        weak=[Location(**w) for w in meta.get("weak", [])],
        untested=meta.get("untested", []),
        tested=meta.get("tested", []),
    )
    for loc in case.bugs + case.weak:
        case.line_of(loc)  # Fail early on an answer key that doesn't match the code.
    return case


def load_cases(directory: Path, only: list[str] | None = None) -> list[Case]:
    cases = [load_case(d) for d in sorted(directory.iterdir()) if (d / "case.json").exists()]
    if only:
        cases = [c for c in cases if c.id in only]
    return cases
