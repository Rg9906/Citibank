"""Train the point-of-no-return grid from M2 batch runs (docs/M3_DETECTION.md §6.2-§6.4).

Offline only: this script MAY read ground_truth.json; the live pipeline never imports it (pitfall 4).
Labels: a run is *stuck* if goodput (closed CONFIRMED_SUCCESS per s) over [trigger end + 60 s, + 120 s] is below
50 % of the warm-up baseline. Samples: one per tick from trigger start to trigger end + 60 s for every PSP
(the switch couples PSPs). Features are recomputed with this module's own pipeline.

    python scripts/train_forecaster.py --runs ../data/runs --out ../data/models/forecaster_grid.json

Split (§6.3, M3-T01): by configuration, never by tick — every sample of a run goes to the run's split, chosen
by seed: A = 1-999 (fit), B = 1000-1999 (validation: AUC, Brier, thresholds), C = 2000-2999 (test, scored once
after freezing). The grid is fitted on A with `monotone` on and off; both are reported on B (IBM saw the monotone
envelope drop AUC 0.80 -> 0.66-0.71). The written grid follows config `forecaster.monotone`. Runs are weighted so
stuck and recovered runs count equally (boundary balance) when the mix is far from 50/50.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from qdet import segments as S  # noqa: E402
from qdet.config import default as default_cfg  # noqa: E402
from qdet.forecast.grid import StuckGrid  # noqa: E402
from qdet.forecast.runtime import phase_point  # noqa: E402
from qdet.pipeline import Pipeline  # noqa: E402

STUCK_FRAC = 0.5
JUDGE_FROM_S, JUDGE_TO_S, SAMPLE_TAIL_S = 60, 120, 60


def goodput_per_s(events: list, n_s: int) -> np.ndarray:
    g = np.zeros(n_s + 1)
    for e in events:
        if e["event_type"] == "PAYMENT_CLOSED" and e["close_reason"] == "CONFIRMED_SUCCESS":
            s = e["sim_ms"] // 1000
            if s <= n_s:
                g[s] += 1
    return g


def samples_for_run(d: Path, cfg) -> tuple:
    gt = [t for t in json.loads((d / "ground_truth.json").read_text()) if t["is_incident"]]
    if not gt:
        return [], None
    events = [json.loads(x) for x in (d / "events.jsonl").open(encoding="utf-8")]
    end_ms = max(t["end_ms"] for t in gt)
    start_ms = min(t["onset_ms"] for t in gt)
    horizon_s = max(e["sim_ms"] for e in events) // 1000
    g = goodput_per_s(events, horizon_s)
    base = g[60:120].mean()
    judge = g[end_ms // 1000 + JUDGE_FROM_S:end_ms // 1000 + JUDGE_TO_S]
    if base <= 0 or judge.size == 0:
        return [], None
    stuck = float(judge.mean() < STUCK_FRAC * base)
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
                    out.append((pp["delay_frac"], pp["orbit_frac"], stuck, rid))
        t += cfg.tick_ms
    return out, stuck


SPLITS = (("A", 1, 999), ("B", 1000, 1999), ("C", 2000, 2999))
_SEED = re.compile(r"^r-S[0-8]-([0-9]+)-U[0-4]")


def split_of(run_id: str):
    """A/B/C by the run's seed (configuration), None outside the ranges."""
    m = _SEED.match(run_id)
    if not m:
        return None
    seed = int(m.group(1))
    return next((k for k, lo, hi in SPLITS if lo <= seed <= hi), None)


def split_rows(rows: list) -> dict:
    """rows: (delay, orbit, stuck, run_id) -> {"A": [...], "B": [...], "C": [...]}; a run never spans splits."""
    out = {k: [] for k, *_ in SPLITS}
    for r in rows:
        k = split_of(r[3])
        if k is not None:
            out[k].append(r)
    runs = {k: {r[3] for r in v} for k, v in out.items()}
    assert not (runs["A"] & runs["B"] or runs["A"] & runs["C"] or runs["B"] & runs["C"]), "split overlap"
    return out


def auc(y: np.ndarray, p: np.ndarray):
    """Rank AUC (ties count half); None if only one class is present."""
    y, p = np.asarray(y, float), np.asarray(p, float)
    pos, neg = p[y == 1], p[y == 0]
    if pos.size == 0 or neg.size == 0:
        return None
    order = np.argsort(np.concatenate([pos, neg]), kind="mergesort")
    allp = np.concatenate([pos, neg])[order]
    ranks = np.empty(allp.size)
    i = 0
    while i < allp.size:                      # average ranks over ties
        j = i
        while j + 1 < allp.size and allp[j + 1] == allp[i]:
            j += 1
        ranks[i:j + 1] = (i + j) / 2 + 1
        i = j + 1
    r = np.empty(allp.size)
    r[order] = ranks
    return float((r[:pos.size].sum() - pos.size * (pos.size + 1) / 2) / (pos.size * neg.size))


def brier(y, p) -> float:
    y, p = np.asarray(y, float), np.asarray(p, float)
    return float(np.mean((p - y) ** 2)) if y.size else float("nan")


def _balance_weights(stuck: np.ndarray) -> np.ndarray:
    """Equal total weight for stuck and recovered samples (oversampling stand-in, §6.3 aim 40-60 % stuck)."""
    w = np.ones_like(stuck, dtype=float)
    k = stuck.mean() if stuck.size else 0.5
    if 0 < k < 1 and not 0.4 <= k <= 0.6:
        w[stuck == 1] = 0.5 / k
        w[stuck == 0] = 0.5 / (1 - k)
    return w


def fit_and_report(rows: list, cfg, out_path) -> dict:
    parts = split_rows(rows)
    a, b = np.array([r[:3] for r in parts["A"]], float), np.array([r[:3] for r in parts["B"]], float)
    if a.size == 0:
        raise SystemExit("no training (A, seeds 1-999) samples")
    fc = cfg.forecaster
    report = {"n_runs": {k: len({r[3] for r in v}) for k, v in parts.items()},
              "n_samples": {k: len(v) for k, v in parts.items()},
              "stuck_share": round(float(a[:, 2].mean()), 4)}
    grids = {}
    for name, mono in (("monotone", True), ("unsmoothed", False)):
        g = StuckGrid(fc.delay_max, fc.orbit_max, fc.bins, cfg.versions.forecaster)
        g.fit(a[:, 0], a[:, 1], a[:, 2], weights=_balance_weights(a[:, 2]), monotone=mono)
        grids[name] = g
        if b.size:
            p = g.predict(b[:, 0], b[:, 1])
            report[name] = {"auc_B": auc(b[:, 2], p), "brier_B": round(brier(b[:, 2], p), 4)}
        else:
            report[name] = {"auc_B": None, "brier_B": None}
    chosen = grids["monotone" if fc.monotone else "unsmoothed"]
    out = Path(out_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(chosen.to_dict()), encoding="utf-8")
    report["written"] = "monotone" if fc.monotone else "unsmoothed"
    return report


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", default="../data/runs")
    ap.add_argument("--out", default="../data/models/forecaster_grid.json")
    a = ap.parse_args()
    cfg = default_cfg()
    rows, labels = [], []
    for d in sorted(Path(a.runs).iterdir()):
        if (d / "events.jsonl").is_file() and d.name.endswith("-U0"):
            s, y = samples_for_run(d, cfg)
            rows += s
            if y is not None:
                labels.append(y)
                print(f"{d.name}: {len(s)} samples, stuck={int(y)}")
    if not rows:
        sys.exit("no U0 runs with incidents under --runs")
    report = fit_and_report(rows, cfg, a.out)
    print(json.dumps(report, indent=2))
    print(f"wrote {a.out}: {len(rows)} samples from {len(labels)} runs ({int(sum(labels))} stuck). "
          "Record the AUC/Brier on B in STATUS.md and ../docs/DEVIATIONS.md (simulation results).")


if __name__ == "__main__":
    main()
