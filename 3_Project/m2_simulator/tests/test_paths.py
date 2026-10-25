"""M2-T06: tests for paths that ran but were never asserted (U1 failover, each action, S1/S2/S5/S7, mock mode)."""
import os
import time

import pytest
from fastapi.testclient import TestClient

from conftest import make
from qsim import config, contracts, scenarios
from qsim.engine import Engine


def _share(events, psp: str, t0: int, t1: int) -> float:
    sent = [e for e in events if e["event_type"] == "ATTEMPT_SENT" and t0 <= e["sim_ms"] < t1 and not e["is_retry"]]
    return sum(1 for e in sent if e["psp"] == psp) / max(1, len(sent))


def test_u1_textbook_failover_moves_weight_and_restores_it():
    # trigger, end to end: at half load a 90 % worker loss on P1 drops its success ratio and U1 moves its weight
    cfg = config.with_rate(config.default(), 80.0)
    e = Engine(cfg, scenarios.build("S4", 1, cfg, {"psp": "P1", "worker_loss": 0.9, "duration": 20_000,
                                                   "onset": 150_000}), 1, "U1", horizon_ms=240_000)
    moved_at = None
    t = 0
    while t < e.horizon and moved_at is None:
        t += 5_000
        e.run_until(t)
        if e.psps[0].weight == 0.0:
            moved_at = t
    assert moved_at is not None and moved_at >= 150_000
    # restore rule (> 0.97 success for 3 ticks): in the runs above the whole network collapses after the move, so
    # restore never happens there (the harmful-failover effect P4 measures); check the rule on its own counters
    e._out_psp[0, :] = 10
    e._succ_psp[0, :] = 10
    for k in range(3):
        assert e.psps[0].weight == 0.0
        e._textbook_failover()
    assert e.psps[0].weight == 1.0 and not e._failover["moved"][0]


def _act(e, atype, scope, params=None, aid="act-00001"):
    a = {"action_id": aid, "action_type": atype, "scope": scope, "params": params or {}}
    return e.apply_action(a), a


def test_shift_traffic_moves_fresh_attempts_and_rollback_restores():
    e = make("S0", 1, "U3", horizon=120_000)
    e.run_until(40_000)
    before = _share(e.events, "P1", 10_000, 40_000)
    assert _act(e, "SHIFT_TRAFFIC", {"psp": "P1"}, {"fraction": 0.25})[0] == "APPLIED"
    e.run_until(80_000)
    after = _share(e.events, "P1", 40_000, 80_000)
    assert after < before - 0.05
    assert _act(e, "ROLLBACK", {"psp": "P1"}, {"action_id": "act-00001"}, "act-00002")[0] == "APPLIED"
    assert e.psps[0].weight == 1.0
    assert _act(e, "ROLLBACK", {}, {"action_id": "act-99999"}, "act-00003")[0] == "REJECTED"


def test_check_budget_defer_shed_and_fresh_first_change_state_and_roll_back():
    e = make("S0", 1, "U3", horizon=30_000)
    e.run_until(10_000)
    _act(e, "CHECK_BUDGET", {"psp": "P2"}, {"rate_per_s": 3.5, "burst": 7}, "act-00001")
    assert e.psps[1].budget["rate_per_s"] == 3.5 and e.psps[1].budget["burst"] == 7
    _act(e, "DEFER_CHECKS", {"bank": "B2"}, {"budget_multiplier": 0.5, "first_check_delay_multiplier": 2.0}, "act-00002")
    assert e.defer[1] == (0.5, 2.0)
    _act(e, "SHED_EXPIRED", {"psp": "P3"}, {}, "act-00003")
    _act(e, "PRIORITIZE_FRESH", {}, {}, "act-00004")
    assert e.psps[2].shed and all(g.fresh_first for g in e.psps)
    for n, orig in enumerate(("act-00002", "act-00003", "act-00004"), start=5):
        assert _act(e, "ROLLBACK", {}, {"action_id": orig}, f"act-{n:05d}")[0] == "APPLIED"
    assert 1 not in e.defer and not e.psps[2].shed and not any(g.fresh_first for g in e.psps)
    applied = [x for x in e.drain_events() if x["event_type"] == "ACTION_APPLIED"]
    assert len(applied) == 7 and all(contracts.errors("payment_event", x) == [] for x in applied)


@pytest.mark.parametrize("scenario", ["S1", "S2", "S5", "S7"])
def test_other_scenarios_run_and_emit_valid_events(scenario):
    e = make(scenario, 2, "U0", horizon=300_000)
    e.run_until(e.horizon)
    ev = e.drain_events()
    assert len(ev) > 10_000
    seen = set()
    for x in ev:
        if x["event_type"] in seen and int(x["event_id"][-8:]) % 200:
            continue                                      # every type once, then a 0.5 % sample
        seen.add(x["event_type"])
        assert contracts.errors("payment_event", x) == [], x
    assert e.spec.truth, "every non-baseline scenario records ground truth"


def test_mock_mode_serves_fixture_run(monkeypatch):
    monkeypatch.setenv("SIM_MODE", "mock")
    monkeypatch.setenv("QS_API_KEY", os.environ.get("QS_API_KEY", "test-key"))
    from qsim.api import create_app
    with TestClient(create_app()) as c:
        assert c.get("/v1/health").json()["mode"] == "mock"
        r = c.post("/v1/scenario", json={"command": "START", "scenario": "S6", "seed": 1, "universe": "U4"},
                   headers={"X-QS-Key": os.environ.get("QS_API_KEY", "test-key")})
        assert r.status_code == 202 and r.json()["run_id"] == "r-S6-1-U4"
        hub = c.app.state.qs.hub
        deadline = time.monotonic() + 10
        while hub.last_id() < 5 and time.monotonic() < deadline:   # the mock replay task publishes fixture events
            time.sleep(0.05)
        assert hub.last_id() >= 5


def test_recovery_time_is_robust_to_poisson_noise():
    import numpy as np

    from qsim.metrics import recovery_time_s
    rng = np.random.default_rng(1)
    g = rng.poisson(165, 600).astype(float)
    assert recovery_time_s(g, 165.0, 200) == 0.0           # healthy but noisy: recovered at once
    out = g.copy()
    out[200:260] = 0
    assert 60 <= recovery_time_s(out, 165.0, 200) <= 75     # 60 s outage + smoothing lag
    stuck = g.copy()
    stuck[200:] = 20
    assert recovery_time_s(stuck, 165.0, 200) is None
