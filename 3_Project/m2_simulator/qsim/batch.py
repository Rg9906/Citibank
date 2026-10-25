"""Batch (lockstep) runner and arena (docs/01_SYSTEM.md §4.1, docs/M2_SIMULATOR.md §12).

For each 5 000 ms tick: advance the engine, POST the new events to detect `/v1/batch/tick`, POST the snapshot to
control `/v1/batch/tick`, apply returned actions whose effective time is before the next tick. U0-U2 skip the
QueueShield steps; U3 sends no ledger events. Without DETECT_URL/CONTROL_URL the run is open-loop (no actions),
which is what U0-U2 need anyway and lets M2 produce datasets alone.

    python -m qsim.batch --scenario S6 --seeds 1 2 3 --universes U0 U2 U4 --out ../data/runs
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx

from qsim import config as config_mod
from qsim import contracts, ids, jsonlog, metrics, scenarios
from qsim.engine import Engine

GOVERNED = ("U3", "U4")


def sim_version() -> str:
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True,
                              check=True).stdout.strip() or "dev"
    except (OSError, subprocess.CalledProcessError):
        return "dev"


def config_sha256(cfg) -> str:
    return hashlib.sha256(repr(cfg).encode()).hexdigest()


class Lockstep:
    """HTTP client for the M3/M4 batch endpoints."""

    def __init__(self, detect_url: str, control_url: str, operator_delay_s: Optional[float]) -> None:
        self.detect_url, self.control_url = detect_url.rstrip("/"), control_url.rstrip("/")
        self.delay = operator_delay_s
        self.http = httpx.Client(timeout=30.0, headers={"X-QS-Key": os.environ.get("QS_API_KEY", "")})

    def reset(self, run_id: str) -> None:
        body = {"run_id": run_id, "mode": "batch", "operator_mode": "auto"}
        if self.delay is not None:
            body["operator_delay_s"] = self.delay
        contracts.validate("lockstep", body, "ResetRequest")
        for url in (self.detect_url, self.control_url):
            self.http.post(f"{url}/v1/batch/reset", json=body).raise_for_status()

    def tick(self, run_id: str, universe: str, t: int, events: list, ledger_events: list) -> tuple:
        req = {"run_id": run_id, "universe": universe, "tick_sim_ms": t, "events": events}
        snap = self.http.post(f"{self.detect_url}/v1/batch/tick", json=req).json()
        if not contracts.accept("segment_state", snap):
            return snap, {"recommendations": [], "actions": [], "advisories": []}
        creq = {"run_id": run_id, "tick_sim_ms": t, "snapshot": snap, "ledger_events": ledger_events}
        resp = self.http.post(f"{self.control_url}/v1/batch/tick", json=creq).json()
        if not contracts.accept("lockstep", resp, "ControlTickResponse"):
            resp = {"recommendations": [], "actions": [], "advisories": []}
        return snap, resp


def model_ledger_events(events: list, block0: int) -> list:
    """U4 batch: the in-sim ledger model's resolutions as `ledger_event` records for M4 (mock=True, never live)."""
    out, now = [], datetime.now(timezone.utc).isoformat(timespec="milliseconds")
    for e in events:
        if e["event_type"] not in ("LEDGER_OPENED", "LEDGER_RESOLVED"):
            continue
        state = e["ledger_state"]
        ref = ids.txn_ref(e["run_id"], e["payment_id"])
        tx = hashlib.sha256(f"{ref}:{state}".encode()).hexdigest()[:16]
        rec = {"event_id": f"{tx}:PaymentUpdated", "block_number": block0 + len(out) + 1, "tx_id": tx,
               "chaincode": "queueshield", "name": "PaymentUpdated",
               "payload": {"txnRef": ref, "state": state, "prevState": None if state == "UNKNOWN" else "UNKNOWN",
                           "kind": "OPEN" if state == "UNKNOWN" else ("CREDIT" if state == "SUCCESS" else
                                                                      "REVERSAL" if state == "REVERSED" else
                                                                      "FAILURE_REMITTER"),
                           "runId": e["run_id"], "payerPsp": e["psp"], "remitterBank": e["remitter_bank"],
                           "beneficiaryBank": e["beneficiary_bank"], "simMs": e["sim_ms"],
                           "debitImplied": state in ("SUCCESS", "REVERSED")},
               "received_wall_iso": now, "mock": True}
        if contracts.accept("ledger_event", rec):
            out.append(rec)
    return out


def run_one(scenario: str, seed: int, universe: str, out_dir: Optional[Path] = None,
            lockstep: Optional[Lockstep] = None, overrides: Optional[dict] = None,
            horizon_ms: Optional[int] = None, stop_after_end_s: Optional[int] = None, gz: bool = True,
            suffix: Optional[str] = None) -> dict:
    """One run. `stop_after_end_s` ends the run that long after the last trigger ends (training data: the stuck
    label needs only end + 120 s) and skips the drain; `gz` writes events.jsonl.gz (~10x smaller)."""
    cfg = config_mod.load(overrides=(overrides or {}).get("config"))
    spec = scenarios.build(scenario, seed, cfg, (overrides or {}).get("scenario"))
    ends = [x["end_ms"] for x in spec.truth if x["is_incident"]]
    if stop_after_end_s is not None and ends:
        horizon_ms = max(ends) + stop_after_end_s * 1000
    rid = ids.run_id(scenario, seed, universe, suffix=suffix)
    e = Engine(cfg, spec, seed, universe, rid, horizon_ms=horizon_ms)
    all_events: list = []
    ticks: list = []
    use_qs = lockstep is not None and universe in GOVERNED
    if use_qs:
        lockstep.reset(rid)
    tick = cfg.run.tick_ms
    pending_actions: list = []
    block = 0
    t = tick
    while t <= e.horizon:
        e.run_until(t)
        for a in [a for a in pending_actions if a["effective_from_sim_ms"] <= t]:
            e.apply_action(a)
            pending_actions.remove(a)
        ev = e.drain_events()
        all_events.extend(ev)
        if use_qs:
            led = model_ledger_events(ev, block) if universe == "U4" else []
            block += len(led)
            snap, resp = lockstep.tick(rid, universe, t, ev, led)
            ticks.append(snap)
            pending_actions.extend(resp.get("actions", []))
        t += tick
    if stop_after_end_s is None:
        e.run_to_completion()
    all_events.extend(e.drain_events())
    ev_name = "events.jsonl.gz" if gz else "events.jsonl"
    result = {"run_id": rid, "scenario": scenario, "seed": int(seed), "universe": universe,
              "config_sha256": config_sha256(cfg), "sim_version": sim_version(),
              "metrics": metrics.run_metrics(e), "ground_truth": spec.truth, "files": {"events": ev_name}}
    if out_dir is not None:
        d = Path(out_dir) / rid
        d.mkdir(parents=True, exist_ok=True)
        for stale in ("events.jsonl", "events.jsonl.gz"):           # never leave an old copy next to the new one
            (d / stale).unlink(missing_ok=True)
        opener = gzip.open if gz else open
        with opener(d / ev_name, "wt", encoding="utf-8") as f:
            for x in all_events:
                f.write(json.dumps(x, separators=(",", ":")) + "\n")
        (d / "ground_truth.json").write_text(json.dumps(spec.truth, indent=1), encoding="utf-8")
        (d / "timeseries.json").write_text(json.dumps(metrics.timeseries(e)), encoding="utf-8")
        result["files"].update(ground_truth="ground_truth.json", timeseries="timeseries.json")
        if ticks:
            with open(d / "ticks.jsonl", "w", encoding="utf-8") as f:
                for x in ticks:
                    f.write(json.dumps(x, separators=(",", ":")) + "\n")
            result["files"]["ticks"] = "ticks.jsonl"
        contracts.validate("run_result", result)
        (d / "result.json").write_text(json.dumps(result, indent=1), encoding="utf-8")
    jsonlog.info("run done", run_id=rid, events=len(all_events))
    return result


def main(argv: Optional[list] = None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", required=True)
    ap.add_argument("--seeds", type=int, nargs="+", default=[1])
    ap.add_argument("--universes", nargs="+", default=["U0", "U2", "U4"])
    ap.add_argument("--out", default=os.environ.get("DATA_DIR", "../data") + "/runs")
    ap.add_argument("--operator-delay-s", type=float, default=None)
    ap.add_argument("--seed-range", type=int, nargs=2, metavar=("FIRST", "LAST"), help="instead of --seeds")
    ap.add_argument("--stop-after-end-s", type=int, default=None, help="training runs: stop this long after the trigger")
    ap.add_argument("--plain", action="store_true", help="write events.jsonl uncompressed")
    ap.add_argument("--jobs", type=int, default=1, help="parallel processes (open-loop runs only)")
    a = ap.parse_args(argv)
    seeds = list(range(a.seed_range[0], a.seed_range[1] + 1)) if a.seed_range else a.seeds
    ls = None
    if os.environ.get("DETECT_URL") and os.environ.get("CONTROL_URL"):
        ls = Lockstep(os.environ["DETECT_URL"], os.environ["CONTROL_URL"], a.operator_delay_s)
    plan = [(a.scenario, s, u, Path(a.out), None, None, None, a.stop_after_end_s, not a.plain)
            for s in seeds for u in a.universes]
    if a.jobs > 1 and ls is None:
        from multiprocessing import Pool
        with Pool(a.jobs) as pool:
            pool.starmap(run_one, plan, chunksize=1)
        return
    for args in plan:
        run_one(*args[:4], ls, *args[5:])


if __name__ == "__main__":
    main()
