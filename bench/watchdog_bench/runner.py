"""Run Watchdog on every case and save one result file per case."""

from __future__ import annotations

import json
import shutil
import tempfile
import time
from pathlib import Path

from .cases import Case
from .repo import build_repo
from .scoring import CaseScore, score_review, score_test_gap
from .watchdog import WatchdogError, run_watchdog

# Keep result files small: only the fields scoring and reports use.
FINDING_FIELDS = (
    "path",
    "line",
    "name",
    "start",
    "end",
    "severity",
    "category",
    "title",
    "verdict",
)


def _trim_findings(findings: list[dict]) -> list[dict]:
    trimmed = []
    for f in findings:
        item = {k: f[k] for k in FINDING_FIELDS if k in f}
        if f.get("proof"):
            item["proof"] = {
                "status": f["proof"]["status"],
                "fixVerified": f["proof"].get("fixVerified"),
            }
        trimmed.append(item)
    return trimmed


def run_case(case: Case, watchdog_root: Path, *, ai: bool) -> dict:
    started = time.time()
    score = CaseScore(case_id=case.id, language=case.language, tags=case.tags)
    outputs: dict = {}
    with tempfile.TemporaryDirectory(prefix="watchdog-bench-") as tmp:
        repo = build_repo(case, Path(tmp), watchdog_root / "node_modules")
        try:
            gap = run_watchdog(watchdog_root, repo, "test-gap", ai=ai, extra=["--mutate"])
            score.test_gap, score.mutation = score_test_gap(case, gap)
            outputs["test_gap"] = {
                "findings": _trim_findings(gap["findings"]),
                "mutation": gap.get("mutation"),
            }
        except WatchdogError as err:
            score.errors.append(str(err))
        if ai:
            try:
                review = run_watchdog(watchdog_root, repo, "review", ai=True, extra=["--verify"])
                score.review = score_review(case, review)
                outputs["review"] = {"findings": _trim_findings(review["findings"])}
            except WatchdogError as err:
                score.errors.append(str(err))
    return {
        "score": score.to_dict(),
        "outputs": outputs,
        "seconds": round(time.time() - started, 1),
    }


def run_all(
    cases: list[Case], watchdog_root: Path, out_dir: Path, *, ai: bool, force: bool = False
) -> list[Path]:
    """Run each case not already in `out_dir` (resumable, since free AI tiers run out mid-way)."""
    out_dir.mkdir(parents=True, exist_ok=True)
    written = []
    for case in cases:
        target = out_dir / f"{case.id}.json"
        if target.exists() and not force:
            print(f"skip {case.id} (already done)")
            continue
        print(f"run  {case.id} ...", end=" ", flush=True)
        result = run_case(case, watchdog_root, ai=ai)
        errors = result["score"]["errors"]
        if errors and ai and any("quota" in e.lower() for e in errors):
            print("stopped: AI quota used up. Re-run later to continue.")
            break
        target.write_text(json.dumps(result, indent=2) + "\n")
        written.append(target)
        print(f"{result['seconds']}s" + (f" ({len(errors)} error(s))" if errors else ""))
    return written


def clean(out_dir: Path) -> None:
    shutil.rmtree(out_dir, ignore_errors=True)
