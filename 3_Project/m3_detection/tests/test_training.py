"""M3-T01: training split integrity (D-7) and the evaluation metric, on synthetic data (no M2 runs needed)."""
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import train_forecaster as tf  # noqa: E402

from qdet.forecast.grid import StuckGrid  # noqa: E402


def test_split_by_configuration_has_no_overlap():
    runs = [f"r-S{sc}-{seed}-U0" for sc in (4, 6) for seed in list(range(1, 40)) + list(range(995, 1010))
            + list(range(1995, 2010)) + [2999, 3000]]
    by = {k: {r for r in runs if tf.split_of(r) == k} for k in "ABC"}
    assert not (by["A"] & by["B"]) and not (by["A"] & by["C"]) and not (by["B"] & by["C"])
    assert tf.split_of("r-S4-999-U0") == "A" and tf.split_of("r-S4-1000-U0") == "B"
    assert tf.split_of("r-S4-2000-U0") == "C" and tf.split_of("r-S4-3000-U0") is None
    # every tick of one configuration lands in one set: the split key is the run, never the sample
    assert all(tf.split_of(r) == tf.split_of(r) for r in runs)


def test_auc_matches_definition_and_handles_ties():
    assert tf.auc(np.array([0.1, 0.4, 0.35, 0.8]), np.array([0, 0, 1, 1])) == 0.75
    assert tf.auc(np.array([0.5, 0.5]), np.array([0, 1])) == 0.5
    assert tf.auc(np.array([0.2, 0.3]), np.array([1, 1])) is None


def test_synthetic_grid_separates_and_evaluates():
    rng = np.random.default_rng(0)
    d = rng.uniform(0, 2, 4000)
    o = rng.uniform(0, 3, 4000)
    y = (d + o / 3 + rng.normal(0, 0.2, 4000) > 1.2).astype(float)
    g = StuckGrid(2.0, 3.0, 20).fit(d[:3000], o[:3000], y[:3000], monotone=True)
    rows = np.c_[d[3000:], o[3000:], y[3000:]]
    run_of = np.array([f"r-S4-{1000 + i // 10}-U0" for i in range(1000)])
    labels = {r: float(rows[run_of == r, 2].max()) for r in set(run_of)}
    rep = tf.evaluate(g, rows, run_of, labels)
    assert rep["auc_samples"] > 0.9 and rep["brier_samples"] < 0.15
