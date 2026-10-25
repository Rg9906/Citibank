import pytest

from qsim import config, scenarios
from qsim.engine import Engine

HORIZON = 300_000


def make(scenario: str, seed: int, universe: str, horizon: int = HORIZON, overrides=None) -> Engine:
    """An engine that has not run yet (for tests that apply actions mid-run)."""
    cfg = config.default()
    return Engine(cfg, scenarios.build(scenario, seed, cfg, overrides), seed, universe, horizon_ms=horizon)


def run(scenario: str, seed: int, universe: str, horizon: int = HORIZON, drain: bool = True,
        overrides=None) -> Engine:
    """Run to the horizon, then (drain=True) until every payment is closed."""
    e = make(scenario, seed, universe, horizon, overrides)
    if drain:
        e.run_to_completion()
    else:
        e.run_until(horizon)
    return e


@pytest.fixture(scope="session")
def s6_runs():
    """S6 on one seed under U0, U2 and U4 (shared by several tests), pinned to a setting that locks in under U0
    (calibration, data/calibration/S6.json: B1, hold 0.3, 45 s sticks in 10/10 seeds)."""
    pin = {"bank": "B1", "hold_frac": 0.3, "duration": 45_000, "onset": 180_000}
    return {u: run("S6", 1, u, overrides=pin) for u in ("U0", "U2", "U4")}
