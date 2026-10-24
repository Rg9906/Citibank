# Deviation lines from the 2026-10-23 roadmap pass — append each line to `docs/DEVIATIONS.md`

`docs/` (and `m2_simulator/`) are not in the GitHub repository, so these lines could not be appended in place.
Append them to the team's `docs/DEVIATIONS.md` and delete this file.

- 2026-10-23 M1: chaincode compiled for the first time (Go 1.24.7, Linux); contractapi v1.2.2 rejects pointer-to-basic fields (`*int64`, `*string`) in return types, so every exported function now returns the record as a JSON string (`chaincode/api.go`); the live gateway must `JSON.parse` results.
- 2026-10-23 M1: `advisory:RevokeAdvisory` on an already revoked advisory is a no-op (no write, no event); revoke reason ≤ 200 chars.
- 2026-10-23 M1: `go.sum`/`vendor/` still not committed — the build machine blocked proxy.golang.org/gopkg.in/golang.org; generate them on the Drunix machine once the ccenv Go version is known ([VERIFY] still open).
- 2026-10-23 M3: new rule "explaining away" (M3-T02, not in spec v1.0): while BANK_SIDE(b) holds or a BANK_SIDE incident is live, a warning on another bank/route/PSP joins b's incident when its excess outside b-involved payments is ≤ `localizer.explain_residual_max` (10, 10 s window); `route:*:b` always joins.
- 2026-10-23 M3: `model_degraded` implemented over the rule scorer + forecaster timing (no ML model yet); wall clock used only for that timing.
- 2026-10-23 M3: forecaster training writes the grid selected by `forecaster.monotone`, but always reports monotone and unsmoothed AUC/Brier on B; balance weights replace explicit oversampling when the stuck share is outside 40–60 %.
- 2026-10-23 M4: `event: decision` has a second shape `{rec_id, decision_id, ledger:{decision_tx, block_number, advisory_txs, pending}}` (ledger confirmation); `POST /v1/decisions` response `ledger` gains `decision_id`, `block_number`, `pending` (additive).
- 2026-10-23 M4: `governor.min_publish_interval_s: 30` (new tunable, M4-T02).
- 2026-10-23 M4: rollback recommendations use severity WARNING, confidence 1.0, one ROLLBACK action each; the resulting action has origin `ROLLBACK`. M4-T04 supersedes an older PENDING BANK_SIDE package for the same bank.
- 2026-10-23 M4: `scripts/operator_sweep.py` sends `overrides: {operator_mode, operator_delay_s}` in `POST /v1/arena`; M2 must forward them into the lockstep `ResetRequest` (to confirm with M2).
- 2026-10-23 M5: TS interfaces for budget / timeseries / status / grid bodies are hand-written in `src/panels/viewLogic.ts` (these bodies have no schema in `contracts/schemas`), guarded at runtime.
- 2026-10-23 M5: browser pass used a headless Chromium from the npm package `@sparticuz/chromium` (scratch only, not a project dependency); Playwright (U-2) not installed because its browser download was blocked.
