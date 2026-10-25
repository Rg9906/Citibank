# M1 Ledger — status (updated 2026-10-23)

Legend: ✅ done and verified by a test that was run · 🟡 built, not verified · ⬜ not started.

## Done

| Item | State | Evidence |
|---|---|---|
| Golden vectors copied to `testdata/transitions.json` (70 cases) | ✅ | |
| TS state machine (mock) passes every vector | ✅ | `npm test` → golden vectors |
| **Mock gateway shipped** (Day-1 gate): every route in CONTRACTS §4, same codes, `mock: true` on events | ✅ | `npm test`: L3, L4, L5, L6, L7 (mock part), L8 |
| SSE ring + Last-Event-ID replay + `reset` + heartbeat | ✅ | L7 mock part |
| Keyed mutex per key (no lost attestations under concurrency) | ✅ | L4: 100 concurrent DEBIT+CREDIT pairs |
| Mock TAT sweeper (every 1 s) | 🟡 | logic tested (`checkTat`); sweeper loop not tested |
| Used by M4 live | ✅ | integration smoke 2026-10-20: advisories and decisions written by the auto operator |
| Go `logic/` state machine + golden-vector test | ✅ | `go test ./logic/...` green on Go 1.24.7 (Linux, 2026-10-23): 70 golden vectors + TAT |
| Go contracts `paystate`, `advisory`, `decisionlog` | ✅ (unit) | compile, `go vet ./...` clean, `go test ./...` green: `contracts_test.go` (fake stub) covers MSP checks, idempotent open, one event per write, TAT on tx time, advisory issue/revoke/expiry/sorted list, append-only decisions. **Not yet run on a peer.** |
| Chaincode start-up metadata (`contractapi.NewChaincode`) | ✅ | `TestChaincodeMetadataBuilds`. Found and fixed a start-up failure: pointer fields (`*int64`, `*string`) are not allowed in contractapi return types, so every exported function now returns the record as a JSON string (`api.go`) |
| `network/qs-net.sh` (doctor/clone/up/create-channel/deploy/sql/status/down/bootstrap) | 🟡 | written to §3; **not run** (needs WSL2 + Docker) |
| Gateway typecheck (`tsc --noEmit`), `npm audit` clean | ✅ | fastify 5.12.7, ajv 8.20.0 |

## Open items (summary — the detailed task cards are in `ROADMAP.md`), in day order (§9)

1. M1-T02 is done except `go mod vendor` with the real ccenv Go version (see below). **Day 1:** on a WSL2 machine with ≥ 16 GB: `qs-net.sh doctor` → `clone` → `up` → `create-channel`; deploy the sample `basic` (L1). Resolve every `[VERIFY]` in §1 and append to `../docs/DEVIATIONS.md`: Go version in `drunix-ccenv:1.0` (then pick `fabric-contract-api-go` v1.2.x or v2 in `go.mod`, `go mod vendor`), host ports, events on the Committing Peer, range queries on YugabyteDB.
2. ~~Run `go test ./logic/...` and fix the compiler findings~~ done 2026-10-23. Still open: check the Go version in `npcioss/drunix-ccenv:1.0`, then `go mod tidy && go mod vendor` on a machine with normal Go-proxy access and commit `go.sum` + `vendor/`.
3. **Day 2:** deploy `queueshield`; live gateway write path (`src/live/fabric.ts`), events (`events.ts` with file checkpointer), L3 live.
4. **Day 3:** MVCC retries (5×, 50–400 ms jitter) + metrics, `/v1/network` from `qscc:GetChainInfo`, YSQL read model, L4/L7 live.
5. **Day 4:** `bench/bench.ts` at 10/25/50 tx/s → `data/ledger_bench.json` (L10; M2's ledger model reads it); screenshots of 11 containers + a YSQL query.
6. L9 TAT live (needs `tat.ts` sweeper calling `paystate:CheckTAT`).
7. [STRETCH] private data collection `payPrivate` (L11), Org3 authority.

## Known issues / decisions
- Contract functions return JSON strings, not structs (contractapi v1.2.x limitation, see `chaincode/api.go`). The live gateway must `JSON.parse` results (noted in `gateway/src/live/README.md`).
- `RevokeAdvisory` on an already revoked advisory is now a no-op (no write, no second `AdvisoryRevoked` event); revoke reasons are limited to 200 characters like advisory reasons.
- `go.sum` is not committed: the 2026-10-23 build ran where proxy.golang.org, gopkg.in and golang.org/x are blocked, using temporary local `replace` directives in a scratch modfile (nothing in `go.mod` changed). Generate `go.sum`/`vendor/` on the Drunix machine.
- `disputedReason` is not a field of the stored payment record (schema has `additionalProperties: false`); it travels only in the `PaymentUpdated` event payload. DISPUTED append-only transitions emit no event (golden vectors), although spec §4.3 rule 1 says every non-no-op emits one — the vectors win.
- Mock-only header `X-QS-As-Msp` lets tests act as another org (403 paths). The live gateway picks identities itself and must ignore it.
- `routes.ts` refuses `LEDGER_MODE=live` until `src/live/` exists — it never fakes a ledger.

## Reused from the IBM project
Nothing — the IBM project had no ledger. Everything here is new.
