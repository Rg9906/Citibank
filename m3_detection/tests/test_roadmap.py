"""Tests for ROADMAP cards M3-T01, T02, T05, T06 (written before the code, 2026-10-23)."""
import json
import time

import numpy as np
import pytest

from conftest import RUN, Stream, drive
from qdet import segments as S
from qdet.config import default as cfg_default
from qdet.ingest import Ingestor
from qdet.localizer import residual_excess
from qdet.pipeline import Pipeline

CFG = cfg_default()


# ---------------------------------------------------------------- M3-T02: one incident per bank fault
def _bank_fault_run(rate, seed, bank="B1", p_bad=1.0, t0=200_000, t1=300_000, t_end=400_000, extra=None):
    s = Stream(seed)

    def bad(t, p, r, b):
        if t0 <= t < t1 and bank in (r, b) and s.rng.uniform() < p_bad:
            return "CLIENT_TIMEOUT"
        if extra:
            return extra(t, p, r, b)
        return None
    ev = s.traffic(0, t_end, rate, bad).sorted()
    return drive(Pipeline(RUN, "U0", CFG, grid=None), ev, t_end)


def _opened(snaps):
    out = {}
    for sn in snaps:
        for i in sn["incidents"]:
            out.setdefault(i["incident_id"], i)
    return out


@pytest.mark.parametrize("rate,p_bad,seed", [(25, 1.0, 1), (25, 1.0, 2), (25, 0.5, 3), (25, 0.3, 2),
                                             (80, 1.0, 2), (80, 0.5, 2), (80, 0.3, 1)])
def test_t02_single_bank_fault_gives_exactly_one_incident(rate, p_bad, seed):
    """Demo rate (~25/s) and full rate; the fault also raises timeouts on every bank/route that trades with B1
    (dual involvement), which used to open 4-11 extra incidents."""
    incs = _opened(_bank_fault_run(rate, seed, p_bad=p_bad))
    assert len(incs) == 1, {k: (v["segment_id"], v["verdict"]) for k, v in incs.items()}
    (inc,) = incs.values()
    assert inc["segment_id"] == "bank:*:B1" and inc["verdict"] == "BANK_SIDE"


def test_t02_independent_second_fault_still_opens_its_own_incident():
    # B1 times out from 200 s; route P2 -> B3/B4 traffic that never touches B1 also fails from 230 s
    def other(t, p, r, b):
        if 230_000 <= t < 300_000 and p == "P2" and "B3" in (r, b) and "B1" not in (r, b):
            return "CLIENT_TIMEOUT"
        return None
    incs = _opened(_bank_fault_run(80, 4, extra=other))
    segs = {i["segment_id"] for i in incs.values()}
    assert "bank:*:B1" in segs
    assert any(sid not in ("bank:*:B1",) and ("B3" in sid or "P2" in sid) for sid in segs), segs


def test_t02_residual_excess_removes_the_explaining_bank():
    exp = np.full((S.NP, S.NB, S.NB), 0.1)
    bad = exp.copy()
    b1 = S.BANK_IDX["B1"]
    bad[:, b1, :] += 5.0
    bad[:, :, b1] += 5.0
    full = residual_excess(bad, exp, "bank:*:B3", None)
    assert full > 20                                   # B3 looks bad because it trades with B1
    assert residual_excess(bad, exp, "bank:*:B3", "B1") == pytest.approx(0.0, abs=1e-9)
    bad[:, S.BANK_IDX["B3"], S.BANK_IDX["B4"]] += 6.0   # an independent B3 problem survives
    assert residual_excess(bad, exp, "bank:*:B3", "B1") >= 18
    assert residual_excess(bad, exp, "route:P2:B3", "B1") == pytest.approx(6.0)


# ---------------------------------------------------------------- M3-T06: robustness
def test_t06_late_event_is_flagged_counted_and_still_delivered():
    got = []
    ing = Ingestor(lambda e, late: got.append((e["event_id"], late)), 1000, 2000, validate=False)
    ing.ingest([{"event_id": "a", "sim_ms": 10_000}, {"event_id": "b", "sim_ms": 20_000}])
    ing.ingest([{"event_id": "late", "sim_ms": 12_000}])           # 8 s behind the max: older than the watermark
    assert ("late", True) in got and ing.metrics["late"] == 1
    ing.ingest([{"event_id": "c", "sim_ms": 19_000}])              # within the 2 s watermark: not late
    assert ing.metrics["late"] == 1


def test_t06_late_event_lands_in_its_bucket_if_inside_the_ring():
    s = Stream()
    s.snapshots(0)
    for k in range(25):
        s.attempt(1000 + k * 300, "P1", "B1", "B2", rt=200)
    p = Pipeline(RUN, "U0", CFG, validate=False, grid=None)
    on_time = [e for e in s.sorted() if e["sim_ms"] < 9_000]
    late = [e for e in s.sorted() if e["sim_ms"] >= 9_000]
    p.ingest(on_time)
    p.ingest([{**on_time[-1], "event_id": "x-future", "sim_ms": 30_000, "event_type": "PSP_SNAPSHOT",
               "psp": "P2", "queue_depth": 0, "active_workers": 0, "workers": 40}])
    p.ingest(late)
    assert p.ingestor.metrics["late"] == len(late)
    snap = p.tick(10_000)
    seg = next(x for x in snap["segments"] if x["segment_id"] == "route:P1:B1")
    assert seg["features"]["arrival_rate"] == pytest.approx(2.5)   # all 25 attempts counted in [0, 10 s)


def test_t06_duplicate_event_counted_once():
    s = Stream()
    s.snapshots(0)
    s.attempt(1000, "P1", "B1", "B2")
    ev = s.sorted()
    p = Pipeline(RUN, "U0", CFG, grid=None)
    p.ingest(ev + ev)
    assert p.ingestor.metrics["duplicates"] == len(ev) and p.ingestor.metrics["accepted"] == len(ev)
    snap = p.tick(10_000)
    seg = next(x for x in snap["segments"] if x["segment_id"] == "psp:P1:*")
    assert seg["features"]["arrival_rate"] == pytest.approx(0.1)


def test_t06_slow_scoring_twice_flags_model_degraded():
    ev = Stream().traffic(0, 150_000, 20).sorted()
    p = Pipeline(RUN, "U0", CFG, grid=None)
    drive(p, ev, 140_000)
    orig = p.d3.update

    def slow(ft):
        time.sleep(CFG.d3.model_budget_ms / 1000 * 1.5)
        return orig(ft)
    p.d3.update = slow
    s1 = p.tick(145_000)
    assert "model_degraded" not in s1["segments"][0]["flags"] and s1["global_state"] != "DEGRADED_MONITORING"
    s2 = p.tick(150_000)
    assert "model_degraded" in s2["segments"][0]["flags"] and s2["global_state"] == "DEGRADED_MONITORING"
    p.d3.update = orig
    s3 = p.tick(155_000)
    assert "model_degraded" not in s3["segments"][0]["flags"]


# ---------------------------------------------------------------- M3-T05: detector race fields
def test_t05_detector_alerts_carry_first_alert_per_detector():
    fault = lambda t, p, r, b: "CLIENT_TIMEOUT" if 200_000 <= t < 280_000 and p == "P2" else None  # noqa: E731
    snaps = drive(Pipeline(RUN, "U0", CFG, grid=None), Stream(5).traffic(0, 280_000, 80, fault).sorted(), 280_000)
    firsts = {}
    for sn in snaps:
        for a in sn["detector_alerts"]:
            firsts.setdefault((a["detector"], a["segment_id"]), a["first_alert_sim_ms"])
            assert firsts[(a["detector"], a["segment_id"])] == a["first_alert_sim_ms"], "first time never moves"
    dets = {d for d, _ in firsts}
    assert "D3" in dets and dets <= {"D0", "D1", "D2", "D3"}


# ---------------------------------------------------------------- M3-T01: training split
def _load_trainer():
    import importlib.util
    from pathlib import Path
    p = Path(__file__).resolve().parent.parent / "scripts" / "train_forecaster.py"
    spec = importlib.util.spec_from_file_location("train_forecaster", p)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def test_t01_split_by_configuration_has_no_overlap():
    m = _load_trainer()
    names = [f"r-S4-{s}-U0" for s in (1, 7, 999, 1000, 1500, 1999, 2000, 2999, 3000)] + ["r-S6-12-U0-x1"]
    sp = {n: m.split_of(n) for n in names}
    assert sp["r-S4-1-U0"] == sp["r-S4-999-U0"] == sp["r-S6-12-U0-x1"] == "A"
    assert sp["r-S4-1000-U0"] == sp["r-S4-1999-U0"] == "B"
    assert sp["r-S4-2000-U0"] == sp["r-S4-2999-U0"] == "C"
    assert sp["r-S4-3000-U0"] is None
    # every sample of a run lands in its run's split (the integrity check of D-7)
    rows = [(0.1, 0.2, 1.0, n) for n in names for _ in range(3)]
    parts = m.split_rows(rows)
    seen = {}
    for k, part in parts.items():
        for *_, run in part:
            assert seen.setdefault(run, k) == k
    assert not (set(r[3] for r in parts["A"]) & set(r[3] for r in parts["B"]))


def test_t01_train_end_to_end_on_synthetic_samples_reports_metrics(tmp_path):
    m = _load_trainer()
    rng = np.random.default_rng(11)
    rows = []
    for split_seed in list(range(1, 41)) + list(range(1000, 1020)):
        run = f"r-S4-{split_seed}-U0"
        stuck = float(rng.uniform() < 0.5)
        for _ in range(20):
            d = rng.uniform(0.8, 2.0) if stuck else rng.uniform(0.0, 1.2)
            o = rng.uniform(0.5, 3.0) if stuck else rng.uniform(0.0, 1.5)
            rows.append((d, o, stuck, run))
    report = m.fit_and_report(rows, CFG, tmp_path / "grid.json")
    assert set(report) >= {"monotone", "unsmoothed", "n_runs", "stuck_share"}
    for k in ("monotone", "unsmoothed"):
        assert 0.5 < report[k]["auc_B"] <= 1.0 and 0.0 <= report[k]["brier_B"] <= 0.25
    out = json.loads((tmp_path / "grid.json").read_text())
    assert len(out["delay_bins"]) == 21 and np.array(out["p"]).shape == (20, 20)
    assert out["contour_0_5"] is not None
