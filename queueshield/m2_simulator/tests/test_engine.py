"""M2 acceptance tests S-1 .. S-7, S-9 (docs/M2_SIMULATOR.md §14). Shortened horizon (300 s) for speed."""
import hashlib
import json
from collections import Counter, defaultdict

import numpy as np

from conftest import HORIZON, make, run
from qsim import config
from qsim.tape import Tape


def digest(events) -> str:
    h = hashlib.sha256()
    for e in events:
        h.update(json.dumps(e, sort_keys=True, separators=(",", ":")).encode())
    return h.hexdigest()


def test_s1_determinism():
    a, b = run("S4", 7, "U3", horizon=120_000), run("S4", 7, "U3", horizon=120_000)
    assert digest(a.drain_events()) == digest(b.drain_events())


def test_s2_conservation(s6_runs):
    for u, e in s6_runs.items():
        closed = Counter(x["payment_id"] for x in e.events if x["event_type"] == "PAYMENT_CLOSED")
        assert len(closed) == len(e.payments), u
        assert set(closed.values()) == {1}, u
        for p in e.payments:                      # every attempt reached exactly one terminal ground-truth state
            for a in p.attempts:
                assert a.state == 3 and not a.reversal_pending, (u, p.pid, a.k)


def test_s3_common_random_numbers():
    cfg = config.default()
    tapes = [Tape(3, cfg, HORIZON) for _ in range(2)]
    for name in ("arrivals", "psp", "rem", "ben", "z_rem", "z_ben", "u_td_ben"):
        assert np.array_equal(getattr(tapes[0], name)[:1000], getattr(tapes[1], name)[:1000]), name
    firsts = [[x["sim_ms"] for x in run("S0", 3, u, horizon=30_000).events
               if x["event_type"] == "PAYMENT_INITIATED"][:1000] for u in ("U0", "U2", "U4")]
    assert firsts[0] == firsts[1] == firsts[2]


def test_s4_utilisation_and_littles_law():
    e = run("S0", 2, "U0", drain=False)
    p1 = e.ground_truth_stats()["per_psp"][0]
    # P1 carries 40 % of demand. With equal workers per PSP, P3 sits lower (see docs/DEVIATIONS.md).
    assert 0.45 <= p1["utilisation"] <= 0.65, p1
    lam = p1["arrival_rate"] / 1000.0
    assert abs(p1["mean_queue"] - lam * p1["mean_wait_ms"]) <= 0.05 * max(1.0, p1["mean_queue"]) + 0.05


def _si1_violations(events) -> int:
    """ATTEMPT_SENT while the payment is PENDING_UNKNOWN / STATUS_CHECKING (derived from the stream only)."""
    pending, bad = defaultdict(bool), 0
    for e in events:
        pid, t = e.get("payment_id"), e["event_type"]
        if t == "ATTEMPT_OUTCOME" and e["status"] == "CLIENT_TIMEOUT":
            pending[pid] = True
        elif t == "STATUS_CHECK_RESULT" and e["status"] in ("CONFIRMED_FAILED", "CONFIRMED_SUCCESS"):
            pending[pid] = False
        elif t == "LEDGER_RESOLVED":
            pending[pid] = False
        elif t == "ATTEMPT_SENT" and pending[pid]:
            bad += 1
    return bad


def test_s6_si1_never_violated_by_npci_rule_clients(s6_runs):
    assert _si1_violations(s6_runs["U2"].events) == 0
    assert _si1_violations(run("S4", 4, "U2").events) == 0
    for u in ("U2", "U4"):
        assert s6_runs[u].stats["si1_violations_governed"] == 0
    # naive clients (U0) do violate it: that is the duplicate-prone behaviour being modelled
    assert _si1_violations(s6_runs["U0"].events) > 0


def test_s7_switch_storm_under_u0_lower_under_u4(s6_runs):
    u0, u4 = s6_runs["U0"], s6_runs["U4"]
    snaps = [x for x in u0.events if x["event_type"] == "SWITCH_SNAPSHOT"]
    assert max(x["switch_slowdown_factor"] for x in snaps) > 2.0
    assert max(x["switch_status_active"] for x in snaps) / 4 > 0.95
    assert u4.ts["switch_checks"].max() < u0.ts["switch_checks"].max()
    assert u4.ground_truth_stats()["duplicate_commits"] < u0.ground_truth_stats()["duplicate_commits"]


def test_throttle_mechanism_rejects_over_budget_retries():
    pins = {"psp": "P1", "onset": 150_000, "duration": 80_000, "worker_loss": 0.65}
    e = make("S4", 5, "U0", overrides=pins)
    e.run_until(160_000)
    e.apply_action({"action_id": "act-00001", "action_type": "THROTTLE_RETRIES", "scope": {"psp": "P1"},
                    "params": {"rate_fraction": 0.1, "retry_after_ms": [2000, 8000]}})
    e.run_until(200_000)
    later = [x for x in e.events if x["event_type"] == "ATTEMPT_OUTCOME" and x["status"] == "RETRY_LATER"]
    assert later and all(x["psp"] == "P1" and x["retry_count"] > 0 for x in later)


def test_s9_throttle_lowers_excess_retries():
    pins = {"psp": "P1", "onset": 150_000, "duration": 80_000, "worker_loss": 0.65}
    base = run("S4", 5, "U0", overrides=pins)
    acted = make("S4", 5, "U0", overrides=pins)
    acted.run_until(160_000)
    acted.apply_action({"action_id": "act-00001", "action_type": "THROTTLE_RETRIES", "scope": {"psp": "P1"},
                        "params": {"rate_fraction": 0.1, "retry_after_ms": [2000, 8000]}})
    acted.run_to_completion()

    def excess(e):
        return e.ground_truth_stats()["attempts"] - len(e.payments)
    assert excess(acted) < excess(base)


def test_ledger_model_resolves_unknowns_in_u4(s6_runs):
    e = s6_runs["U4"]
    assert e.stats["ledger_opened"] > 0 and e.stats["ledger_resolved"] > 0
    opened = {x["payment_id"] for x in e.events if x["event_type"] == "LEDGER_OPENED"}
    resolved = {x["payment_id"] for x in e.events if x["event_type"] == "LEDGER_RESOLVED"}
    assert resolved <= opened
