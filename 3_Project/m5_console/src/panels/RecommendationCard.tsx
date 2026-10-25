// Pending recommendation with approve / reject (docs/M5_CONSOLE.md §3, §5). Blocked actions show a lock and can
// never be ticked (U-4). Buttons are disabled until M4 answers.
import { useEffect, useRef, useState } from "react";
import { config } from "../config";
import { decisionRow, postDecision } from "../connect";
import type { Decision } from "../contracts";
import { useQs } from "../store";
import { TEXT } from "../text/claims";
import { buildDecision, keyToDecision, selectable, toggle } from "./decisionLogic";

export function RecommendationCard() {
  const recs = useQs((s) => s.recs);
  const source = useQs((s) => s.sources.control);
  const addDecision = useQs((s) => s.addDecision);
  const rec = Object.values(recs).filter((r) => r.status === "PENDING").sort((a, b) => b.created_sim_ms - a.created_sim_ms)[0];
  const [selected, setSelected] = useState<string[]>([]);
  const [operator, setOperator] = useState<string>(config.operators[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const keyRef = useRef<(k: Decision["decision"]) => void>(() => undefined);
  useEffect(() => {                                          // M5-T02: A approve all, S approve selected, R reject
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.ctrlKey || e.metaKey || e.altKey || (el && ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName))) return;
      const k = keyToDecision(e.key);
      if (k) keyRef.current(k);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
  if (!rec) return <section className="panel"><h3>Recommendation</h3><p className="muted">no pending recommendation</p></section>;

  const decide = async (kind: Decision["decision"]) => {
    setBusy(true);
    setError("");
    const d = buildDecision(rec, kind, selected, operator);
    const r = await postDecision(d).catch((e) => ({ ok: false, body: { detail: String(e) } }));
    setBusy(false);
    if (!r.ok) { setError((r.body as { detail?: string }).detail ?? "decision failed"); return; }
    const b = r.body as Parameters<typeof decisionRow>[0];
    addDecision(decisionRow({ ...b, rec_id: rec.rec_id, operator, decision: kind }));
    useQs.getState().upsertRec({ ...rec, status: b.status as typeof rec.status });
    setSelected([]);
  };

  keyRef.current = (k) => { if (!busy && (k !== "APPROVE_SELECTED" || selected.length)) void decide(k); };

  return (
    <section key={rec.rec_id} className={`panel rec-card sev-${rec.severity.toLowerCase()}`}>
      <h3>{rec.severity} · {rec.verdict} · {rec.segment_id} {source === "mock" && <span className="badge">MOCK</span>}</h3>
      <p>confidence {rec.confidence.toFixed(2)}
        {rec.p_stuck != null && <> · p_stuck {rec.p_stuck.toFixed(2)}</>}
        {rec.countdown_s_estimate != null && <> · countdown {rec.countdown_s_estimate}s ({TEXT.countdownCaveat})</>}
      </p>
      <p className="muted">{TEXT.reasonsCaveat}: {rec.reasons.map((r) => r.code).join(", ") || "none"}</p>
      <ul className="actions">
        {rec.actions.map((a) => (
          <li key={a.action_type + a.scope_segment_id} className={selectable(a) ? "" : "blocked"}>
            <label>
              <input type="checkbox" disabled={!selectable(a) || busy} checked={selected.includes(a.action_type)}
                onChange={() => setSelected(toggle(selected, a))} />
              {selectable(a) ? "" : "🔒 "}{a.action_type} <span className="muted">{a.scope_segment_id}</span>
            </label>
            <div className="muted small">{a.blocked_by ? <span className="danger">{a.blocked_by}</span> : a.side_effect}</div>
          </li>
        ))}
      </ul>
      <div className="row">
        <select value={operator} onChange={(e) => setOperator(e.target.value)} disabled={busy}>
          {config.operators.map((o) => <option key={o}>{o}</option>)}
        </select>
        <button disabled={busy} onClick={() => decide("APPROVE_ALL")}>Approve all <kbd>A</kbd></button>
        <button disabled={busy || !selected.length} onClick={() => decide("APPROVE_SELECTED")}>Approve selected <kbd>S</kbd></button>
        <button disabled={busy} onClick={() => decide("REJECT")}>Reject <kbd>R</kbd></button>
      </div>
      {error && <p className="danger">{error}</p>}
    </section>
  );
}
