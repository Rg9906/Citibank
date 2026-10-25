// U-6: a recording replayed at 1x and 4x leaves the store in the same final state; timeseries is revealed by clock.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SegmentState } from "../src/contracts";
import { useQs } from "../src/store";
import { applyToStore, makeReplayer, parseRecording, replayParams, sliceSeries, type RecLine } from "../src/streams/replay";

const fx = (n: string) => path.resolve(__dirname, "../../contracts/fixtures", n);
const rec = JSON.parse(fs.readFileSync(fx("recommendation.json"), "utf8"));
const ledger = fs.readFileSync(fx("ledger_events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const tick = (ms: number) => ({ run_id: "r-S6-1-U4", tick_sim_ms: ms, global_state: "MONITORING", segments: [],
  localization: { verdict: "INSUFFICIENT_EVIDENCE", primary_segment_id: null, candidates: [], confidence: 0, total_excess: 0 },
  detector_alerts: [], incidents: [], universe: "U4", schema_version: 1 }) as unknown as SegmentState;

const ts = { t: [0, 1, 2, 3, 4, 5], goodput: [1, 2, 3, 4, 5, 6], switch_checks_per_s: [0, 0, 9, 9, 0, 0],
  unknown_open: [0, 1, 2, 1, 0, 0], queue: { P1: [0, 0, 1, 1, 0, 0] } };
const lines: RecLine[] = [
  { stream: "timeseries", sim_ms: 0, data: ts },
  ...[0, 1000, 2000, 3000, 4000, 5000].map((ms) => ({ stream: "tick", sim_ms: ms, data: tick(ms) })),
  { stream: "recommendation", sim_ms: 2500, data: rec },
  ...ledger.map((e, i) => ({ stream: "ledger_event", sim_ms: 3000 + i, data: e })),
  { stream: "onset", sim_ms: 1500, data: { sim_ms: 1500, label: "ground truth" } },
];

function finalState(stepMs: number) {
  useQs.getState().reset();
  const rp = makeReplayer(parseRecording(lines.map((l) => JSON.stringify(l)).join("\n")), (l) => applyToStore(l));
  for (let t = rp.startMs; !rp.done; t += stepMs) rp.advanceTo(t);
  rp.advanceTo(rp.endMs + 10 * stepMs);
  const s = useQs.getState();
  return JSON.stringify({ ticks: s.ticks.map((t) => t.tick_sim_ms), recs: Object.keys(s.recs), ledger: s.ledgerEvents.length,
    ts: s.timeseries, onset: s.onset });
}

describe("replay (U-6)", () => {
  it("same final state at 1x and 4x", () => {
    const a = finalState(100);
    const b = finalState(400);
    expect(a).toBe(b);
    expect(JSON.parse(a).ticks).toHaveLength(6);
  });
  it("timeseries is revealed only up to the replay clock", () => {
    expect(sliceSeries(ts, 2500).t).toEqual([0, 1, 2]);
    expect(sliceSeries(ts, 2500).queue.P1).toEqual([0, 0, 1]);
  });
  it("query params are parsed and the name sanitised", () => {
    expect(replayParams("?mode=replay&rec=s6_u4&speed=4")).toEqual({ rec: "s6_u4", speed: 4 });
    expect(replayParams("?mode=replay&rec=../../etc&speed=3")).toEqual({ rec: "....etc", speed: 1 });
    expect(replayParams("?rec=x")).toBeNull();
  });
});
