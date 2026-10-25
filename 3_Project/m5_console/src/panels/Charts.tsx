// MetricStrip, DetectorRace, CascadeMap, VerificationPanel (docs/M5_CONSOLE.md §3; M5-T03, M5-T04).
// Inline SVG instead of uPlot: four small charts do not need a charting dependency (see docs/DEVIATIONS.md).
import { useQs } from "../store";
import { TEXT } from "../text/claims";
import { DETECTORS, featureSeries, firstAlerts, lastFinite, sparkPath, trail } from "./panelLogic";

const PSP_COLOURS: Record<string, string> = { P1: "#4ea8de", P2: "#c77dff", P3: "#3ecf8e" };
const STRIP: { feature: string; label: string; fmt: (v: number) => string }[] = [
  { feature: "timeout_ratio", label: "timeout %", fmt: (v) => `${(100 * v).toFixed(1)}%` },
  { feature: "near_timeout_ratio", label: "near-timeout %", fmt: (v) => `${(100 * v).toFixed(1)}%` },
  { feature: "p95_ms", label: "p95", fmt: (v) => `${Math.round(v)} ms` },
  { feature: "raf", label: "RAF", fmt: (v) => v.toFixed(2) },
  { feature: "queue_depth", label: "queue", fmt: (v) => v.toFixed(0) },
];

function Spark({ values, w = 150, h = 34, colour = "#ffd400" }: { values: number[]; w?: number; h?: number; colour?: string }) {
  return (
    <svg width={w} height={h} role="img">
      <path d={sparkPath(values, w, h - 2)} fill="none" stroke={colour} strokeWidth={1.5} />
    </svg>
  );
}

export function MetricStrip() {
  const ticks = useQs((s) => s.ticks);
  const seg = useQs((s) => s.selectedSegment);
  const recent = ticks.slice(-60);
  return (
    <section className="panel">
      <h3>Metric strip <span className="muted small">{seg} · last {recent.length} ticks</span></h3>
      {!recent.length ? <p className="muted">waiting for detection ticks…</p> : (
        <div className="row">
          {STRIP.map(({ feature, label, fmt }) => {
            const v = featureSeries(recent, seg, feature);
            const last = lastFinite(v);
            return (
              <div key={feature} className="metric">
                <div className="muted small">{label}</div>
                <Spark values={v} />
                <div>{last == null ? "—" : fmt(last)}</div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function DetectorRace() {
  const ticks = useQs((s) => s.ticks);
  const onset = useQs((s) => s.onset);
  const first = firstAlerts(ticks);
  if (!ticks.length) return <section className="panel"><h3>Detector race</h3><p className="muted">waiting for detection ticks…</p></section>;
  const t0 = ticks[0].tick_sim_ms;
  const t1 = Math.max(ticks[ticks.length - 1].tick_sim_ms, t0 + 1);
  const W = 400, lane = 22, left = 40;
  const x = (ms: number) => left + ((ms - t0) / (t1 - t0)) * (W - left - 10);
  return (
    <section className="panel">
      <h3>Detector race <span className="muted small">{onset ? `onset ${Math.round(onset.sim_ms / 1000)} s (${onset.label})` : TEXT.onsetUnknown}</span></h3>
      <svg width={W} height={lane * 4 + 24} role="img" aria-label="detector race">
        {DETECTORS.map((d, i) => {
          const a = first[d];
          return (
            <g key={d}>
              <text x={4} y={16 + i * lane}>{d}</text>
              <line x1={left} x2={W - 10} y1={12 + i * lane} y2={12 + i * lane} stroke="#2a2f3a" />
              {a && a.sim_ms >= t0 && (
                <g>
                  <circle cx={x(a.sim_ms)} cy={12 + i * lane} r={6} fill={d === "D3" ? "#ffd400" : "#8a93a3"} />
                  <text x={x(a.sim_ms) + 9} y={16 + i * lane}>{`${Math.round(a.sim_ms / 1000)} s · ${a.segment_id}`}</text>
                </g>
              )}
            </g>
          );
        })}
        {onset && onset.sim_ms >= t0 && onset.sim_ms <= t1 && (
          <line x1={x(onset.sim_ms)} x2={x(onset.sim_ms)} y1={0} y2={lane * 4} stroke="#f31260" strokeDasharray="4 3" />
        )}
        <text x={left} y={lane * 4 + 18}>{`${Math.round(t0 / 1000)} s`}</text>
        <text x={W - 10} y={lane * 4 + 18} textAnchor="end">{`${Math.round(t1 / 1000)} s`}</text>
      </svg>
    </section>
  );
}

export function CascadeMap() {
  const ticks = useQs((s) => s.ticks);
  const grid = useQs((s) => s.grid);
  const W = 280, H = 200, pad = 34;
  const dMax = grid ? grid.delay_bins[grid.delay_bins.length - 1] : 1;
  const oMax = grid ? grid.orbit_bins[grid.orbit_bins.length - 1] : 1;
  const sx = (d: number) => pad + (Math.min(d, dMax) / dMax) * (W - pad - 8);
  const sy = (o: number) => H - pad - (Math.min(o, oMax) / oMax) * (H - pad - 8);
  const tick = ticks[ticks.length - 1];
  return (
    <section className="panel">
      <h3>Cascade map <span className="muted small">{grid ? TEXT.contourLabel : "forecaster grid not loaded: trails only"}</span></h3>
      <svg width={W} height={H} role="img" aria-label="cascade map">
        {grid && grid.p.map((row, i) => row.map((p, j) => (
          <rect key={`${i}-${j}`} x={sx(grid.delay_bins[i])} y={sy(grid.orbit_bins[j + 1])}
            width={sx(grid.delay_bins[i + 1]) - sx(grid.delay_bins[i])} height={sy(grid.orbit_bins[j]) - sy(grid.orbit_bins[j + 1])}
            fill={`rgba(243, 18, 96, ${0.08 + 0.6 * p})`} />
        )))}
        {grid && grid.contour_0_5.length > 1 && (
          <polyline points={grid.contour_0_5.map(([d, o]) => `${sx(d)},${sy(o)}`).join(" ")} fill="none" stroke="#fff" strokeDasharray="5 3" />
        )}
        {["P1", "P2", "P3"].map((p) => {
          const tr = trail(ticks, p);
          if (!tr.length) return null;
          const last = tr[tr.length - 1];
          return (
            <g key={p}>
              <polyline points={tr.map((q) => `${sx(q.x)},${sy(q.y)}`).join(" ")} fill="none" stroke={PSP_COLOURS[p]} strokeWidth={2} />
              <circle cx={sx(last.x)} cy={sy(last.y)} r={4} fill={PSP_COLOURS[p]} />
              <text x={sx(last.x) + 6} y={sy(last.y) - 4} style={{ fill: PSP_COLOURS[p] }}>{p}</text>
            </g>
          );
        })}
        <line x1={pad} x2={W - 8} y1={H - pad} y2={H - pad} stroke="#39404f" />
        <line x1={pad} x2={pad} y1={8} y2={H - pad} stroke="#39404f" />
        <text x={W / 2} y={H - 8} textAnchor="middle">queue delay / client timeout</text>
        <text x={10} y={H / 2} transform={`rotate(-90 10 ${H / 2})`} textAnchor="middle">retry orbit share</text>
      </svg>
      {tick && (
        <p className="muted small">
          {["P1", "P2", "P3"].map((p) => {
            const s = tick.segments.find((x) => x.segment_id === `psp:${p}:*`) as
              { p_stuck?: number | null; forecast_state?: string | null; countdown_s_estimate?: number | null } | undefined;
            return `${p}: ${s?.forecast_state ?? "—"}${s?.p_stuck != null ? ` p_stuck ${s.p_stuck.toFixed(2)}` : ""}${s?.countdown_s_estimate != null ? ` · ~${Math.round(s.countdown_s_estimate)} s (${TEXT.countdownCaveat})` : ""}`;
          }).join("  ·  ")}
        </p>
      )}
    </section>
  );
}

export function VerificationPanel() {
  const ts = useQs((s) => s.timeseries);
  const budgets = useQs((s) => s.budgets);
  const st = useQs((s) => s.simStatus);
  if (!ts || !ts.t.length) return <section className="panel"><h3>Verification</h3><p className="muted">waiting for simulator timeseries…</p></section>;
  const n = 180;
  const checks = ts.switch_checks_per_s.slice(-n);
  const unknown = ts.unknown_open.slice(-n);
  const budget = Object.values(budgets).reduce((a, b) => a + b, 0);
  const W = 360, H = 70;
  const hi = Math.max(budget, ...checks, 1);
  const by = H - (budget / hi) * (H - 2);
  return (
    <section className="panel">
      <h3>Verification <span className="muted small">{st?.universe ?? ""} · last {checks.length} s · {TEXT.simulationLabel}</span></h3>
      <div className="muted small">switch status checks/s {budget > 0 && <span>(dashed: summed check budget {budget.toFixed(1)}/s)</span>}</div>
      <svg width={W} height={H} role="img" aria-label="switch checks">
        <path d={sparkPath(checks, W, H - 2, 0, hi)} fill="none" stroke="#f5a524" strokeWidth={1.5} />
        {budget > 0 && <line x1={0} x2={W} y1={by} y2={by} stroke="#3ecf8e" strokeDasharray="4 3" />}
      </svg>
      <div>now {lastFinite(checks)?.toFixed(0) ?? "—"}/s · peak {Math.max(0, ...checks).toFixed(0)}/s</div>
      <div className="muted small" style={{ marginTop: 6 }}>unknown payments open</div>
      <Spark values={unknown} w={W} h={40} colour="#4ea8de" />
      <div>now {lastFinite(unknown) ?? "—"}{st?.ledger ? ` · ledger bridge: ${st.ledger.opened} opened, ${st.ledger.resolved_events} resolved, backlog ${st.ledger.backlog}${st.ledger.healthy ? "" : " (unhealthy)"}` : ""}</div>
    </section>
  );
}
