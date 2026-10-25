// The panels that were placeholders until 2026-10-23 (docs/M5_CONSOLE.md §3). Each one only shows what a module
// published; when the source is missing it says so instead of drawing zeros.
import { useEffect, useMemo, useState } from "react";
import { config } from "../config";
import { fetchRecording } from "../connect";
import type { RunResult } from "../contracts";
import { useQs } from "../store";
import { stateAt, type RecLine } from "../streams/replay";
import { TEXT } from "../text/claims";
import { Chart } from "./Chart";
import {
  ARENA_METRICS, arenaTable, isGrid, isTimeseries, raceLanes, stripSeries, summedBudget, switchUtil, trails,
  type Grid, type Timeseries,
} from "./viewLogic";

const PSP_COLOURS: Record<string, string> = { P1: "#4ea1ff", P2: "#3ecf8e", P3: "#c084fc" };

function fmt(x: number | null | undefined, digits = 2): string {
  return x == null ? "—" : Number.isInteger(x) ? String(x) : x.toFixed(digits);
}

// ---------------------------------------------------------------- MetricStrip (M5-T03)
export function MetricStrip() {
  const ticks = useQs((s) => s.ticks);
  const seg = useQs((s) => s.selectedSegment);
  const series = useMemo(() => stripSeries(ticks.slice(-120), seg), [ticks, seg]);
  if (!ticks.length) return <section className="panel"><h3>Metrics</h3><p className="muted">{TEXT.waitingTicks}</p></section>;
  return (
    <section className="panel">
      <h3>Metrics <span className="muted">{seg}</span></h3>
      <div className="strip">
        {series.map((s) => (
          <div key={s.key} className={`spark ${s.hot[s.hot.length - 1] ? "hot" : ""}`}>
            <div className="small"><span className="muted">{s.label}</span> <strong>{fmt(s.last, 3)}</strong>
              {s.hot[s.hot.length - 1] && <span className="badge warn">|z| &gt; 2.5</span>}</div>
            <Chart data={[s.t, s.v]} series={[{ label: s.label, stroke: "#ffd400" }]} height={56} compact />
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- DetectorRace (M5-T04)
export function DetectorRace() {
  const ticks = useQs((s) => s.ticks);
  const tick = ticks[ticks.length - 1], first = ticks[0];
  const mode = useQs((s) => s.mode);
  const onset = useQs((s) => s.onsetMs);
  const lanes = useMemo(() => raceLanes(ticks, mode === "replay" ? onset : null), [ticks, mode, onset]);  // ground truth never live
  const t0 = first?.tick_sim_ms ?? 0, t1 = Math.max(t0 + 1, tick?.tick_sim_ms ?? 1);
  const W = 640, x = (ms: number) => 60 + ((ms - t0) / (t1 - t0)) * (W - 80);
  return (
    <section className="panel">
      <h3>Detector race <span className="muted small">{mode === "replay" && onset != null ? TEXT.onsetKnown : TEXT.onsetUnknown}</span></h3>
      <svg width={W} height={lanes.length * 26 + 10} viewBox={`0 0 ${W} ${lanes.length * 26 + 10}`} className="fixed" role="img" aria-label="detector race">
        {mode === "replay" && onset != null && onset >= t0 && (
          <line x1={x(onset)} x2={x(onset)} y1={0} y2={lanes.length * 26} stroke="#f31260" strokeDasharray="4 3" />)}
        {lanes.map((l, i) => (
          <g key={l.detector} transform={`translate(0 ${i * 26 + 4})`}>
            <text x={8} y={15}>{l.detector}</text>
            <line x1={60} x2={W - 20} y1={11} y2={11} stroke="#262b36" strokeWidth={8} />
            {l.first_ms != null && <>
              <circle cx={x(l.first_ms)} cy={11} r={7} fill={l.detector === "D3" ? "#ffd400" : "#8a93a3"} />
              <text x={x(l.first_ms) > W - 200 ? x(l.first_ms) - 12 : x(l.first_ms) + 12} y={15} className="small"
                textAnchor={x(l.first_ms) > W - 200 ? "end" : "start"}>
                {`t=${Math.round(l.first_ms / 1000)}s ${l.segment}${l.delay_s != null ? ` (+${l.delay_s}s)` : ""}`}</text>
            </>}
            {l.first_ms == null && <text x={70} y={15} className="small">no alert</text>}
          </g>
        ))}
      </svg>
    </section>
  );
}

// ---------------------------------------------------------------- CascadeMap (M5-T04)
export function CascadeMap() {
  const ticks = useQs((s) => s.ticks);
  const [grid, setGrid] = useState<Grid | null>(null);
  const [gridState, setGridState] = useState<"loading" | "ok" | "missing">("loading");
  useEffect(() => {
    let alive = true;
    fetch(`${config.detectUrl}/v1/forecaster/grid`).then((r) => (r.ok ? r.json() : null))
      .then((g) => { if (!alive) return; if (isGrid(g)) { setGrid(g); setGridState("ok"); } else setGridState("missing"); })
      .catch(() => alive && setGridState("missing"));
    return () => { alive = false; };
  }, []);
  const tr = useMemo(() => trails(ticks, config.trailWindowS), [ticks]);
  const dMax = grid ? grid.delay_bins[grid.delay_bins.length - 1] : 2, oMax = grid ? grid.orbit_bins[grid.orbit_bins.length - 1] : 3;
  const W = 440, H = 300, px = (d: number) => 30 + (Math.min(d, dMax) / dMax) * (W - 40), py = (o: number) => H - 25 - (Math.min(o, oMax) / oMax) * (H - 35);
  const last = ticks[ticks.length - 1];
  const countdowns = last?.segments.filter((s) => s.segment_id.startsWith("psp:") && s.countdown_s_estimate != null) ?? [];
  return (
    <section className="panel">
      <h3>Cascade map <span className="muted small">{gridState === "ok" ? TEXT.contourLabel : TEXT.gridMissing}</span></h3>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="fixed" role="img" aria-label="cascade map">
        {grid && grid.p.map((row, i) => row.map((p, j) => (
          <rect key={`${i}-${j}`} x={px(grid.delay_bins[i])} y={py(grid.orbit_bins[j + 1])}
            width={px(grid.delay_bins[i + 1]) - px(grid.delay_bins[i])} height={py(grid.orbit_bins[j]) - py(grid.orbit_bins[j + 1])}
            fill={`rgba(243, 18, 96, ${(p * 0.6).toFixed(3)})`} />)))}
        {grid && grid.contour_0_5.length > 1 && (
          <polyline fill="none" stroke="#ffd400" strokeWidth={2} strokeDasharray="5 3"
            points={grid.contour_0_5.map(([d, o]) => `${px(d)},${py(o)}`).join(" ")} />)}
        <line x1={30} y1={H - 25} x2={W - 10} y2={H - 25} stroke="#39404f" />
        <line x1={30} y1={10} x2={30} y2={H - 25} stroke="#39404f" />
        <text x={W - 10} y={H - 8} textAnchor="end">delay / timeout</text>
        <text x={4} y={12}>orbit</text>
        {Object.entries(tr).map(([p, pts]) => pts.length > 0 && (
          <g key={p}>
            <polyline fill="none" stroke={PSP_COLOURS[p]} strokeWidth={1.5} points={pts.map((q) => `${px(q.delay)},${py(q.orbit)}`).join(" ")} />
            <circle cx={px(pts[pts.length - 1].delay)} cy={py(pts[pts.length - 1].orbit)} r={4} fill={PSP_COLOURS[p]} />
            <text x={px(pts[pts.length - 1].delay) + 6} y={py(pts[pts.length - 1].orbit) - 4} fill={PSP_COLOURS[p]}>{p}</text>
          </g>))}
      </svg>
      {countdowns.map((s) => <p key={s.segment_id} className="small">{s.segment_id}: ~{fmt(s.countdown_s_estimate, 0)} s ({TEXT.countdownCaveat})</p>)}
    </section>
  );
}

// ---------------------------------------------------------------- VerificationPanel (M5-T03)
export function VerificationPanel() {
  const budgets = useQs((s) => s.budgets);
  const tick = useQs((s) => s.ticks[s.ticks.length - 1]);
  const runId = useQs((s) => s.simStatus?.run_id ?? s.ticks[s.ticks.length - 1]?.run_id ?? null);
  const [ts, setTs] = useState<Timeseries | null>(null);
  useEffect(() => {
    if (!runId) return;
    let alive = true;
    const poll = () => fetch(`${config.simUrl}/v1/timeseries?run_id=${encodeURIComponent(runId)}`).then((r) => (r.ok ? r.json() : null))
      .then((x) => alive && setTs(isTimeseries(x) ? x : null)).catch(() => alive && setTs(null));
    poll();
    const t = setInterval(poll, config.timeseriesPollMs);
    return () => { alive = false; clearInterval(t); };
  }, [runId]);
  const budget = summedBudget(budgets);
  const util = switchUtil(tick);
  const data = ts ? [ts.t, ts.switch_checks_per_s, ts.t.map(() => budget)] : null;
  return (
    <section className="panel">
      <h3>Verification <span className="badge">{TEXT.simulationLabel}</span></h3>
      <p className="small">switch utilisation {fmt(util)} <span className="muted">(knee {config.switchKnee})</span>
        {util != null && util >= config.switchKnee && <span className="badge warn">above knee</span>}
        {" · "}summed check budget {budget == null ? "—" : `${budget}/s`}</p>
      {data ? <>
        <Chart data={data} height={110} series={[{ label: "switch checks/s", stroke: "#4ea1ff" }, { label: "budget/s", stroke: "#ffd400", dash: [5, 3] }]} />
        <Chart data={[ts!.t, ts!.unknown_open]} height={80} series={[{ label: "unknown open", stroke: "#f5a524" }]} />
      </> : <p className="muted">{TEXT.timeseriesMissing}</p>}
    </section>
  );
}

// ---------------------------------------------------------------- Arena (M5-T06)
export function ArenaTab() {
  const [rows, setRows] = useState<ReturnType<typeof arenaTable> | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    fetch(`${config.simUrl}/v1/results`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(async (list: { run_id: string }[]) => {
        const full = await Promise.all(list.map((x) => fetch(`${config.simUrl}/v1/results/${encodeURIComponent(x.run_id)}`)
          .then((r) => (r.ok ? r.json() : null)).catch(() => null)));
        setRows(arenaTable(full.filter(Boolean) as RunResult[]));
      }).catch((e) => setErr(String(e)));
  }, []);
  return (
    <section className="panel">
      <h3>Arena <span className="badge">{TEXT.arenaLabel}</span></h3>
      <p className="muted small">{TEXT.arenaNote}</p>
      {err && <p className="muted">{TEXT.simulatorOffline}</p>}
      {rows && rows.length === 0 && <p className="muted">{TEXT.noResults}</p>}
      {rows && rows.length > 0 && (
        <table>
          <thead><tr><th>scenario</th><th>universe</th><th>runs</th>{ARENA_METRICS.map((m) => <th key={m}>{m} (median)</th>)}</tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={`${r.scenario}${r.universe}`} className={r.runs === 0 ? "muted" : ""}>
              <td>{r.scenario}</td><td>{r.universe}</td><td>{r.runs}</td>
              {ARENA_METRICS.map((m) => <td key={m}>{fmt(r.medians[m])}</td>)}
            </tr>))}</tbody>
        </table>)}
    </section>
  );
}

// ---------------------------------------------------------------- April-2025 split replay (M5-T06)
export function SplitReplay() {
  const q = new URLSearchParams(window.location.search);
  const names = [q.get("left") ?? "s6-u0", q.get("right") ?? "s6-u4"];
  const [recs, setRecs] = useState<(RecLine[] | null)[]>([null, null]);
  const [clock, setClock] = useState(0);
  const [playing, setPlaying] = useState(false);
  useEffect(() => { Promise.all(names.map(fetchRecording)).then(setRecs); }, [names[0], names[1]]);  // eslint-disable-line
  const end = Math.max(0, ...recs.flatMap((r) => (r?.length ? [r[r.length - 1].sim_ms] : [])));
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => setClock((c) => (c >= end ? (setPlaying(false), c) : Math.min(end, c + 1000 * 4))), 250);
    return () => clearInterval(t);
  }, [playing, end]);
  return (
    <section className="panel">
      <h3>April-2025 split replay <span className="badge">{TEXT.splitReplayLabel}</span></h3>
      <div className="row">
        <button onClick={() => setPlaying(!playing)} disabled={!end}>{playing ? "pause" : "play 4×"}</button>
        <input type="range" min={0} max={end} step={1000} value={clock} onChange={(e) => setClock(Number(e.target.value))} disabled={!end} />
        <span className="small">t={Math.round(clock / 1000)}s</span>
      </div>
      <div className="split">
        {recs.map((r, i) => {
          const st = r ? stateAt(r, clock) : null;
          return (
            <div key={names[i]} className="panel inner">
              <h4>{names[i]}</h4>
              {!r && <p className="muted">{TEXT.recordingMissing}</p>}
              {st && <>
                <p><span className={`pill ${st.global_state}`}>{st.global_state}</span> {st.verdict ?? ""} {st.primary ?? ""}</p>
                <p className="small">recommendations {st.recommendations} · decisions {st.decisions} · advisories {st.advisories}</p>
              </>}
            </div>);
        })}
      </div>
    </section>
  );
}

export function About() {
  return (
    <section className="panel">
      <h3>About & claims</h3>
      <ul>{TEXT.about.map((t) => <li key={t}>{t}</li>)}</ul>
      <p className="muted small">{TEXT.keyboardHelp}</p>
    </section>
  );
}
