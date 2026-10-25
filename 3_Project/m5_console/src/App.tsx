// One screen, four tabs (docs/M5_CONSOLE.md §2). Live: left 60 % network hero + detection, right 40 % decisions + ledger.
import { useEffect, useState } from "react";
import { config } from "./config";
import { connectAll, startScenario } from "./connect";
import { loadRecording, replayParams, startReplay } from "./streams/replay";
import { HeatMap } from "./panels/HeatMap";
import { DecisionLog, DrunixPanel } from "./panels/LedgerPanels";
import { CascadeMap, DetectorRace, MetricStrip, VerificationPanel } from "./panels/Charts";
import { DemoCaption } from "./panels/DemoCaption";
import { NetworkScene } from "./panels/NetworkScene";
import { About } from "./panels/Placeholders";
import { ArenaTab, SplitReplay } from "./panels/Replays";
import { RecommendationCard } from "./panels/RecommendationCard";
import { useQs } from "./store";
import { TEXT } from "./text/claims";

type Tab = "live" | "arena" | "split" | "about";

function Header() {
  const tick = useQs((s) => s.ticks[s.ticks.length - 1]);
  const sources = useQs((s) => s.sources);
  const st = useQs((s) => s.simStatus);
  const run = st?.run_id
    ? `${st.scenario} · seed ${st.seed} · ${st.universe} · t=${Math.round(st.sim_ms / 1000)}s · ${st.speed}×${st.achieved_speed ? ` (achieved ${st.achieved_speed}×)` : ""} · ${st.state}`
    : tick ? `${tick.run_id} · t=${Math.round(tick.tick_sim_ms / 1000)}s` : "no run";
  const state = tick?.global_state ?? "IDLE";
  return (
    <header className={`topbar state-${state}`}>
      <div className="brand"><span className="logo" aria-hidden="true" />QueueShield<span className="muted small">× Drunix</span></div>
      <span className="run">{run}</span>
      <span className={`pill ${state}`}>{state}</span>
      <div className="row badges">
        {Object.entries(sources).map(([k, v]) => <span key={k} className={`badge ${v}`}>{k}: {v}</span>)}
        <span className="badge sim">{TEXT.simulationLabel}</span>
      </div>
    </header>
  );
}

function ScenarioBar() {
  const [busy, setBusy] = useState(false);
  return (
    <nav className="row scenarios">
      {config.scenarios.map((s) => (
        <button key={s.id} disabled={busy} onClick={async () => { setBusy(true); await startScenario(s.id, s.seed); setBusy(false); }}>
          {s.label}
        </button>
      ))}
    </nav>
  );
}

const REPLAY = replayParams(window.location.search);
const DEMO = new URLSearchParams(window.location.search).get("demo") === "1";

function useReplay(): { msg: string; clock: number } {
  const [msg, setMsg] = useState("");
  const [clock, setClock] = useState(0);
  useEffect(() => {
    if (!REPLAY) return;
    let stop = () => undefined as void;
    const s = useQs.getState();
    (["sim", "detect", "control", "ledger"] as const).forEach((k) => s.setSource(k, "replay"));
    loadRecording(REPLAY.rec).then((lines) => {
      stop = startReplay(lines, REPLAY.speed, undefined, (t, done) => {
        setClock(t);
        setMsg(`${TEXT.splitReplayLabel} · ${REPLAY.rec} · ${REPLAY.speed}× · t=${Math.round(t / 1000)}s${done ? " · end" : ""}`);
      });
    }).catch((e) => setMsg(String(e)));
    return () => stop();
  }, []);
  return { msg, clock };
}

export function App() {
  const [tab, setTab] = useState<Tab>("live");
  useEffect(() => (REPLAY ? undefined : connectAll()), []);
  const replay = useReplay();
  return (
    <div className="app">
      <Header />
      <div className="subbar">
        {REPLAY ? <div className="row"><span className="badge replay">REPLAY</span><span className="muted">{replay.msg}</span></div> : <ScenarioBar />}
        {DEMO && REPLAY && tab === "live" && <DemoCaption rec={REPLAY.rec} clockMs={replay.clock} />}
        <nav className="tabs">
          {(["live", "arena", "split", "about"] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>{t}</button>
          ))}
        </nav>
      </div>
      {tab === "live" && (
        <main className="grid">
          <div className="left">
            <NetworkScene />
            <MetricStrip />
            <div className="grid3">
              <HeatMap />
              <DetectorRace />
              <CascadeMap />
            </div>
          </div>
          <div className="right"><RecommendationCard /><DecisionLog /><DrunixPanel /><VerificationPanel /></div>
        </main>
      )}
      {tab === "arena" && <ArenaTab />}
      {tab === "split" && <SplitReplay />}
      {tab === "about" && <About />}
    </div>
  );
}
