# Demo narration — word-for-word voiceover script

For the pitch videos (25 Oct 2026). Read at a calm pace (~140 words per minute). Each video plays a **recording of a
simulation run** in the console's replay mode, so every take is identical:
`http://localhost:8000/?mode=replay&rec=<recording>&speed=4`. Recordings live in `data/recordings/`.
Times are wall-clock seconds at 4× speed; follow the **cue** if the timing drifts.

Claims policy (`00_PRODUCT.md` §8): never say "prevents outages", "predicts outages", "production-ready",
"NPCI-approved" or "Citi integration". Say "in our simulator" for every result.

---

## 00 · Full demo (4 minutes) — the order of the videos below

01 → 02 → 03 → 04 → 05 → 06. Total ≈ 4 min.

## 01 · Overview — the network at rest (≈ 30 s) · recording `s1_festive`, first 30 s

| Time | Cue on screen | Say |
|---|---|---|
| 0–10 | 3D network: payments flowing app → switch → bank | "This is QueueShield. Three payment apps, the central switch, and five banks — a scaled simulation of a UPI-style network, placed on an illustrative map. Every dot is a payment; every number is from our simulator." |
| 10–20 | Header badges | "Up top: the scenario, the simulation clock, and the state of each service. The ledger badge says mock: today the Drunix gateway runs in mock mode." |
| 20–30 | Quiet heat map | "Everything is green. Now let's stress it." |

## 02 · Festive surge stays quiet (≈ 30 s) · recording `s1_festive`, from ≈ 35 s

| Time | Cue | Say |
|---|---|---|
| 0–15 | Traffic rises | "A festive sale: demand jumps sharply. Lots of systems would page someone here." |
| 15–30 | No recommendation card | "QueueShield stays quiet: no incident, no recommendation. Arrivals went up, but latency is stable and queues drain. That's a surge, not a sick bank — and we don't wake the operator for it." |

## 03 · Bank slowdown — find the sick bank (34 s) · recording `s3_bank` at **2×**, from wall 66 s

| Time | Cue | Say |
|---|---|---|
| 0–8 | Caption "Bank B1 slows down"; arcs into Chennai (B1) turn red | "Now bank B1 slows down — for every payment app at once. Watch the network." |
| 8–20 | B1 pulses red with a beacon; heat map column B1 lights; verdict BANK_SIDE | "The localizer names it: bank side, B1. Not 'errors are up' — which bank, and at what level." |
| 20–34 | Recommendation card slides in; first approvals | "Within seconds a recommendation arrives: slow down retries, defer status checks — with its reasons, which are supporting signals, not proof of cause." |

## 04a · Human approval and ledger record (40 s) · recording `s3_bank` at 2×, continue from wall 100 s

| Time | Cue | Say |
|---|---|---|
| 0–15 | Decision log rows with tx ids; ring above the switch flashes | "An operator approves — the machine recommends; a person decides. Each decision is written to the shared ledger with a transaction id and block number. The ring above the switch is the Drunix ledger: it flashes on every event." |
| 15–40 | Caption "Unknown payments are resolved…"; verification panel shows unknowns opened and resolved | "Payments that timed out are not retried blindly. The bank that knows the outcome attests it once, and every app is pushed the answer — so the switch never gets flooded with status checks." |

## 04b · Blocked failover (≈ 20 s) · console with **all services stopped** (MOCK badge, fixture card)

The `s3_bank` recording has no failover action (M4 scoped its actions to P3 and route P1:B3), so this clip uses the
console's MOCK mode: with M1–M4 offline it shows the contract fixture, a BANK_SIDE card for bank B3 with
SHIFT_TRAFFIC locked. Keep the MOCK badge in frame.

| Time | Cue | Say |
|---|---|---|
| 0–20 | Red lock on "shift traffic", MOCK badge | "Here's the safety rule, shown on our test card. When the sick bank is shared by every app, shifting traffic to another app would only spread the fault — so the console locks that action. It can never be sent." |

## 05 · April-2025 split replay (≈ 75 s) · split tab → 8× → play, recordings `s6_u0` (left) and `s6_u4` (right)

The two panels use separate y-axes, so always say the peak numbers out loud (left peaks in the hundreds of checks
per second, right stays under ~40).

Both recordings are built from batch runs `r-S6-3-U0` / `r-S6-3-U4` (seed 3, one of the two storm seeds) with
`m5_console/scripts/rec_from_run.mjs`; the seed-1 versions are kept as `s6_u0_seed1` / `s6_u4_seed1`.

| Time | Cue | Say |
|---|---|---|
| 0–15 | Two panels side by side | "In 2025, UPI had three outages that NPCI linked to status-check traffic. This is our replay of that pattern — the same seed, two worlds. Left: no control. Right: QueueShield." |
| 15–30 | "fault onset 251 s (ground truth)" appears; both quiet | "At about 250 seconds a beneficiary bank starts swallowing credits. Watch both sides." |
| 30–50 | Left: checks shoot into the hundreds, unknowns pass a thousand, goodput falls | "On the left, payments time out, apps keep asking the switch 'did it go through?' — hundreds of times a second — and those questions become the load. Good payments collapse." |
| 50–65 | Right: checks peak under 40, goodput flat | "On the right, the same fault. Checks stay under forty a second, because the bank that knows the outcome attests it once on the ledger, and every app is pushed the answer. Payments keep flowing." |
| 65–75 | Label "replay of simulation runs" | "This is seed three. Across five seeds in our simulator, without control two runs locked into a storm like this. With QueueShield, none did." |

## 06 · Results and honesty (≈ 30 s) · deck slides "Results" and "Honest scorecard"

| Time | Cue | Say |
|---|---|---|
| 0–15 | Results table | "We compare against NPCI's own rule, not just against doing nothing. Both keep every run out of the storm. QueueShield sends 29 percent fewer payments to manual handling, because the ledger resolves them." |
| 15–30 | Open items | "And we say what's not done: we still use more status checks than the NPCI rule, and we have a duplicate-commit gap to close. That's our build-phase plan. Machines recommend, humans decide, the ledger remembers." |

---

### Recording your voice
- Record each section separately (phone voice memo is fine), then lay it over the matching video.
- If ffmpeg is used to merge: `ffmpeg -i video.mp4 -i voice.m4a -c:v copy -c:a aac -shortest out.mp4`.
