# M4 Control — status (updated 2026-10-23)

Legend: ✅ done and verified by a test that was run · 🟡 built, not fully verified · ⬜ not started.

## Done

| Item | State | Evidence |
|---|---|---|
| Rule table R0–R7 as data, first match wins, fallback | ✅ | C-1 (one test per row) |
| SHIFT_TRAFFIC eligibility (§4) with first failed check as `blocked_by` | ✅ | C-2, C-3 |
| BANK_SIDE: shift blocked "shared bank b", maps to DO_NOT_SHIFT advisory | ✅ | C-3, C-4 |
| Safety invariants SI-1, SI-2, SI-4, SI-5 over 5 000 random states | ✅ | C-2 |
| Governor budget formula, r_min/r_max, monotone in switch use, publish on > 10 % change | ✅ | C-7 |
| One PENDING recommendation per incident; SUPERSEDED / EXPIRED; expired when the incident closes | ✅ | dedicated test |
| Decisions → actions (SI-3) → ledger decision + advisories (SI-9), 409 on double decision / blocked action | ✅ | C-4, C-6, API contract test |
| Ledger outage: actions still applied, writes queued and retried every tick / 10 s | ✅ | C-5 |
| Simulated operator: delay honoured, confidence ≥ 0.6, never approves blocked | ✅ | C-8 |
| **M4-T01** ledger status on the stream: `POST /v1/decisions` returns `ledger.decision_id` + `block_number`; `DecisionRecorded`/`AdvisoryIssued` and late (queued) writes re-publish `event: decision` with `{rec_id, decision_id, ledger: {decision_tx, block_number, advisory_txs, pending}}` | ✅ | `tests/test_roadmap.py::test_t01_*` (3) |
| **M4-T02** budget publication at most once per `governor.min_publish_interval_s` (30 sim s); first tick and DEFER_CHECKS approve/rollback always publish | ✅ | `test_t02_*` (3): > 3× fewer CHECK_BUDGET actions on a noisy run; C-7 and SI-5 unchanged |
| **M4-T03 / C-9** rollback proposals: after `rollback.clean_ticks` clean ticks (incident closed, network MONITORING, scope segment MONITORING) one single-`ROLLBACK` recommendation per applied action; approval queues a `ROLLBACK` action (origin `ROLLBACK`) and revokes that action's advisories; never re-proposed after approval/rejection; M2-rejected actions skipped | ✅ | `test_t03_*` (4); `ModelLedger.revoke` now records `AdvisoryRevoked` |
| **M4-T04** one package per bank fault: a new PENDING BANK_SIDE recommendation supersedes an older PENDING one for the same bank | ✅ | `test_t04_*` (2) |
| **M4-T05** `scripts/operator_sweep.py` (arena sweep over 5/15/30/60/120 s → markdown table labelled simulation) | 🟡 | table logic tested (`test_t05_*`); never run against M2 (M2 not in this repo) |
| Live inputs (M3 + M1 SSE), mock mode, batch endpoints | ✅ | live integration smoke 2026-10-20: auto-approved BANK_SIDE package wrote advisories to the M1 mock |

## Open items (summary — the detailed task cards are in `ROADMAP.md`), in spec order

1. ~~C-9 rollback proposals~~ done 2026-10-23 (M4-T03).
2. **PACE_PAYOUTS** in R3 (needs an M3 feature for PAYOUT share per bank — ask M3 via a contract proposal) and its params (`max_rate_per_s = 0.5 × spare, min 5/s`).
3. **R2 DEFER_CHECKS(top bank)** uses the localizer candidate lift; check against real M3 output.
4. ~~Budget publication too chatty~~ done (M4-T02). 5. ~~Ledger tx on the decision stream~~ done (M4-T01).
6. Operator-delay sweep: script ready (M4-T05); run it once M2's arena is available. It sends `overrides: {operator_mode, operator_delay_s}` in `POST /v1/arena` — M2 must forward these into the lockstep `ResetRequest` (check with the M2 owner).
7. `C_status` uses the default 80/s; switch capacity is not in `segment_state` — propose adding it if M2 calibration changes capacity.

## Known issues
- `event: decision` now has two shapes on the stream: the full decision (on decide) and a ledger update `{rec_id, decision_id, ledger}` (on confirmation). Consumers merge by `decision_id`.
- Rollback recommendations use severity WARNING and confidence 1.0, so the simulated operator approves them after its delay.
- Live smoke: during recovery, small INSUFFICIENT_EVIDENCE incidents from M3 produced PENDING recommendations that expired after 120 sim s (correct behaviour; noise is an M3 tuning item).
- `operator_sim` lives inside `controller.py` (`_auto_operator`) rather than its own file.

## Reused from the IBM project
Rule-order idea, SHIFT checks returning the first failing reason, approval/rejection flow and SI checks, simulated operator, API hardening patterns (see `docs/REUSE_MAP.md`). New: budget publisher instead of per-payment scheduler, ledger writes, advisories, rule table as YAML.
