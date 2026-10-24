#!/usr/bin/env node
// M5-T05 recorder: subscribe to the four live streams and write data/recordings/<name>.jsonl, one
// {"stream","sim_ms","event","data"} per line (CONTRACTS §6). Replay with ?mode=replay&rec=<name>&speed=1|2|4.
//
//   node scripts/record.mjs --name s6-u4 --seconds 240
//   node scripts/record.mjs --name s3-demo --until-done        # stops when M2 reports run_done
//
// sim_ms per line: detect ticks carry tick_sim_ms; other messages take the latest sim time seen on any stream
// (payment events / ticks), so ordering in the file follows the simulation clock.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
  return acc;
}, []));
const name = String(args.name ?? "");
if (!/^[A-Za-z0-9._-]+$/.test(name)) { console.error("--name <file-name> is required (letters, digits, . _ -)"); process.exit(2); }
const seconds = Number(args.seconds ?? 600);
const env = (k, d) => process.env[k] ?? d;
const SOURCES = {
  sim: [`${env("SIM_URL", "http://localhost:8001")}/v1/stream?types=SWITCH_SNAPSHOT,ACTION_APPLIED`, ["run_started", "run_done", "payment_event"]],
  detect: [`${env("DETECT_URL", "http://localhost:8002")}/v1/stream`, ["tick"]],
  control: [`${env("CONTROL_URL", "http://localhost:8003")}/v1/stream`, ["recommendation", "decision", "budget"]],
  ledger: [`${env("LEDGER_URL", "http://localhost:8004")}/v1/stream`, ["ledger_event"]],
};

const outDir = path.resolve(here, "../../data/recordings");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${name}.jsonl`);
const out = fs.createWriteStream(outFile, { flags: "w" });
let simMs = 0, n = 0;
const counts = {};
const ctrl = new AbortController();

function write(stream, event, data) {
  if (stream === "detect" && typeof data.tick_sim_ms === "number") simMs = Math.max(simMs, data.tick_sim_ms);
  if (stream === "sim" && typeof data.sim_ms === "number") simMs = Math.max(simMs, data.sim_ms);
  const t = stream === "detect" && typeof data.tick_sim_ms === "number" ? data.tick_sim_ms : simMs;
  out.write(JSON.stringify({ stream, sim_ms: t, event, data }) + "\n");
  n++; counts[stream] = (counts[stream] ?? 0) + 1;
  if (stream === "sim" && event === "run_done" && args["until-done"]) stop("run_done");
}

async function follow(stream, url, events) {
  const want = new Set(events);
  for (let backoff = 500; !ctrl.signal.aborted; backoff = Math.min(8000, backoff * 2)) {
    try {
      const r = await fetch(url, { headers: { accept: "text/event-stream" }, signal: ctrl.signal });
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
      backoff = 500;
      const dec = new TextDecoder();
      let buf = "", ev = "message", data = [];
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1);
          if (line === "") {
            if (data.length && want.has(ev)) { try { write(stream, ev, JSON.parse(data.join("\n"))); } catch { /* skip bad JSON */ } }
            ev = "message"; data = [];
          } else if (line.startsWith("event:")) ev = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
      }
    } catch (e) {
      if (ctrl.signal.aborted) return;
      console.error(`${stream}: ${e.message}; retrying in ${backoff} ms`);
    }
    await new Promise((res) => setTimeout(res, backoff));
  }
}

function stop(why) {
  if (ctrl.signal.aborted) return;
  ctrl.abort();
  out.end(() => { console.log(`${why}: wrote ${n} lines to ${outFile}`, counts); process.exit(0); });
}

process.on("SIGINT", () => stop("interrupted"));
setTimeout(() => stop(`${seconds}s elapsed`), seconds * 1000);
for (const [k, [url, events]] of Object.entries(SOURCES)) follow(k, url, events);
console.log(`recording ${Object.keys(SOURCES).join(", ")} -> ${outFile} for up to ${seconds}s (Ctrl-C to stop)`);
