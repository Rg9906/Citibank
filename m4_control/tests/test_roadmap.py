"""Tests for ROADMAP cards M4-T01..T05 (written before the code, 2026-10-23)."""
import pytest

from conftest import incident, snapshot
from qctl import contracts
from qctl.config import default as cfg_default
from qctl.config import load
from qctl.controller import RunControl
from qctl.ledger import ModelLedger

CFG = cfg_default()
TICK = 5_000


class Recorder:
    def __init__(self):
        self.events = []

    def __call__(self, ev, data):
        self.events.append((ev, data))

    def of(self, ev):
        return [d for e, d in self.events if e == ev]


def _run(mode="human", delay=None, ledger=None, cfg=CFG):
    rec = Recorder()
    r = RunControl(cfg, "r-S3-1-U4", ledger or ModelLedger(), mode, delay, publish=rec)
    return r, rec


def _approve_all(r, rec_id, operator="saran"):
    return r.decide({"rec_id": rec_id, "decision": "APPROVE_ALL", "operator": operator, "actions_selected": []})


def _ledger_event(name, body, tx="abc123", block=7):
    return {"event_id": f"{tx}:{name}", "block_number": block, "tx_id": tx, "chaincode": "queueshield",
            "name": name, "payload": body, "received_wall_iso": "2026-10-23T10:00:00.000+00:00", "mock": True}


# ---------------------------------------------------------------- M4-T01: ledger status on the decision stream
def test_t01_decision_response_carries_decision_id_and_block():
    r, _ = _run()
    r.on_tick(snapshot(incidents=[incident()]))
    resp = _approve_all(r, r.pending()[0]["rec_id"])["resp"]
    led = resp["ledger"]
    assert led["decision_tx"] and led["decision_id"] == r.decisions[resp["rec_id"]]["decision_id"]
    assert isinstance(led["block_number"], int) and led["block_number"] >= 1


def test_t01_decision_recorded_event_republishes_ledger_status():
    r, pub = _run()
    r.on_tick(snapshot(incidents=[incident()]))
    res = _approve_all(r, r.pending()[0]["rec_id"])
    dec_id = r.decisions[res["resp"]["rec_id"]]["decision_id"]
    before = len(pub.of("decision"))
    body = {"id": dec_id, "recId": res["resp"]["rec_id"]}
    r.on_ledger_event(_ledger_event("DecisionRecorded", body, tx="feedbeef", block=42))
    upd = pub.of("decision")[before:]
    assert len(upd) == 1
    assert upd[0]["rec_id"] == res["resp"]["rec_id"] and upd[0]["decision_id"] == dec_id
    assert upd[0]["ledger"]["decision_tx"] == "feedbeef" and upd[0]["ledger"]["block_number"] == 42
    adv_id = res["advisories"][0]["id"]
    r.on_ledger_event(_ledger_event("AdvisoryIssued", {"id": adv_id, "decisionId": dec_id}, tx="adv1tx", block=43))
    last = pub.of("decision")[-1]
    assert "adv1tx" in last["ledger"]["advisory_txs"] and last["decision_id"] == dec_id
    # events for ids we never wrote are ignored, never crash
    n = len(pub.of("decision"))
    r.on_ledger_event(_ledger_event("DecisionRecorded", {"id": "dec-99999"}))
    assert len(pub.of("decision")) == n


def test_t01_queued_write_publishes_when_it_finally_lands():
    from test_control import FlakyLedger
    led = FlakyLedger(fail_times=100)
    r, pub = _run(ledger=led)
    r.on_tick(snapshot(incidents=[incident()]))
    res = _approve_all(r, r.pending()[0]["rec_id"])
    assert res["resp"]["ledger"]["pending"] is True and res["resp"]["ledger"]["decision_tx"] is None
    led.fail = 0
    n = len(pub.of("decision"))
    r.on_tick(snapshot(t=270_000))
    late = pub.of("decision")[n:]
    assert late and late[-1]["ledger"]["decision_tx"] and late[-1]["ledger"]["pending"] is False


# ---------------------------------------------------------------- M4-T02: quieter budget publication
def _budget_actions(out):
    return [a for a in out["actions"] if a["action_type"] == "CHECK_BUDGET"]


def test_t02_budgets_respect_min_publish_interval():
    r, pub = _run()
    first = r.on_tick(snapshot(t=100_000, status_rate=0.0))
    assert len(_budget_actions(first)) == 3                          # always on the first tick
    gap = CFG.c.governor.min_publish_interval_s * 1000
    rates = [60.0, 5.0, 60.0, 5.0, 60.0]                             # every tick changes budgets by far more than 10 %
    n = 0
    for i, u in enumerate(rates, start=1):
        n += len(_budget_actions(r.on_tick(snapshot(t=100_000 + i * TICK, status_rate=u))))
    assert n == 0, "changes inside the minimum interval are not published"
    later = r.on_tick(snapshot(t=100_000 + gap, status_rate=60.0))
    assert _budget_actions(later), "a real change after the interval is published"
    for a in _budget_actions(later):
        p = a["params"]
        assert CFG.c.governor.r_min <= p["rate_per_s"]               # SI-5 still holds


def test_t02_defer_checks_approval_forces_a_publication():
    r, _ = _run()
    r.on_tick(snapshot(t=260_000, incidents=[incident()]))
    _approve_all(r, r.pending()[0]["rec_id"])                       # R3 package contains DEFER_CHECKS
    out = r.on_tick(snapshot(t=265_000, status_rate=60.0))
    assert len(_budget_actions(out)) == 3


def test_t02_fewer_budget_actions_than_before_on_a_noisy_run():
    noisy = [float(x) for x in ([0, 40, 5, 50, 10, 60, 2, 45] * 4)]
    r, _ = _run()
    total = sum(len(_budget_actions(r.on_tick(snapshot(t=i * TICK, status_rate=u)))) for i, u in enumerate(noisy))
    old = load(overrides={"governor": {"min_publish_interval_s": 0}})
    r0, _ = _run(cfg=old)
    total0 = sum(len(_budget_actions(r0.on_tick(snapshot(t=i * TICK, status_rate=u)))) for i, u in enumerate(noisy))
    assert total < total0 / 3


# ---------------------------------------------------------------- M4-T03: rollback proposals (C-9)
def _decided_bank_run(mode="human"):
    led = ModelLedger()
    r, pub = _run(mode=mode, delay=0, ledger=led)
    r.on_tick(snapshot(t=260_000, states={"bank:*:B3": "CRITICAL"}, incidents=[incident()]))
    res = _approve_all(r, r.pending()[0]["rec_id"]) if mode == "human" else None
    return r, pub, led, res


def _clean(r, t0, n):
    for i in range(n):
        r.on_tick(snapshot(t=t0 + i * TICK, global_state="MONITORING", incidents=[incident(state="CLOSED")]
                           if i == 0 else []))


def _rollback_recs(r):
    return [x for x in r.recs.values() if [a["action_type"] for a in x["actions"]] == ["ROLLBACK"]]


def test_t03_proposal_after_clean_ticks_and_approval_revokes_advisory():
    r, pub, led, res = _decided_bank_run()
    led.drain()
    n_clean = CFG.c.rollback.clean_ticks
    _clean(r, 270_000, n_clean - 1)
    assert _rollback_recs(r) == [], "not before clean_ticks clean ticks"
    _clean(r, 270_000 + (n_clean - 1) * TICK, 1)
    props = _rollback_recs(r)
    applied = [a for a in res["actions"]]
    assert len(props) == len(applied) and all(p["status"] == "PENDING" for p in props)
    for p in props:
        assert contracts.errors("recommendation", p) == []
        assert p["actions"][0]["params"]["action_id"] in {a["action_id"] for a in applied}
    # approve the rollback of THROTTLE_RETRIES: a ROLLBACK action for M2 and the SLOW_RETRIES advisory revoked
    thr = next(a for a in applied if a["action_type"] == "THROTTLE_RETRIES")
    prop = next(p for p in props if p["actions"][0]["params"]["action_id"] == thr["action_id"])
    out = _approve_all(r, prop["rec_id"])
    rb = [a for a in out["actions"] if a["action_type"] == "ROLLBACK"]
    assert len(rb) == 1 and rb[0]["params"]["action_id"] == thr["action_id"] and rb[0]["origin"] == "ROLLBACK"
    assert contracts.errors("action", rb[0]) == []
    slow = next(a["id"] for a in res["advisories"] if a["kind"] == "SLOW_RETRIES")
    revoked = [e for e in led.drain() if e["name"] == "AdvisoryRevoked"]
    assert [e["payload"]["id"] for e in revoked] == [slow]
    # never proposed twice for the same action
    _clean(r, 400_000, n_clean + 2)
    assert sum(1 for p in _rollback_recs(r) if p["actions"][0]["params"]["action_id"] == thr["action_id"]) == 1


def test_t03_no_proposal_while_the_segment_is_not_clean():
    r, *_ = _decided_bank_run()
    for i in range(CFG.c.rollback.clean_ticks + 3):
        r.on_tick(snapshot(t=270_000 + i * TICK, states={"bank:*:B3": "WARNING"}))
    assert _rollback_recs(r) == []


def test_t03_rejected_actions_and_hold_monitor_get_no_rollback():
    r, _ = _run()
    r.on_tick(snapshot(t=260_000, incidents=[incident(severity="WARNING")]))     # R4: includes HOLD_MONITOR
    rec = r.pending()[0]
    r.decide({"rec_id": rec["rec_id"], "decision": "REJECT", "operator": "saran", "actions_selected": []})
    _clean(r, 270_000, CFG.c.rollback.clean_ticks + 1)
    assert _rollback_recs(r) == []


def test_t03_rejected_actions_by_m2_get_no_rollback():
    r, _, _, res = _decided_bank_run()
    for a in res["actions"]:
        r.mark_applied(a["action_id"], {"sim_ms": 261_000, "result": "REJECTED", "detail": "test"})
    _clean(r, 270_000, CFG.c.rollback.clean_ticks + 1)
    assert _rollback_recs(r) == []


# ---------------------------------------------------------------- M4-T04: one package per bank fault
def test_t04_two_bank_side_incidents_for_one_bank_give_one_pending_package():
    r, _ = _run()
    r.on_tick(snapshot(t=100_000, primary="bank:*:B1",
                       incidents=[incident("route:P1:B1", inc_id="inc-0001")]))
    r.on_tick(snapshot(t=105_000, primary="bank:*:B1",
                       incidents=[incident("route:P1:B1", inc_id="inc-0001"),
                                  incident("route:P2:B1", inc_id="inc-0002")]))
    pend = r.pending()
    assert len(pend) == 1 and pend[0]["incident_id"] == "inc-0002"
    assert r.recs[r.rec_of_incident["inc-0001"]]["status"] == "SUPERSEDED"
    # a later unchanged update of the first incident does not resurrect its package
    r.on_tick(snapshot(t=110_000, primary="bank:*:B1", incidents=[incident("route:P1:B1", inc_id="inc-0001")]))
    assert len(r.pending()) == 1


def test_t04_different_banks_keep_separate_packages():
    r, _ = _run()
    r.on_tick(snapshot(t=100_000, incidents=[incident("bank:*:B1", inc_id="inc-0001"),
                                             incident("bank:*:B2", inc_id="inc-0002")]))
    assert len(r.pending()) == 2


# ---------------------------------------------------------------- M4-T05: operator-delay sweep table
def test_t05_sweep_table_from_results():
    import importlib.util
    from pathlib import Path
    p = Path(__file__).resolve().parent.parent / "scripts" / "operator_sweep.py"
    spec = importlib.util.spec_from_file_location("operator_sweep", p)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    results = {5: [{"metrics": {"recovery_time_s": 0.0, "peak_queue": 10}},
                   {"metrics": {"recovery_time_s": 2.0, "peak_queue": 12}}],
               120: [{"metrics": {"recovery_time_s": 64.0, "peak_queue": 90}},
                     {"metrics": {"recovery_time_s": None, "peak_queue": 99}}]}
    rows = m.tabulate(results)
    assert [r["delay_s"] for r in rows] == [5, 120]
    assert rows[0]["recovery_time_s_median"] == 1.0 and rows[0]["runs"] == 2
    assert rows[1]["recovery_time_s_median"] == 64.0 and rows[1]["not_recovered"] == 1
    assert "simulation" in m.render(rows)
