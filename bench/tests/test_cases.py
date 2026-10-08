from pathlib import Path

import pytest
from watchdog_bench.cases import Case, Location, load_cases

CASES_DIR = Path(__file__).resolve().parent.parent / "cases"


def test_every_case_loads_and_its_answer_key_resolves():
    cases = load_cases(CASES_DIR)
    assert len(cases) >= 20
    assert {c.language for c in cases} == {"ts", "python"}
    ids = [c.id for c in cases]
    assert len(ids) == len(set(ids))
    for case in cases:
        assert case.pr, f"{case.id} has no PR changes"
        for key in case.untested + case.tested:
            path, name = key.split("#")
            assert name in case.pr_file(path), f"{case.id}: {name} not in {path}"


def test_line_of_requires_a_unique_match():
    case = Case(
        id="x",
        language="ts",
        title="",
        description="",
        tags=[],
        base={"a.ts": "one\ntwo\ntwo\n"},
        pr={},
    )
    assert case.line_of(Location("a.ts", "one")) == 1
    with pytest.raises(ValueError, match="matches 2 lines"):
        case.line_of(Location("a.ts", "two"))
    with pytest.raises(ValueError, match="matches 0 lines"):
        case.line_of(Location("a.ts", "three"))


def test_pr_files_override_base_files():
    case = Case(
        id="x", language="ts", title="", description="", tags=[], base={"a": "old"}, pr={"a": "new"}
    )
    assert case.pr_file("a") == "new"
