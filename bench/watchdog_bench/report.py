"""Aggregate per-case scores into a results table, a markdown report and charts."""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd


def load_scores(results_dir: Path) -> list[dict]:
    return [json.loads(p.read_text())["score"] for p in sorted(results_dir.glob("*.json"))]


def to_frame(scores: list[dict]) -> pd.DataFrame:
    """One row per case, with mutation/test_gap/review columns flattened (e.g. mutation.killed)."""
    return pd.json_normalize(scores, sep=".")


def _rate(num: float, den: float) -> float | None:
    return None if den == 0 else num / den


def summarize(df: pd.DataFrame) -> dict[str, float | int | None]:
    """Headline metrics across all cases."""

    def total(col: str) -> float:
        return float(df[col].fillna(0).sum()) if col in df else 0.0

    s: dict[str, float | int | None] = {"cases": len(df)}
    if "mutation.mutants" in df:
        s["mutants_run"] = int(total("mutation.mutants"))
        s["mutation_kill_rate"] = _rate(total("mutation.killed"), total("mutation.mutants"))
        s["weak_line_detection"] = _rate(
            total("mutation.weak_detected"), total("mutation.weak_lines")
        )
        s["mutation_false_alarms"] = int(total("mutation.unexpected_survivors"))
    if "test_gap.untested_total" in df:
        s["untested_recall"] = _rate(
            total("test_gap.untested_flagged"), total("test_gap.untested_total")
        )
        s["tested_false_alarm_rate"] = _rate(
            total("test_gap.tested_flagged"), total("test_gap.tested_total")
        )
        s["bugs_flagged_without_ai"] = _rate(
            total("test_gap.bugs_in_flagged_functions"), total("test_gap.bugs_total")
        )
    if "review.bugs_total" in df and total("review.bugs_total") > 0:
        s["bug_recall"] = _rate(total("review.bugs_found"), total("review.bugs_total"))
        s["bug_recall_after_proof"] = _rate(
            total("review.bugs_found_after_proof"), total("review.bugs_total")
        )
        s["false_positives"] = int(total("review.false_positives"))
        s["false_positives_after_proof"] = int(total("review.false_positives_after_proof"))
        s["false_positive_reduction"] = _rate(
            total("review.false_positives") - total("review.false_positives_after_proof"),
            total("review.false_positives"),
        )
        confirmed = total("review.confirmed_true") + total("review.confirmed_false")
        s["confirmed_precision"] = _rate(total("review.confirmed_true"), confirmed)
    return s


LABELS = {
    "cases": "Cases",
    "mutants_run": "Mutants run",
    "mutation_kill_rate": "Mutants caught by tests",
    "weak_line_detection": "Weak-test lines detected",
    "mutation_false_alarms": "Mutation false alarms",
    "untested_recall": "Untested functions flagged",
    "tested_false_alarm_rate": "Tested functions wrongly flagged",
    "bugs_flagged_without_ai": "Planted bugs in code the free checks flagged",
    "bug_recall": "Planted bugs found (before proof)",
    "bug_recall_after_proof": "Planted bugs found (after proof)",
    "false_positives": "False positives (before proof)",
    "false_positives_after_proof": "False positives (after proof)",
    "false_positive_reduction": "False positives removed by proof tests",
    "confirmed_precision": "Confirmed findings that were real bugs",
}


def _fmt(key: str, value: float | int | None) -> str:
    if value is None:
        return "n/a"
    if key.endswith(
        ("rate", "detection", "recall", "reduction", "precision", "after_proof", "without_ai")
    ) and isinstance(value, float):
        return f"{value:.0%}"
    return str(int(value)) if float(value).is_integer() else f"{value:.2f}"


def markdown(summary: dict, df: pd.DataFrame, title: str) -> str:
    lines = [f"# {title}", "", "| Metric | Value |", "|---|---|"]
    for key, value in summary.items():
        lines.append(f"| {LABELS.get(key, key)} | {_fmt(key, value)} |")

    cols = [
        c
        for c in (
            "case_id",
            "language",
            "mutation.killed",
            "mutation.survived",
            "mutation.weak_detected",
            "mutation.weak_lines",
            "test_gap.untested_flagged",
            "test_gap.untested_total",
            "review.bugs_found",
            "review.bugs_total",
            "review.false_positives_after_proof",
        )
        if c in df
    ]
    lines += ["", "## Per case", "", "| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    for _, row in df[cols].iterrows():
        cells = [
            "" if pd.isna(v) else (str(int(v)) if isinstance(v, float) else str(v)) for v in row
        ]
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines) + "\n"


def charts(df: pd.DataFrame, summary: dict, out_dir: Path) -> list[Path]:
    """Save PNG charts of the headline rates and per-language mutation results."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    out_dir.mkdir(parents=True, exist_ok=True)
    saved: list[Path] = []

    rates = {LABELS[k]: v for k, v in summary.items() if isinstance(v, float) and k in LABELS}
    if rates:
        fig, ax = plt.subplots(figsize=(8, 0.5 + 0.45 * len(rates)))
        ax.barh(list(rates), [v * 100 for v in rates.values()], color="#4C72B0")
        ax.set_xlim(0, 112)
        ax.set_xlabel("%")
        ax.invert_yaxis()
        for i, v in enumerate(rates.values()):
            ax.text(v * 100 + 1, i, f"{v:.0%}", va="center")
        ax.set_title("Watchdog benchmark")
        fig.tight_layout()
        path = out_dir / "summary.png"
        fig.savefig(path, dpi=150)
        plt.close(fig)
        saved.append(path)

    if "mutation.killed" in df:
        by_lang = df.groupby("language")[["mutation.killed", "mutation.survived"]].sum()
        fig, ax = plt.subplots(figsize=(6, 3.5))
        by_lang.plot.bar(ax=ax, color=["#55A868", "#C44E52"], rot=0)
        ax.legend(["Caught by tests", "Unnoticed"])
        ax.set_ylabel("Mutants")
        ax.set_title("Mutation check by language")
        fig.tight_layout()
        path = out_dir / "mutation_by_language.png"
        fig.savefig(path, dpi=150)
        plt.close(fig)
        saved.append(path)
    return saved
