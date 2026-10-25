// Replay mode (docs/M5_CONSOLE.md §6, U-6): `?mode=replay&rec=<name>&speed=1|2|4` feeds a recording through the same
// store handlers the live streams use. Lines are applied strictly in order, so the final panel state is identical at
// any speed. Recording line: {"stream": "tick"|"recommendation"|"decision"|"budget"|"ledger_event"|"status"|
// "timeseries"|"onset", "sim_ms": number, "data": ...}. `timeseries` holds the run's full series and is revealed up to
// the replay clock; `onset` is ground truth and exists only in recordings made from finished runs.
import { decisionRow } from "../connect";
import type { LedgerEvent, Recommendation, SegmentState } from "../contracts";
import { useQs, type SimStatus, type Timeseries } from "../store";

export interface RecLine { stream: string; sim_ms: number; data: unknown }

export function parseRecording(text: string): RecLine[] {
  const lines = text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as RecLine);
  return lines.map((l, i) => ({ ...l, i })).sort((a, b) => a.sim_ms - b.sim_ms || a.i - b.i)
    .map(({ i: _i, ...l }) => l);
}

/** Series cut at `simMs` (seconds index), so the verification chart grows with the replay clock. */
export function sliceSeries(ts: Timeseries, simMs: number): Timeseries {
  const n = ts.t.findIndex((t) => t * 1000 > simMs);
  const k = n < 0 ? ts.t.length : n;
  return { t: ts.t.slice(0, k), goodput: ts.goodput.slice(0, k), switch_checks_per_s: ts.switch_checks_per_s.slice(0, k),
    unknown_open: ts.unknown_open.slice(0, k),
    queue: Object.fromEntries(Object.entries(ts.queue).map(([p, v]) => [p, v.slice(0, k)])) };
}

export type Apply = (line: RecLine, clockMs: number) => void;

/** Deterministic cursor over a recording: advanceTo() applies every line with sim_ms <= t exactly once. */
export function makeReplayer(lines: RecLine[], apply: Apply) {
  let next = 0;
  let series: Timeseries | null = null;
  return {
    get done() { return next >= lines.length; },
    get startMs() { return lines.length ? lines[0].sim_ms : 0; },
    get endMs() { return lines.length ? lines[lines.length - 1].sim_ms : 0; },
    advanceTo(t: number) {
      while (next < lines.length && lines[next].sim_ms <= t) {
        const l = lines[next++];
        if (l.stream === "timeseries") series = l.data as Timeseries;
        else apply(l, t);
      }
      const tc = Math.min(t, this.endMs);                     // same final state at any speed (U-6)
      if (series) apply({ stream: "timeseries", sim_ms: tc, data: sliceSeries(series, tc) }, tc);
    },
  };
}

/** Store handlers shared with the live wiring. */
export function applyToStore(l: RecLine): void {
  const s = useQs.getState();
  switch (l.stream) {
    case "tick": s.addTick(l.data as SegmentState); break;
    case "recommendation": s.upsertRec(l.data as Recommendation); break;
    case "decision": s.addDecision(decisionRow(l.data as Parameters<typeof decisionRow>[0])); break;
    case "budget": s.setBudget((l.data as { psp: string }).psp, (l.data as { rate_per_s: number }).rate_per_s); break;
    case "ledger_event": s.addLedgerEvent(l.data as LedgerEvent); break;
    case "status": s.setSimStatus(l.data as SimStatus); break;
    case "timeseries": s.setTimeseries(l.data as Timeseries); break;
    case "onset": s.setOnset(l.data as { sim_ms: number; label: string }); break;
    default: break;                                           // unknown streams are ignored, never fatal
  }
}

export function replayParams(search: string): { rec: string; speed: number } | null {
  const q = new URLSearchParams(search);
  if (q.get("mode") !== "replay" || !q.get("rec")) return null;
  const speed = Number(q.get("speed") ?? "1");
  return { rec: q.get("rec")!.replace(/[^A-Za-z0-9_.-]/g, ""), speed: [1, 2, 4, 8].includes(speed) ? speed : 1 };
}

export async function loadRecording(name: string): Promise<RecLine[]> {
  const r = await fetch(`/recordings/${encodeURIComponent(name)}.jsonl`);
  if (!r.ok) throw new Error(`recording ${name}: HTTP ${r.status}`);
  return parseRecording(await r.text());
}

/** Browser driver: one replay clock at `speed` x sim time; returns a stop function. */
export function startReplay(lines: RecLine[], speed: number, apply: Apply = (l) => applyToStore(l),
  onClock?: (t: number, done: boolean) => void): () => void {
  const rp = makeReplayer(lines, apply);
  const t0 = performance.now();
  const id = setInterval(() => {
    const t = rp.startMs + (performance.now() - t0) * speed;
    rp.advanceTo(t);
    onClock?.(t, rp.done);
    if (rp.done) clearInterval(id);
  }, 100);
  return () => clearInterval(id);
}
