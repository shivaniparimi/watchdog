"""Compare Watchdog's output for a case with the case's answer key."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field

from .cases import Case

# A finding counts as catching a bug when it points within this many lines of it.
LINE_TOLERANCE = 3
# Finding categories that claim the code is wrong (as opposed to style or "add a test" advice).
CORRECTNESS = {"bug", "security", "error-handling", "concurrency", "performance"}


@dataclass
class MutationScore:
    mutants: int = 0
    killed: int = 0
    survived: int = 0
    weak_lines: int = 0
    weak_detected: int = 0
    # Survivors inside functions the answer key says have no tests: correct, expected detections.
    untested_survivors: int = 0
    # Survivors on lines the answer key says are well tested: false alarms.
    unexpected_survivors: int = 0
    skipped_files: int = 0


@dataclass
class TestGapScore:
    untested_total: int = 0
    untested_flagged: int = 0
    tested_total: int = 0
    tested_flagged: int = 0
    # Planted bugs sitting in a function the free checks flagged (weak or missing tests).
    bugs_total: int = 0
    bugs_in_flagged_functions: int = 0


@dataclass
class ReviewScore:
    bugs_total: int = 0
    # Found by any correctness finding, before proof tests filter anything.
    bugs_found: int = 0
    # Still found after dismissed findings are removed.
    bugs_found_after_proof: int = 0
    false_positives: int = 0
    false_positives_after_proof: int = 0
    confirmed_true: int = 0
    confirmed_false: int = 0
    dismissed_true: int = 0
    dismissed_false: int = 0


@dataclass
class CaseScore:
    case_id: str
    language: str
    tags: list[str]
    mutation: MutationScore | None = None
    test_gap: TestGapScore | None = None
    review: ReviewScore | None = None
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


def _function_key(finding: dict) -> str:
    return f"{finding['path']}#{finding['name']}"


def score_test_gap(case: Case, output: dict) -> tuple[TestGapScore, MutationScore | None]:
    """Score test-gap verdicts and, when present, the mutation report."""
    findings = output.get("findings", [])
    by_key = {_function_key(f): f for f in findings}

    def flagged(key: str) -> bool:
        f = by_key.get(key)
        if f is None:
            return False
        v = f["verdict"]
        return (not v["covered"]) and v["risk"] != "none" and not v.get("uncertain", False)

    def bug_flagged(path: str, line: int) -> bool:
        return any(
            f["path"] == path and f["start"] <= line <= f["end"] and flagged(_function_key(f))
            for f in findings
        )

    bug_lines = [(b.path, case.line_of(b)) for b in case.bugs]
    gap = TestGapScore(
        untested_total=len(case.untested),
        untested_flagged=sum(flagged(k) for k in case.untested),
        tested_total=len(case.tested),
        tested_flagged=sum(flagged(k) for k in case.tested),
        bugs_total=len(bug_lines),
        bugs_in_flagged_functions=sum(bug_flagged(p, line) for p, line in bug_lines),
    )

    report = output.get("mutation")
    if report is None:
        return gap, None

    untested_ranges = [
        (f["path"], f["start"], f["end"]) for f in findings if _function_key(f) in case.untested
    ]
    weak = {(w.path, case.line_of(w)) for w in case.weak}
    results = report["results"]
    survivors = [r for r in results if r["status"] == "survived"]

    def in_untested(r: dict) -> bool:
        return any(p == r["path"] and s <= r["line"] <= e for p, s, e in untested_ranges)

    mutation = MutationScore(
        mutants=sum(r["status"] in ("killed", "survived", "timeout") for r in results),
        killed=sum(r["status"] in ("killed", "timeout") for r in results),
        survived=len(survivors),
        weak_lines=len(weak),
        weak_detected=sum(any((r["path"], r["line"]) == w for r in survivors) for w in weak),
        untested_survivors=sum(1 for r in survivors if in_untested(r)),
        unexpected_survivors=sum(
            1 for r in survivors if (r["path"], r["line"]) not in weak and not in_untested(r)
        ),
        skipped_files=len(report.get("skipped", [])),
    )
    return gap, mutation


def score_review(case: Case, output: dict) -> ReviewScore:
    """Score AI findings against the planted bugs, before and after proof tests."""
    bug_lines = [(b.path, case.line_of(b)) for b in case.bugs]
    findings = [
        f
        for f in output.get("findings", [])
        if f["category"] in CORRECTNESS and f["severity"] != "nit"
    ]

    def matches(f: dict) -> bool:
        return any(
            f["path"] == p and abs(f["line"] - line) <= LINE_TOLERANCE for p, line in bug_lines
        )

    def found(path: str, line: int, pool: list[dict]) -> bool:
        return any(f["path"] == path and abs(f["line"] - line) <= LINE_TOLERANCE for f in pool)

    kept = [f for f in findings if (f.get("proof") or {}).get("status") != "refuted"]
    score = ReviewScore(
        bugs_total=len(bug_lines),
        bugs_found=sum(found(p, line, findings) for p, line in bug_lines),
        bugs_found_after_proof=sum(found(p, line, kept) for p, line in bug_lines),
        false_positives=sum(not matches(f) for f in findings),
        false_positives_after_proof=sum(not matches(f) for f in kept),
    )
    for f in findings:
        status = (f.get("proof") or {}).get("status")
        real = matches(f)
        if status == "confirmed":
            score.confirmed_true += real
            score.confirmed_false += not real
        elif status == "refuted":
            score.dismissed_true += real
            score.dismissed_false += not real
    return score
