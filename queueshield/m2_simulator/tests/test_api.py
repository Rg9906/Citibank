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
