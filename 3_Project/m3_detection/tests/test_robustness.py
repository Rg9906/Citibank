"""M3-T06: watermark late events, dedupe, and the model timing guard (SPEC §1, §4.3 step 9)."""
from conftest import Stream, drive
from qdet import contracts
from qdet.config import default as cfg_default
from qdet.ingest import Ingestor
from qdet.pipeline import Pipeline

CFG = cfg_default()


def test_late_event_is_delivered_flagged_and_counted():
    seen = []
    ing = Ingestor(lambda e, late: seen.append((e["event_id"], late)), 100, watermark_ms=2000, validate=False)
    ev = lambda i, t: {"event_id": f"e{i}", "sim_ms": t}
    ing.ingest([ev(1, 1000), ev(2, 5000)])                  # watermark now at 3000: e1 released in order
    ing.ingest([ev(3, 4000)])                               # inside the watermark: held, not late
    ing.ingest([ev(4, 2500)])                               # older than max(5000) - 2000: late
    assert ("e4", True) in seen and ing.metrics["late"] == 1
    ing.release_until(10_000)
    assert [x for x, _ in seen] == ["e1", "e4", "e3", "e2"]  # late goes straight through; the rest stay ordered
    assert all(not late for x, late in seen if x != "e4")


def test_same_event_id_twice_is_processed_once():
    seen = []
    ing = Ingestor(lambda e, late: seen.append(e["event_id"]), 100, watermark_ms=0, validate=False)
    e = {"event_id": "e1", "sim_ms": 1000}
    ing.ingest([e, dict(e)])
    ing.ingest([dict(e)])
    ing.release_until(5000)
    assert seen == ["e1"] and ing.metrics["duplicates"] == 2


def test_late_event_still_lands_in_its_window_bucket():
    events = Stream().traffic(0, 60_000, 30).sorted()
    late = Stream(seed=9)
    late.n = 10_000_000                                     # fresh event ids
    for k in range(40):
        late.attempt(56_000 + k * 10, "P1", "B1", "B2")    # ~4 s behind the newest event: late, inside the window
    rates = {}
    for name, extra in (("without", []), ("with", late.sorted())):
        p = Pipeline("r-S0-1-U0", "U0", CFG, validate=False, grid=None)
        drive(p, events, 60_000)
        p.ingest(extra)
        if extra:
            assert p.ingestor.metrics["late"] > 0
        seg = next(x for x in p.tick(65_000)["segments"] if x["segment_id"] == "psp:P1:*")
        rates[name] = seg["features"]["arrival_rate"]
    assert rates["with"] > rates["without"]                # the late attempts were counted, not dropped


def test_slow_model_twice_degrades_monitoring_with_flag():
    s = Stream().traffic(0, 40_000, 30)
    p = Pipeline("r-S0-1-U0", "U0", CFG, validate=False, grid=None)
    drive(p, s.sorted(), 30_000)
    ticks = iter([0.0, 0.2, 1.0, 1.2, 2.0, 2.2, 3.0, 3.0])  # 200 ms, 200 ms, 200 ms, then fast
    p.clock = lambda: next(ticks)
    first = p.tick(35_000)
    assert first["global_state"] != "DEGRADED_MONITORING"   # one slow tick is tolerated
    second = p.tick(40_000)
    assert second["global_state"] == "DEGRADED_MONITORING"
    assert all("model_degraded" in seg["flags"] for seg in second["segments"])
    assert contracts.errors("segment_state", second) == []
    p.tick(45_000)
    fast = p.tick(50_000)
    assert not any("model_degraded" in seg["flags"] for seg in fast["segments"])
