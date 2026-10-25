# M4 Control — status (updated 2026-10-25)

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
| Live inputs (M3 + M1 SSE), mock mode, batch endpoints | ✅ | live integration smoke 2026-10-20: auto-approved BANK_SIDE package wrote advisories to the M1 mock |
| M4-T01 ledger proof on the decision stream: `decision` re-published with `decision_tx`, `block_number`, `advisory_txs` when DecisionRecorded / AdvisoryIssued arrive; sync `POST /v1/decisions` returns `decision_id` + `block_number` | ✅ 2026-10-25 | `test_u3_ledger_proof_republished_on_decision_stream`, `test_u3_sync_decision_response_carries_block_number` |
| M4-T02 quieter budgets: loosening at most every `governor.min_publish_interval_s` (30 s) per PSP, tightening immediate, DEFER_CHECKS/ROLLBACK approval forces a publish | ✅ 2026-10-25 | `test_m4_t02_budget_publication_is_rate_limited_but_tightening_is_immediate` (C-7 and SI-5 still green) |
| M4-T03 rollback proposals (C-9): after `rollback.clean_ticks` clean ticks on the action's scope a single-ROLLBACK recommendation; approval enqueues ROLLBACK for M2 and revokes the action's advisories | ✅ 2026-10-25 | `test_c9_rollback_proposal_after_clean_ticks_revokes_advisory` |
| M4-T04 one package per bank fault: a new BANK_SIDE package supersedes other PENDING BANK_SIDE packages for the same bank | ✅ 2026-10-25 | `test_m4_t04_two_incidents_for_one_bank_fault_show_one_package` |
| M4-T05 `scripts/operator_sweep.py` (S4 U4 arena at delays 5/15/30/60/120 s, run ids `r-S4-<seed>-U4-op<delay>`) | 🟡 | written; not run yet (needs M2+M3+M4 running) |

## Open items (summary — the detailed task cards are in `ROADMAP.md`), in spec order

1. **PACE_PAYOUTS** in R3 (needs an M3 feature for PAYOUT share per bank — ask M3 via a contract proposal) and its params (`max_rate_per_s = 0.5 × spare, min 5/s`).
2. **R2 DEFER_CHECKS(top bank)** uses the localizer candidate lift; check against real M3 output.
3. Run the operator-delay sweep (`scripts/operator_sweep.py`) once M2/M3/M4 are up — the IBM project found operator delay was the dominant factor.
4. `C_status` uses the default 80/s; switch capacity is not in `segment_state` — propose adding it if M2 calibration changes capacity.

## Known issues
- Live smoke: during recovery, small INSUFFICIENT_EVIDENCE incidents from M3 produced PENDING recommendations that expired after 120 sim s (correct behaviour; noise is an M3 tuning item).
- `operator_sim` lives inside `controller.py` (`_auto_operator`) rather than its own file.

## Reused from the IBM project
Rule-order idea, SHIFT checks returning the first failing reason, approval/rejection flow and SI checks, simulated operator, API hardening patterns (see `docs/REUSE_MAP.md`). New: budget publisher instead of per-payment scheduler, ledger writes, advisories, rule table as YAML.
