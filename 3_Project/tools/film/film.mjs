// Film the QueueShield console feature by feature (1920x1080), from replay recordings, so every take is identical.
//   node film.mjs [--base http://localhost:8000] [--only 03_bank,05_split]
// Writes <repo>/data/videos/<clip>.mp4 plus 1080p screenshots in data/videos/shots/. Needs the console's dev
// server running; the 04b clip needs M1-M4 stopped so the console falls back to the MOCK fixture card.
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const BASE = args.base ?? "http://localhost:8000";
const REPO = "C:/Users/RG Saran Vishakan/Desktop/Hackathon_Projects/Citibank/queueshield";
const OUT = path.join(REPO, "data/videos");
const SHOTS = path.join(OUT, "shots");
const RAW = path.join(OUT, "raw");
const FFMPEG = process.env.FFMPEG ?? "C:/Users/RG Saran Vishakan/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1.2-full_build/bin/ffmpeg.exe";
const W = 1920, H = 1080;
const replay = (rec, speed = 4) => `${BASE}/?mode=replay&rec=${rec}&speed=${speed}&demo=1`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// One take per source; cuts (start s, length s) become the per-feature videos named in docs/DEMO_NARRATION.md.
const TAKES = [
  { name: "festive", url: replay("s1_festive"), seconds: 80, shots: { 20: "overview", 60: "festive_quiet" },
    cuts: [["01_overview", 2, 28], ["02_festive", 35, 30]] },
  // 2x so the captions stay readable: sim 140 s (slowdown) is wall 70 s, approvals at sim 177 s are wall ~88 s
  { name: "bank", url: replay("s3_bank", 2), seconds: 150, shots: { 86: "bank_heatmap", 92: "bank_recommendation", 140: "bank_decision_log" },
    cuts: [["03_bank", 66, 34], ["04a_approve_ledger", 100, 40]] },
  { name: "mock", url: `${BASE}/`, seconds: 25, shots: { 15: "blocked_failover_mock" }, cuts: [["04b_blocked_failover", 3, 20]] },
  { name: "split", url: `${BASE}/`, tab: "split", speed: "8×", click: "play", seconds: 82, shots: { 40: "split_storm", 78: "split_replay" },
    cuts: [["05_split", 4, 76]] },
  { name: "arena", url: `${BASE}/`, tab: "arena", seconds: 20, shots: { 10: "arena" }, cuts: [["06_arena", 2, 15]] },
  { name: "about", url: `${BASE}/`, tab: "about", seconds: 12, shots: { 6: "about_claims" }, cuts: [["07_about", 2, 8]] },
];

function ff(argv) { execFileSync(FFMPEG, ["-y", "-loglevel", "error", ...argv], { stdio: "inherit" }); }

async function take(browser, t) {
  const dir = path.join(RAW, t.name);
  fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir, size: { width: W, height: H } } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.goto(t.url, { waitUntil: "domcontentloaded" });
  if (t.tab) await page.getByRole("button", { name: t.tab, exact: true }).click().catch(() => errors.push(`no tab ${t.tab}`));
  if (t.speed) await page.locator("select").last().selectOption({ label: t.speed }).catch(() => errors.push(`no speed ${t.speed}`));
  if (t.click) await page.getByRole("button", { name: new RegExp(`^\\W*${t.click}$`, "i") }).first().click().catch(() => errors.push(`no button ${t.click}`));
  const t0 = Date.now();
  for (const [sec, shot] of Object.entries(t.shots).sort((a, b) => a[0] - b[0])) {
    await wait(Math.max(0, Number(sec) * 1000 - (Date.now() - t0)));
    await page.screenshot({ path: path.join(SHOTS, `${shot}.png`) });
  }
  await wait(Math.max(0, t.seconds * 1000 - (Date.now() - t0)));
  const video = page.video();
  await ctx.close();
  const webm = await video.path();
  for (const [clip, start, len] of t.cuts) {
    ff(["-ss", String(start), "-i", webm, "-t", String(len), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "fast", "-crf", "20", path.join(OUT, `${clip}.mp4`)]);
  }
  return { take: t.name, errors: [...new Set(errors)].slice(0, 5) };
}

const only = args.only ? new Set(args.only.split(",")) : null;
fs.mkdirSync(SHOTS, { recursive: true });
const browser = await chromium.launch({ channel: "chrome" });
const report = [];
for (const t of TAKES) {
  if (only && !t.cuts.some(([c]) => only.has(c)) && !only.has(t.name)) continue;
  report.push(await take(browser, t));
  console.log(JSON.stringify(report[report.length - 1]));
}
await browser.close();
// Full demo: the cuts in narration order.
const order = ["01_overview", "02_festive", "03_bank", "04a_approve_ledger", "04b_blocked_failover", "05_split", "06_arena", "07_about"]
  .map((c) => path.join(OUT, `${c}.mp4`)).filter((f) => fs.existsSync(f));
if (order.length > 1) {
  const list = path.join(RAW, "concat.txt");
  fs.writeFileSync(list, order.map((f) => `file '${f.replace(/\\/g, "/")}'`).join("\n"));
  ff(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", path.join(OUT, "00_full_demo.mp4")]);
}
console.log(JSON.stringify({ msg: "done", out: OUT, clips: order.length }));
