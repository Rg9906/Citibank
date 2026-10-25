"""Record the demo recordings used by replay mode, the videos and the deck (M5-T05/T08).

    .venv/Scripts/python m5_console/scripts/record_demo.py [--only s3_bank s4_storm]      (from the repo root)

For each demo scenario: start M1 (mock ledger), M2, M3 and M4 (simulated operator) fresh, START the scenario at 4x,
and run scripts/record.mjs alongside it. Writes data/recordings/<name>.jsonl. Services are stopped after each take so
every recording starts from a clean state. Simulation only; nothing here is a measurement of a real system.
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]
PY = str(ROOT / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python"))
KEY = "dev"
PORTS = {"m1": 8004, "m2": 8001, "m3": 8002, "m4": 8003}

# name -> scenario command. Onsets after the 120 s warm-up; 600 s runs at 4x take ~150 s of wall time.
TAKES = {
    "s3_bank": {"scenario": "S3", "universe": "U4",
                "overrides": {"scenario": {"onset": 150000, "duration": 120000, "mult": 8.0, "bank": "B1"}}},
    "s4_storm": {"scenario": "S4", "universe": "U4",
                 "overrides": {"scenario": {"onset": 150000, "duration": 90000, "worker_loss": 0.7}}},
    "s1_festive": {"scenario": "S1", "universe": "U4",
                   "overrides": {"scenario": {"onset": 150000, "duration": 150000, "mult": 1.6}}},
}


def start(name: str, cmd: list, cwd: str, extra: dict, logdir: Path) -> subprocess.Popen:
    log = open(logdir / f"rec_{name}.log", "w", encoding="utf-8")
    env = {**os.environ, "QS_API_KEY": KEY, "PYTHONUNBUFFERED": "1", **extra}
    return subprocess.Popen(cmd, cwd=ROOT / cwd, env=env, stdout=log, stderr=subprocess.STDOUT)


def services(logdir: Path) -> list[subprocess.Popen]:
    uv = [PY, "-m", "uvicorn", "--factory"]
    return [
        start("m1", ["node", "src/main.ts"], "m1_ledger/gateway", {"LEDGER_MODE": "mock"}, logdir),
        start("m2", uv + ["qsim.api:create_app", "--port", "8001"], "m2_simulator",
              {"SIM_MODE": "live", "CONTROL_URL": "http://127.0.0.1:8003", "LEDGER_MODE": "mock",
               "LEDGER_URL": "http://127.0.0.1:8004"}, logdir),
        start("m3", uv + ["qdet.api:create_app", "--port", "8002"], "m3_detection",
              {"DETECT_MODE": "live", "SIM_URL": "http://127.0.0.1:8001"}, logdir),
        start("m4", uv + ["qctl.api:create_app", "--port", "8003"], "m4_control",
              {"CONTROL_MODE": "live", "DETECT_URL": "http://127.0.0.1:8002", "LEDGER_URL": "http://127.0.0.1:8004",
               "OPERATOR_MODE": "auto", "OPERATOR_DELAY_S": "6"}, logdir),
    ]


def wait_healthy(c: httpx.Client) -> None:
    for name, port in PORTS.items():
        for _ in range(80):
            try:
                c.get(f"http://127.0.0.1:{port}/v1/health").raise_for_status()
                break
            except httpx.HTTPError:
                time.sleep(0.5)
        else:
            raise RuntimeError(f"{name} never became healthy")


def take(name: str, cmd: dict, seconds: int, logdir: Path) -> None:
    procs = services(logdir)
    try:
        c = httpx.Client(timeout=10)
        wait_healthy(c)
        time.sleep(2)
        rec = subprocess.Popen(["node", "scripts/record.mjs", "--name", name, "--seconds", str(seconds)],
                               cwd=ROOT / "m5_console")
        time.sleep(2)                                          # streams subscribed before the run starts
        r = c.post("http://127.0.0.1:8001/v1/scenario", headers={"X-QS-Key": KEY},
                   json={"command": "START", "seed": 1, "speed": 4, **cmd})
        print(name, "start", r.status_code, r.text[:200], flush=True)
        rec.wait(timeout=seconds + 60)
    finally:
        for p in procs:
            p.terminate()
        for p in procs:
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                p.kill()
        time.sleep(2)                                          # ports released before the next take


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*", default=list(TAKES))
    ap.add_argument("--seconds", type=int, default=165)
    a = ap.parse_args()
    logdir = ROOT / "data" / "smoke"
    logdir.mkdir(parents=True, exist_ok=True)
    for name in a.only:
        take(name, TAKES[name], a.seconds, logdir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
