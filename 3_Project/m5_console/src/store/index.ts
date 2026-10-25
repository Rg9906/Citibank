// Zustand store (docs/M5_CONSOLE.md §4). Keeps only what panels need, in bounded rings. No business logic here:
// every number shown comes from a stream or a results file.
import { create } from "zustand";
import { config } from "../config";
import type { LedgerEvent, PaymentEvent, Recommendation, SegmentState } from "../contracts";

export type Source = "live" | "mock" | "offline" | "replay";

export interface DecisionRow {
  rec_id: string; decision_id?: string; operator?: string; decision?: string; action_ids: string[];
  status: string; decided_sim_ms?: number; ledger_tx?: string | null; ledger_block?: number | null;
}

/** M2 GET /v1/status (CONTRACTS §4.1). */
export interface SimStatus {
  run_id: string | null; scenario: string | null; seed: number | null; universe: string | null; sim_ms: number;
  speed: number; state: string; ledger_mode?: string; achieved_speed?: number | null;
  ledger?: { healthy: boolean; backlog: number; opened: number; resolved_events: number } | null;
}
/** M2 GET /v1/timeseries. */
export interface Timeseries {
  t: number[]; goodput: number[]; queue: Record<string, number[]>; switch_checks_per_s: number[]; unknown_open: number[];
}
/** M3 GET /v1/forecaster/grid. */
export interface ForecastGrid { version: string; delay_bins: number[]; orbit_bins: number[]; p: number[][]; contour_0_5: number[][] }

export interface QsState {
  sources: Record<"sim" | "detect" | "control" | "ledger", Source>;
  ticks: SegmentState[];
  recs: Record<string, Recommendation>;
  decisions: DecisionRow[];
  ledgerEvents: LedgerEvent[];
  lastPaymentEvents: PaymentEvent[];
  selectedSegment: string;
  seenIds: Set<string>;
  simStatus: SimStatus | null;
  timeseries: Timeseries | null;
  budgets: Record<string, number>;
  grid: ForecastGrid | null;
  onset: { sim_ms: number; label: string } | null;     // ground truth: set only by replay / arena, never live
  setSimStatus(s: SimStatus | null): void;
  setTimeseries(t: Timeseries | null): void;
  setBudget(psp: string, rate: number): void;
  setGrid(g: ForecastGrid | null): void;
  setOnset(o: QsState["onset"]): void;
  reset(): void;
  setSource(k: keyof QsState["sources"], s: Source): void;
  addTick(t: SegmentState): void;
  upsertRec(r: Recommendation): void;
  addDecision(d: DecisionRow): void;
  addLedgerEvent(e: LedgerEvent): void;
  select(segmentId: string): void;
}

function pushRing<T>(arr: T[], x: T, n: number): T[] {
  const out = arr.length >= n ? arr.slice(arr.length - n + 1) : arr.slice();
  out.push(x);
  return out;
}

export const useQs = create<QsState>((set, get) => ({
  sources: { sim: "offline", detect: "offline", control: "offline", ledger: "offline" },
  ticks: [],
  recs: {},
  decisions: [],
  ledgerEvents: [],
  lastPaymentEvents: [],
  selectedSegment: "platform:*:*",
  seenIds: new Set(),
  simStatus: null,
  timeseries: null,
  budgets: {},
  grid: null,
  onset: null,
  setSimStatus: (simStatus) => set({ simStatus }),
  setTimeseries: (timeseries) => set({ timeseries }),
  setBudget: (psp, rate) => set((st) => ({ budgets: { ...st.budgets, [psp]: rate } })),
  setGrid: (grid) => set({ grid }),
  setOnset: (onset) => set({ onset }),
  reset: () => {
    get().seenIds.clear();
    set({ ticks: [], recs: {}, decisions: [], ledgerEvents: [], lastPaymentEvents: [], timeseries: null, budgets: {},
      onset: null, simStatus: null });
  },
  setSource: (k, s) => set((st) => ({ sources: { ...st.sources, [k]: s } })),
  addTick: (t) => {
    const key = `tick:${t.run_id}:${t.tick_sim_ms}`;
    if (get().seenIds.has(key)) return;                     // U-5: replayed messages never duplicate rows
    get().seenIds.add(key);
    set((st) => ({ ticks: pushRing(st.ticks, t, config.ring.ticks) }));
  },
  upsertRec: (r) => set((st) => ({ recs: { ...st.recs, [r.rec_id]: r } })),
  addDecision: (d) => set((st) => {
    // M4 re-publishes a decision when its ledger proof arrives: merge, never lose fields already shown
    const old = st.decisions.find((x) => x.rec_id === d.rec_id);
    const rest = st.decisions.filter((x) => x.rec_id !== d.rec_id);
    const known = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined && v !== null));
    const merged = { ...old, ...known } as DecisionRow;
    return { decisions: [merged, ...rest] };
  }),
  addLedgerEvent: (e) => {
    if (get().seenIds.has(e.event_id)) return;
    get().seenIds.add(e.event_id);
    set((st) => {
      const decisions = e.name === "DecisionRecorded"
        ? st.decisions.map((d) => d.decision_id === (e.payload as { id?: string }).id
          ? { ...d, ledger_tx: e.tx_id, ledger_block: e.block_number } : d)
        : st.decisions;
      return { ledgerEvents: pushRing(st.ledgerEvents, e, config.ring.ledgerEvents), decisions };
    });
  },
  select: (segmentId) => set({ selectedSegment: segmentId }),
}));
