"""Command line: `python -m watchdog_bench run|report|serve`."""

from __future__ import annotations

import argparse
from pathlib import Path

from .cases import load_cases
from .report import charts, load_scores, markdown, summarize, to_frame
from .runner import clean, run_all

BENCH_DIR = Path(__file__).resolve().parent.parent
WATCHDOG_ROOT = BENCH_DIR.parent


def main() -> None:
    parser = argparse.ArgumentParser(prog="watchdog_bench", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="run Watchdog on the benchmark cases")
    run.add_argument(
        "--ai", action="store_true", help="also run the AI review and proof tests (needs a key)"
    )
    run.add_argument("--only", nargs="*", help="case ids to run")
    run.add_argument("--out", type=Path, help="results directory (default: bench/results/<mode>)")
    run.add_argument("--force", action="store_true", help="re-run cases that already have results")

    rep = sub.add_parser("report", help="summarize results into report.md and charts")
    rep.add_argument("results", type=Path, help="results directory")

    serve = sub.add_parser("serve", help="start the FastAPI dashboard")
    serve.add_argument("--port", type=int, default=8000)

    args = parser.parse_args()
    if args.command == "run":
        out = args.out or BENCH_DIR / "results" / ("ai" if args.ai else "no-ai")
        if args.force:
            clean(out)
        cases = load_cases(BENCH_DIR / "cases", args.only)
        run_all(cases, WATCHDOG_ROOT, out, ai=args.ai, force=args.force)
        write_report(out)
    elif args.command == "report":
        write_report(args.results)
    elif args.command == "serve":
        import uvicorn

        uvicorn.run("watchdog_bench.api:app", host="127.0.0.1", port=args.port)


def write_report(results: Path) -> None:
    df = to_frame(load_scores(results))
    if df.empty:
        print("No results yet.")
        return
    summary = summarize(df)
    (results / "report.md").write_text(
        markdown(summary, df, f"Watchdog benchmark ({results.name})")
    )
    for path in charts(df, summary, results):
        print(f"chart: {path}")
    print(f"report: {results / 'report.md'}")
    for key, value in summary.items():
        print(f"  {key}: {value}")


if __name__ == "__main__":
    main()
