import json

import pytest
from fastapi.testclient import TestClient
from watchdog_bench import api


@pytest.fixture
def client(tmp_path, monkeypatch):
    results = tmp_path / "results"
    run = results / "no-ai"
    run.mkdir(parents=True)
    score = {
        "case_id": "ts-member-eligibility",
        "language": "ts",
        "tags": ["weak-test"],
        "errors": [],
        "review": None,
        "mutation": {
            "mutants": 2,
            "killed": 0,
            "survived": 2,
            "weak_lines": 1,
            "weak_detected": 1,
            "untested_survivors": 0,
            "unexpected_survivors": 0,
            "skipped_files": 0,
        },
        "test_gap": {
            "untested_total": 0,
            "untested_flagged": 0,
            "tested_total": 0,
            "tested_flagged": 0,
            "bugs_total": 0,
            "bugs_in_flagged_functions": 0,
        },
    }
    (run / "ts-member-eligibility.json").write_text(json.dumps({"score": score, "outputs": {}}))
    monkeypatch.setattr(api, "RESULTS_DIR", results)
    return TestClient(api.app)


def test_health_and_dashboard(client):
    assert client.get("/api/health").json() == {"status": "ok"}
    assert "Watchdog benchmark" in client.get("/").text


def test_cases(client):
    cases = client.get("/api/cases").json()
    assert len(cases) >= 20
    one = client.get("/api/cases/ts-member-eligibility").json()
    assert one["weak_lines"] == 1
    assert "src/coupon.ts" in one["pr"]
    assert client.get("/api/cases/nope").status_code == 404


def test_runs_and_results(client):
    runs = client.get("/api/runs").json()
    assert runs[0]["name"] == "no-ai"
    assert runs[0]["summary"]["weak_line_detection"] == 1.0
    assert (
        client.get("/api/runs/no-ai/cases/ts-member-eligibility").json()["score"]["mutation"][
            "survived"
        ]
        == 2
    )
    assert client.get("/api/runs/missing").status_code == 404


def test_rejects_path_traversal_and_bad_input(client):
    assert client.get("/api/runs/..%2Fsecrets").status_code in (400, 404)
    assert client.get("/api/runs/no-ai/cases/..%2F..%2Fx").status_code in (400, 404)
    assert client.post("/api/runs", json={"mode": "no-ai", "name": "../x"}).status_code == 400
    assert (
        client.post("/api/runs", json={"mode": "no-ai", "only": ["not-a-case"]}).status_code == 400
    )
    assert client.post("/api/runs", json={"mode": "bogus"}).status_code == 422


def test_only_one_run_at_a_time(client, monkeypatch):
    monkeypatch.setattr(api, "_run_job", lambda status, request: None)  # Leave the job "running".
    api._jobs.clear()
    first = client.post("/api/runs", json={"mode": "no-ai", "name": "first"})
    assert first.status_code == 202
    assert client.get("/api/jobs/first").json()["state"] == "running"
    assert client.post("/api/runs", json={"mode": "no-ai", "name": "second"}).status_code == 409
    api._jobs.clear()
