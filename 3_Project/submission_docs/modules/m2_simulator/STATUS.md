# M2 Simulator — status (updated 2026-10-25)

Legend: ✅ done and verified by a test that was run · 🟡 built, not fully verified · ⬜ not started.

## Done

| Item | State | Evidence |
|---|---|---|
| Config in YAML → frozen dataclasses (§9 defaults) | ✅ | `config/*.yaml`, `qsim/config.py` |
| Common-random-number tape, named PCG64 streams (§10) | ✅ | S-3 test |
| Engine: PSP queues/workers, remitter + beneficiary legs, declines, zombie work, reversals | ✅ | S-1, S-2 tests |
| Switch status service + slowdown coupling (§2.2) | ✅ | S-7: U0 S6 slowdown > 2, util > 0.95 |
| Client profiles naive / npci_rule / governed / ledger_first, 30 % naive mix in U3/U4 (§4) | ✅ | S-6 (SI-1 from the stream) |
| U1 textbook failover rule | 🟡 | implemented, no dedicated test |
| Ledger **model** for U4 (open unknowns, pushed resolution) | ✅ | `test_ledger_model_resolves_unknowns_in_u4` |
| Actions THROTTLE_RETRIES, SHED_EXPIRED, PRIORITIZE_FRESH, SHIFT_TRAFFIC, CHECK_BUDGET, DEFER_CHECKS, ROLLBACK | ✅/🟡 | S-9 (throttle); others applied but not individually tested |
| Scenarios S0–S8 incl. S8 payout batch | 🟡 | S8 events validate; S1/S2/S5/S7 not exercised by tests |
| Events validate against `payment_event.schema.json` | ✅ | S-5 contract tests |
| Batch runner writes `data/runs/<run_id>/*` + valid `result.json` | ✅ | ran S3 and S6 (600 s S3 run in 8.4 s wall) |
| HTTP API: health, scenario, status, stream, timeseries, results | ✅ | `test_api.py`; live run used in the integration smoke |
| Mock mode (fixture replay) | ✅ | `test_mock_mode_serves_fixture_run` (2026-10-25) |
| **G-SIM calibration (M2-T01)** — accepted on both scenarios, 10 seeds | ✅ 2026-10-25 | `scripts/calibrate.py`; `data/calibration/S{4,6}.json`, `data/figures/F1_s{4,6}.png`. S4 (P1, 50 % loss): ≤ 10 s recovers 10/10, 25 s sticks 9/10 (U2 3/10). S6 (B1, hold 0.2): 15 s recovers 10/10, ≥ 30 s sticks 10/10 (U2 0/10). One parameter changed: `status_bank_cost_ms` 20 → 5 (DEVIATIONS) |
| Training-set ranges | ✅ 2026-10-25 | `scripts/mix_check.py`: S4 config ranges 63 % stuck (unchanged), S6 ranges narrowed → 37 % stuck |
| **Live ledger bridge (M2-T02, S-11)** `LEDGER_MODE=mock|live`, `LEDGER_URL` | ✅ 2026-10-25 | `tests/test_ledger_bridge.py` against the real M1 mock gateway: unknowns opened + attested, every resolution from a terminal `PaymentUpdated`, gateway records match truth; dead gateway → unhealthy → model fallback. `/v1/status.ledger` shows backlog/health |
| **Arena jobs (M2-T03, S-10)** `POST /v1/arena`, `GET /v1/arena/{job}`, optional `suffix`, `operator_delay_s` | ✅ 2026-10-25 | `test_s10_arena_job_writes_valid_results`; U4 lockstep forwards ledger-model `PaymentUpdated` records to M4 |
| Wall-clock pacing (M2-T09): engine advances to `t0_sim + elapsed × speed`; `/v1/status.achieved_speed` | 🟡 | implemented; achieved speed not yet measured in a demo run |
| Batch: `events.jsonl.gz` by default, `--stop-after-end-s`, `--seed-range`, `--jobs` | ✅ 2026-10-25 | 120 training runs in `data/train_runs` (~1 GB instead of ~30 GB) |
| U1 textbook failover, every action + rollback, S1/S2/S5/S7 (M2-T06) | ✅ 2026-10-25 | `tests/test_paths.py` (8 tests). Finding: in every S4 run where U1 failed P1 over, the shifted load collapsed the whole network (S4 P1 90 %/20 s at half load: U0 goodput 18/s after, U1 0/s) and weight was never restored — evidence for P4 (harmful failover) |

Last test run (2026-10-25): `../.venv/Scripts/python -m pytest -q` → 29 passed.

## Preliminary arena (2026-10-25; simulation, 5 seeds, U4 through M3/M4 lockstep, auto operator) — `data/runs/r-S{4,6}-{1..5}-U{0,2,4}`

| | stuck runs U0 / U2 / U4 | switch checks per unknown U0 / U2 / U4 | peak switch checks/s | duplicate commits (median) |
|---|---|---|---|---|
| S4 (config ranges) | 3 / 2 / **0** of 5 | 29.6 / 2.1 / **0.65** | 2212 / 100 / 59 | 1900 / 0 / 30 |
| S6 (new milder ranges) | 2 / 0 / 0 of 5 | 18.4 / **3.0** / 7.2 | 62 / 22 / 36 | 84 / 0 / 21 |

Honest reading: U4 clearly beats U0 and U2 on S4. On S6 at the new ranges U2 ≈ U4 and U4 uses *more* checks per unknown than
U2, because U3/U4 keep 30 % naive clients (SPEC §4) — P7 as worded does not hold for the population mix; report a
per-profile breakdown before claiming it. U4's duplicates also come from the naive 30 %. Recovery medians are over
recovered runs only (not comparable across universes). `recovery_time_s` was fixed on 2026-10-25 (10 s smoothing;
`scripts/recompute_metrics.py` corrected the saved runs).

**S1 is not benign at the top of its range** (found via M3's surge evaluation): mult up to 1.8 on ~0.55-0.58 baseline
utilisation puts P1 at ρ ≈ 1.0 and the network locks in (timeouts, rejects, still CRITICAL after the surge). The flash
is capped at ρ ≤ 0.95 but the surge itself is not. Proposed: cap S1 `mult` so ρ_P1 ≤ ~0.9 (≈ [1.3, 1.55]) — needs the
lead's OK (dataset change; ties in with M2-T05).

## Open items (summary — the detailed task cards are in `ROADMAP.md`)

1. Tag `sim-frozen` once the team agrees (not done: no commits/tags without the owner's go-ahead).
2. **M2-T04** (E_STATUS_STOP for npci_rule, SLOW_RETRIES for ledger_first, PACE_PAYOUTS enforcement): deliberately left
   until after the pitch freeze — it changes U2/U4 client dynamics and would invalidate the calibration and arena numbers.
3. **M2-T05** S-4 utilisation target: needs the lead's decision (per-PSP or platform mean).
4. Metrics still `null`: `tat_breaches`, `harmful_failovers` (M2-T07).
5. Real NPCI decline rates (M2-T10), `default_budget` placeholder (M2-T11), configuration sets with parameter draws (M2-T08).
6. Measure `achieved_speed` in a demo run (M2-T09).
7. Cap the S1 surge multiplier (see above) and regenerate S1 runs; add a per-profile switch-check breakdown to the arena.

## Known issues
- `fresh_rate()` used by THROTTLE_RETRIES reads a 10 s ring that is reset per snapshot; OK at 1 s snapshots, fragile if `snapshot_ms` changes.
- S1 flash is capped at ρ ≤ 0.95 (≈ ×1.73, spec says ×2.5) — IBM lesson; see docs/DEVIATIONS.md.

## Reused from the IBM project
Heap loop, queue/worker accounting, fresh/retry split, shed and fresh-first controls, modifier ramps, tape idea, scenario builder, id helpers (see `docs/REUSE_MAP.md`). New: two legs per payment, switch coupling, universes U2–U4, ledger model, contract events.
