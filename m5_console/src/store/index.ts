// Zustand store (docs/M5_CONSOLE.md §4). Keeps only what panels need, in bounded rings. No business logic here:
// every number shown comes from a stream or a results file.
import { create } from "zustand";
import { config } from "../config";
import type { LedgerEvent, PaymentEvent, Recommendation, SegmentState } from "../contracts";
import type { Budget, SimStatus } from "../panels/viewLogic";

export type Source = "live" | "mock" | "offline";

export interface DecisionRow {
  rec_id: string; decision_id?: string; operator?: string; decision?: string; action_ids: string[];
  status: string; decided_sim_ms?: number; ledger_tx?: string | null; ledger_block?: number | null;
}

/** `event: decision` from M4 comes in two shapes: the decision itself, and later a ledger update
 *  `{rec_id, decision_id, ledger:{decision_tx, block_number, advisory_txs, pending}}` (M4-T01). */
export interface DecisionMsg {
  rec_id: string; decision_id?: string; operator?: string; decision?: string; action_ids?: string[]; status?: string;
  decided_sim_ms?: number;
  ledger?: { decision_tx?: string | null; block_number?: number | null; advisory_txs?: string[]; pending?: boolean };
}

export function mergeDecision(old: DecisionRow | undefined, m: DecisionMsg): DecisionRow {
  const keep = <T,>(a: T | undefined, b: T | undefined) => (a !== undefined && a !== null ? a : b);
  return {
    rec_id: m.rec_id,
    decision_id: keep(m.decision_id, old?.decision_id),
    operator: keep(m.operator, old?.operator),
    decision: keep(m.decision, old?.decision),
    action_ids: m.action_ids ?? old?.action_ids ?? [],
    status: m.status ?? old?.status ?? "",
    decided_sim_ms: keep(m.decided_sim_ms, old?.decided_sim_ms),
    ledger_tx: keep(m.ledger?.decision_tx, old?.ledger_tx) ?? null,
    ledger_block: keep(m.ledger?.block_number, old?.ledger_block) ?? null,
  };
}

export type Mode = "live" | "replay";

export interface QsState {
  sources: Record<"sim" | "detect" | "control" | "ledger", Source>;
  ticks: SegmentState[];
  recs: Record<string, Recommendation>;
  decisions: DecisionRow[];
  ledgerEvents: LedgerEvent[];
  lastPaymentEvents: PaymentEvent[];
  selectedSegment: string;
  seenIds: Set<string>;
  budgets: Record<string, Budget>;
  simStatus: SimStatus | null;
  health: Record<string, "ok" | "degraded" | "offline">;
  mode: Mode;
  replayClockMs: number | null;
  onsetMs: number | null;                                   // ground truth: replay/arena only, never live
  setBudget(b: Budget): void;
  setSimStatus(s: SimStatus | null): void;
  setHealth(k: string, h: "ok" | "degraded" | "offline"): void;
  setMode(m: Mode, onsetMs?: number | null): void;
  setReplayClock(ms: number): void;
  reset(): void;
  setSource(k: keyof QsState["sources"], s: Source): void;
  addTick(t: SegmentState): void;
  upsertRec(r: Recommendation): void;
  addDecision(d: DecisionMsg | DecisionRow): void;
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
  budgets: {},
  simStatus: null,
  health: {},
  mode: "live",
  replayClockMs: null,
  onsetMs: null,
  setBudget: (b) => set((st) => ({ budgets: { ...st.budgets, [b.psp]: b } })),
  setSimStatus: (simStatus) => set({ simStatus }),
  setHealth: (k, h) => set((st) => (st.health[k] === h ? st : { health: { ...st.health, [k]: h } })),
  setMode: (mode, onsetMs = null) => set({ mode, onsetMs: mode === "replay" ? onsetMs : null }),
  setReplayClock: (replayClockMs) => set({ replayClockMs }),
  reset: () => set({ ticks: [], recs: {}, decisions: [], ledgerEvents: [], lastPaymentEvents: [], budgets: {},
    seenIds: new Set(), replayClockMs: null }),
  setSource: (k, s) => set((st) => ({ sources: { ...st.sources, [k]: s } })),
  addTick: (t) => {
    const key = `tick:${t.run_id}:${t.tick_sim_ms}`;
    if (get().seenIds.has(key)) return;                     // U-5: replayed messages never duplicate rows
    get().seenIds.add(key);
    set((st) => ({ ticks: pushRing(st.ticks, t, config.ring.ticks) }));
  },
  upsertRec: (r) => set((st) => ({ recs: { ...st.recs, [r.rec_id]: r } })),
  addDecision: (d) => set((st) => {
    const msg: DecisionMsg = "ledger_tx" in d || "ledger_block" in d
      ? { ...(d as DecisionRow), ledger: { decision_tx: (d as DecisionRow).ledger_tx, block_number: (d as DecisionRow).ledger_block } }
      : (d as DecisionMsg);
    const old = st.decisions.find((x) => x.rec_id === msg.rec_id);
    const row = mergeDecision(old, msg);
    return { decisions: old ? st.decisions.map((x) => (x.rec_id === row.rec_id ? row : x)) : [row, ...st.decisions] };
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
