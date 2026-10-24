// Pure view logic for the M5 panels (tested in tests/panels.test.ts). It only selects and reshapes numbers the
// modules already published; it computes no metric of its own (CLAUDE.md: no business logic in the UI).
import type { LedgerEvent, RunResult, SegmentState } from "../contracts";

type Seg = SegmentState["segments"][number];
type Feature = keyof Seg["features"];

// ---------------------------------------------------------------- MetricStrip
export const STRIP: { key: Feature; label: string }[] = [
  { key: "timeout_ratio", label: "timeout %" },
  { key: "near_timeout_ratio", label: "near-timeout %" },
  { key: "p95_ms", label: "p95 ms" },
  { key: "raf", label: "RAF" },
  { key: "queue_depth", label: "queue" },
];
export const Z_FLAG = 2.5;

export interface Series { key: Feature; label: string; t: number[]; v: (number | null)[]; hot: boolean[]; last: number | null }

/** One series per strip metric for a segment: values as published (null stays null, never 0), and whether |z| > 2.5. */
export function stripSeries(ticks: SegmentState[], segmentId: string): Series[] {
  return STRIP.map(({ key, label }) => {
    const t: number[] = [], v: (number | null)[] = [], hot: boolean[] = [];
    for (const tick of ticks) {
      const s = tick.segments.find((x) => x.segment_id === segmentId);
      if (!s) continue;
      t.push(tick.tick_sim_ms / 1000);
      const x = s.features[key];
      v.push(x ?? null);
      const z = s.z[key];
      hot.push(z != null && Math.abs(z) > Z_FLAG);
    }
    const last = [...v].reverse().find((x) => x != null) ?? null;
    return { key, label, t, v, hot, last };
  });
}

// ---------------------------------------------------------------- DetectorRace
export const DETECTORS = ["D0", "D1", "D2", "D3"] as const;
export interface Lane { detector: (typeof DETECTORS)[number]; first_ms: number | null; segment: string | null; delay_s: number | null }

/** Earliest first-alert per detector (across segments) over every tick in view — M3 lists only currently active
 *  alerts, so the latest tick alone forgets a detector that already fired. Delay vs onset only when onset is known. */
export function raceLanes(ticks: SegmentState[] | SegmentState | undefined, onsetMs: number | null): Lane[] {
  const all = (Array.isArray(ticks) ? ticks : ticks ? [ticks] : []).flatMap((t) => t.detector_alerts ?? []);
  return DETECTORS.map((d) => {
    const alerts = all.filter((a) => a.detector === d)
      .sort((a, b) => a.first_alert_sim_ms - b.first_alert_sim_ms);
    const a = alerts[0];
    return { detector: d, first_ms: a?.first_alert_sim_ms ?? null, segment: a?.segment_id ?? null,
      delay_s: a && onsetMs != null ? (a.first_alert_sim_ms - onsetMs) / 1000 : null };
  });
}

// ---------------------------------------------------------------- Drunix panel
/** Advisories issued and not revoked (expiry is the ledger's job; the gateway's /v1/advisories?active=true is the
 *  authority — this is the stream view). Newest last. */
export function activeAdvisories(events: LedgerEvent[]): LedgerEvent[] {
  const revoked = new Set(events.filter((e) => e.name === "AdvisoryRevoked").map((e) => (e.payload as { id?: string }).id));
  return events.filter((e) => e.name === "AdvisoryIssued" && !revoked.has((e.payload as { id?: string }).id));
}

// ---------------------------------------------------------------- CascadeMap
export interface TrailPoint { t: number; delay: number; orbit: number }

/** Last `windowS` seconds of phase points per PSP, oldest first. Missing phase points are skipped, never zeroed. */
export function trails(ticks: SegmentState[], windowS = 60): Record<string, TrailPoint[]> {
  const out: Record<string, TrailPoint[]> = { P1: [], P2: [], P3: [] };
  const last = ticks[ticks.length - 1];
  if (!last) return out;
  const from = last.tick_sim_ms - windowS * 1000;
  for (const tick of ticks) {
    if (tick.tick_sim_ms < from) continue;
    for (const s of tick.segments) {
      if (!s.segment_id.startsWith("psp:")) continue;
      const pp = s.phase_point;
      if (pp?.delay_frac == null || pp.orbit_frac == null) continue;
      out[s.segment_id.split(":")[1]]?.push({ t: tick.tick_sim_ms, delay: pp.delay_frac, orbit: pp.orbit_frac });
    }
  }
  return out;
}

export interface Grid { version: string; delay_bins: number[]; orbit_bins: number[]; p: number[][]; contour_0_5: number[][] }

export function isGrid(x: unknown): x is Grid {
  const g = x as Grid;
  return !!g && Array.isArray(g.delay_bins) && Array.isArray(g.orbit_bins) && Array.isArray(g.p)
    && g.p.length === g.delay_bins.length - 1 && Array.isArray(g.contour_0_5);
}

// ---------------------------------------------------------------- VerificationPanel
export interface Budget { psp: string; rate_per_s: number; burst: number; first_check_delay_ms: number; ledger_wait_ms: number; origin: string }

export function summedBudget(budgets: Record<string, Budget>): number | null {
  const v = Object.values(budgets);
  return v.length ? Math.round(v.reduce((s, b) => s + b.rate_per_s, 0) * 100) / 100 : null;
}

export interface Timeseries { t: number[]; goodput: number[]; queue: Record<string, number[]>; switch_checks_per_s: number[]; unknown_open: number[] }

export function isTimeseries(x: unknown): x is Timeseries {
  const s = x as Timeseries;
  return !!s && Array.isArray(s.t) && Array.isArray(s.switch_checks_per_s) && Array.isArray(s.unknown_open);
}

/** Switch utilisation from the latest tick (M3 feature) — shown against the 0.85 knee. */
export function switchUtil(tick: SegmentState | undefined): number | null {
  return tick?.segments.find((s) => s.segment_id === "switch:*:*")?.features.switch_status_util ?? null;
}

// ---------------------------------------------------------------- Arena
export const ARENA_METRICS = ["recovery_time_s", "peak_queue", "switch_checks_per_unknown", "goodput_min_frac",
  "harmful_failovers"] as const;
export type ArenaMetric = (typeof ARENA_METRICS)[number];
export interface ArenaRow { scenario: string; universe: string; runs: number; medians: Record<ArenaMetric, number | null> }

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length / 2;
  return s.length % 2 ? s[Math.floor(m)] : (s[m - 1] + s[m]) / 2;
}

/** Medians per (scenario, universe), as reported by M2. U2 is always listed when U4 is (honest baseline): a missing
 *  U2 row is added with runs = 0 so the gap is visible instead of hidden. */
export function arenaTable(results: RunResult[]): ArenaRow[] {
  const groups = new Map<string, RunResult[]>();
  for (const r of results) {
    const k = `${r.scenario}|${r.universe}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const k of [...groups.keys()]) {
    const [sc, u] = k.split("|");
    if (u === "U4" && !groups.has(`${sc}|U2`)) groups.set(`${sc}|U2`, []);
  }
  return [...groups.entries()].map(([k, rs]) => {
    const [scenario, universe] = k.split("|");
    const medians = Object.fromEntries(ARENA_METRICS.map((m) =>
      [m, median(rs.map((r) => r.metrics[m]).filter((x): x is number => x != null))])) as Record<ArenaMetric, number | null>;
    return { scenario, universe, runs: rs.length, medians };
  }).sort((a, b) => a.scenario.localeCompare(b.scenario) || a.universe.localeCompare(b.universe));
}

// ---------------------------------------------------------------- Keyboard (operator speed: IBM sweep)
export type KeyCmd = "APPROVE_ALL" | "APPROVE_SELECTED" | "REJECT" | null;

export function keyCommand(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; target?: unknown },
  hasSelection: boolean): KeyCmd {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const tag = (e.target as { tagName?: string } | undefined)?.tagName?.toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return null;
  switch (e.key.toLowerCase()) {
    case "a": return "APPROVE_ALL";
    case "s": return hasSelection ? "APPROVE_SELECTED" : null;
    case "r": return "REJECT";
    default: return null;
  }
}

// ---------------------------------------------------------------- Header
export interface SimStatus { run_id: string | null; scenario: string | null; seed: number | null; universe: string | null;
  sim_ms: number; speed: number; state: string; ledger_mode?: string }

export function statusLine(s: SimStatus | null): string {
  if (!s) return "simulator offline";
  if (!s.run_id) return `simulator ${s.state.toLowerCase()}`;
  return `${s.scenario} · seed ${s.seed} · ${s.universe} · t=${Math.round(s.sim_ms / 1000)}s · ${s.speed}× · ${s.state}`;
}
