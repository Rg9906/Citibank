"""Train the point-of-no-return grid from M2 batch runs (docs/M3_DETECTION.md §6.2-§6.4, ROADMAP M3-T01).

Offline only: this script MAY read ground_truth.json; the live pipeline never imports it (pitfall 4).
Labels: a run is *stuck* if goodput (closed CONFIRMED_SUCCESS per s) over [trigger end + 60 s, + 120 s] is below
50 % of the warm-up baseline. Samples: one per tick from trigger start to trigger end + 60 s for every PSP
(the switch couples PSPs). Features are recomputed with this module's own pipeline.

Split **by configuration** (all ticks of a run in one set) by seed: A 1-999 train, B 1000-1999 validation,
C 2000-2999 test (untouched here). Each run gets the same total weight, so long stuck runs do not dominate.
Fits the grid with monotone on and off and reports sample-level AUC / Brier and run-level AUC on B.

    python scripts/train_forecaster.py --runs ../data/train_runs --out ../data/models/forecaster_grid.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from multiprocessing import Pool
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from qdet import segments as S  # noqa: E402
from qdet.config import default as default_cfg  # noqa: E402
from qdet.forecast.grid import StuckGrid  # noqa: E402
from qdet.pipeline import Pipeline  # noqa: E402
from qdet.runs import events_file, read_events  # noqa: E402

STUCK_FRAC = 0.5
JUDGE_FROM_S, JUDGE_TO_S, SAMPLE_TAIL_S = 60, 120, 60
SPLITS = {"A": (1, 999), "B": (1000, 1999), "C": (2000, 2999)}


def split_of(run_id: str) -> str | None:
    """r-<scenario>-<seed>-<universe> -> A/B/C by seed range; None outside every range."""
    seed = int(run_id.split("-")[2])
    return next((k for k, (lo, hi) in SPLITS.items() if lo <= seed <= hi), None)


def goodput_per_s(events: list, n_s: int) -> np.ndarray:
    g = np.zeros(n_s + 1)
    for e in events:
        if e["event_type"] == "PAYMENT_CLOSED" and e["close_reason"] == "CONFIRMED_SUCCESS":
            s = e["sim_ms"] // 1000
            if s <= n_s:
                g[s] += 1
    return g


def samples_for_run(d: Path, cfg=None) -> tuple:
    cfg = cfg or default_cfg()
    gt = [t for t in json.loads((d / "ground_truth.json").read_text()) if t["is_incident"]]
    if not gt:
        return [], None, None
    events = read_events(d)
    end_ms = max(t["end_ms"] for t in gt)
    start_ms = min(t["onset_ms"] for t in gt)
    horizon_s = max(e["sim_ms"] for e in events) // 1000
    g = goodput_per_s(events, horizon_s)
    base = g[60:120].mean()
    judge = g[end_ms // 1000 + JUDGE_FROM_S:end_ms // 1000 + JUDGE_TO_S]
    if base <= 0 or judge.size < (JUDGE_TO_S - JUDGE_FROM_S) // 2:
        return [], None, None
    stuck = float(judge.mean() < STUCK_FRAC * base)
    # collapse: first second after onset where 10 s mean goodput < 50 % of baseline (for lead-time reporting)
    roll = np.convolve(g, np.ones(10) / 10, mode="full")[:len(g)]
    low = [s_ for s_ in range(start_ms // 1000, len(g)) if roll[s_] < STUCK_FRAC * base]
    meta = {"onset_ms": start_ms, "end_ms": end_ms, "collapse_ms": low[0] * 1000 if low else None}
    rid = d.name
    p = Pipeline(rid, rid.split("-")[3], cfg, validate=False, grid=None)
    out, i, t = [], 0, cfg.tick_ms
    while t <= end_ms + SAMPLE_TAIL_S * 1000:
        j = i
        while j < len(events) and events[j]["sim_ms"] < t:
            j += 1
        p.ingest(events[i:j])
        i = j
        p.tick(t)
        if t >= start_ms:
            for k in range(S.NP):
                seg = next(s for s in p.last_snapshot["segments"] if s["segment_id"] == f"psp:{S.PSPS[k]}:*")
                pp = seg.get("phase_point")
                if pp:
                    out.append((pp["delay_frac"], pp["orbit_frac"], stuck, t))
        t += cfg.tick_ms
    return out, stuck, meta


def _job(d: str) -> tuple:
    s, y, meta = samples_for_run(Path(d))
    return d, s, y, meta


def lead_times(g: StuckGrid, rows: np.ndarray, run_of: np.ndarray, labels: dict, metas: dict, level: float) -> dict:
    """First tick with p >= level (any PSP) per run, against collapse and against the judge window.
    Positive lead = warning came first. Non-stuck runs that ever reach the level count as false CRITICALs."""
    p = g.predict(rows[:, 0], rows[:, 1])
    to_collapse, to_end, false_crit, missed = [], [], 0, 0
    for r, y in labels.items():
        m = run_of == r
        hit = rows[m, 3][p[m] >= level]
        first = float(hit.min()) if hit.size else None
        if not y:
            false_crit += first is not None
            continue
        if first is None:
            missed += 1
            continue
        meta = metas[r]
        if meta["collapse_ms"] is not None:
            to_collapse.append((meta["collapse_ms"] - first) / 1000.0)
        to_end.append((meta["end_ms"] - first) / 1000.0)
    med = lambda v: float(np.median(v)) if v else None
    return {"level": level, "stuck_runs_warned": len(to_end), "stuck_runs_missed": missed,
            "median_lead_to_collapse_s": med(to_collapse), "share_warned_before_collapse":
            (sum(1 for x in to_collapse if x > 0) / len(to_collapse)) if to_collapse else None,
            "median_lead_to_trigger_end_s": med(to_end), "false_critical_runs": int(false_crit),
            "non_stuck_runs": int(sum(1 for y in labels.values() if not y))}


def auc(score: np.ndarray, y: np.ndarray) -> float | None:
    """Rank AUC (Mann-Whitney) with ties averaged; None when one class is missing."""
    y = np.asarray(y, bool)
    if y.all() or not y.any():
        return None
    order = np.argsort(score, kind="mergesort")
    s = np.asarray(score)[order]
    ranks = np.empty(len(s))
    i = 0
    while i < len(s):
        j = i
        while j + 1 < len(s) and s[j + 1] == s[i]:
            j += 1
        ranks[order[i:j + 1]] = (i + j) / 2.0 + 1.0
        i = j + 1
    n1, n0 = y.sum(), (~y).sum()
    return float((ranks[y].sum() - n1 * (n1 + 1) / 2.0) / (n1 * n0))


def evaluate(g: StuckGrid, rows: np.ndarray, run_of: np.ndarray, labels: dict) -> dict:
    p = g.predict(rows[:, 0], rows[:, 1])
    y = rows[:, 2]
    runs = sorted(labels)
    run_max = np.array([p[run_of == r].max() for r in runs])        # "did it ever look stuck-bound"
    return {"samples": int(len(y)), "runs": len(runs), "stuck_runs": int(sum(labels.values())),
            "auc_samples": auc(p, y), "brier_samples": float(np.mean((p - y) ** 2)),
            "auc_runs_max_p": auc(run_max, np.array([labels[r] for r in runs]))}


def main(argv=None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", default="../data/train_runs")
    ap.add_argument("--out", default="../data/models/forecaster_grid.json")
    ap.add_argument("--report", default="../data/models/forecaster_report.json")
    ap.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 2) - 1))
    a = ap.parse_args(argv)
    cfg = default_cfg()
    dirs = [str(d) for d in sorted(Path(a.runs).iterdir())
            if d.name.endswith("-U0") and events_file(d) and split_of(d.name) in ("A", "B")]
    if not dirs:
        sys.exit("no U0 runs of sets A/B with events under --runs")
    with Pool(a.jobs) as pool:
        res = pool.map(_job, dirs, chunksize=1)
    data = {"A": ([], [], {}), "B": ([], [], {})}
    metas = {}
    for d, s, y, meta in res:
        if y is None or not s:
            continue
        rows, run_of, labels = data[split_of(Path(d).name)]
        rid = Path(d).name
        rows += s
        run_of += [rid] * len(s)
        labels[rid] = y
        metas[rid] = meta
        print(f"{rid}: {len(s)} samples, stuck={int(y)}")
    assert not set(data["A"][2]) & set(data["B"][2]), "split overlap"
    xa, ra, la = np.array(data["A"][0]), np.array(data["A"][1]), data["A"][2]
    xb, rb, lb = np.array(data["B"][0]), np.array(data["B"][1]), data["B"][2]
    if not len(xa) or not len(xb):
        sys.exit("need runs in both A (seeds 1-999) and B (seeds 1000-1999)")
    counts = {r: n for r, n in zip(*np.unique(ra, return_counts=True))}
    w = np.array([1.0 / counts[r] for r in ra])                     # every configuration weighs the same
    fc = cfg.forecaster
    report = {"weighting": "equal per run", "split": SPLITS, "A": {"runs": len(la), "stuck_runs": int(sum(la.values()))}}
    grids = {}
    for mono in (True, False):
        g = StuckGrid(fc.delay_max, fc.orbit_max, fc.bins, cfg.versions.forecaster).fit(
            xa[:, 0], xa[:, 1], xa[:, 2], weights=w, monotone=mono)
        grids[mono] = g
        report[f"B_monotone_{mono}"] = evaluate(g, xb, rb, lb)
    chosen = fc.monotone
    gap = (report["B_monotone_False"]["auc_samples"] or 0) - (report["B_monotone_True"]["auc_samples"] or 0)
    report["chosen_monotone"] = chosen
    report["B_lead_time"] = lead_times(grids[chosen], xb, rb, lb, metas, cfg.d3.critical_p_stuck)
    # threshold trade-off on B (reported, not applied: CRITICAL thresholds are frozen from S1/S5 false-alarm runs)
    report["B_threshold_sweep"] = [lead_times(grids[chosen], xb, rb, lb, metas, lv)
                                   for lv in (0.5, 0.6, 0.7, 0.8, 0.9)]
    report["note"] = (f"spec grid (monotone={chosen}) kept; AUC gap monotone off - on = {gap:+.3f} on B. "
                      "Sample AUC includes ticks after collapse; see B_lead_time for warning before collapse. "
                      "Simulation data only.")
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(grids[chosen].to_dict()), encoding="utf-8")
    Path(a.report).write_text(json.dumps(report, indent=1), encoding="utf-8")
    print(json.dumps(report, indent=1))
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
