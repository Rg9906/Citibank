"""AI voiceover for the demo clips: neural TTS per line, placed at its cue, mixed into each clip and the full demo.

    ../../.venv/Scripts/python voiceover.py [--voice en-US-AndrewMultilingualNeural] [--rate +4%] [--only 03_bank]

Reads the silent clips in ../videos/*.mp4, writes ../videos/narrated/<clip>.mp4 and 00_full_demo_narrated.mp4.
A line starts at its cue or right after the previous line, whichever is later; if speech outlasts the picture, the
clip's last frame is held. Text follows docs/DEMO_NARRATION.md and the claims policy (docs/00_PRODUCT.md §8).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
from pathlib import Path

import truststore

truststore.inject_into_ssl()                                   # TLS interception on this machine: use the OS store
import edge_tts  # noqa: E402

HERE = Path(__file__).resolve().parent
VIDEOS = HERE.parent / "videos"
OUT = VIDEOS / "narrated"
TMP = OUT / "lines"
FFMPEG = ("C:/Users/RG Saran Vishakan/AppData/Local/Microsoft/WinGet/Packages/"
          "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1.2-full_build/bin/")
GAP = 0.35                                                     # seconds of air between consecutive lines
TAIL = 1.2                                                     # picture kept after the last word

# clip -> [(cue seconds into the clip, line)]
SCRIPT: dict[str, list[tuple[float, str]]] = {
    "01_overview": [
        (0.5, "This is QueueShield. Three payment apps, a central switch, and five banks: a scaled simulation of a "
              "U.P.I.-style network, drawn on an illustrative map."),
        (10, "Every dot is a payment. Every number you see comes from our simulator, and the badges show exactly "
             "what is live, mocked, or replayed."),
        (21, "Right now, everything is calm. Let's stress it."),
    ],
    "02_festive": [
        (0.5, "First, a festive sale. Demand jumps by sixty percent, the kind of spike that pages people at most "
              "companies."),
        (10, "QueueShield stays quiet. Arrivals went up, but latency is stable and queues drain. That's a surge, "
             "not a sick bank."),
        (21, "No incident is raised, and no operator is woken up."),
    ],
    "03_bank": [
        # clip t = (sim s - 132) / 2: onset sim 150 -> 9 s, BANK_SIDE + first rec sim 165 -> 16.5 s, approvals sim 176 -> 22 s
        (7, "Now bank B1 slows down, for every payment app at once."),
        (12, "Watch the map: the arcs into B1 turn red, and the bank starts to pulse."),
        (17, "The localizer names it: bank side, B1. Not just \"errors are up\", but which bank, and at what level."),
        (24.5, "A recommendation arrives: slow down retries and defer status checks, with its supporting signals."),
    ],
    "04a_approve_ledger": [
        (0.5, "An operator approves. The machine recommends; a person decides."),
        (6, "Each decision is written to the shared ledger, with a transaction ID and a block number. The ring above "
            "the switch is the Drunix ledger. It flashes on every event."),
        (20, "Payments that timed out are not retried blindly. The bank that knows the outcome attests it once, and "
             "every app is pushed the answer, so the switch is never flooded with status checks."),
    ],
    "04b_blocked_failover": [
        (0.5, "Here is the safety rule, shown on our test card. When the sick bank is shared by every app, shifting "
              "traffic to another app would only spread the fault. So the console locks that action. It can never "
              "be sent."),
    ],
    "05_split": [
        (0.5, "In 2025, U.P.I. had three outages that N.P.C.I. linked to status-check traffic. This is our replay of "
              "that pattern: the same seed, two worlds. On the left, no control. On the right, QueueShield."),
        (15, "Both sides see exactly the same traffic, from the same random seed, so any difference you see comes "
             "from the policy alone."),
        (25, "At about two hundred and fifty seconds, a beneficiary bank starts swallowing credits."),
        (34, "On the left, payments time out, and apps keep asking the switch whether they went through, hundreds of "
             "times a second. Those questions become the load, and good payments collapse."),
        (49, "On the right, the same fault. Checks stay under forty a second, because the bank attests the outcome "
             "once on the ledger, and every app is pushed the answer."),
        (62, "This is seed three. Across five seeds in our simulator, without control, two runs locked into a storm "
             "like this. With QueueShield, none did."),
    ],
    "06_arena": [
        (0.5, "The arena compares every policy on the same seeds, including N.P.C.I.'s own rule, which also kept "
              "every run out of the storm."),
        (8.5, "And we report where we still lose: today, we use more status checks than the N.P.C.I. rule."),
    ],
    "07_about": [
        (0.5, "Everything here is a simulation with synthetic data. Machines recommend, humans decide, and the "
              "ledger remembers."),
    ],
}
ORDER = list(SCRIPT)


def probe(path: Path) -> float:
    out = subprocess.run([FFMPEG + "ffprobe.exe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                          str(path)], capture_output=True, text=True, check=True).stdout
    return float(out.strip())


def ff(args: list[str]) -> None:
    subprocess.run([FFMPEG + "ffmpeg.exe", "-y", "-loglevel", "error", *args], check=True)


async def synth(text: str, path: Path, voice: str, rate: str) -> None:
    await edge_tts.Communicate(text, voice, rate=rate).save(str(path))


async def build(clip: str, voice: str, rate: str) -> dict:
    src = VIDEOS / f"{clip}.mp4"
    lines = SCRIPT[clip]
    files = [TMP / f"{clip}_{i}.mp3" for i in range(len(lines))]
    await asyncio.gather(*(synth(t, f, voice, rate) for (_, t), f in zip(lines, files)))
    placed, t_free = [], 0.0
    for (cue, text), f in zip(lines, files):
        start = max(cue, t_free)
        dur = probe(f)
        placed.append({"start": round(start, 2), "dur": round(dur, 2), "cue": cue, "late": round(start - cue, 2), "text": text})
        t_free = start + dur + GAP
    vdur = probe(src)
    end = placed[-1]["start"] + placed[-1]["dur"] + TAIL       # no dead air: the clip ends shortly after the last word
    hold = max(0.0, end - vdur)
    inputs = ["-i", str(src)] + [x for f in files for x in ("-i", str(f))]
    delays = [f"[{i + 1}:a]adelay={int(p['start'] * 1000)}:all=1,apad[a{i}]" for i, p in enumerate(placed)]
    mix = "".join(f"[a{i}]" for i in range(len(placed)))
    graph = ";".join(delays + [f"{mix}amix=inputs={len(placed)}:normalize=0,volume=1.35,alimiter=limit=0.89:level=disabled,atrim=0:{end:.2f}[aout]",
                                f"[0:v]tpad=stop_mode=clone:stop_duration={hold:.2f}[vout]"])
    out = OUT / f"{clip}.mp4"
    ff([*inputs, "-filter_complex", graph, "-map", "[vout]", "-map", "[aout]", "-c:v", "libx264", "-preset", "fast",
        "-crf", "20", "-pix_fmt", "yuv420p", "-r", "25", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-t", f"{end:.2f}", str(out)])
    (TMP / f"{clip}.json").write_text(json.dumps({"clip": clip, "duration": end, "lines": placed}), encoding="utf-8")
    return {"clip": clip, "video_s": round(vdur, 1), "out_s": round(end, 1), "held_s": round(hold, 1),
            "late_lines": [p["late"] for p in placed if p["late"] > 0.5]}


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--voice", default="en-US-AndrewMultilingualNeural")
    ap.add_argument("--rate", default="+4%")
    ap.add_argument("--only", default="")
    a = ap.parse_args()
    TMP.mkdir(parents=True, exist_ok=True)
    clips = [c for c in ORDER if not a.only or c in a.only.split(",")]
    for c in clips:
        print(json.dumps(await build(c, a.voice, a.rate)), flush=True)
    done = [OUT / f"{c}.mp4" for c in ORDER if (OUT / f"{c}.mp4").exists()]
    if len(done) == len(ORDER):
        lst = TMP / "concat.txt"
        lst.write_text("\n".join(f"file '{p.as_posix()}'" for p in done), encoding="utf-8")
        ff(["-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(OUT / "00_full_demo_narrated.mp4")])
        print(json.dumps({"full_demo": str(OUT / "00_full_demo_narrated.mp4"), "seconds": round(probe(OUT / "00_full_demo_narrated.mp4"), 1)}))


if __name__ == "__main__":
    asyncio.run(main())
