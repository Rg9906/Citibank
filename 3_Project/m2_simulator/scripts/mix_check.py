"""Share of stuck runs when every scenario parameter is drawn from config/scenarios.yaml (U0), as M3's training set
will see it. Target for S4/S6: roughly 30-70 % stuck so the forecaster has both outcomes to learn from.

    python scripts/mix_check.py --scenario S4 --seeds 40 [--set S4.duration=[10000,45000]]
"""
from __future__ import annotations

import argparse
import os
import sys
from multiprocessing import Pool
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from qsim import config as config_mod  # noqa: E402
from qsim import ids, scenarios  # noqa: E402
from qsim.engine import Engine  # noqa: E402


def one(job: tuple) -> dict:
    scenario, seed, sc_over = job
    cfg = config_mod.load()
    if sc_over:
        cfg.scenarios[scenario].update(sc_over)
    spec = scenarios.build(scenario, seed, cfg)
    end_s = (spec.params["onset"] + spec.params["duration"]) // 1000
    e = Engine(cfg, spec, seed, "U0", ids.run_id(scenario, seed, "U0"), horizon_ms=(end_s + 125) * 1000)
    e.run_until(e.horizon)
    g = e.ts["goodput"]
    warm = cfg.run.warmup_ms // 1000
    base = float(g[warm // 2:warm].mean())
    stuck = float(g[end_s + 60:end_s + 120].mean()) < 0.5 * base
    return {"seed": seed, "stuck": stuck, **{k: v for k, v in spec.params.items() if k in
                                               ("psp", "bank", "duration", "worker_loss", "hold_frac")}}


def main(argv=None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", required=True)
    ap.add_argument("--seeds", type=int, default=40)
    ap.add_argument("--set", nargs="*", default=[], help="scenario range overrides, e.g. S4.duration=[10000,45000]")
    a = ap.parse_args(argv)
    over = {}
    for it in a.set:
        k, v = it.split("=", 1)
        over[k.split(".", 1)[1]] = yaml.safe_load(v)
    with Pool(max(1, (os.cpu_count() or 2) - 1)) as pool:
        rows = pool.map(one, [(a.scenario, s, over) for s in range(1, a.seeds + 1)])
    share = sum(r["stuck"] for r in rows) / len(rows)
    by = {}
    for r in rows:
        k = r.get("psp") if a.scenario == "S4" else r.get("bank")
        by.setdefault(k, []).append(r["stuck"])
    print(f"{a.scenario} {over or 'config ranges'}: stuck {share:.2f} over {len(rows)} configs; "
          + ", ".join(f"{k}: {sum(v)}/{len(v)}" for k, v in sorted(by.items())))


if __name__ == "__main__":
    main()
