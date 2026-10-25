"""S-11: the live ledger bridge against the real M1 mock gateway (started here over HTTP; nothing imported).

Skipped when Node or the gateway folder is missing (M1_GATEWAY_DIR overrides the default sibling path).
"""
import os
import shutil
import socket
import subprocess
import time
from dataclasses import replace
from pathlib import Path

import httpx
import pytest

from qsim import config, ids, scenarios
from qsim.engine import Engine
from qsim.ledger_bridge import LedgerBridge, facts

GATEWAY = Path(os.environ.get("M1_GATEWAY_DIR", Path(__file__).resolve().parents[2] / "m1_ledger" / "gateway"))
KEY = "s11-test-key"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture(scope="module")
def gateway():
    node = shutil.which("node")
    if node is None or not (GATEWAY / "src" / "main.ts").exists():
        pytest.skip("node or the M1 gateway is not available")
    port = _free_port()
    env = {**os.environ, "PORT": str(port), "QS_API_KEY": KEY, "LEDGER_MODE": "mock"}
    proc = subprocess.Popen([node, "src/main.ts"], cwd=GATEWAY, env=env, stdout=subprocess.DEVNULL,
                            stderr=subprocess.DEVNULL)
    url = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            if httpx.get(f"{url}/v1/health", timeout=0.5).status_code == 200:
                break
        except httpx.HTTPError:
            time.sleep(0.1)
    else:
        proc.kill()
        pytest.fail("gateway did not start")
    yield url
    proc.kill()
    proc.wait(timeout=5)


def _engine(run_id: str) -> Engine:
    base = config.default()
    cfg = replace(base, fresh_rate_per_s=base.fresh_rate_per_s * base.live.demo_rate_factor)
    spec = scenarios.build("S6", 3, cfg, {"onset": 20_000, "duration": 25_000, "hold_frac": 0.5,
                                          "resolve_after": 15_000, "bank": "B1"})
    return Engine(cfg, spec, 3, "U4", run_id, horizon_ms=120_000)


def test_s11_unknowns_open_attest_and_resolve_only_from_ledger_events(gateway):
    run_id = ids.run_id("S6", 3, "U4", suffix="s11")
    e = _engine(run_id)
    bridge = LedgerBridge(gateway, run_id, KEY).start()
    e.attach_ledger(bridge)
    consumed = 0
    try:
        t = 0
        while t < e.horizon:
            t += 500
            for ref, state in bridge.drain():
                consumed += 1
                e.ledger_event(ref, state)
            e.run_until(t)
            e.drain_events()
            time.sleep(0.005)                       # let the writer and the stream keep up (~100x real time)
        deadline = time.monotonic() + 30
        while (bridge.backlog or e._bridged) and time.monotonic() < deadline:
            for ref, state in bridge.drain():
                consumed += 1
                e.ledger_event(ref, state)
            time.sleep(0.05)
        st = bridge.status()
    finally:
        bridge.stop()

    opened = [p for p in e.payments if p.ledger_live]
    assert len(opened) >= 20, "the scenario must produce unknowns that go to the ledger"
    assert st["healthy"] and st["write_errors"] == 0 and st["dropped"] == 0
    assert st["opened"] == len(opened) and st["attested"] >= len(opened)
    # every ledger resolution in the engine came from a terminal PaymentUpdated read off the stream
    assert e.stats["ledger_resolved"] + e.stats.get("ledger_disputed", 0) == consumed > 0
    assert e._bridged == {}, "every opened unknown reached a terminal ledger state"
    # the gateway agrees: the records for this run are terminal and match the simulator's truth
    recs = {r["txnRef"]: r for r in httpx.get(f"{gateway}/v1/payments", params={"run_id": run_id, "limit": 100000},
                                               headers={"X-QS-Key": KEY}).json()}
    states = [recs[ids.txn_ref(run_id, p.pid)]["state"] for p in opened]
    assert set(states) <= {"SUCCESS", "FAILED_NO_DEBIT", "REVERSED", "DISPUTED"}
    assert states.count("DISPUTED") <= 0.05 * len(states)
    for p, st_ in zip(opened, states):
        if st_ == "SUCCESS":                         # the ledger never invents a credit
            assert any(a.credited for a in p.attempts)
        if st_ == "REVERSED":
            assert any(a.reversed for a in p.attempts)


def test_bridge_facts_order():
    class A:
        def __init__(self, **kw):
            self.debited = self.credited = self.failed = self.reversed = False
            self.__dict__.update(kw)

    class P:
        def __init__(self, attempts, truth):
            self.attempts, self._t = attempts, truth

        def truth(self):
            return self._t

    assert facts(P([A(debited=True, credited=True)], "SUCCESS")) == ["DEBIT", "CREDIT"]
    assert facts(P([A(debited=True, failed=True, reversed=True)], "FAILED")) == \
        ["DEBIT", "FAILURE_BENEFICIARY", "REVERSAL"]
    assert facts(P([A()], "FAILED")) == ["FAILURE_REMITTER"]
    assert facts(P([A(debited=True)], "IN_FLIGHT")) == ["DEBIT"]


def test_dead_gateway_marks_bridge_unhealthy_and_engine_falls_back():
    run_id = ids.run_id("S6", 3, "U4", suffix="dead")
    e = _engine(run_id)
    bridge = LedgerBridge(f"http://127.0.0.1:{_free_port()}", run_id, KEY, timeout_s=0.3).start(wait_stream_s=1)
    e.attach_ledger(bridge)
    try:
        deadline = time.monotonic() + 30
        t = 0
        while bridge.healthy and time.monotonic() < deadline and t < e.horizon:
            t += 1000
            e.run_until(t)
            time.sleep(0.05)
        assert not bridge.healthy
        moved = e.ledger_fallback()
        assert moved >= 1 and e._bridged == {}
        e.run_until(e.horizon)
        assert any(p.ledger_open and not p.ledger_live for p in e.payments)   # new unknowns use the model
    finally:
        bridge.stop()
