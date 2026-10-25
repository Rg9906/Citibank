// Pending recommendation with approve / reject (docs/M5_CONSOLE.md §3, §5). Blocked actions show a lock and can
// never be ticked (U-4). Buttons are disabled until M4 answers.
import { useEffect, useRef, useState } from "react";
import { config } from "../config";
import { postDecision } from "../connect";
import type { Decision } from "../contracts";
import { useQs } from "../store";
import { TEXT } from "../text/claims";
import { buildDecision, selectable, toggle } from "./decisionLogic";
import { keyCommand } from "./viewLogic";

export function RecommendationCard() {
  const recs = useQs((s) => s.recs);
  const source = useQs((s) => s.sources.control);
  const addDecision = useQs((s) => s.addDecision);
  const rec = Object.values(recs).filter((r) => r.status === "PENDING").sort((a, b) => b.created_sim_ms - a.created_sim_ms)[0];
  const [selected, setSelected] = useState<string[]>([]);
  const [operator, setOperator] = useState<string>(config.operators[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const decideRef = useRef<(k: Decision["decision"]) => void>(() => {});
  useEffect(() => {                                  // M5-T02: A approve all · S approve selected · R reject
    const onKey = (e: KeyboardEvent) => {
      const cmd = keyCommand(e, selected.length > 0);
      if (cmd && rec && !busy) { e.preventDefault(); decideRef.current(cmd); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rec?.rec_id, selected, busy]);                  // eslint-disable-line react-hooks/exhaustive-deps
  if (!rec) return <section className="panel"><h3>Recommendation</h3><p className="muted">no pending recommendation</p></section>;

  const decide = async (kind: Decision["decision"]) => {
    setBusy(true);
    setError("");
    const d = buildDecision(rec, kind, selected, operator);
    const r = await postDecision(d).catch((e) => ({ ok: false, body: { detail: String(e) } }));
    setBusy(false);
    if (!r.ok) { setError((r.body as { detail?: string }).detail ?? "decision failed"); return; }
    const b = r.body as { status: string; action_ids: string[];
      ledger?: { decision_tx?: string | null; decision_id?: string; block_number?: number | null } };
    addDecision({ rec_id: rec.rec_id, decision_id: b.ledger?.decision_id, operator, decision: kind, action_ids: b.action_ids,
      status: b.status, ledger: { decision_tx: b.ledger?.decision_tx ?? null, block_number: b.ledger?.block_number ?? null } });
    useQs.getState().upsertRec({ ...rec, status: b.status as typeof rec.status });
    setSelected([]);
  };

  decideRef.current = decide;
  const isRollback = rec.actions.length === 1 && rec.actions[0].action_type === "ROLLBACK";

  return (
    <section className={`panel sev-${rec.severity.toLowerCase()}`}>
      <h3>{isRollback ? "ROLLBACK proposal" : rec.severity} · {rec.verdict} · {rec.segment_id} {source === "mock" && <span className="badge">MOCK</span>}</h3>
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
