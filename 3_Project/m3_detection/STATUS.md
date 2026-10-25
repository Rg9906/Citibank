# M3 Detection — status (updated 2026-10-25)

Legend: ✅ done and verified by a test that was run · 🟡 built, not fully verified · ⬜ not started.

## Done

| Item | State | Evidence |
|---|---|---|
| Segments + involvement (both bank roles, once if equal) | ✅ | D-1, D-2 |
| Ingest: schema validation, LRU dedupe, 2 s watermark | ✅ 2026-10-25 | `tests/test_robustness.py`: late event delivered with late=True, counted, and lands in its window; duplicate ids processed once |
| Model timing guard: forecaster step > `d3.model_budget_ms` twice in a row → `model_degraded` flag on every segment + DEGRADED_MONITORING | ✅ 2026-10-25 | `test_slow_model_twice_degrades_monitoring_with_flag` (injected clock) |
| Run reader for `events.jsonl.gz` (M2's new default) | ✅ 2026-10-25 | `qdet/runs.py`, used by the D-10 test and training |
| Windows, 23 features, NaN never treated as 0 | ✅ | D-1 (hand-computed values) |
| EWMA baselines, warm-up, freeze while an incident is open | ✅ | D-3 |
| D3 rules: 6 signals, surge gate, logistic rule score, 3-of-4 persistence, fast path, confidence, reasons | ✅ | D-5, bank-fault test |
| D0, D1, D2 comparison detectors | 🟡 | run every tick; thresholds untuned |
| Localizer (involvement lift) + hysteresis | ✅ | D-6: 6 verdicts × 1 000 Poisson trials ≥ 95 % |
| Grid forecaster: fit, monotone option, export with contour, < 1 ms inference | ✅ | D-7 |
| Forecaster runtime (EMA, CALM/WATCH/CRITICAL, countdown) | ✅ 2026-10-25 | trained grid loaded from `data/models/forecaster_grid.json`; `GET /v1/forecaster/grid` serves it (20×20, 20-point contour) |
| **Trained grid (M3-T01)** — A/B split by configuration seed, equal weight per run, monotone on/off compared | ✅ 2026-10-25 | `scripts/train_forecaster.py --runs ../data/train_runs`; `tests/test_training.py` (split has no overlap, AUC, synthetic fit). Report `data/models/forecaster_report.json`. **Set B (30 runs, 14 stuck), simulation:** sample AUC 0.93, Brier 0.077. At p ≥ 0.6: 14/14 stuck runs CRITICAL before collapse, median lead **5.5 s**, 0/16 recovered runs CRITICAL. At p ≥ 0.5: lead 18.5 s but 9/16 false. Thresholds set to 0.6 (DEVIATIONS). Set C not scored |
| Incident lifecycle, merge with localizer primary, network-wide anchor | ✅ | D-10, S6 smoke (one incident) |
| DEGRADED_MONITORING when input stops for 12 s | ✅ | D-9 |
| Every message validates (`segment_state`, `incident`) | ✅ | D-8, batch API contract test |
| Live SSE subscription to M2, mock mode, batch endpoints | ✅ | live integration smoke 2026-10-20 (S3 U4: BANK_SIDE incidents reached M4) |
| D-10 on a recorded M2 S3 run (D3 before D0, right bank) | ✅ | runs when `data/runs/r-S3-*-U0` exists |

## S1 surge evaluation (2026-10-25; `scripts/eval_surge.py`, 10 S1 U0 runs, seeds 1000-1009, 2.2 simulated h) — `data/models/surge_report.json`
- **D-4 fails:** platform rows labelled SURGE on 24 % of surge ticks (PSP rows 42 %), target ≥ 95 %. Main cause is M2's
  S1 range, not the gate: at mult ≈ 1.75 the surge overloads P1 (queues, timeouts, rejects; CRITICAL after the surge
  ends), so the gate's "≤ 1 signal and queue not growing" condition is correctly false. Re-measure after M2 caps S1.
- False CRITICAL at the new 0.6 threshold: 0.92 groups per simulated hour (budget ≤ 1). D3 warning groups 6.9/h on
  these runs — partly real overload (above), the rest is M3-T03 tuning.

## Open items (summary — the detailed task cards are in `ROADMAP.md`), in spec order

1. **Forecaster follow-ups**: false-CRITICAL check on S1/S5 surge runs before quoting the threshold (card step 5);
   the grid's 0.5 contour sits at delay 0 for orbit ≥ ~0.15, i.e. the orbit axis dominates — check whether that holds on
   other scenarios; lead time is measured on raw grid p (runtime adds an EMA). Score set C once, after freezing.
2. **D-4 surge gate ≥ 95 % on S1** — needs M2 S1 runs; not measured.
3. **D-11 matched-budget tuning**: bisect θ0, D1 sensitivity, D2 h, D3 τ to ≤ 1 false alert per simulated hour on S0+S1+pre-incident ticks; write `config/detectors_frozen.yaml` (loaded automatically if present).
4. **Live-rate tuning**: at the demo rate (~25 payments/s) the S3 fault opened incidents on two *route* segments before the bank segment warned, giving two recommendations; recovery tails raised small extra incidents. Consider requiring the localizer primary to be warning for 1 tick before opening route incidents, or lowering bank thresholds at low volume.
5. IsolationForest score [BUILD] (`detectors/iforest.py` not written) — IBM evidence says rules-only had fewer false alerts; only add if it beats rules on validation.
6. Model timing guard (> 50 ms twice → `model_degraded`) is only meaningful once a model exists.

## Known issues / decisions (details in ../docs/DEVIATIONS.md)
- MULTI_FAULT uses an extra `multi_psp_lift` condition so flat faults read PLATFORM_WIDE.
- switch_status_util is derived from served checks / capacity (no worker count in SWITCH_SNAPSHOT).
- Batch `/v1/batch/tick` skips per-event schema validation for speed.
- Hysteresis also applies to INSUFFICIENT_EVIDENCE (spec text); IBM published it immediately.

## Reused from the IBM project
Windows and latency histogram, feature engine, baselines, ingest/dedupe, rule signals, surge gate, persistence,
lifecycle, stuck grid (see `docs/REUSE_MAP.md`). New: 25 segments with dual bank involvement, switch features,
involvement-lift localizer, network-wide incident anchor, the stale-primary guard.
