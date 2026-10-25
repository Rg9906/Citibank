// M5-T02..T06 logic: keyboard, metric strip, detector race, cascade trails, budgets, arena table, replay (U-6),
// decision-row merge for M4's ledger updates (U-3).
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { LedgerEvent, Recommendation, RunResult, SegmentState } from "../src/contracts";
import { activeAdvisories, arenaTable, isGrid, keyCommand, raceLanes, statusLine, stripSeries, summedBudget, trails } from "../src/panels/viewLogic";
import { mergeDecision, useQs } from "../src/store";
import { parseRecording, replay, replayParams, stateAt, type RecLine, type Scheduler } from "../src/streams/replay";
import { dispatch } from "../src/connect";

const SEGS = ["platform:*:*", "psp:P1:*", "psp:P2:*", "psp:P3:*", "bank:*:B1", "switch:*:*"];

function tick(t: number, opts: { to?: number | null; z?: number; pp?: [number, number] | null; alerts?: SegmentState["detector_alerts"];
  state?: SegmentState["global_state"] } = {}): SegmentState {
  return {
    schema_version: 1, run_id: "r-S4-1-U4", universe: "U4", tick_sim_ms: t, global_state: opts.state ?? "MONITORING",
    segments: SEGS.map((id) => ({
      segment_id: id, eligible: true, flags: [], d3_score: 0.1, state: "MONITORING", surge: false, d0_alert: false,
      signals: { lat: false, to: false, near_to: false, q: false, raf: false, rej: false },
      features: { timeout_ratio: opts.to === undefined ? 0.01 : opts.to, p95_ms: 400, switch_status_util: 0.5 },
      z: { timeout_ratio: opts.z ?? 0 },
      ...(id.startsWith("psp:") ? { phase_point: opts.pp === null ? null : { delay_frac: (opts.pp ?? [0.1, 0.2])[0], orbit_frac: (opts.pp ?? [0.1, 0.2])[1] } } : {}),
    })),
    localization: { verdict: "INSUFFICIENT_EVIDENCE", primary_segment_id: null, candidates: [], confidence: 0, total_excess: 0 },
    detector_alerts: opts.alerts ?? [], incidents: [],
  };
}

describe("keyboard (M5-T02)", () => {
  it("A / S / R map to decisions, S needs a selection, typing in inputs is ignored", () => {
    expect(keyCommand({ key: "a" }, false)).toBe("APPROVE_ALL");
    expect(keyCommand({ key: "A" }, false)).toBe("APPROVE_ALL");
    expect(keyCommand({ key: "s" }, false)).toBeNull();
    expect(keyCommand({ key: "s" }, true)).toBe("APPROVE_SELECTED");
    expect(keyCommand({ key: "r" }, false)).toBe("REJECT");
    expect(keyCommand({ key: "a", ctrlKey: true }, false)).toBeNull();
    expect(keyCommand({ key: "a", target: { tagName: "input" } }, false)).toBeNull();
    expect(keyCommand({ key: "x" }, false)).toBeNull();
  });
});

describe("metric strip (M5-T03)", () => {
  it("keeps nulls as nulls and flags |z| > 2.5", () => {
    const s = stripSeries([tick(5000), tick(10000, { to: null }), tick(15000, { to: 0.3, z: 4 })], "psp:P1:*");
    const to = s.find((x) => x.key === "timeout_ratio")!;
    expect(to.t).toEqual([5, 10, 15]);
    expect(to.v).toEqual([0.01, null, 0.3]);
    expect(to.hot).toEqual([false, false, true]);
    expect(to.last).toBe(0.3);
    expect(s.map((x) => x.key)).toEqual(["timeout_ratio", "near_timeout_ratio", "p95_ms", "raf", "queue_depth"]);
  });
});

describe("detector race (M5-T04)", () => {
  const alerts: SegmentState["detector_alerts"] = [
    { detector: "D3", segment_id: "bank:*:B1", first_alert_sim_ms: 215000 },
    { detector: "D3", segment_id: "psp:P1:*", first_alert_sim_ms: 220000 },
    { detector: "D0", segment_id: "platform:*:*", first_alert_sim_ms: 240000 },
  ];
  it("earliest flag per detector; delay only when the onset is known", () => {
    const live = raceLanes(tick(250000, { alerts }), null);
    expect(live.map((l) => l.detector)).toEqual(["D0", "D1", "D2", "D3"]);
    expect(live[3]).toMatchObject({ first_ms: 215000, segment: "bank:*:B1", delay_s: null });
    expect(live[1].first_ms).toBeNull();
    const rp = raceLanes(tick(250000, { alerts }), 200000);
    expect(rp[3].delay_s).toBe(15);
    expect(rp[0].delay_s).toBe(40);
  });
  it("remembers a detector that fired earlier even after its alert cleared (M3 lists only active alerts)", () => {
    const later: SegmentState["detector_alerts"] = [{ detector: "D2", segment_id: "bank:*:B1", first_alert_sim_ms: 300000 }];
    const lanes = raceLanes([tick(250000, { alerts }), tick(320000, { alerts: later })], null);
    expect(lanes[3].first_ms).toBe(215000);
    expect(lanes[2].first_ms).toBe(300000);
  });
});

describe("cascade map (M5-T04)", () => {
  it("60 s trail per PSP, skipping missing phase points", () => {
    const ticks = [tick(0, { pp: [0.9, 0.9] }), tick(65000, { pp: null }), tick(70000, { pp: [0.3, 0.4] }), tick(120000, { pp: [0.5, 0.6] })];
    const tr = trails(ticks, 60);
    expect(tr.P1.map((p) => p.t)).toEqual([70000, 120000]);
    expect(tr.P2[1]).toMatchObject({ delay: 0.5, orbit: 0.6 });
  });
  it("accepts only a well-formed grid", () => {
    const edges = Array.from({ length: 21 }, (_, i) => i / 10);
    const p = Array.from({ length: 20 }, () => Array(20).fill(0.2));
    expect(isGrid({ version: "g", delay_bins: edges, orbit_bins: edges, p, contour_0_5: [] })).toBe(true);
    expect(isGrid({ error: "UNAVAILABLE" })).toBe(false);
  });
});

describe("drunix panel", () => {
  it("revoked advisories are not listed as active", () => {
    const ev = (name: string, id: string): LedgerEvent => ({ event_id: `${name}:${id}`, block_number: 1, tx_id: "t", chaincode: "queueshield",
      name: name as LedgerEvent["name"], payload: { id }, received_wall_iso: "2026-10-23T00:00:00.000Z", mock: true });
    const act = activeAdvisories([ev("AdvisoryIssued", "adv-00001"), ev("AdvisoryIssued", "adv-00002"), ev("AdvisoryRevoked", "adv-00001")]);
    expect(act.map((e) => (e.payload as { id: string }).id)).toEqual(["adv-00002"]);
  });
});

describe("verification + header (M5-T01, T03)", () => {
  it("sums the per-PSP budgets M4 published", () => {
    expect(summedBudget({})).toBeNull();
    const b = (psp: string, r: number) => ({ psp, rate_per_s: r, burst: 2, first_check_delay_ms: 1, ledger_wait_ms: 1, origin: "POLICY_DEFAULT" });
    expect(summedBudget({ P1: b("P1", 1.5), P2: b("P2", 2.25), P3: b("P3", 1) })).toBe(4.75);
  });
  it("status line", () => {
    expect(statusLine(null)).toBe("simulator offline");
    expect(statusLine({ run_id: null, scenario: null, seed: null, universe: null, sim_ms: 0, speed: 1, state: "IDLE" })).toBe("simulator idle");
    expect(statusLine({ run_id: "r-S4-1-U4", scenario: "S4", seed: 1, universe: "U4", sim_ms: 125400, speed: 2, state: "RUNNING" }))
      .toBe("S4 · seed 1 · U4 · t=125s · 2× · RUNNING");
  });
});

describe("arena table (M5-T06)", () => {
  const rr = (sc: string, u: string, seed: number, rec: number | null): RunResult => ({
    run_id: `r-${sc}-${seed}-${u}`, scenario: sc as RunResult["scenario"], seed, universe: u as RunResult["universe"],
    config_sha256: "x", sim_version: "1", metrics: { recovery_time_s: rec, peak_queue: seed * 10 }, ground_truth: [], files: { events: "e" } });
  it("medians per scenario/universe; U2 always shown next to U4", () => {
    const rows = arenaTable([rr("S4", "U4", 1, 10), rr("S4", "U4", 2, 30), rr("S4", "U4", 3, null), rr("S4", "U0", 1, 90)]);
    expect(rows.map((r) => `${r.scenario}/${r.universe}/${r.runs}`)).toEqual(["S4/U0/1", "S4/U2/0", "S4/U4/3"]);
    const u4 = rows.find((r) => r.universe === "U4")!;
    expect(u4.medians.recovery_time_s).toBe(20);
    expect(u4.medians.peak_queue).toBe(20);
    expect(rows.find((r) => r.universe === "U2")!.medians.recovery_time_s).toBeNull();
  });
});

describe("decision log merge (U-3, M4-T01)", () => {
  it("a ledger update keeps operator/decision and fills tx + block", () => {
    const first = mergeDecision(undefined, { rec_id: "rec-0001", decision_id: "dec-00001", operator: "saran", decision: "APPROVE_ALL",
      action_ids: ["act-00001"], status: "APPROVED", ledger: { decision_tx: null, pending: true } });
    expect(first.ledger_tx).toBeNull();
    const upd = mergeDecision(first, { rec_id: "rec-0001", decision_id: "dec-00001", ledger: { decision_tx: "feedbeef", block_number: 42 } });
    expect(upd).toMatchObject({ operator: "saran", decision: "APPROVE_ALL", action_ids: ["act-00001"], ledger_tx: "feedbeef", ledger_block: 42 });
  });
  it("store applies M4's two decision shapes into one row", () => {
    useQs.getState().reset();
    useQs.getState().addDecision({ rec_id: "rec-0002", decision_id: "dec-00002", operator: "saran", decision: "REJECT", action_ids: [], status: "REJECTED" });
    useQs.getState().addDecision({ rec_id: "rec-0002", decision_id: "dec-00002", ledger: { decision_tx: "aa11bb22", block_number: 7 } });
    const rows = useQs.getState().decisions;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ operator: "saran", ledger_tx: "aa11bb22", ledger_block: 7 });
  });
});

// ---------------------------------------------------------------- replay (U-6)
class FakeClock implements Scheduler {
  now = 0; q: { at: number; fn: () => void; id: number }[] = []; n = 0;
  setTimeout(fn: () => void, ms: number) { const id = ++this.n; this.q.push({ at: this.now + ms, fn, id }); return id; }
  clearTimeout(h: unknown) { this.q = this.q.filter((x) => x.id !== h); }
  runAll() { while (this.q.length) { this.q.sort((a, b) => a.at - b.at); const x = this.q.shift()!; this.now = x.at; x.fn(); } }
}

function recording(): string {
  const rec = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../contracts/fixtures/recommendation.json"), "utf8")) as Recommendation;
  const lev = fs.readFileSync(path.resolve(__dirname, "../../contracts/fixtures/ledger_events.jsonl"), "utf8").trim().split("\n")
    .map((l) => JSON.parse(l) as LedgerEvent);
  const lines: RecLine[] = [];
  for (let t = 5000; t <= 60000; t += 5000) lines.push({ stream: "detect", sim_ms: t, event: "tick", data: tick(t, { state: t > 30000 ? "CRITICAL" : "MONITORING" }) });
  lines.push({ stream: "control", sim_ms: 35000, event: "recommendation", data: rec });
  lines.push({ stream: "control", sim_ms: 45000, event: "decision", data: { rec_id: rec.rec_id, decision_id: "dec-00001", operator: "saran", decision: "APPROVE_ALL", action_ids: ["act-00001"], status: "APPROVED" } });
  lev.forEach((e, i) => lines.push({ stream: "ledger", sim_ms: 46000 + i * 1000, event: "ledger_event", data: e }));
  // shuffled order + one corrupt line: parse must sort and skip
  return [...lines].reverse().map((l) => JSON.stringify(l)).concat(["{broken", ""]).join("\n");
}

function finalState(speed: number) {
  useQs.getState().reset();
  const { lines, rejected } = parseRecording(recording());
  expect(rejected).toBe(1);
  const clock = new FakeClock();
  let last = 0;
  replay(lines, speed, dispatch, (ms) => (last = ms), clock);
  clock.runAll();
  const st = useQs.getState();
  return { wall: clock.now, last, ticks: st.ticks.length, global: st.ticks[st.ticks.length - 1]?.global_state,
    recs: Object.keys(st.recs).sort(), decisions: st.decisions.map((d) => d.rec_id), ledger: st.ledgerEvents.length };
}

describe("replay (U-6, M5-T05)", () => {
  beforeEach(() => useQs.getState().reset());
  it("same final panel state at 1x and 4x; 4x takes a quarter of the wall time", () => {
    const a = finalState(1), b = finalState(4);
    const { wall: wa, ...ra } = a, { wall: wb, ...rb } = b;
    expect(ra).toEqual(rb);
    expect(ra.ticks).toBe(12);
    expect(ra.global).toBe("CRITICAL");
    expect(ra.decisions).toHaveLength(1);
    expect(wb).toBeCloseTo(wa / 4, 5);
  });
  it("url params: replay only with a plain file name and a known speed", () => {
    expect(replayParams("?mode=replay&rec=s6-u4&speed=4")).toEqual({ name: "s6-u4", speed: 4 });
    expect(replayParams("?mode=replay&rec=s6&speed=3")).toEqual({ name: "s6", speed: 1 });
    expect(replayParams("?mode=replay&rec=../../etc/passwd")).toBeNull();
    expect(replayParams("?rec=x")).toBeNull();
  });
  it("split replay summary at a sim time", () => {
    const { lines } = parseRecording(recording());
    expect(stateAt(lines, 20000)).toMatchObject({ global_state: "MONITORING", recommendations: 0, decisions: 0 });
    expect(stateAt(lines, 60000)).toMatchObject({ global_state: "CRITICAL", recommendations: 1, decisions: 1 });
  });
});
