"""S1 benign-surge evaluation (ROADMAP M3-T04 / D-4, and M3-T01 step 5).

For every S1 run of validation set B: replay the events through the pipeline with the trained grid and report
  - D-4: share of surge ticks (ground-truth surge window) whose `platform:*:*` row is labelled `surge` (target >= 95 %),
    and the same share for the PSP rows;
  - false CRITICAL per simulated hour: ticks where any segment is CRITICAL or any PSP forecast is CRITICAL
    (S1 is benign, so every one is false), counted as alert groups (a group = consecutive CRITICAL ticks);
  - D3 warning groups (any segment WARNING/CRITICAL) per simulated hour, for the D-11 budget.
Offline only (reads ground_truth.json). Simulation data.

    python scripts/eval_surge.py --runs ../data/train_runs [--out ../data/models/surge_report.json]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from multiprocessing import Pool
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from qdet.config import default as default_cfg  # noqa: E402
from qdet.forecast.grid import StuckGrid  # noqa: E402
from qdet.pipeline import Pipeline  # noqa: E402
from qdet.runs import events_file, read_events  # noqa: E402

PSP_ROWS = ("psp:P1:*", "psp:P2:*", "psp:P3:*")


def groups(flags: list) -> int:
    return sum(1 for i, f in enumerate(flags) if f and (i == 0 or not flags[i - 1]))


def eval_run(args: tuple) -> dict:
    d, grid_path = Path(args[0]), args[1]
    cfg = default_cfg()
    grid = StuckGrid.from_dict(json.loads(Path(grid_path).read_text(encoding="utf-8"))) if grid_path else None
    gt = json.loads((d / "ground_truth.json").read_text(encoding="utf-8"))
    surge = next(t for t in gt if t["kind"] == "surge")
    events = read_events(d)
    p = Pipeline(d.name, "U0", cfg, validate=False, grid=grid)
    end = max(e["sim_ms"] for e in events)
    i, t = 0, cfg.tick_ms
    in_win, plat, psp_hits, psp_total = 0, 0, 0, 0
    crit, warn = [], []
    while t <= end:
        j = i
        while j < len(events) and events[j]["sim_ms"] < t:
            j += 1
        p.ingest(events[i:j])
        i = j
        snap = p.tick(t)
        rows = {s["segment_id"]: s for s in snap["segments"]}
        if t > cfg.baselines.warmup_s * 1000:          # alerts are not counted while baselines warm up
            crit.append(any(s["state"] == "CRITICAL" or s.get("forecast_state") == "CRITICAL" for s in snap["segments"]))
            warn.append(any(s["state"] in ("WARNING", "CRITICAL") for s in snap["segments"]))
        if surge["onset_ms"] <= t < surge["end_ms"]:
            in_win += 1
            plat += bool(rows["platform:*:*"]["surge"])
            psp_hits += sum(bool(rows[r]["surge"]) for r in PSP_ROWS)
            psp_total += len(PSP_ROWS)
        t += cfg.tick_ms
    hours = len(crit) * cfg.tick_ms / 3_600_000
    return {"run_id": d.name, "surge_ticks": in_win, "platform_surge_share": plat / in_win if in_win else None,
            "psp_surge_share": psp_hits / psp_total if psp_total else None,
            "false_critical_groups": groups(crit), "warning_groups": groups(warn), "hours": hours}


def main(argv=None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", default="../data/train_runs")
    ap.add_argument("--grid", default="../data/models/forecaster_grid.json")
    ap.add_argument("--out", default="../data/models/surge_report.json")
    ap.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    a = ap.parse_args(argv)
    dirs = [str(d) for d in sorted(Path(a.runs).glob("r-S1-1[0-9][0-9][0-9]-U0")) if events_file(d)]
    if not dirs:
        sys.exit("no S1 validation runs (seeds 1000-1999) under --runs")
    grid = a.grid if Path(a.grid).is_file() else None
    with Pool(min(a.jobs, len(dirs))) as pool:
        rows = pool.map(eval_run, [(d, grid) for d in dirs], chunksize=1)
    hours = sum(r["hours"] for r in rows)
    ticks = sum(r["surge_ticks"] for r in rows)
    summary = {
        "runs": len(rows), "simulated_hours": round(hours, 3), "grid": grid,
        "platform_surge_share": sum((r["platform_surge_share"] or 0) * r["surge_ticks"] for r in rows) / ticks,
        "psp_surge_share": sum((r["psp_surge_share"] or 0) * r["surge_ticks"] for r in rows) / ticks,
        "false_critical_groups_per_hour": sum(r["false_critical_groups"] for r in rows) / hours,
        "warning_groups_per_hour": sum(r["warning_groups"] for r in rows) / hours,
        "d4_target": ">= 0.95 platform surge share", "label": "simulation, S1 validation runs"}
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps({"summary": summary, "runs": rows}, indent=1), encoding="utf-8")
    for r in rows:
        print(json.dumps(r))
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
