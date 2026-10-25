"""M4-T05: operator-delay sweep for the arena (simulation only).

Asks M2 for S4 arena runs at several simulated-operator approval delays and tabulates recovery per delay.
The delay reaches M4 through the lockstep ResetRequest (`operator_delay_s`), which M2 fills from `overrides`.

    python scripts/operator_sweep.py --sim http://localhost:8001 --scenario S4 --seeds 1 2 3 4 5 \
        --universe U4 --delays 5 15 30 60 120 --out ../data/operator_sweep.md

Talks to M2 only over HTTP (CONTRACTS §1: POST /v1/arena, GET /v1/arena/{job_id}, GET /v1/results/{run_id});
never imports simulator code. Every number it prints is a simulation result and is labelled so.
"""
from __future__ import annotations

import argparse
import os
import statistics
import sys
import time
from typing import Optional

METRICS = ("recovery_time_s", "peak_queue", "switch_checks_per_unknown", "goodput_min_frac")


def _median(xs: list) -> Optional[float]:
    xs = [x for x in xs if x is not None]
    return round(statistics.median(xs), 3) if xs else None


def tabulate(results: dict) -> list:
    """results: {delay_s: [run_result, ...]} -> one row per delay (sorted), medians of each metric.

    A run with recovery_time_s == null did not recover inside the run; it is counted, not averaged in.
    """
    rows = []
    for delay in sorted(results):
        runs = results[delay]
        row = {"delay_s": delay, "runs": len(runs),
               "not_recovered": sum(1 for r in runs if r["metrics"].get("recovery_time_s") is None)}
        for m in METRICS:
            row[f"{m}_median"] = _median([r["metrics"].get(m) for r in runs])
        rows.append(row)
    return rows


def render(rows: list, scenario: str = "S4", universe: str = "U4") -> str:
    head = ["approval delay (s)", "runs", "not recovered", "median recovery (s)", "median peak queue",
            "median checks/unknown", "median min goodput"]
    lines = [f"Operator-delay sweep — simulation, scenario {scenario}, universe {universe} (our simulator; "
             "not a measurement of any real network)", "",
             "| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    fmt = lambda v: "–" if v is None else f"{v:g}"  # noqa: E731
    for r in rows:
        lines.append("| " + " | ".join([str(r["delay_s"]), str(r["runs"]), str(r["not_recovered"])]
                                       + [fmt(r[f"{m}_median"]) for m in METRICS]) + " |")
    return "\n".join(lines) + "\n"


def run_sweep(sim: str, scenario: str, seeds: list, universe: str, delays: list, poll_s: float = 2.0,
              timeout_s: float = 3600.0) -> dict:
    import httpx
    headers = {"X-QS-Key": os.environ.get("QS_API_KEY", "")}
    out = {}
    with httpx.Client(base_url=sim.rstrip("/"), timeout=30.0, headers=headers) as c:
        for d in delays:
            r = c.post("/v1/arena", json={"scenario": scenario, "seeds": seeds, "universes": [universe],
                                          "overrides": {"operator_mode": "auto", "operator_delay_s": d}})
            r.raise_for_status()
            job, t0 = r.json()["job_id"], time.monotonic()
            while True:
                st = c.get(f"/v1/arena/{job}").json()
                print(f"delay {d:>4}s: {st.get('done', 0)}/{st.get('total', '?')}", file=sys.stderr)
                if st.get("state") in ("DONE", "FAILED") or st.get("done") == st.get("total"):
                    break
                if time.monotonic() - t0 > timeout_s:
                    raise TimeoutError(f"arena job {job} did not finish")
                time.sleep(poll_s)
            out[d] = [c.get(f"/v1/results/{rid}").json() for rid in st.get("run_ids", [])]
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sim", default=os.environ.get("SIM_URL", "http://localhost:8001"))
    ap.add_argument("--scenario", default="S4")
    ap.add_argument("--seeds", type=int, nargs="+", default=[1, 2, 3, 4, 5])
    ap.add_argument("--universe", default="U4")
    ap.add_argument("--delays", type=float, nargs="+", default=[5, 15, 30, 60, 120])
    ap.add_argument("--out", help="also write the markdown table here")
    a = ap.parse_args(argv)
    rows = tabulate(run_sweep(a.sim, a.scenario, a.seeds, a.universe, a.delays))
    md = render(rows, a.scenario, a.universe)
    print(md)
    if a.out:
        with open(a.out, "w", encoding="utf-8") as fh:
            fh.write(md)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
