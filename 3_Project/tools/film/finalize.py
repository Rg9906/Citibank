"""Final cut of the narrated demo: title card + narrated clips + end card, subtitles from the voiceover timings.

    ../../.venv/Scripts/python voiceover.py && node cards.mjs && ../../.venv/Scripts/python finalize.py

Writes ../videos/narrated/QueueShield_demo_final.mp4 (subtitles burned in), QueueShield_demo_final_clean.mp4 (no
burned subtitles) and QueueShield_demo_final.srt (sidecar for players and upload sites).
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

from voiceover import FFMPEG, ORDER, OUT, TMP, probe

TITLE_S, END_S, FADE = 4.5, 6.0, 0.6
MAX_CHARS = 80


def ff(args: list[str]) -> None:
    subprocess.run([FFMPEG + "ffmpeg.exe", "-y", "-loglevel", "error", *args], check=True)


def card(png: Path, seconds: float, out: Path) -> None:
    ff(["-loop", "1", "-t", f"{seconds}", "-i", str(png), "-f", "lavfi", "-t", f"{seconds}", "-i", "anullsrc=r=48000:cl=stereo",
        "-vf", f"fade=t=in:st=0:d={FADE},fade=t=out:st={seconds - FADE}:d={FADE},format=yuv420p", "-r", "25",
        "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-c:a", "aac", "-b:a", "160k", "-shortest", str(out)])


def chunks(text: str) -> list[str]:
    """Split a spoken line into subtitle-sized pieces at sentence/comma boundaries, then words."""
    out, cur = [], ""
    for word in text.split():
        if cur and len(cur) + 1 + len(word) > MAX_CHARS:
            out.append(cur)
            cur = word
        else:
            cur = f"{cur} {word}".strip()
        if cur.endswith((".", ":")) and len(cur) > MAX_CHARS * 0.45:
            out.append(cur)
            cur = ""
    if cur:
        out.append(cur)
    return out


def stamp(s: float) -> str:
    ms = int(round(s * 1000))
    return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"


def main() -> None:
    title, end = TMP / "title.mp4", TMP / "end.mp4"
    card(TMP / "title.png", TITLE_S, title)
    card(TMP / "end.png", END_S, end)
    parts = [title] + [OUT / f"{c}.mp4" for c in ORDER] + [end]
    # subtitles: each clip's lines, offset by everything before it
    cues, t0 = [], probe(title)
    for c in ORDER:
        meta = json.loads((TMP / f"{c}.json").read_text(encoding="utf-8"))
        for ln in meta["lines"]:
            pieces = chunks(ln["text"].replace("U.P.I.", "UPI").replace("N.P.C.I.", "NPCI"))
            total = sum(len(p) for p in pieces)
            s = t0 + ln["start"]
            for p in pieces:
                d = ln["dur"] * len(p) / total
                cues.append((s, s + d - 0.05, p))
                s += d
        t0 += probe(OUT / f"{c}.mp4")
    srt = OUT / "QueueShield_demo_final.srt"
    srt.write_text("\n".join(f"{i}\n{stamp(a)} --> {stamp(b)}\n{txt}\n" for i, (a, b, txt) in enumerate(cues, 1)), encoding="utf-8")
    # concat with re-encode (cards and clips share 1920x1080, 25 fps, 48 kHz)
    n = len(parts)
    streams = "".join(f"[{i}:v][{i}:a]" for i in range(n))
    clean = OUT / "QueueShield_demo_final_clean.mp4"
    ff([x for p in parts for x in ("-i", str(p))] + ["-filter_complex", f"{streams}concat=n={n}:v=1:a=1[v][a]", "-map", "[v]",
        "-map", "[a]", "-c:v", "libx264", "-preset", "fast", "-crf", "19", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k",
        "-movflags", "+faststart", str(clean)])
    # burn subtitles: ffmpeg's filter wants the path escaped; run from the folder and pass the bare name
    style = ("FontName=Segoe UI Semibold,FontSize=11,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H99060A14,"
             "BorderStyle=4,Outline=0,Shadow=0,MarginV=14")
    subprocess.run([FFMPEG + "ffmpeg.exe", "-y", "-loglevel", "error", "-i", clean.name, "-vf",
                    f"subtitles={srt.name}:force_style='{style}'", "-c:v", "libx264", "-preset", "fast", "-crf", "19",
                    "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart", "QueueShield_demo_final.mp4"],
                   check=True, cwd=OUT)
    print(json.dumps({"final": str(OUT / "QueueShield_demo_final.mp4"), "seconds": round(probe(OUT / "QueueShield_demo_final.mp4"), 1),
                      "cues": len(cues), "srt": str(srt)}))


if __name__ == "__main__":
    main()
