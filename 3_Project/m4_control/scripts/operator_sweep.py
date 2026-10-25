"""Operator-delay sweep (ROADMAP M4-T05): how much does approval latency matter?

Asks M2 for S4 arena runs in U4 at operator delays 5/15/30/60/120 s (M3 and M4 must be running and M2 must have
DETECT_URL / CONTROL_URL set, so U4 runs go through lockstep with the simulated operator), then tabulates recovery
and peak queue per delay. The IBM sweep found approval delay was the dominant factor. Every number is simulation.

    python scripts/operator_sweep.py --sim http://127.0.0.1:8001 --seeds 1 2 3 [--scenario S4] [--delays 5 15 30 60 120]
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time

import httpx


def run_delay(http: httpx.Client, sim: str, scenario: str, seeds: list, delay: float) -> list:
    body = {"scenario": scenario, "seeds": seeds, "universes": ["U4"], "operator_delay_s": delay,
            "suffix": f"op{int(delay)}"}
    r = http.post(f"{sim}/v1/arena", json=body)
    r.raise_for_status()
    job = r.json()["job_id"]
    while True:
        v = http.get(f"{sim}/v1/arena/{job}").json()
        if v["state"] in ("DONE", "FAILED"):
            break
        time.sleep(2)
    if v["state"] == "FAILED":
        raise RuntimeError(f"arena job {job} failed: {v.get('error')}")
    return [http.get(f"{sim}/v1/results/{rid}").json()["metrics"] for rid in v["run_ids"]]


def med(xs: list):
    xs = [x for x in xs if x is not None]
    return statistics.median(xs) if xs else None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--sim", default=os.environ.get("SIM_URL", "http://127.0.0.1:8001"))
    ap.add_argument("--scenario", default="S4")
    ap.add_argument("--seeds", type=int, nargs="+", default=[1, 2, 3])
    ap.add_argument("--delays", type=float, nargs="+", default=[5, 15, 30, 60, 120])
    ap.add_argument("--out", default="../data/figures/operator_sweep.json")
    a = ap.parse_args(argv)
    http = httpx.Client(timeout=60, headers={"X-QS-Key": os.environ.get("QS_API_KEY", "")})
    rows = []
    for d in a.delays:
        ms = run_delay(http, a.sim.rstrip("/"), a.scenario, a.seeds, d)
        rows.append({"operator_delay_s": d, "runs": len(ms),
                     "recovered": sum(1 for m in ms if m["recovery_time_s"] is not None),
                     "median_recovery_time_s": med([m["recovery_time_s"] for m in ms]),
                     "median_peak_queue": med([m["peak_queue"] for m in ms]),
                     "median_goodput_min_frac": med([m["goodput_min_frac"] for m in ms])})
        print(json.dumps(rows[-1]))
    out = {"label": f"simulation, {a.scenario}, U4, seeds {a.seeds}, preliminary", "rows": rows}
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1)
    print(f"{'delay s':>8} {'recovered':>10} {'med recovery s':>15} {'med peak queue':>15}")
    for r in rows:
        print(f"{r['operator_delay_s']:>8.0f} {r['recovered']:>4}/{r['runs']:<5} "
              f"{str(r['median_recovery_time_s']):>15} {str(r['median_peak_queue']):>15}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
