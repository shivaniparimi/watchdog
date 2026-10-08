"""FastAPI service for the benchmark: browse cases and results, view charts, start runs.

Start it with `python -m watchdog_bench serve`, then open http://127.0.0.1:8000.
"""

from __future__ import annotations

import json
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel, Field

from .cases import Case, load_cases
from .report import load_scores, summarize, to_frame
from .runner import run_all

BENCH_DIR = Path(__file__).resolve().parent.parent
WATCHDOG_ROOT = BENCH_DIR.parent
CASES_DIR = BENCH_DIR / "cases"
RESULTS_DIR = BENCH_DIR / "results"
SAFE_NAME = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

app = FastAPI(title="Watchdog benchmark", version="1.0.0")


class CaseSummary(BaseModel):
    id: str
    language: str
    title: str
    tags: list[str]
    bugs: int
    weak_lines: int
    untested: int


class CaseDetail(CaseSummary):
    description: str
    base: dict[str, str]
    pr: dict[str, str]


class RunSummary(BaseModel):
    name: str
    cases: int
    summary: dict[str, float | int | None]


class RunRequest(BaseModel):
    mode: Literal["no-ai", "ai"] = "no-ai"
    only: list[str] | None = Field(default=None, description="case ids to run; all when empty")
    name: str | None = Field(
        default=None, description="results folder name; defaults to the mode and a timestamp"
    )


class JobStatus(BaseModel):
    name: str
    state: Literal["running", "done", "failed"]
    started: str
    finished: str | None = None
    error: str | None = None


# One benchmark run at a time: runs share the machine's CPU and, in AI mode, a rate-limited key.
_jobs: dict[str, JobStatus] = {}
_lock = threading.Lock()


def _summary(case: Case) -> CaseSummary:
    return CaseSummary(
        id=case.id,
        language=case.language,
        title=case.title,
        tags=case.tags,
        bugs=len(case.bugs),
        weak_lines=len(case.weak),
        untested=len(case.untested),
    )


def _run_dir(name: str) -> Path:
    if not SAFE_NAME.match(name):
        raise HTTPException(400, "invalid run name")
    path = RESULTS_DIR / name
    if not path.is_dir():
        raise HTTPException(404, f"no run named {name}")
    return path


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/cases", response_model=list[CaseSummary])
def list_cases() -> list[CaseSummary]:
    return [_summary(c) for c in load_cases(CASES_DIR)]


@app.get("/api/cases/{case_id}", response_model=CaseDetail)
def get_case(case_id: str) -> CaseDetail:
    matches = load_cases(CASES_DIR, [case_id])
    if not matches:
        raise HTTPException(404, f"no case named {case_id}")
    c = matches[0]
    return CaseDetail(**_summary(c).model_dump(), description=c.description, base=c.base, pr=c.pr)


@app.get("/api/runs", response_model=list[RunSummary])
def list_runs() -> list[RunSummary]:
    runs = []
    for path in sorted(RESULTS_DIR.glob("*")) if RESULTS_DIR.exists() else []:
        scores = load_scores(path) if path.is_dir() else []
        if scores:
            runs.append(
                RunSummary(name=path.name, cases=len(scores), summary=summarize(to_frame(scores)))
            )
    return runs


@app.get("/api/runs/{name}", response_model=RunSummary)
def get_run(name: str) -> RunSummary:
    scores = load_scores(_run_dir(name))
    if not scores:
        raise HTTPException(404, f"run {name} has no results yet")
    return RunSummary(name=name, cases=len(scores), summary=summarize(to_frame(scores)))


@app.get("/api/runs/{name}/cases")
def run_cases(name: str) -> list[dict]:
    return load_scores(_run_dir(name))


@app.get("/api/runs/{name}/cases/{case_id}")
def run_case_result(name: str, case_id: str) -> dict:
    if not SAFE_NAME.match(case_id):
        raise HTTPException(400, "invalid case id")
    path = _run_dir(name) / f"{case_id}.json"
    if not path.exists():
        raise HTTPException(404, f"no result for {case_id} in {name}")
    return json.loads(path.read_text())


@app.get("/api/runs/{name}/charts/{chart}")
def run_chart(name: str, chart: Literal["summary", "mutation_by_language"]) -> FileResponse:
    path = _run_dir(name) / f"{chart}.png"
    if not path.exists():
        raise HTTPException(404, "chart not generated yet")
    return FileResponse(path, media_type="image/png")


def _run_job(status: JobStatus, request: RunRequest) -> None:
    from .__main__ import write_report

    try:
        cases = load_cases(CASES_DIR, request.only)
        out = RESULTS_DIR / status.name
        run_all(cases, WATCHDOG_ROOT, out, ai=request.mode == "ai")
        write_report(out)
        status.state = "done"
    except Exception as err:  # Report any failure through the status endpoint.
        status.state = "failed"
        status.error = str(err)[:1000]
    finally:
        status.finished = datetime.now(timezone.utc).isoformat()


@app.post("/api/runs", response_model=JobStatus, status_code=202)
def start_run(request: RunRequest) -> JobStatus:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    name = request.name or f"{request.mode}-{stamp}"
    if not SAFE_NAME.match(name):
        raise HTTPException(400, "invalid run name")
    if request.only:
        known = {c.id for c in load_cases(CASES_DIR)}
        unknown = sorted(set(request.only) - known)
        if unknown:
            raise HTTPException(400, f"unknown case ids: {', '.join(unknown)}")
    with _lock:
        if any(j.state == "running" for j in _jobs.values()):
            raise HTTPException(409, "a benchmark run is already in progress")
        status = JobStatus(
            name=name, state="running", started=datetime.now(timezone.utc).isoformat()
        )
        _jobs[name] = status
    threading.Thread(target=_run_job, args=(status, request), daemon=True).start()
    return status


@app.get("/api/jobs/{name}", response_model=JobStatus)
def job_status(name: str) -> JobStatus:
    if name not in _jobs:
        raise HTTPException(404, f"no job named {name}")
    return _jobs[name]


DASHBOARD = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Watchdog benchmark</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 960px; padding: 24px 16px; color: #1f2328; }
  h1 { margin-top: 0 } table { border-collapse: collapse; width: 100%; margin: 12px 0 24px }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #d0d7de } th { background: #f6f8fa }
  img { max-width: 100%; margin: 8px 0 } select, button { font: inherit; padding: 4px 10px }
  .muted { color: #59636e }
</style></head>
<body>
<h1>🐕 Watchdog benchmark</h1>
<p class="muted">How well Watchdog finds planted bugs, weak tests and untested code across test cases.</p>
<p><label>Run: <select id="run"></select></label> <button id="start">Start a free (no-AI) run</button> <span id="job"></span></p>
<div id="summary"></div><div id="charts"></div><div id="cases"></div>
<script>
const pct = v => v === null || v === undefined ? "n/a" : (typeof v === "number" && v <= 1 && !Number.isInteger(v) ? Math.round(v * 100) + "%" : v);
async function loadRuns() {
  const runs = await (await fetch("/api/runs")).json();
  const sel = document.getElementById("run");
  sel.innerHTML = runs.map(r => `<option>${r.name}</option>`).join("");
  if (runs.length) show(sel.value); else document.getElementById("summary").textContent = "No runs yet.";
}
async function show(name) {
  const run = await (await fetch(`/api/runs/${name}`)).json();
  document.getElementById("summary").innerHTML = "<h2>Summary</h2><table><tr><th>Metric</th><th>Value</th></tr>" +
    Object.entries(run.summary).map(([k, v]) => `<tr><td>${k.replaceAll("_", " ")}</td><td>${pct(v)}</td></tr>`).join("") + "</table>";
  document.getElementById("charts").innerHTML = ["summary", "mutation_by_language"]
    .map(c => `<img alt="${c} chart" src="/api/runs/${name}/charts/${c}" onerror="this.remove()">`).join("");
  const cases = await (await fetch(`/api/runs/${name}/cases`)).json();
  document.getElementById("cases").innerHTML = "<h2>Cases</h2><table><tr><th>Case</th><th>Language</th><th>Mutants caught</th><th>Unnoticed</th><th>Weak lines found</th><th>Untested flagged</th></tr>" +
    cases.map(c => { const m = c.mutation || {}, g = c.test_gap || {};
      return `<tr><td>${c.case_id}</td><td>${c.language}</td><td>${m.killed ?? ""}</td><td>${m.survived ?? ""}</td><td>${m.weak_detected ?? ""}/${m.weak_lines ?? ""}</td><td>${g.untested_flagged ?? ""}/${g.untested_total ?? ""}</td></tr>`; }).join("") + "</table>";
}
document.getElementById("run").onchange = e => show(e.target.value);
document.getElementById("start").onclick = async () => {
  const res = await fetch("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "no-ai" }) });
  const job = await res.json(); const el = document.getElementById("job");
  if (!res.ok) { el.textContent = job.detail; return; }
  el.textContent = `Running ${job.name}…`;
  const poll = setInterval(async () => {
    const s = await (await fetch(`/api/jobs/${job.name}`)).json();
    if (s.state !== "running") { clearInterval(poll); el.textContent = s.state === "done" ? "Done." : `Failed: ${s.error}`; loadRuns(); }
  }, 2000);
};
loadRuns();
</script></body></html>"""


@app.get("/", response_class=HTMLResponse)
def dashboard() -> str:
    return DASHBOARD
