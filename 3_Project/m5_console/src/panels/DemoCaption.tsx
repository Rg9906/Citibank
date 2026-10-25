// Guided demo caption (?demo=1 in replay mode, ROADMAP §4 enhancement): one sentence at a time, keyed to the replay
// clock. Text lives in text/claims.ts so the claims lint covers it.
import { TEXT } from "../text/claims";

export function DemoCaption({ rec, clockMs }: { rec: string; clockMs: number }) {
  const steps = TEXT.demo[rec] ?? [];
  const i = steps.reduce((k, [at], j) => (clockMs >= at ? j : k), -1);
  if (i < 0) return null;
  return (
    <div className="caption" role="status" aria-live="polite">
      <span key={i} className="caption-text">{steps[i][1]}</span>
      <span className="caption-tag">{TEXT.splitReplayLabel}</span>
    </div>
  );
}
