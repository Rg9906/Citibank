// Pure helpers for the chart panels (docs/M5_CONSOLE.md §3). Selection and layout only: every number comes from a
// stream or an endpoint, nothing is computed about the network here.
import type { SegmentState } from "../contracts";

export const DETECTORS = ["D0", "D1", "D2", "D3"] as const;
export type Detector = (typeof DETECTORS)[number];

type Seg = SegmentState["segments"][number];

export function segmentOf(t: SegmentState, id: string): Seg | undefined {
  return t.segments.find((s) => s.segment_id === id);
}

/** Feature values for one segment across ticks (null/missing -> NaN so lines break instead of dropping to 0). */
export function featureSeries(ticks: SegmentState[], segmentId: string, feature: string): number[] {
  return ticks.map((t) => {
    const v = (segmentOf(t, segmentId)?.features as Record<string, number | null | undefined> | undefined)?.[feature];
    return typeof v === "number" ? v : NaN;
  });
}

/** Earliest alert per detector over the ticks we hold (each tick repeats the current alerts). */
export function firstAlerts(ticks: SegmentState[]): Record<Detector, { sim_ms: number; segment_id: string } | null> {
  const out = { D0: null, D1: null, D2: null, D3: null } as Record<Detector, { sim_ms: number; segment_id: string } | null>;
  for (const t of ticks) {
    for (const a of t.detector_alerts ?? []) {
      const d = a.detector as Detector;
      const cur = out[d];
      if (!cur || a.first_alert_sim_ms < cur.sim_ms) out[d] = { sim_ms: a.first_alert_sim_ms, segment_id: a.segment_id };
    }
  }
  return out;
}

/** Phase-space trail of one PSP over the last `windowMs` of sim time. */
export function trail(ticks: SegmentState[], psp: string, windowMs = 60_000): { x: number; y: number }[] {
  const last = ticks.length ? ticks[ticks.length - 1].tick_sim_ms : 0;
  const out: { x: number; y: number }[] = [];
  for (const t of ticks) {
    if (t.tick_sim_ms < last - windowMs) continue;
    const pp = (segmentOf(t, `psp:${psp}:*`) as { phase_point?: { delay_frac?: number; orbit_frac?: number } | null } | undefined)?.phase_point;
    if (pp && typeof pp.delay_frac === "number" && typeof pp.orbit_frac === "number") out.push({ x: pp.delay_frac, y: pp.orbit_frac });
  }
  return out;
}

/** SVG path through finite values; NaN breaks the line. Scale is [min, max] of finite values unless given. */
export function sparkPath(values: number[], w: number, h: number, lo?: number, hi?: number): string {
  const fin = values.filter(Number.isFinite);
  if (!fin.length) return "";
  const min = lo ?? Math.min(...fin);
  const max = hi ?? Math.max(...fin);
  const span = max - min || 1;
  const dx = values.length > 1 ? w / (values.length - 1) : 0;
  let d = "";
  let pen = false;
  values.forEach((v, i) => {
    if (!Number.isFinite(v)) { pen = false; return; }
    const x = i * dx;
    const y = h - ((v - min) / span) * h;
    d += `${pen ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    pen = true;
  });
  return d;
}

export function lastFinite(values: number[]): number | null {
  for (let i = values.length - 1; i >= 0; i--) if (Number.isFinite(values[i])) return values[i];
  return null;
}

export interface RunSummary { run_id: string; scenario: string; seed: number; universe: string; metrics: Record<string, number | null> }

/** Median of a metric per universe over the seeds present (display summary of M2's per-run numbers). */
export function medianBy(runs: RunSummary[], metric: string): Record<string, { median: number | null; n: number }> {
  const by: Record<string, number[]> = {};
  for (const r of runs) {
    const v = r.metrics[metric];
    (by[r.universe] ??= []);
    if (typeof v === "number" && Number.isFinite(v)) by[r.universe].push(v);
  }
  return Object.fromEntries(Object.entries(by).map(([u, v]) => {
    const s = [...v].sort((a, b) => a - b);
    const m = s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
    return [u, { median: m, n: s.length }];
  }));
}
