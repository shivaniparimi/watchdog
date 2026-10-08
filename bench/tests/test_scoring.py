from watchdog_bench.cases import Case, Location
from watchdog_bench.report import summarize, to_frame
from watchdog_bench.scoring import CaseScore, score_review, score_test_gap

SOURCE = "\n".join(
    [
        "export function ok(a, b) {",  # 1
        "  return a > b && b > 0;",  # 2  weak line
        "}",  # 3
        "export function fresh(x) {",  # 4  untested function
        "  return x === 1;",  # 5
        "}",  # 6
        "export function buggy(t) {",  # 7
        "  return t - 1;",  # 8  planted bug
        "}",  # 9
    ]
)


def make_case() -> Case:
    return Case(
        id="demo",
        language="ts",
        title="t",
        description="d",
        tags=["bug"],
        base={},
        pr={"src/a.ts": SOURCE},
        bugs=[Location("src/a.ts", "return t - 1;")],
        weak=[Location("src/a.ts", "a > b && b > 0")],
        untested=["src/a.ts#fresh"],
        tested=["src/a.ts#ok", "src/a.ts#buggy"],
    )


def verdict(covered, risk="medium", uncertain=False):
    return {"covered": covered, "risk": risk, "uncertain": uncertain, "source": "rule"}


def function(name, start, end, v):
    return {"path": "src/a.ts", "name": name, "start": start, "end": end, "verdict": v}


def mutant(line, status):
    return {"path": "src/a.ts", "line": line, "status": status, "description": "x"}


def test_test_gap_and_mutation_scoring():
    output = {
        "findings": [
            function("ok", 1, 3, verdict(False)),  # flagged by mutation: correct for a weak test
            function("fresh", 4, 6, verdict(False)),  # flagged: correct, it's untested
            function(
                "buggy", 7, 9, verdict(False, uncertain=True)
            ),  # unverified doesn't count as a flag
        ],
        "mutation": {
            "results": [
                mutant(2, "survived"),  # weak line detected
                mutant(5, "survived"),  # inside the untested function: expected
                mutant(8, "survived"),  # tested line nobody expected to survive: false alarm
                mutant(8, "killed"),
                mutant(8, "timeout"),  # counts as caught
                mutant(8, "invalid"),  # not counted at all
            ],
            "skipped": [{"path": "src/b.ts", "reason": "no tests"}],
        },
    }
    gap, mutation = score_test_gap(make_case(), output)
    assert (gap.untested_flagged, gap.untested_total) == (1, 1)
    assert (gap.tested_flagged, gap.tested_total) == (1, 2)
    assert (gap.bugs_in_flagged_functions, gap.bugs_total) == (0, 1)
    assert mutation.mutants == 5
    assert mutation.killed == 2
    assert mutation.survived == 3
    assert (mutation.weak_detected, mutation.weak_lines) == (1, 1)
    assert mutation.untested_survivors == 1
    assert mutation.unexpected_survivors == 1
    assert mutation.skipped_files == 1


def test_missing_mutation_report_scores_only_test_gaps():
    gap, mutation = score_test_gap(make_case(), {"findings": [], "mutation": None})
    assert mutation is None
    assert gap.untested_flagged == 0


def finding(line, category="bug", severity="major", proof=None):
    f = {"path": "src/a.ts", "line": line, "category": category, "severity": severity, "title": "t"}
    if proof:
        f["proof"] = {"status": proof}
    return f


def test_review_scoring_before_and_after_proof():
    output = {
        "findings": [
            finding(9, proof="confirmed"),  # within 3 lines of the bug on line 8
            finding(2, proof="refuted"),  # false alarm, correctly dismissed
            finding(1),  # false alarm that was never tested (more than 3 lines from the bug)
            finding(1, category="style"),  # style advice isn't a correctness claim
            finding(8, severity="nit"),  # nits don't count
        ]
    }
    score = score_review(make_case(), output)
    assert (score.bugs_found, score.bugs_found_after_proof, score.bugs_total) == (1, 1, 1)
    assert score.false_positives == 2
    assert score.false_positives_after_proof == 1
    assert (score.confirmed_true, score.confirmed_false) == (1, 0)
    assert (score.dismissed_true, score.dismissed_false) == (0, 1)


def test_review_scoring_counts_a_dismissed_real_bug():
    score = score_review(make_case(), {"findings": [finding(8, proof="refuted")]})
    assert score.bugs_found == 1
    assert score.bugs_found_after_proof == 0
    assert score.dismissed_true == 1


def test_summary_rates():
    case = make_case()
    gap, mutation = score_test_gap(
        case,
        {
            "findings": [function("fresh", 4, 6, verdict(False))],
            "mutation": {"results": [mutant(2, "survived")]},
        },
    )
    review = score_review(
        case, {"findings": [finding(8, proof="confirmed"), finding(2, proof="refuted")]}
    )
    scores = [CaseScore("demo", "ts", [], mutation=mutation, test_gap=gap, review=review).to_dict()]
    s = summarize(to_frame(scores))
    assert s["cases"] == 1
    assert s["weak_line_detection"] == 1.0
    assert s["untested_recall"] == 1.0
    assert s["bug_recall"] == 1.0
    assert s["false_positives"] == 1
    assert s["false_positives_after_proof"] == 0
    assert s["false_positive_reduction"] == 1.0
    assert s["confirmed_precision"] == 1.0
