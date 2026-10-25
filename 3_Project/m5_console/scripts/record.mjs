// Record a live run for replay mode (M5-T05, docs/M5_CONSOLE.md §6).
//   node scripts/record.mjs --name s6_live --seconds 240
// Subscribes to M3 ticks, M4 recommendations/decisions/budgets and M1 ledger events, polls M2 /v1/status every
// second, and at the end stores M2's full timeseries. Writes ../data/recordings/<name>.jsonl, one
// {"stream","sim_ms","data"} per line. Live recordings carry no ground truth (no onset line).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) => (x.startsWith("--") ? [...a, [x.slice(2), all[i + 1]]] : a), []));
const name = (args.name ?? `rec_${Date.now()}`).replace(/[^A-Za-z0-9_.-]/g, "");
const seconds = Number(args.seconds ?? 240);
const URLS = {
  sim: process.env.SIM_URL ?? "http://127.0.0.1:8001", detect: process.env.DETECT_URL ?? "http://127.0.0.1:8002",
  control: process.env.CONTROL_URL ?? "http://127.0.0.1:8003", ledger: process.env.LEDGER_URL ?? "http://127.0.0.1:8004",
};
const outDir = path.resolve(here, "../../data/recordings");
fs.mkdirSync(outDir, { recursive: true });
const out = fs.createWriteStream(path.join(outDir, `${name}.jsonl`));
let simMs = 0;
let n = 0;
const write = (stream, data, ms = simMs) => { out.write(JSON.stringify({ stream, sim_ms: ms, data }) + "\n"); n++; };
const ctl = new AbortController();

async function sse(url, wanted, onEvent) {
  for (;;) {
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { accept: "text/event-stream" } });
      const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let k;
        while ((k = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, k);
          buf = buf.slice(k + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1];
          const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n");
          if (ev && wanted.includes(ev) && data) onEvent(ev, JSON.parse(data));
        }
      }
    } catch (e) {
      if (ctl.signal.aborted) return;
    }
    await new Promise((res) => setTimeout(res, 1000));                 // reconnect
  }
}

sse(`${URLS.detect}/v1/stream`, ["tick"], (_e, d) => { simMs = Math.max(simMs, d.tick_sim_ms); write("tick", d, d.tick_sim_ms); });
sse(`${URLS.control}/v1/stream`, ["recommendation", "decision", "budget"], (e, d) => write(e, d));
sse(`${URLS.ledger}/v1/stream`, ["ledger_event"], (_e, d) => write("ledger_event", d));
let runId = null;
const poll = setInterval(async () => {
  try {
    const st = await (await fetch(`${URLS.sim}/v1/status`)).json();
    if (st.run_id) { runId = st.run_id; simMs = Math.max(simMs, st.sim_ms); }
    write("status", st);
  } catch { /* M2 down: nothing to record this second */ }
}, 1000);

setTimeout(async () => {
  clearInterval(poll);
  if (runId) {
    try {
      const ts = await (await fetch(`${URLS.sim}/v1/timeseries?run_id=${encodeURIComponent(runId)}`)).json();
      write("timeseries", ts, 0);
    } catch { /* recorded without the verification series */ }
  }
  ctl.abort();
  out.end(() => { console.log(JSON.stringify({ msg: "recording written", file: `data/recordings/${name}.jsonl`, lines: n })); process.exit(0); });
}, seconds * 1000);
