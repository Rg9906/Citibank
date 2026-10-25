# M5 Console — status (updated 2026-10-25)

Legend: ✅ done and verified by a test/build that was run · 🟡 built, not verified in a browser · ⬜ not started.

## Done

| Item | State | Evidence |
|---|---|---|
| Vite + React + TS skeleton, dark theme, 4 tabs, 60/40 layout | 🟡 | `vite build` succeeds; not opened in a browser yet |
| Contract types generated from schemas (`npm run gen:types`) | ✅ | `tsc --noEmit` clean |
| Resilient SSE client (backoff, stale watchdog, browser Last-Event-ID resume) | 🟡 | backoff bounds tested; reconnect not exercised |
| Store with bounded rings and id de-duplication | ✅ | U-5 test (replayed ledger events add no rows) |
| HeatMap (3×5 routes coloured by d3_score, localizer primary outlined, click selects) | 🟡 | renders from ticks; not visually checked |
| RecommendationCard: approve all / selected / reject, operator dropdown, blocked actions locked | ✅ (logic) | U-4 test on the fixture (blocked SHIFT_TRAFFIC never sent) |
| DecisionLog ("recording on ledger…" until DecisionRecorded), DrunixPanel ("ledger offline" instead of numbers) | 🟡 | not visually checked |
| MOCK fallback from fixtures when M4 is unreachable | 🟡 | implemented in `connect.ts` |
| Claims lint over `text/claims.ts` and every `.tsx` | ✅ | U-8 test |
| `npm audit` clean | ✅ | Vite 7.3.7 / Vitest 4.1.12 (spec said Vite 5; see docs/DEVIATIONS.md) |
| **U-1 in a real browser** (Chrome, `npx vite`, no services): every panel renders, badges `offline`, MOCK fixture recommendation after 3 s, no console errors | ✅ 2026-10-25 | checked through the accessibility tree + console (screenshots could not be captured from this machine's Chrome) |
| Header polls M2 `/v1/status` every 1 s (scenario · seed · universe · t · speed · achieved speed) | 🟡 | built; not seen against a running M2 |
| MetricStrip, DetectorRace (onset only in replay/arena), CascadeMap (grid + 0.5 contour + 60 s trails), VerificationPanel (switch checks vs summed budget, unknowns, ledger bridge counts) — inline SVG | ✅ logic / 🟡 visual | `tests/panels.test.ts`; rendered empty-state in the browser |
| Approve flow: keyboard A / S / R, decision rows merge the ledger proof M4 re-publishes (M4-T01) | ✅ logic | `tests/decision.test.ts`; `A` approved the MOCK recommendation in the browser; live ≤ 2 s against M4 not checked |
| **Replay mode (U-6)** `?mode=replay&rec=<name>&speed=1|2|4|8`; `scripts/record.mjs` (live), `scripts/rec_from_run.mjs` (finished batch run, with ground-truth onset) | ✅ | `tests/replay.test.ts`: same final state at 1x and 4x |
| Arena tab (M2 `/v1/results`, falls back to `data/runs`), U2-missing warning, per-universe medians, "simulation, N seeds, preliminary" | ✅ | rendered in the browser from `data/runs` with M2 offline |
| April-2025 split replay (two recordings, one clock, **shared y-scale** so U0 and U4 compare directly) | ✅ 2026-10-25 | filmed at 1080p from `s6_u0` / `s6_u4` (built from `r-S6-3-U0/U4`, seed 3; seed-1 copies kept as `*_seed1`) |
| **3D network hero** (`panels/NetworkScene.tsx`, three.js 0.186.1): dot-matrix India (illustrative geography), PSP → switch → bank arcs with payment particles coloured by route `d3_score`, localizer primary pulses red with a beacon, status-check particles scale with M2 switch checks/s, Drunix ring flashes on ledger events, slow camera sway (static under reduced motion), HeatMap fallback without WebGL | ✅ 2026-10-25 | `tests/scene.test.ts` (5: node placement, dot fill, primary → nodes, colour/speed, check density); seen in Chrome at 1920×1080, ~80–110 fps, no page scroll |
| Restyle: design tokens, glass panels with gradient borders, staggered entrance, glowing state pill, slide-in recommendation card, shimmer on "recording on ledger…", tab underline, Space Grotesk / Inter / JetBrains Mono | ✅ 2026-10-25 | seen in Chrome; CSS-only motion, off under `prefers-reduced-motion` |
| Guided demo captions `?demo=1` (with replay), text in `text/claims.ts` keyed to the sim clock | ✅ 2026-10-25 | claims lint passes; filmed |
| `scripts/record_demo.py`: records `s1_festive`, `s3_bank`, `s4_storm` against fresh mock-ledger stacks | ✅ 2026-10-25 | run twice; `s4_storm` raises no incident at the current calibration (not used in the demo) |

## Open items (summary — the detailed task cards are in `ROADMAP.md`)

1. Playwright snapshots (U-2) — not installed.
2. Live ≤ 2 s approve check against M4 (U-3) and a visual pass with live data (heat map, charts) — run the integration
   smoke and keep the console open.
3. Make the split-replay recordings from the S6 arena runs; record a live run with `scripts/record.mjs`.
4. Docker compose (U-7) — Docker is not installed on the dev machine.
5. M5-T08: demo script rehearsal, backup video, deck screenshots — needs people.

## Known issues
- `EventSource` cannot send headers, so a connection rebuilt after the browser gives up starts from "now" (the browser's own reconnects do resume with Last-Event-ID). Use a fetch-based SSE reader if full resume is needed.
- The API key for decisions comes from `VITE_QS_API_KEY` at build time — fine for a local demo, not for anything shared.

## Reused from the IBM project
Layout ideas only (heat map, detector race, arena tab, decision log). The IBM console was plain JS + canvas; nothing was copied.
