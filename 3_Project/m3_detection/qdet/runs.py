"""Read M2 batch run folders (`data/runs/<run_id>/`, CONTRACTS §6). Offline tools and tests only."""
from __future__ import annotations

import gzip
import json
from pathlib import Path
from typing import Optional


def events_file(d: Path) -> Optional[Path]:
    """events.jsonl.gz (M2 default since 2026-10-25) or events.jsonl, whichever exists."""
    for name in ("events.jsonl.gz", "events.jsonl"):
        if (d / name).is_file():
            return d / name
    return None


def read_events(d: Path) -> list:
    f = events_file(d)
    if f is None:
        raise FileNotFoundError(f"no events file in {d}")
    opener = gzip.open if f.suffix == ".gz" else open
    with opener(f, "rt", encoding="utf-8") as fh:
        return [json.loads(x) for x in fh if x.strip()]
