// Chart panel helpers (M5-T03, M5-T04): selection only, never computation about the network.
import { describe, expect, it } from "vitest";
import type { SegmentState } from "../src/contracts";
import { featureSeries, firstAlerts, lastFinite, medianBy, sparkPath, trail } from "../src/panels/panelLogic";

// minimal tick: only the fields these helpers read (no segment_state fixture exists in contracts/fixtures)
const fx = { run_id: "r-S4-1-U4", tick_sim_ms: 0, detector_alerts: [],
  segments: [{ segment_id: "psp:P1:*", features: {}, phase_point: null }] } as unknown as SegmentState;

function tickAt(ms: number, alerts: SegmentState["detector_alerts"], timeout: number | null, pp?: { delay_frac: number; orbit_frac: number }): SegmentState {
  const t = structuredClone(fx);
  t.tick_sim_ms = ms;
  t.detector_alerts = alerts;
  for (const s of t.segments) {
    if (s.segment_id === "psp:P1:*") {
      (s.features as Record<string, number | null>).timeout_ratio = timeout;
      (s as { phase_point?: unknown }).phase_point = pp ?? null;
    }
  }
  return t;
}

describe("panel logic", () => {
  it("first alert per detector is the earliest seen; missing detectors stay null", () => {
    const ticks = [
      tickAt(200_000, [{ detector: "D3", segment_id: "psp:P1:*", first_alert_sim_ms: 195_000 }], 0.1),
      tickAt(205_000, [{ detector: "D3", segment_id: "psp:P1:*", first_alert_sim_ms: 195_000 },
        { detector: "D0", segment_id: "psp:P1:*", first_alert_sim_ms: 205_000 }], 0.2),
    ];
    const f = firstAlerts(ticks);
    expect(f.D3).toEqual({ sim_ms: 195_000, segment_id: "psp:P1:*" });
    expect(f.D0?.sim_ms).toBe(205_000);
    expect(f.D1).toBeNull();
  });
  it("missing features are NaN (lines break, never drop to zero)", () => {
    const v = featureSeries([tickAt(1, [], 0.1), tickAt(2, [], null), tickAt(3, [], 0.3)], "psp:P1:*", "timeout_ratio");
    expect(v[0]).toBe(0.1);
    expect(Number.isNaN(v[1])).toBe(true);
    expect(lastFinite(v)).toBe(0.3);
    expect(sparkPath(v, 100, 10).match(/M/g)).toHaveLength(2);
  });
  it("cascade trail keeps only the last 60 s of phase points", () => {
    const ticks = [0, 30_000, 70_000, 100_000].map((ms, i) => tickAt(ms, [], 0, { delay_frac: i / 10, orbit_frac: i / 20 }));
    expect(trail(ticks, "P1").map((p) => p.x)).toEqual([0.2, 0.3]);
  });
});

describe("arena summary", () => {
  it("median per universe ignores null metrics and counts seeds", () => {
    const r = (u: string, seed: number, v: number | null) => ({ run_id: `r-S6-${seed}-${u}`, scenario: "S6", seed, universe: u, metrics: { peak_queue: v } });
    const m = medianBy([r("U0", 1, 10), r("U0", 2, 30), r("U0", 3, 20), r("U4", 1, 4), r("U4", 2, null), r("U4", 3, 6)], "peak_queue");
    expect(m.U0).toEqual({ median: 20, n: 3 });
    expect(m.U4).toEqual({ median: 5, n: 2 });
  });
});
