// One screen, four tabs (docs/M5_CONSOLE.md §2). Layout: left 60 % detection, right 40 % decisions + ledger.
import { useEffect, useState } from "react";
import { config } from "./config";
import { connectAll, startReplay, startScenario } from "./connect";
import { HeatMap } from "./panels/HeatMap";
import { DecisionLog, DrunixPanel } from "./panels/LedgerPanels";
import { About, ArenaTab, CascadeMap, DetectorRace, MetricStrip, SplitReplay, VerificationPanel } from "./panels/Panels";
import { statusLine } from "./panels/viewLogic";
import { replayParams } from "./streams/replay";
import { Boundary } from "./panels/Boundary";
import { RecommendationCard } from "./panels/RecommendationCard";
import { useQs } from "./store";
import { TEXT } from "./text/claims";

type Tab = "live" | "arena" | "split" | "about";

function Header() {
  const tick = useQs((s) => s.ticks[s.ticks.length - 1]);
  const sources = useQs((s) => s.sources);
  const health = useQs((s) => s.health);
  const status = useQs((s) => s.simStatus);
  const mode = useQs((s) => s.mode);
  const clock = useQs((s) => s.replayClockMs);
  return (
    <header>
      <strong>QueueShield</strong>
      {mode === "replay"
        ? <span className="badge mock">{TEXT.replayBanner}{clock != null ? ` · t=${Math.round(clock / 1000)}s` : ""}</span>
        : <span>{statusLine(status)}</span>}
      <span className="muted">{tick ? `${tick.run_id} · tick ${Math.round(tick.tick_sim_ms / 1000)}s` : "no ticks"}</span>
      <span className={`pill ${tick?.global_state ?? "idle"}`}>{tick?.global_state ?? "IDLE"}</span>
      {Object.entries(sources).map(([k, v]) => (
        <span key={k} className={`badge ${v}`} title={`health: ${health[k] ?? "unknown"}`}>
          {k}: {v}{health[k] === "degraded" ? " (degraded)" : ""}</span>))}
      <span className="badge">{TEXT.simulationLabel}</span>
    </header>
  );
}

function ScenarioBar() {
  const [busy, setBusy] = useState(false);
  return (
    <nav className="row">
      {config.scenarios.map((s) => (
        <button key={s.id} disabled={busy} onClick={async () => { setBusy(true); await startScenario(s.id, s.seed); setBusy(false); }}>
          {s.label}
        </button>
      ))}
    </nav>
  );
}

export function App() {
  const [tab, setTab] = useState<Tab>("live");
  const [replayError, setReplayError] = useState("");
  const mode = useQs((s) => s.mode);
  useEffect(() => {
    const rp = replayParams(window.location.search);
    if (!rp) return connectAll();
    let stop = () => {};
    startReplay(rp.name, rp.speed).then(({ handle, error }) => { if (handle) stop = () => handle.stop(); if (error) setReplayError(error); });
    return () => stop();
  }, []);
  return (
    <div className="app">
      <Header />
      {mode === "live" && <ScenarioBar />}
      {replayError && <p className="danger">{replayError}</p>}
      <nav className="tabs">
        {(["live", "arena", "split", "about"] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{t}</button>
        ))}
      </nav>
      {tab === "live" && (
        <main className="grid">
          <div className="left">
            <Boundary name="Heat map"><HeatMap /></Boundary><Boundary name="Metrics"><MetricStrip /></Boundary>
            <Boundary name="Detector race"><DetectorRace /></Boundary><Boundary name="Cascade map"><CascadeMap /></Boundary>
          </div>
          <div className="right">
            <Boundary name="Recommendation"><RecommendationCard /></Boundary><Boundary name="Decision log"><DecisionLog /></Boundary>
            <Boundary name="Drunix ledger"><DrunixPanel /></Boundary><Boundary name="Verification"><VerificationPanel /></Boundary>
          </div>
        </main>
      )}
      {tab === "arena" && <Boundary name="Arena"><ArenaTab /></Boundary>}
      {tab === "split" && <Boundary name="Split replay"><SplitReplay /></Boundary>}
      {tab === "about" && <About />}
    </div>
  );
}
