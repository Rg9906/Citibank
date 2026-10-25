# M5 Console — status (updated 2026-10-23)

Legend: ✅ done and verified by a test/build that was run · 🟡 built, not verified in a browser · ⬜ not started.

## Done

| Item | State | Evidence |
|---|---|---|
| Vite + React + TS skeleton, dark theme, 4 tabs, 60/40 layout | ✅ | **opened in a headless Chromium on 2026-10-23** (1920×1080): no services (U-1), 4× replay, split and arena tabs; 0 non-network console errors |
| Contract types generated from schemas (`npm run gen:types`) | ✅ | `tsc --noEmit` clean |
| Resilient SSE client (backoff, stale watchdog, browser Last-Event-ID resume) | 🟡 | backoff bounds tested; reconnect not exercised |
| Store with bounded rings and id de-duplication | ✅ | U-5 test (replayed ledger events add no rows) |
| HeatMap (3×5 routes coloured by d3_score, localizer primary outlined, click selects) | 🟡 | renders from ticks; not visually checked |
| RecommendationCard: approve all / selected / reject, operator dropdown, blocked actions locked | ✅ (logic) | U-4 test on the fixture (blocked SHIFT_TRAFFIC never sent) |
| DecisionLog ("recording on ledger…" until DecisionRecorded), DrunixPanel ("ledger offline" instead of numbers) | 🟡 | not visually checked |
| MOCK fallback from fixtures when M4 is unreachable | 🟡 | implemented in `connect.ts` |
| Claims lint over `text/claims.ts` and every `.tsx` | ✅ | U-8 test |
| **M5-T01** Header polls M2 `/v1/status` (1 s) and every `/v1/health` (5 s); per-panel error boundary | ✅ | `statusLine` test; browser: "simulator offline", badges per source |
| **M5-T02** keyboard `A` / `S` / `R` (ignored while typing); decision rows merge M4's ledger updates (`tx … · block …`) | ✅ | `keyCommand` + `mergeDecision` + store tests; browser replay shows three rows with tx + block |
| **M5-T03** MetricStrip (5 uPlot sparklines, |z| > 2.5 flagged, nulls kept) · VerificationPanel (M2 `/v1/timeseries` checks/s vs summed M4 budget, switch utilisation vs 0.85 knee, unknown open) | ✅ / 🟡 | strip + budget tests; strip seen in browser; timeseries chart not yet seen (needs M2) |
| **M5-T04** DetectorRace (earliest flag per detector over the ring; onset only in replay) · CascadeMap (grid heat + 0.5 contour + 60 s PSP trails + countdown "rough estimate"; axes + trails until the grid exists) | ✅ / 🟡 | race/trail/grid tests; race seen in browser with D1–D3 flags; grid layer not yet seen (needs M3's trained grid) |
| **M5-T05** recorder `scripts/record.mjs` + replay `?mode=replay&rec=<name>&speed=1\|2\|4` (dev server serves `../data/recordings`) | ✅ | U-6 test: same final state at 1× and 4×, 4× in ¼ wall time; recorder run against live M1/M3/M4 mocks; browser replay of an M3→M4 recording |
| **M5-T06** Arena tab (medians per scenario × universe, U2 row forced next to U4) · split replay (two recordings, shared scrubber, 4× play) | ✅ / 🟡 | arena + `stateAt` tests; split seen in browser; arena needs M2 results |
| Drunix panel lists only advisories not revoked | ✅ | `activeAdvisories` test (bug found in the browser pass: rolled-back advisories were still listed) |
| `npm audit` clean | ✅ | Vite 7.3.7 / Vitest 4.1.12 (spec said Vite 5; see docs/DEVIATIONS.md) |

## Open items (summary — the detailed task cards are in `ROADMAP.md`), in day order (§10)

1. ~~Browser pass~~ done 2026-10-23 with a headless Chromium (Playwright's browser download is blocked in that environment, so no committed Playwright snapshots yet — U-2 still open). Originally: **Day 1–2:** open it in a browser against `make run-mock` services and against nothing (U-1: badges, no crash); Playwright snapshot of every panel on fixtures (U-2, not installed yet); U-3 approve flow against M4 mock ≤ 2 s with tx id shown.
2. ~~Placeholder panels~~ all built 2026-10-23 (`src/panels/Panels.tsx`). Originally: build the placeholder panels (each names its source and acceptance test in `src/panels/Placeholders.tsx`): MetricStrip (uPlot sparklines), DetectorRace, CascadeMap (needs M3's trained grid), VerificationPanel (M2 timeseries + M4 budget events), Header polling M2 `/v1/status`.
3. **Day 3:** root `docker-compose.yml` profiles `live` and `mock` (skeleton exists at the repo root, untested: Docker not installed on the dev machine); `scripts/integration_smoke.sh` per §6 — a Python version of this smoke already ran on 2026-10-20 (see root README).
4. **Day 4:** Arena tab (M2 `/v1/results`, U2 always next to U4, "simulation" labels), `scripts/record.ts` + `streams/replay.ts` (`?mode=replay&rec=`), April-2025 split replay (U-6); deck screenshots.
5. **Day 5:** polish, rehearse twice, backup video.

## Known issues
- Headless check found that a Chromium without locale data throws in `Intl.NumberFormat` (uPlot axis labels); the per-panel `Boundary` now contains such failures to one panel. Normal browsers are unaffected.
- Budget / timeseries / status / grid bodies have no JSON Schema in `contracts/` (CONTRACTS §1–§3 give only the shape), so their TS interfaces live in `src/panels/viewLogic.ts` with runtime guards (`isGrid`, `isTimeseries`). Propose schemas if the shapes change.
- `EventSource` cannot send headers, so a connection rebuilt after the browser gives up starts from "now" (the browser's own reconnects do resume with Last-Event-ID). Use a fetch-based SSE reader if full resume is needed.
- The API key for decisions comes from `VITE_QS_API_KEY` at build time — fine for a local demo, not for anything shared.

## Reused from the IBM project
Layout ideas only (heat map, detector race, arena tab, decision log). The IBM console was plain JS + canvas; nothing was copied.
