# M3 Detection — status (updated 2026-10-23)

Legend: ✅ done and verified by a test that was run · 🟡 built, not fully verified · ⬜ not started.

## Done

| Item | State | Evidence |
|---|---|---|
| Segments + involvement (both bank roles, once if equal) | ✅ | D-1, D-2 |
| Ingest: schema validation, LRU dedupe, 2 s watermark | ✅ | M3-T06: `test_t06_late_*` (late flagged, counted, lands in its bucket), `test_t06_duplicate_*` |
| Windows, 23 features, NaN never treated as 0 | ✅ | D-1 (hand-computed values) |
| EWMA baselines, warm-up, freeze while an incident is open | ✅ | D-3 |
| D3 rules: 6 signals, surge gate, logistic rule score, 3-of-4 persistence, fast path, confidence, reasons | ✅ | D-5, bank-fault test |
| D0, D1, D2 comparison detectors | 🟡 | run every tick; thresholds untuned |
| Localizer (involvement lift) + hysteresis | ✅ | D-6: 6 verdicts × 1 000 Poisson trials ≥ 95 % |
| Grid forecaster: fit, monotone option, export with contour, < 1 ms inference | ✅ | D-7 |
| Forecaster runtime (EMA, CALM/WATCH/CRITICAL, countdown) | 🟡 | runs; no trained grid yet so p_stuck is null |
| Incident lifecycle, merge with localizer primary, network-wide anchor | ✅ | D-10, S6 smoke (one incident) |
| DEGRADED_MONITORING when input stops for 12 s | ✅ | D-9 |
| Every message validates (`segment_state`, `incident`) | ✅ | D-8, batch API contract test |
| Live SSE subscription to M2, mock mode, batch endpoints | ✅ | live integration smoke 2026-10-20 (S3 U4: BANK_SIDE incidents reached M4) |
| D-10 on a recorded M2 S3 run (D3 before D0, right bank) | ✅ | runs when `data/runs/r-S3-*-U0` exists |
| **M3-T02** one incident per bank fault ("explaining away"): while BANK_SIDE(b) is the verdict or a live incident, a warning on another bank/route/PSP joins b's incident only if its excess outside b-involved payments is ≤ `localizer.explain_residual_max` (10); `route:*:b` always joins; an independent fault keeps its own incident | ✅ | `test_t02_*`: 7 synthetic B1 faults (25/s and 80/s, 30–100 % timeouts) → exactly 1 incident `bank:*:B1` BANK_SIDE (before: 5–12 incidents each); independent P2/B3 fault still separate; residual unit test |
| **M3-T06** `model_degraded`: scorer > `d3.model_budget_ms` (50 ms) on 2 consecutive ticks → flag on every segment + DEGRADED_MONITORING; clears on the next fast tick | ✅ | `test_t06_slow_scoring_*` |
| **M3-T05** `detector_alerts` first-alert times are stable per (detector, segment) | ✅ (synthetic) | `test_t05_*`; four distinct flags on S4 still to confirm on M2 runs |
| **M3-T01** training pipeline: A/B/C split by seed (configuration), balance weights, monotone *and* unsmoothed fits, AUC + Brier on B, written grid follows `forecaster.monotone` | ✅ (pipeline) | `test_t01_*` on synthetic samples. **No real grid yet** — needs M2 U0 runs of S4/S6 (M2 is not in this repository) |

## Open items (summary — the detailed task cards are in `ROADMAP.md`), in spec order

1. **Train the grid** (§6): pipeline ready (M3-T01) — run `python scripts/train_forecaster.py --runs ../data/runs` once M2 runs exist and record the printed AUC/Brier. need M2 U0 runs of S4/S6 with a mix of stuck and recovered outcomes. Blocked on M2 calibration (today every S4 trigger sticks). `scripts/train_forecaster.py` works but still needs the A/B/C split by configuration, boundary oversampling, and Brier/AUC on B. Then incidents can go CRITICAL from p_stuck.
2. **D-4 surge gate ≥ 95 % on S1** — needs M2 S1 runs; not measured.
3. **D-11 matched-budget tuning**: bisect θ0, D1 sensitivity, D2 h, D3 τ to ≤ 1 false alert per simulated hour on S0+S1+pre-incident ticks; write `config/detectors_frozen.yaml` (loaded automatically if present).
4. ~~Live-rate tuning~~ fixed 2026-10-23 by M3-T02 (explaining away); re-check on a recorded live-rate M2 stream. Original note: at the demo rate (~25 payments/s) the S3 fault opened incidents on two *route* segments before the bank segment warned, giving two recommendations; recovery tails raised small extra incidents. Consider requiring the localizer primary to be warning for 1 tick before opening route incidents, or lowering bank thresholds at low volume.
5. IsolationForest score [BUILD] (`detectors/iforest.py` not written) — IBM evidence says rules-only had fewer false alerts; only add if it beats rules on validation.
6. ~~Model timing guard~~ done (M3-T06); it times the rule scorer + forecaster today.
7. `/v1/forecaster/grid` returns 503 until `data/models/forecaster_grid.json` exists; M5's CascadeMap depends on it.

## Known issues / decisions (details in ../docs/DEVIATIONS.md)
- Explaining away (M3-T02) is a new rule, not in the v1.0 spec: it uses the localizer's 10 s cell window. A merged segment that later shows its own residual is detached from the bank incident (`Lifecycle.on_warning(independent=True)`).
- `model_degraded` uses wall-clock time only to time the scorer (allowed: latency measurement); no result depends on it.
- MULTI_FAULT uses an extra `multi_psp_lift` condition so flat faults read PLATFORM_WIDE.
- switch_status_util is derived from served checks / capacity (no worker count in SWITCH_SNAPSHOT).
- Batch `/v1/batch/tick` skips per-event schema validation for speed.
- Hysteresis also applies to INSUFFICIENT_EVIDENCE (spec text); IBM published it immediately.

## Reused from the IBM project
Windows and latency histogram, feature engine, baselines, ingest/dedupe, rule signals, surge gate, persistence,
lifecycle, stuck grid (see `docs/REUSE_MAP.md`). New: 25 segments with dual bank involvement, switch features,
involvement-lift localizer, network-wide incident anchor, the stale-primary guard.
