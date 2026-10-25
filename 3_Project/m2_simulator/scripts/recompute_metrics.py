"""Recompute `recovery_time_s` in existing data/runs/*/result.json from their timeseries.json (after the 2026-10-25
fix: 10 s smoothing). Other metrics need the engine and are left as they are.

    python scripts/recompute_metrics.py [--runs ../data/runs]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from qsim import config as config_mod  # noqa: E402
from qsim import contracts  # noqa: E402
from qsim.metrics import recovery_time_s  # noqa: E402


def main(argv=None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", default=str(Path(__file__).resolve().parents[2] / "data" / "runs"))
    a = ap.parse_args(argv)
    run_cfg = config_mod.default().run
    warm, horizon_s = run_cfg.warmup_ms // 1000, run_cfg.length_ms // 1000
    for f in sorted(Path(a.runs).glob("*/result.json")):
        r = json.loads(f.read_text(encoding="utf-8"))
        ts_f = f.parent / "timeseries.json"
        ends = [t["end_ms"] for t in r["ground_truth"] if t["is_incident"]]
        if not ts_f.is_file() or not ends:
            continue
        g = np.asarray(json.loads(ts_f.read_text(encoding="utf-8"))["goodput"], float)[:horizon_s]  # as run_metrics
        base = float(g[warm // 2:warm].mean())
        old = r["metrics"]["recovery_time_s"]
        r["metrics"]["recovery_time_s"] = recovery_time_s(g, base, max(ends) // 1000)
        contracts.validate("run_result", r)
        f.write_text(json.dumps(r, indent=1), encoding="utf-8")
        print(f"{r['run_id']}: recovery_time_s {old} -> {r['metrics']['recovery_time_s']}")


if __name__ == "__main__":
    main()
