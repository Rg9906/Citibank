// Wires streams to the store, with MOCK fallback from contracts/fixtures when a service is unreachable
// (docs/M5_CONSOLE.md §4). A panel never mixes mock and live data: each source has one badge.
// Live streams and replays go through the same `dispatch`, so a replay ends in exactly the state the live run had.
import { config } from "./config";
import type { Decision, LedgerEvent, Recommendation, SegmentState } from "./contracts";
import type { Budget, SimStatus } from "./panels/viewLogic";
import { useQs, type DecisionMsg } from "./store";
import { openStream } from "./streams/sse";
import { parseRecording, replay, type RecLine, type ReplayHandle } from "./streams/replay";
import recommendationFx from "../../contracts/fixtures/recommendation.json";
import ledgerEventsFx from "../../contracts/fixtures/ledger_events.jsonl?raw";

const s = () => useQs.getState();

/** Route one message (live or replayed) into the store. Unknown streams/events are ignored, never crash. */
export function dispatch(l: RecLine): void {
  const ev = l.event;
  if (l.stream === "detect" && (ev === undefined || ev === "tick")) s().addTick(l.data as SegmentState);
  else if (l.stream === "control" && ev === "recommendation") s().upsertRec(l.data as Recommendation);
  else if (l.stream === "control" && ev === "decision") s().addDecision(l.data as DecisionMsg);
  else if (l.stream === "control" && ev === "budget") s().setBudget(l.data as Budget);
  else if (l.stream === "ledger" && (ev === undefined || ev === "ledger_event")) s().addLedgerEvent(l.data as LedgerEvent);
}

export function loadMockFixtures(): void {
  s().upsertRec(recommendationFx as unknown as Recommendation);
  for (const line of ledgerEventsFx.split("\n").filter(Boolean)) s().addLedgerEvent(JSON.parse(line) as LedgerEvent);
  s().setSource("control", "mock");
  s().setSource("ledger", "mock");
}

/** Header: poll M2 /v1/status every second and every module's /v1/health (M5-T01). */
function startPolling(): () => void {
  let alive = true;
  const get = (url: string) => fetch(url, { signal: AbortSignal.timeout(2000) }).then((r) => (r.ok ? r.json() : null));
  const status = () => get(`${config.simUrl}/v1/status`).then((x) => alive && s().setSimStatus(x as SimStatus | null))
    .catch(() => alive && s().setSimStatus(null));
  const services: [string, string][] = [["sim", config.simUrl], ["detect", config.detectUrl], ["control", config.controlUrl],
    ["ledger", config.ledgerUrl]];
  const health = () => services.forEach(([k, url]) => get(`${url}/v1/health`)
    .then((h) => alive && s().setHealth(k, (h as { status?: string } | null)?.status === "ok" ? "ok" : h ? "degraded" : "offline"))
    .catch(() => alive && s().setHealth(k, "offline")));
  status(); health();
  const t1 = setInterval(status, config.statusPollMs);
  const t2 = setInterval(health, config.healthPollMs);
  return () => { alive = false; clearInterval(t1); clearInterval(t2); };
}

export function connectAll(): () => void {
  const handles = [
    openStream(`${config.detectUrl}/v1/stream`, ["tick"], (e, d) => dispatch({ stream: "detect", sim_ms: 0, event: e, data: d }),
      (st) => s().setSource("detect", st === "live" ? "live" : "offline")),
    openStream(`${config.controlUrl}/v1/stream`, ["recommendation", "decision", "budget"],
      (e, d) => dispatch({ stream: "control", sim_ms: 0, event: e, data: d }),
      (st) => s().setSource("control", st === "live" ? "live" : s().sources.control === "mock" ? "mock" : "offline")),
    openStream(`${config.ledgerUrl}/v1/stream`, ["ledger_event"], (e, d) => dispatch({ stream: "ledger", sim_ms: 0, event: e, data: d }),
      (st) => s().setSource("ledger", st === "live" ? "live" : s().sources.ledger === "mock" ? "mock" : "offline")),
  ];
  const stopPolling = startPolling();
  // if control is unreachable at start, show the fixture recommendation with a MOCK badge
  const t = setTimeout(() => { if (s().sources.control === "offline") loadMockFixtures(); }, 3000);
  return () => { clearTimeout(t); stopPolling(); handles.forEach((h) => h.close()); };
}

/** ?mode=replay: load data/recordings/<name>.jsonl (served by the dev server at /recordings/) and replay it. */
export async function startReplay(name: string, speed: number): Promise<{ handle: ReplayHandle | null; error?: string }> {
  s().reset();
  s().setMode("replay");
  const r = await fetch(`${config.recordingsUrl}/${encodeURIComponent(name)}.jsonl`).catch(() => null);
  if (!r || !r.ok) return { handle: null, error: `recording ${name} not found` };
  const { lines } = parseRecording(await r.text());
  for (const k of ["sim", "detect", "control", "ledger"] as const) s().setSource(k, "mock");
  return { handle: replay(lines, speed, dispatch, (ms) => s().setReplayClock(ms)) };
}

export async function fetchRecording(name: string): Promise<RecLine[] | null> {
  const r = await fetch(`${config.recordingsUrl}/${encodeURIComponent(name)}.jsonl`).catch(() => null);
  return r && r.ok ? parseRecording(await r.text()).lines : null;
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
