// Wires streams to the store, with MOCK fallback from contracts/fixtures when a service is unreachable
// (docs/M5_CONSOLE.md §4). A panel never mixes mock and live data: each source has one badge.
import { config } from "./config";
import type { Decision, LedgerEvent, Recommendation, SegmentState } from "./contracts";
import { useQs, type DecisionRow, type ForecastGrid, type SimStatus, type Timeseries } from "./store";
import { openStream } from "./streams/sse";
import recommendationFx from "../../contracts/fixtures/recommendation.json";
import ledgerEventsFx from "../../contracts/fixtures/ledger_events.jsonl?raw";

const s = () => useQs.getState();

export function loadMockFixtures(): void {
  s().upsertRec(recommendationFx as unknown as Recommendation);
  for (const line of ledgerEventsFx.split("\n").filter(Boolean)) s().addLedgerEvent(JSON.parse(line) as LedgerEvent);
  s().setSource("control", "mock");
  s().setSource("ledger", "mock");
}

/** M4 `event: decision` (CONTRACTS §4.3 + M4-T01 ledger proof) -> a DecisionLog row. */
interface DecisionEvent {
  rec_id: string; decision_id?: string; operator?: string; decision?: string; action_ids?: string[]; status: string;
  decided_sim_ms?: number; ledger?: { decision_tx?: string | null; block_number?: number | null };
}
export function decisionRow(d: DecisionEvent): DecisionRow {
  return { rec_id: d.rec_id, decision_id: d.decision_id, operator: d.operator, decision: d.decision,
    action_ids: d.action_ids ?? [], status: d.status, decided_sim_ms: d.decided_sim_ms,
    ledger_tx: d.ledger?.decision_tx ?? null, ledger_block: d.ledger?.block_number ?? null };
}

export function connectAll(): () => void {
  const handles = [
    openStream(`${config.detectUrl}/v1/stream`, ["tick"], (_e, d) => s().addTick(d as SegmentState),
      (st) => s().setSource("detect", st === "live" ? "live" : "offline")),
    openStream(`${config.controlUrl}/v1/stream`, ["recommendation", "decision", "budget"], (e, d) => {
      if (e === "recommendation") s().upsertRec(d as Recommendation);
      else if (e === "budget") s().setBudget((d as { psp: string }).psp, (d as { rate_per_s: number }).rate_per_s);
      else s().addDecision(decisionRow(d as DecisionEvent));
    }, (st) => s().setSource("control", st === "live" ? "live" : s().sources.control === "mock" ? "mock" : "offline")),
    openStream(`${config.ledgerUrl}/v1/stream`, ["ledger_event"], (_e, d) => s().addLedgerEvent(d as LedgerEvent),
      (st) => s().setSource("ledger", st === "live" ? "live" : s().sources.ledger === "mock" ? "mock" : "offline")),
  ];
  // if control is unreachable at start, show the fixture recommendation with a MOCK badge
  const t = setTimeout(() => { if (s().sources.control === "offline") loadMockFixtures(); }, 3000);
  const stopPolls = startPolls();
  return () => { clearTimeout(t); stopPolls(); handles.forEach((h) => h.close()); };
}

export async function postDecision(d: Decision): Promise<{ ok: boolean; body: unknown }> {
  if (s().sources.control === "mock") {
    return { ok: true, body: { rec_id: d.rec_id, status: "APPROVED", action_ids: [], ledger: { decision_tx: null } } };
  }
  const r = await fetch(`${config.controlUrl}/v1/decisions`, {
    method: "POST", headers: { "content-type": "application/json", "x-qs-key": config.apiKey }, body: JSON.stringify(d),
  });
  return { ok: r.ok, body: await r.json() };
}

export async function startScenario(scenario: string, seed: number, universe = "U4", speed = 1): Promise<boolean> {
  const r = await fetch(`${config.simUrl}/v1/scenario`, {
    method: "POST", headers: { "content-type": "application/json", "x-qs-key": config.apiKey },
    body: JSON.stringify({ command: "START", scenario, seed, universe, speed }),
  }).catch(() => null);
  return !!r && r.ok;
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

/** M2 status + timeseries every second, M3's forecaster grid until it exists (then every minute). */
export function startPolls(): () => void {
  let stopped = false;
  const status = async () => {
    const st = await getJson<SimStatus>(`${config.simUrl}/v1/status`);
    if (stopped) return;
    s().setSimStatus(st);
    s().setSource("sim", st ? "live" : "offline");
    if (st?.run_id) {
      const ts = await getJson<Timeseries>(`${config.simUrl}/v1/timeseries?run_id=${encodeURIComponent(st.run_id)}`);
      if (!stopped && ts) s().setTimeseries(ts);
    }
  };
  const grid = async () => {
    const g = await getJson<ForecastGrid>(`${config.detectUrl}/v1/forecaster/grid`);
    if (!stopped && g) s().setGrid(g);
  };
  void status();
  void grid();
  const a = setInterval(status, config.statusPollMs);
  const b = setInterval(() => { if (!s().grid) void grid(); }, 10_000);
  const c = setInterval(grid, 60_000);
  return () => { stopped = true; clearInterval(a); clearInterval(b); clearInterval(c); };
}
