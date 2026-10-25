"""Arena jobs (S-10, CONTRACTS §4.1 `POST /v1/arena`): scenario x seeds x universes through `batch.run_one`.

One background thread per job; runs are sequential inside a job so M3/M4 lockstep sessions never interleave.
U3/U4 go through M3/M4 when DETECT_URL and CONTROL_URL are set; otherwise every run is open-loop (U0-U2 never
need them). Results land in `data/runs/<run_id>/` and are listed by `GET /v1/results`.
Every number produced here is a simulation result; consumers label it "simulation".
"""
from __future__ import annotations

import os
import re
import threading
import uuid
from pathlib import Path
from typing import Optional

from qsim import batch, jsonlog

UNIVERSES = ("U0", "U1", "U2", "U3", "U4")
SCENARIOS = tuple(f"S{i}" for i in range(9))
MAX_RUNS = 200


def validate_request(body) -> Optional[str]:
    if not isinstance(body, dict):
        return "body must be a JSON object"
    if body.get("scenario") not in SCENARIOS:
        return f"scenario must be one of {list(SCENARIOS)}"
    seeds, us = body.get("seeds"), body.get("universes")
    if not isinstance(seeds, list) or not seeds or not all(isinstance(x, int) and x >= 0 for x in seeds):
        return "seeds must be a non-empty list of non-negative integers"
    if not isinstance(us, list) or not us or not set(us) <= set(UNIVERSES):
        return f"universes must be a non-empty subset of {list(UNIVERSES)}"
    if len(seeds) * len(us) > MAX_RUNS:
        return f"at most {MAX_RUNS} runs per job"
    if not isinstance(body.get("overrides", {}), dict):
        return "overrides must be an object"
    if body.get("suffix") is not None and not re.fullmatch(r"[a-z0-9]{1,12}", str(body["suffix"])):
        return "suffix must match [a-z0-9]{1,12} (run ids become r-<sc>-<seed>-<U>-<suffix>)"
    d = body.get("operator_delay_s")
    if d is not None and not (isinstance(d, (int, float)) and 0 <= d <= 3600):
        return "operator_delay_s must be a number in [0, 3600]"
    return None


class Job:
    def __init__(self, body: dict, out_dir: Path) -> None:
        self.job_id = "arena-" + uuid.uuid4().hex[:10]
        self.body, self.out_dir = body, out_dir
        self.plan = [(seed, u) for seed in body["seeds"] for u in body["universes"]]
        self.state, self.done, self.run_ids = "QUEUED", 0, []
        self.error: Optional[str] = None

    def view(self) -> dict:
        out = {"state": self.state, "done": self.done, "total": len(self.plan), "run_ids": list(self.run_ids)}
        if self.error:
            out["error"] = self.error
        return out

    def run(self) -> None:
        self.state = "RUNNING"
        ls = None
        if os.environ.get("DETECT_URL") and os.environ.get("CONTROL_URL"):
            ls = batch.Lockstep(os.environ["DETECT_URL"], os.environ["CONTROL_URL"], self.body.get("operator_delay_s"))
        try:
            for seed, u in self.plan:
                res = batch.run_one(self.body["scenario"], seed, u, self.out_dir, ls, self.body.get("overrides"),
                                    suffix=self.body.get("suffix"))
                self.run_ids.append(res["run_id"])
                self.done += 1
            self.state = "DONE"
        except Exception as exc:                       # surfaced in GET /v1/arena/{job_id}, never silent
            self.state, self.error = "FAILED", f"{type(exc).__name__}: {exc}"
            jsonlog.error("arena job failed", job_id=self.job_id, err=self.error)


class ArenaRunner:
    def __init__(self) -> None:
        self.jobs: dict = {}
        self._lock = threading.Lock()                  # one job at a time: lockstep sessions must not interleave

    def submit(self, body: dict, out_dir: Path) -> Job:
        job = Job(body, out_dir)
        self.jobs[job.job_id] = job

        def go() -> None:
            with self._lock:
                job.run()
        threading.Thread(target=go, name=job.job_id, daemon=True).start()
        return job
