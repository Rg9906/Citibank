// Replay of a recording (docs/M5_CONSOLE.md U-6; CONTRACTS §6 `data/recordings/<name>.jsonl`, one
// {"stream","sim_ms","data"} per line). The replay feeds the SAME store handlers as the live streams, ordered by
// sim_ms, so a 1× and a 4× replay end in the same panel state. Speed only changes the wall-clock pacing.

export type RecStream = "sim" | "detect" | "control" | "ledger";
export interface RecLine { stream: RecStream; sim_ms: number; event?: string; data: unknown }

const STREAMS = new Set(["sim", "detect", "control", "ledger"]);

/** Parse a .jsonl recording; malformed lines are counted and skipped, never crash. Stable sort by sim_ms. */
export function parseRecording(text: string): { lines: RecLine[]; rejected: number } {
  const lines: RecLine[] = [];
  let rejected = 0;
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const x = JSON.parse(raw) as RecLine;
      if (!STREAMS.has(x.stream) || typeof x.sim_ms !== "number" || x.data === undefined) { rejected++; continue; }
      lines.push(x);
    } catch { rejected++; }
  }
  lines.sort((a, b) => a.sim_ms - b.sim_ms);                 // Array.prototype.sort is stable (ES2019)
  return { lines, rejected };
}

export interface Scheduler { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void }

export interface ReplayHandle { stop(): void; done: Promise<void> }

/**
 * Deliver lines in sim-time order, `speed` sim-seconds per wall-second, batching lines that share a sim_ms.
 * `sink(line)` is the same dispatch the live connection uses. `onClock(sim_ms)` drives the header clock.
 */
export function replay(lines: RecLine[], speed: number, sink: (l: RecLine) => void,
  onClock: (simMs: number) => void = () => {},
  sched: Scheduler = { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h as number) }): ReplayHandle {
  let i = 0, stopped = false, handle: unknown = null, resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  const step = () => {
    if (stopped) return;
    if (i >= lines.length) { resolve(); return; }
    const t = lines[i].sim_ms;
    while (i < lines.length && lines[i].sim_ms === t) sink(lines[i++]);
    onClock(t);
    if (i >= lines.length) { resolve(); return; }
    handle = sched.setTimeout(step, Math.max(0, (lines[i].sim_ms - t) / Math.max(0.01, speed)));
  };
  step();
  return { stop() { stopped = true; if (handle != null) sched.clearTimeout(handle); resolve(); }, done };
}

/** ?mode=replay&rec=<name>&speed=1|2|4  ->  { name, speed } or null for live mode. */
export function replayParams(search: string): { name: string; speed: number } | null {
  const q = new URLSearchParams(search);
  if (q.get("mode") !== "replay" || !q.get("rec")) return null;
  const name = q.get("rec")!;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;          // a file name, never a path
  const speed = Number(q.get("speed") ?? "1");
  return { name, speed: [1, 2, 4].includes(speed) ? speed : 1 };
}

/** Summary of a recording at a sim time, for the split replay (latest tick state + decision/rec counts). */
export function stateAt(lines: RecLine[], simMs: number) {
  type TickLite = { global_state?: string; localization?: { verdict?: string; primary_segment_id?: string | null } };
  let tick: TickLite | null = null;
  const recs = new Set<string>(), decisions = new Set<string>();
  let advisories = 0;
  for (const l of lines) {
    if (l.sim_ms > simMs) break;
    const d = l.data as Record<string, unknown>;
    if (l.stream === "detect") tick = d as unknown as TickLite;
    if (l.stream === "control" && typeof d.rec_id === "string") {
      if (l.event === "decision") decisions.add(d.rec_id); else recs.add(d.rec_id);
    }
    if (l.stream === "ledger" && d.name === "AdvisoryIssued") advisories++;
  }
  const t = tick as TickLite | null;
  return { global_state: t?.global_state ?? "IDLE", verdict: t?.localization?.verdict ?? null,
    primary: t?.localization?.primary_segment_id ?? null, recommendations: recs.size, decisions: decisions.size, advisories };
}
