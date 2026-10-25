// Turn a finished batch run into a replay recording (M5-T05/T06): no live services needed.
//   node scripts/rec_from_run.mjs r-S6-1-U4 [--name s6_u4]
// Reads ../data/runs/<run_id>/{result.json, timeseries.json, ticks.jsonl?, ground_truth.json?}. Because the run is
// finished, the ground-truth onset is included (shown only in replay/arena views, never live).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const [runId, ...rest] = process.argv.slice(2);
if (!runId || !/^[A-Za-z0-9_.-]+$/.test(runId)) { console.error("usage: rec_from_run.mjs <run_id> [--name n]"); process.exit(2); }
const name = (rest[0] === "--name" && rest[1] ? rest[1] : runId).replace(/[^A-Za-z0-9_.-]/g, "");
const runDir = path.resolve(here, "../../data/runs", runId);
const read = (f) => (fs.existsSync(path.join(runDir, f)) ? fs.readFileSync(path.join(runDir, f), "utf8") : null);
const result = JSON.parse(read("result.json") ?? "null");
if (!result) { console.error(`no result.json in ${runDir}`); process.exit(1); }
const ts = JSON.parse(read("timeseries.json") ?? "null");
const lines = [];
if (ts) lines.push({ stream: "timeseries", sim_ms: 0, data: ts });
for (const l of (read("ticks.jsonl") ?? "").split("\n").filter(Boolean)) {
  const t = JSON.parse(l);
  lines.push({ stream: "tick", sim_ms: t.tick_sim_ms, data: t });
}
const end = ts ? ts.t[ts.t.length - 1] * 1000 : 0;
for (let ms = 0; ms <= end; ms += 1000) {
  lines.push({ stream: "status", sim_ms: ms, data: { run_id: runId, scenario: result.scenario, seed: result.seed,
    universe: result.universe, sim_ms: ms, speed: 1, state: ms >= end ? "DONE" : "RUNNING" } });
}
const gt = (result.ground_truth ?? []).find((g) => g.is_incident);
if (gt) lines.push({ stream: "onset", sim_ms: gt.onset_ms, data: { sim_ms: gt.onset_ms, label: `ground truth: ${gt.kind}` } });
const outDir = path.resolve(here, "../../data/recordings");
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, `${name}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
console.log(JSON.stringify({ msg: "recording written", file: `data/recordings/${name}.jsonl`, lines: lines.length }));
