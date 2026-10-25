// Pure mapping from store state to the 3D network hero (NetworkScene.tsx). No metric is computed here: every number is a
// field M3 (tick), M2 (timeseries) or M1 (ledger events) sent; this file only turns them into colours, speeds and counts.
import type { SegmentState } from "../contracts";

export const PSPS = ["P1", "P2", "P3"] as const;
export const BANKS = ["B1", "B2", "B3", "B4", "B5"] as const;
export const SWITCH = "SW";
export type LonLat = [number, number];

/** Illustrative city positions only: the simulator has no geography. */
export const NODES: Record<string, { label: string; city: string; ll: LonLat }> = {
  SW: { label: "NPCI-like switch", city: "Mumbai", ll: [72.88, 19.08] },
  P1: { label: "P1 · PSP", city: "Bengaluru", ll: [77.59, 12.97] },
  P2: { label: "P2 · PSP", city: "Delhi", ll: [77.21, 28.61] },
  P3: { label: "P3 · PSP", city: "Nagpur", ll: [79.09, 21.15] },
  B1: { label: "B1 · bank", city: "Chennai", ll: [80.27, 13.08] },
  B2: { label: "B2 · bank", city: "Kolkata", ll: [88.36, 22.57] },
  B3: { label: "B3 · bank", city: "Ahmedabad", ll: [72.57, 23.02] },
  B4: { label: "B4 · bank", city: "Guwahati", ll: [91.74, 26.14] },
  B5: { label: "B5 · bank", city: "Kochi", ll: [76.4, 9.95] },
};

/** Hand-simplified outline of India (lon, lat), clockwise from Kashmir. Stylised, not a survey map. */
export const INDIA: LonLat[] = [
  [73.9, 34.6], [74.6, 37.0], [77.0, 35.6], [78.9, 34.3], [79.3, 32.6], [78.8, 31.2], [80.3, 30.4], [81.1, 30.0],
  [82.5, 28.0], [84.0, 27.5], [85.5, 26.8], [88.0, 26.4], [88.2, 27.9], [88.9, 27.3], [89.8, 26.7], [92.0, 26.8],
  [92.1, 27.8], [94.0, 28.8], [95.4, 29.3], [96.6, 29.0], [97.4, 28.2], [96.0, 27.2], [95.2, 26.5], [94.6, 25.2],
  [94.2, 23.8], [93.4, 23.0], [93.2, 22.0], [92.6, 21.9], [92.0, 24.0], [91.0, 25.1], [90.0, 25.2], [89.8, 25.9],
  [88.7, 26.2], [88.4, 25.0], [88.9, 23.5], [89.0, 22.0], [88.0, 21.6], [87.0, 21.0], [86.5, 20.3], [85.0, 19.3],
  [84.0, 18.3], [82.3, 16.6], [81.0, 15.6], [80.3, 15.0], [80.5, 13.3], [79.9, 11.0], [79.3, 10.2], [78.4, 9.0],
  [77.5, 8.1], [76.5, 8.9], [76.0, 10.5], [75.4, 12.0], [74.8, 13.5], [74.1, 15.0], [73.4, 16.5], [72.7, 18.9],
  [72.7, 20.5], [72.6, 21.1], [71.0, 20.8], [69.2, 22.3], [68.5, 23.5], [70.0, 24.3], [70.7, 24.4], [71.0, 25.5],
  [70.2, 26.6], [71.2, 27.9], [72.8, 29.0], [73.9, 30.0], [74.6, 31.0], [74.6, 32.5], [74.0, 33.3],
];

const CENTRE: LonLat = [82.5, 22.5];

/** Equirectangular projection into scene units (1 unit ≈ 1 degree), centred on India. */
export function project([lon, lat]: LonLat): [number, number] {
  return [lon - CENTRE[0], lat - CENTRE[1]];
}

/** Ray-casting point-in-polygon test. */
export function pointInPolygon([x, y]: [number, number], poly: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Dot-matrix fill of the outline in scene units (spacing in degrees). */
export function indiaDots(step = 0.45): [number, number][] {
  const poly = INDIA.map(project);
  const out: [number, number][] = [];
  for (let lon = 68; lon <= 97.5; lon += step) {
    for (let lat = 8; lat <= 37; lat += step) {
      const p = project([lon, lat]);
      if (pointInPolygon(p, poly)) out.push(p);
    }
  }
  return out;
}

export type RGB = [number, number, number];
const CALM: RGB = [0.25, 0.82, 0.88];
const WARN: RGB = [1.0, 0.62, 0.22];
const CRIT: RGB = [1.0, 0.22, 0.3];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (v: number) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

/** D3 score (0..1) → cyan → amber → red. */
export function scoreColour(score: number): RGB {
  const s = clamp01(score);
  return s < 0.5 ? mix(CALM, WARN, s / 0.5) : mix(WARN, CRIT, (s - 0.5) / 0.5);
}

export interface RouteVisual { id: string; psp: string; bank: string; score: number; colour: RGB; speed: number }
export interface SceneVisual {
  routes: RouteVisual[];
  hot: Set<string>;            // node ids the localizer names (bank, PSP, both for a route, SW for the switch)
  globalState: string;
  verdict: string;
  primary: string | null;
  checksPerS: number | null;   // M2 switch status checks/s, latest second
  ledgerEvents: number;        // count of ledger events seen (drives the ring flash)
}

/** Localizer primary segment id → node ids to highlight. */
export function hotNodes(primary: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (!primary) return out;
  const [level, psp, bank] = primary.split(":");
  if (level === "switch") out.add(SWITCH);
  if (psp && psp !== "*" && (level === "psp" || level === "route")) out.add(psp);
  if (bank && bank !== "*" && (level === "bank" || level === "route")) out.add(bank);
  return out;
}

/** Number of status-check particles for a checks/s rate: sqrt keeps 38/s and 372/s visibly different. */
export function checkParticles(rate: number | null | undefined, cap = 220): number {
  if (rate == null || !Number.isFinite(rate) || rate <= 0) return 0;
  return Math.min(cap, Math.round(4 * Math.sqrt(rate)));
}

function lastFinite(v: number[] | undefined): number | null {
  if (!v) return null;
  for (let i = v.length - 1; i >= 0; i--) if (Number.isFinite(v[i])) return v[i];
  return null;
}

export function deriveVisual(tick: SegmentState | undefined, checks: number[] | undefined, ledgerEvents: number): SceneVisual {
  const seg = new Map((tick?.segments ?? []).map((s) => [s.segment_id, s]));
  const routes: RouteVisual[] = [];
  for (const psp of PSPS) {
    for (const bank of BANKS) {
      const id = `route:${psp}:${bank}`;
      const score = clamp01(seg.get(id)?.d3_score ?? 0);
      routes.push({ id, psp, bank, score, colour: scoreColour(score), speed: 1 - 0.65 * score });
    }
  }
  const primary = tick?.localization.primary_segment_id ?? null;
  return {
    routes, hot: hotNodes(primary), primary,
    globalState: tick?.global_state ?? "IDLE",
    verdict: tick?.localization.verdict ?? "—",
    checksPerS: lastFinite(checks), ledgerEvents,
  };
}
