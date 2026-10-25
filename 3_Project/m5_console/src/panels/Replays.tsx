// Arena tab and the April-2025 split replay (M5-T06, docs/M5_CONSOLE.md §3). Finished simulation runs only:
// numbers come from M2's result.json / timeseries.json; ground-truth onset is allowed here (not in the live view).
import { useEffect, useMemo, useState } from "react";
import { config } from "../config";
import type { Timeseries } from "../store";
import { TEXT } from "../text/claims";
import { loadRecording, makeReplayer, type RecLine } from "../streams/replay";
import { medianBy, sparkPath, type RunSummary } from "./panelLogic";

const U_COLOURS: Record<string, string> = { U0: "#f31260", U1: "#f5a524", U2: "#c77dff", U3: "#4ea8de", U4: "#3ecf8e" };
const METRICS: { key: string; label: string; digits: number }[] = [
  { key: "goodput_min_frac", label: "worst goodput (× baseline)", digits: 2 },
  { key: "recovery_time_s", label: "recovery time (s)", digits: 0 },
  { key: "peak_queue", label: "peak queue", digits: 0 },
  { key: "peak_switch_checks_per_s", label: "peak switch checks/s", digits: 0 },
  { key: "switch_checks_per_unknown", label: "checks per unknown", digits: 2 },
  { key: "excess_retries", label: "excess retries", digits: 0 },
  { key: "median_resolve_s", label: "median time to resolve unknown (s)", digits: 1 },
  { key: "duplicate_commits", label: "duplicate commits", digits: 0 },
];

async function getJson<T>(url: string): Promise<T | null> {
  try { const r = await fetch(url); return r.ok ? ((await r.json()) as T) : null; } catch { return null; }
}

type SeriesKey = "goodput" | "switch_checks_per_s" | "unknown_open";

function Lines({ series, k, W = 420, H = 90, top }: { series: { u: string; ts: Timeseries }[]; k: SeriesKey; W?: number; H?: number; top?: number }) {
  const hi = top ?? Math.max(1, ...series.flatMap(({ ts }) => ts[k]));
  const len = Math.max(1, ...series.map(({ ts }) => ts.t.length));
  return (
    <svg width={W} height={H} role="img">
      {series.map(({ u, ts }, i) => (
        <path key={i} d={sparkPath(ts[k], (W * ts.t.length) / len, H - 2, 0, hi)} fill="none" stroke={U_COLOURS[u] ?? "#888"}
          strokeWidth={1.2} opacity={0.8} />
      ))}
    </svg>
  );
}

export function ArenaTab() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [src, setSrc] = useState("");
  const [scenario, setScenario] = useState("");
  const [series, setSeries] = useState<{ u: string; ts: Timeseries }[]>([]);
  useEffect(() => {
    void (async () => {
      const live = await getJson<RunSummary[]>(`${config.simUrl}/v1/results`);
      const r = live ?? (await getJson<RunSummary[]>("/runs/index.json")) ?? [];
      setSrc(live ? "M2 /v1/results" : "data/runs (M2 offline)");
      setRuns(r);
      const sc = [...new Set(r.map((x) => x.scenario))].sort();
      setScenario(sc.includes("S6") ? "S6" : sc[0] ?? "");
    })();
  }, []);
  const chosen = useMemo(() => (runs ?? []).filter((r) => r.scenario === scenario), [runs, scenario]);
  useEffect(() => {
    void Promise.all(chosen.map(async (r) => ({ u: r.universe, ts: await getJson<Timeseries>(`/runs/${r.run_id}/timeseries.json`) })))
      .then((xs) => setSeries(xs.filter((x): x is { u: string; ts: Timeseries } => !!x.ts)));
  }, [chosen]);
  if (runs === null) return <section className="panel"><h3>Arena</h3><p className="muted">loading results…</p></section>;
  const universes = [...new Set(chosen.map((r) => r.universe))].sort();
  const seeds = [...new Set(chosen.map((r) => r.seed))].length;
  const label = seeds >= 5 ? TEXT.arenaLabel : `${TEXT.simulationLabel}, ${seeds} seed${seeds === 1 ? "" : "s"}, preliminary`;
  return (
    <section className="panel">
      <h3>Arena <span className="badge">{label}</span> <span className="muted small">source: {src}</span></h3>
      <div className="row">
        {[...new Set(runs.map((x) => x.scenario))].sort().map((s) => (
          <button key={s} className={s === scenario ? "active" : ""} onClick={() => setScenario(s)}>{s}</button>
        ))}
      </div>
      {!chosen.length ? <p className="muted">no finished runs yet (M2 arena job or python -m qsim.batch)</p> : (
        <>
          {universes.includes("U4") && !universes.includes("U2") && <p className="danger small">U2 baseline missing for this scenario: add it before comparing U4.</p>}
          <div className="row small">{universes.map((u) => <span key={u} style={{ color: U_COLOURS[u] }}>■ {u}</span>)}</div>
          <div className="row">
            <div><div className="muted small">goodput /s</div><Lines series={series} k="goodput" /></div>
            <div><div className="muted small">switch status checks /s</div><Lines series={series} k="switch_checks_per_s" /></div>
            <div><div className="muted small">unknown payments open</div><Lines series={series} k="unknown_open" /></div>
          </div>
          <table>
            <thead><tr><td>median over seeds</td>{universes.map((u) => <td key={u} style={{ color: U_COLOURS[u] }}>{u}</td>)}</tr></thead>
            <tbody>
              {METRICS.map(({ key, label: l, digits }) => {
                const m = medianBy(chosen, key);
                return (
                  <tr key={key}><td>{l}</td>{universes.map((u) => (
                    <td key={u}>{m[u]?.median == null ? "—" : m[u].median!.toFixed(digits)}<span className="muted small"> (n={m[u]?.n ?? 0})</span></td>
                  ))}</tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}

function useRecording(name: string) {
  const [lines, setLines] = useState<RecLine[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { loadRecording(name).then(setLines).catch((e) => setError(String(e))); }, [name]);
  return { lines, error };
}

export function SplitReplay() {
  const left = useRecording(config.split.left);
  const right = useRecording(config.split.right);
  const [speed, setSpeed] = useState(4);
  const [t, setT] = useState(0);
  const [running, setRunning] = useState(false);
  const [views, setViews] = useState<Record<string, { ts: Timeseries | null; onset: number | null; meta: string }>>({});
  useEffect(() => {
    if (!running || !left.lines || !right.lines) return;
    const sides = { left: left.lines, right: right.lines };
    const state: Record<string, { ts: Timeseries | null; onset: number | null; meta: string }> = {};
    const players = Object.entries(sides).map(([side, lines]) => {
      state[side] = { ts: null, onset: null, meta: "" };
      return makeReplayer(lines, (l) => {
        if (l.stream === "timeseries") state[side].ts = l.data as Timeseries;
        if (l.stream === "onset") state[side].onset = (l.data as { sim_ms: number }).sim_ms;
        if (l.stream === "status") { const d = l.data as { universe?: string; scenario?: string; seed?: number }; state[side].meta = `${d.scenario} · seed ${d.seed} · ${d.universe}`; }
      });
    });
    const start = performance.now();
    const id = setInterval(() => {
      const clock = (performance.now() - start) * speed;           // one synchronised clock for both sides
      players.forEach((p) => p.advanceTo(clock));
      setT(clock);
      setViews({ ...state });
      if (players.every((p) => p.done)) { clearInterval(id); setRunning(false); }
    }, 100);
    return () => clearInterval(id);
  }, [running, left.lines, right.lines, speed]);
  const missing = [left, right].map((r, i) => (r.error ? `${i ? config.split.right : config.split.left}: missing` : "")).filter(Boolean);
  // both sides share one y-scale per chart, so the left storm and the right calm are directly comparable
  const shared = (k: SeriesKey) => Math.max(1, ...(["left", "right"] as const).flatMap((s) => views[s]?.ts?.[k] ?? []));
  return (
    <section className="panel">
      <h3>April-2025 split replay <span className="badge">{TEXT.splitReplayLabel}</span> <span className="muted small">left: no control · right: QueueShield · shared scale</span></h3>
      <div className="row">
        <button disabled={running || !left.lines || !right.lines} onClick={() => setRunning(true)}>▶ play</button>
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} disabled={running}>
          {[1, 2, 4, 8].map((s) => <option key={s} value={s}>{s}×</option>)}
        </select>
        <span>t = {Math.round(t / 1000)} s</span>
        {missing.length > 0 && <span className="danger small">{missing.join(", ")} (node scripts/rec_from_run.mjs &lt;run_id&gt; --name …)</span>}
      </div>
      <div className="grid2">
        {(["left", "right"] as const).map((side) => {
          const v = views[side];
          const ts = v?.ts;
          return (
            <div key={side} className="panel">
              <h3>{v?.meta || config.split[side]}</h3>
              {!ts ? <p className="muted">press play</p> : (
                <>
                  <div className="split-stat"><span className="muted small">switch status checks /s · peak</span>
                    <b className={side}>{Math.max(0, ...ts.switch_checks_per_s).toFixed(0)}</b></div>
                  <Lines series={[{ u: side === "left" ? "U0" : "U4", ts }]} k="switch_checks_per_s" W={820} H={150} top={shared("switch_checks_per_s")} />
                  <div className="split-stat"><span className="muted small">unknown payments open · now</span>
                    <b className={side}>{ts.unknown_open[ts.unknown_open.length - 1] ?? 0}</b></div>
                  <Lines series={[{ u: side === "left" ? "U0" : "U4", ts }]} k="unknown_open" W={820} H={110} top={shared("unknown_open")} />
                  <div className="muted small">goodput /s</div>
                  <Lines series={[{ u: side === "left" ? "U0" : "U4", ts }]} k="goodput" W={820} H={110} top={shared("goodput")} />
                  {v.onset != null && <div className="muted small">fault onset {Math.round(v.onset / 1000)} s (ground truth)</div>}
                </>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
