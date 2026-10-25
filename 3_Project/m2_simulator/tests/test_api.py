import os

from fastapi.testclient import TestClient

os.environ.setdefault("QS_API_KEY", "test-key")
from qsim.api import create_app  # noqa: E402

KEY = {"X-QS-Key": os.environ["QS_API_KEY"]}


def test_health_auth_and_scenario_lifecycle():
    with TestClient(create_app()) as c:
        h = c.get("/v1/health").json()
        assert h["module"] == "m2" and h["status"] in ("ok", "degraded")
        body = {"command": "START", "scenario": "S0", "seed": 1, "universe": "U0"}
        assert c.post("/v1/scenario", json=body).status_code == 401
        assert c.post("/v1/scenario", json={"command": "NOPE"}, headers=KEY).status_code == 400
        r = c.post("/v1/scenario", json=body, headers=KEY)
        assert r.status_code == 202 and r.json()["run_id"] == "r-S0-1-U0-live"
        assert c.get("/v1/status").json()["state"] in ("RUNNING", "DONE")
        assert c.post("/v1/scenario", json={"command": "RESET"}, headers=KEY).status_code == 202
        assert c.get("/v1/status").json()["state"] == "IDLE"


def test_s10_arena_job_writes_valid_results(tmp_path, monkeypatch):
    import time

    from qsim import contracts
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.delenv("DETECT_URL", raising=False)
    with TestClient(create_app()) as c:
        assert c.post("/v1/arena", json={"scenario": "S0", "seeds": [1], "universes": ["U0"]}).status_code == 401
        assert c.post("/v1/arena", json={"scenario": "S9", "seeds": [1], "universes": ["U0"]},
                      headers=KEY).status_code == 400
        r = c.post("/v1/arena", json={"scenario": "S0", "seeds": [1], "universes": ["U0", "U4"]}, headers=KEY)
        assert r.status_code == 202
        job = r.json()["job_id"]
        for _ in range(600):
            v = c.get(f"/v1/arena/{job}").json()
            if v["state"] in ("DONE", "FAILED"):
                break
            time.sleep(0.2)
        assert v == {"state": "DONE", "done": 2, "total": 2, "run_ids": ["r-S0-1-U0", "r-S0-1-U4"]}
        listed = {x["run_id"] for x in c.get("/v1/results").json()}
        assert listed == {"r-S0-1-U0", "r-S0-1-U4"}
        for rid in listed:
            assert contracts.errors("run_result", c.get(f"/v1/results/{rid}").json()) == []
        assert c.get("/v1/arena/arena-nope").status_code == 404
