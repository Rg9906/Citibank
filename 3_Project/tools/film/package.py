"""Assemble the hackathon submission folder and zip it.

    ../../.venv/Scripts/python package.py

Creates Citibank/QueueShield_Submission/ (next to queueshield/) and QueueShield_Submission.zip:
  01_Pitch_Deck/  02_Demo_Video/  03_Source_Code/  04_Documentation/  05_Screenshots/  06_Results/  README.md
Source code = every file git tracks or would track (respects .gitignore: no node_modules, .venv, caches), plus the demo
recordings and finished-run summaries the replay and Arena views read.
"""
from __future__ import annotations

import csv
import json
import shutil
import statistics as st
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]                   # queueshield/
DATA = REPO / "data"
OUT = REPO.parent / "QueueShield_Submission"
VID = DATA / "videos"


def copy(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    # 01 pitch deck
    for f in ("QueueShield_pitch_deck.pdf", "QueueShield_pitch_deck.pptx"):
        copy(DATA / "deck_render" / f, OUT / "01_Pitch_Deck" / f)
    # 02 video
    v = OUT / "02_Demo_Video"
    copy(VID / "narrated" / "QueueShield_demo_final.mp4", v / "QueueShield_demo_final.mp4")
    copy(VID / "narrated" / "QueueShield_demo_final.srt", v / "QueueShield_demo_final.srt")
    copy(VID / "narrated" / "QueueShield_demo_final_clean.mp4", v / "QueueShield_demo_no_burned_subtitles.mp4")
    names = {"01_overview": "01_Overview", "02_festive": "02_Festive_surge_stays_quiet", "03_bank": "03_Bank_slowdown_localised",
             "04a_approve_ledger": "04_Human_approval_and_ledger_record", "04b_blocked_failover": "05_Unsafe_failover_locked",
             "05_split": "06_April_2025_split_replay", "06_arena": "07_Arena_results", "07_about": "08_About_and_claims"}
    for k, n in names.items():
        copy(VID / "narrated" / f"{k}.mp4", v / "Feature_clips" / f"{n}.mp4")
    # 03 source code (git's view of the repo) + demo data
    code = OUT / "03_Source_Code" / "queueshield"
    files = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=REPO,
                           capture_output=True, check=True).stdout.decode("utf-8").split("\0")
    for rel in filter(None, files):
        p = REPO / rel
        if p.is_file():
            copy(p, code / rel)
    for p in (DATA / "recordings").glob("*.jsonl"):
        copy(p, code / "data" / "recordings" / p.name)
    for run in (DATA / "runs").iterdir():
        for f in ("result.json", "timeseries.json"):
            if (run / f).exists():
                copy(run / f, code / "data" / "runs" / run.name / f)
    for f in (DATA / "models").glob("*.json"):
        copy(f, code / "data" / "models" / f.name)
    for f in (DATA / "film").glob("*.*"):
        if f.suffix in (".mjs", ".py") or f.name in ("package.json", "package-lock.json"):
            copy(f, code / "tools" / "film" / f.name)
    # 04 documentation
    d = OUT / "04_Documentation"
    copy(REPO / "README.md", d / "README.md")
    for f in (REPO / "docs").glob("*.md"):
        copy(f, d / "project" / f.name)
    copy(REPO / "contracts" / "CONTRACTS.md", d / "project" / "CONTRACTS.md")
    for m in sorted(REPO.glob("m[1-5]_*")):
        for f in ("README.md", "STATUS.md", "ROADMAP.md", "SPEC.md"):
            if (m / f).exists():
                copy(m / f, d / "modules" / m.name / f)
    # 05 screenshots
    for f in ("bank_recommendation.png", "split_final.png", "blocked_failover_mock.png", "arena.png", "overview.png",
              "festive_quiet.png", "bank_decision_log.png"):
        if (VID / "shots" / f).exists():
            copy(VID / "shots" / f, OUT / "05_Screenshots" / f)
    # 06 results: per-run metrics + per-universe medians (simulation)
    r = OUT / "06_Results"
    r.mkdir(parents=True, exist_ok=True)
    runs = [json.loads((p / "result.json").read_text(encoding="utf-8")) for p in sorted((DATA / "runs").iterdir())
            if (p / "result.json").exists()]
    keys = sorted({k for x in runs for k in x["metrics"]})
    with open(r / "runs_metrics_simulation.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["run_id", "scenario", "seed", "universe", *keys])
        for x in runs:
            w.writerow([x["run_id"], x["scenario"], x["seed"], x["universe"], *[x["metrics"].get(k) for k in keys]])
    with open(r / "S6_medians_simulation.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["universe", "n_seeds", *keys])
        for u in ("U0", "U2", "U4"):
            xs = [x["metrics"] for x in runs if x["scenario"] == "S6" and x["universe"] == u]
            w.writerow([u, len(xs), *[round(st.median(v), 3) if (v := [m[k] for m in xs if m.get(k) is not None]) else ""
                                      for k in keys]])
    copy(Path(__file__).parent / "SUBMISSION_README.md", OUT / "README.md")
    zip_path = shutil.make_archive(str(OUT), "zip", root_dir=OUT.parent, base_dir=OUT.name)
    size = sum(p.stat().st_size for p in OUT.rglob("*") if p.is_file())
    print(json.dumps({"folder": str(OUT), "zip": zip_path, "files": sum(1 for p in OUT.rglob('*') if p.is_file()),
                      "folder_mb": round(size / 1e6, 1), "zip_mb": round(Path(zip_path).stat().st_size / 1e6, 1)}))


if __name__ == "__main__":
    main()
