"""Calibration sweeps for gate G-SIM (SPEC §8).

A run is *stuck* if goodput over [end+60 s, end+120 s] is below 50 % of the warm-up baseline goodput.

    python scripts/calibrate.py --scenario S4 --seeds 20
    python scripts/calibrate.py --scenario S6 --seeds 20 --universes U0 U2
    python scripts/calibrate.py --scenario S4 --seeds 3 --set switch.status_workers=8   # try a lever

Writes data/calibration/<scenario>.json and, if matplotlib is installed, data/figures/F1_<scenario>.png.
Exit code 0 when the §8.3 acceptance holds, 1 otherwise.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from multiprocessing import Pool
from pathlib import Path

import numpy as np
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from qsim import config as config_mod  # noqa: E402
from qsim import ids, scenarios  # noqa: E402
from qsim.engine import Engine  # noqa: E402

ONSET_MS = 180_000
GRIDS = {  # SPEC §8.1 / §8.2
    "S4": ("worker_loss", [0.5, 0.6, 0.7], [20, 40, 60, 90, 120]),
    "S6": ("hold_frac", [0.2, 0.3, 0.4, 0.5], [30, 45, 60, 75]),
}
DATA = Path(os.environ.get("DATA_DIR", Path(__file__).resolve().parents[2] / "data"))


def parse_sets(items: list) -> dict:
    """["switch.status_workers=8"] -> {"switch": {"status_workers": 8}}"""
    out: dict = {}
    for it in items or []:
        key, val = it.split("=", 1)
        sec, name = key.split(".", 1)
        out.setdefault(sec, {})[name] = yaml.safe_load(val)
    return out


def one(job: tuple) -> dict:
    scenario, level, dur_s, seed, universe, cfg_ov, pin = job
    cfg = config_mod.load(overrides=cfg_ov)
    lever = GRIDS[scenario][0]
    sc_ov = {"onset": ONSET_MS, "duration": dur_s * 1000, lever: level}
    sc_ov.update(pin)
    if scenario == "S6":
        sc_ov["resolve_after"] = 90_000
    spec = scenarios.build(scenario, seed, cfg, sc_ov)
    end_s = (ONSET_MS + dur_s * 1000) // 1000
    horizon = (end_s + 125) * 1000
    e = Engine(cfg, spec, seed, universe, ids.run_id(scenario, seed, universe), horizon_ms=horizon)
    e.run_until(horizon)
    g = e.ts["goodput"]
    warm = cfg.run.warmup_ms // 1000
    base = float(g[warm // 2:warm].mean())
    after = float(g[end_s + 60:end_s + 120].mean())
    return {"level": level, "duration_s": dur_s, "seed": seed, "universe": universe,
            "base": base, "after": after, "stuck": bool(after < 0.5 * base)}


def summarise(rows: list, scenario: str, universes: list) -> dict:
    lever, levels, durs = GRIDS[scenario]
    p = {u: {str(lv): {str(d): float(np.mean([r["stuck"] for r in rows if r["universe"] == u and r["level"] == lv
                                              and r["duration_s"] == d])) for d in durs} for lv in levels}
         for u in universes}
    accepted = []
    for lv in levels:
        row = p["U0"][str(lv)]
        short = [d for d in durs if row[str(d)] <= 0.2]
        long_ = [d for d in durs if row[str(d)] >= 0.8 and (not short or d > min(short))]
        if short and long_:
            d_stuck = min(long_)
            u2_ok = "U2" not in p or p["U2"][str(lv)][str(d_stuck)] < row[str(d_stuck)]
            accepted.append({"level": lv, "recover_at_s": min(short), "stuck_at_s": d_stuck,
                             "u0_stuck": row[str(d_stuck)],
                             "u2_stuck": p["U2"][str(lv)][str(d_stuck)] if "U2" in p else None,
                             "u2_less_stuck": u2_ok})
    ok = any(a["u2_less_stuck"] for a in accepted)
    return {"scenario": scenario, "lever": lever, "p_stuck": p, "boundaries": accepted, "accepted": ok}


def heatmap(summary: dict, path: Path) -> None:
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError:
        print("matplotlib not installed; skipping", path.name)
        return
    us = list(summary["p_stuck"])
    fig, axes = plt.subplots(1, len(us), figsize=(4.6 * len(us), 3.4), squeeze=False)
    for k, (ax, u) in enumerate(zip(axes[0], us)):
        p = summary["p_stuck"][u]
        levels = list(p)
        durs = list(p[levels[0]])
        m = np.array([[p[lv][d] for d in durs] for lv in levels])
        im = ax.imshow(m, vmin=0, vmax=1, cmap="magma", origin="lower", aspect="auto")
        ax.set_xticks(range(len(durs)), durs)
        ax.set_yticks(range(len(levels)), levels)
        ax.set_xlabel("trigger duration (s)")
        if k == 0:
            ax.set_ylabel(summary["lever"])
        ax.set_title(f"{summary['scenario']} {u}: P(stuck)")
        for i in range(m.shape[0]):
            for j in range(m.shape[1]):
                ax.text(j, i, f"{m[i, j]:.2f}", ha="center", va="center",
                        color="black" if m[i, j] > 0.5 else "white", fontsize=8)
    fig.colorbar(im, ax=axes[0].tolist(), shrink=0.8)
    fig.text(0.01, 0.01, "simulation", fontsize=7, color="grey")
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=120, bbox_inches="tight")
    print("wrote", path)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", choices=list(GRIDS), required=True)
    ap.add_argument("--seeds", type=int, default=20)
    ap.add_argument("--universes", nargs="+", default=["U0", "U2"])
    ap.add_argument("--set", nargs="*", default=[], help="config overrides section.key=value")
    ap.add_argument("--procs", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    ap.add_argument("--levels", type=float, nargs="+", help="override the trigger-size grid")
    ap.add_argument("--durations", type=int, nargs="+", help="override the duration grid (s)")
    ap.add_argument("--psp", help="pin the faulty PSP (S4)")
    ap.add_argument("--bank", help="pin the faulty bank (S6)")
    ap.add_argument("--no-write", action="store_true", help="print only (use while trying levers)")
    a = ap.parse_args(argv)
    cfg_ov = parse_sets(a.set)
    if a.levels or a.durations:
        lever, lv0, d0 = GRIDS[a.scenario]
        GRIDS[a.scenario] = (lever, a.levels or lv0, a.durations or d0)
    _, levels, durs = GRIDS[a.scenario]
    pin = {k: v for k, v in (("psp", a.psp), ("bank", a.bank)) if v}
    jobs = [(a.scenario, lv, d, s, u, cfg_ov, pin) for u in a.universes for lv in levels for d in durs
            for s in range(1, a.seeds + 1)]
    with Pool(a.procs) as pool:
        rows = pool.map(one, jobs, chunksize=1)
    summary = summarise(rows, a.scenario, a.universes)
    summary.update(seeds=a.seeds, overrides=cfg_ov, pinned=pin)
    for u, p in summary["p_stuck"].items():
        print(f"{a.scenario} {u}  P(stuck)   " + "  ".join(f"{d:>5}s" for d in durs))
        for lv in levels:
            print(f"  {summary['lever']}={lv:<5}  " + "  ".join(f"{p[str(lv)][str(d)]:6.2f}" for d in durs))
    print("boundaries:", json.dumps(summary["boundaries"]))
    print("ACCEPTED" if summary["accepted"] else "NOT ACCEPTED")
    if not a.no_write:
        out = DATA / "calibration" / f"{a.scenario}.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps({**summary, "runs": rows}, indent=1), encoding="utf-8")
        print("wrote", out)
        heatmap(summary, DATA / "figures" / f"F1_{a.scenario.lower()}.png")
    return 0 if summary["accepted"] else 1


if __name__ == "__main__":
    sys.exit(main())
