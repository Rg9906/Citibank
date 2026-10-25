# QueueShield × Drunix

**Drunix Hackathon 2026 (NPCI × Citi) · Theme: Real-Time Payments · Team Achilles**

When a UPI bank or PSP route slows down, payments time out and become *unknown*. Apps then ask the NPCI switch for the
status again and again, users retry, and that load slows the switch and causes more timeouts. NPCI attributed the
outages of 26 Mar, 2 Apr and 12 Apr 2025 to this status-check traffic.

**QueueShield** detects and localises the degrading bank or route within seconds, forecasts whether it will lock into a
storm, recommends bounded actions that **a human approves**, publishes check budgets so verification is never the
outage, and resolves unknown payments from a **shared Drunix ledger**: the bank that knows the outcome attests it once
and every PSP is pushed the answer.

> All data is synthetic. Every outcome number comes from our simulator and is labelled **simulation**.

## What is in this repository

| # | Folder | What you will find |
|---|---|---|
| 1 | [`1_Pitch_Deck/`](1_Pitch_Deck) | The pitch deck: [PDF](1_Pitch_Deck/QueueShield_pitch_deck.pdf) and [PPTX](1_Pitch_Deck/QueueShield_pitch_deck.pptx) (with speaker notes) |
| 2 | [`2_Demo_Videos/`](2_Demo_Videos) | The 4-minute [demo video](2_Demo_Videos/QueueShield_demo_final.mp4), subtitles, and one short clip per feature |
| 3 | [`3_Project/`](3_Project) | The full project: five modules, contracts, tests, docs, screenshots and simulation results |

## Watch first (4 minutes)

[**QueueShield_demo_final.mp4**](2_Demo_Videos/QueueShield_demo_final.mp4) (narrated, 1080p, subtitles burned in).
Feature clips are listed in [`2_Demo_Videos/README.md`](2_Demo_Videos/README.md).

## Run the demo in 2 minutes (no backend needed)

```bash
cd 3_Project/m5_console
npm install
npm run dev            # http://localhost:8000
```

Then open `http://localhost:8000/?mode=replay&rec=s3_bank&speed=2&demo=1` for the bank-slowdown scenario.
The full live stack is described in [`3_Project/README.md`](3_Project/README.md).

## Headline results (simulation, April-2025 replay scenario, medians of 5 seeds)

| | U0 no control | U2 NPCI rule | U4 QueueShield |
|---|---|---|---|
| Runs that locked into a status-check storm | 2 of 5 | 0 of 5 | 0 of 5 |
| Status checks per unknown payment | 18.4 | 3.0 | 7.2 |
| Unknown payments escalated to manual handling | 0 | 235 | 166 |
| Duplicate commits | 84 | 0 | 21 |

We compare against NPCI's own rule, not just "doing nothing", and report where we still lose (more checks than the NPCI
rule; a duplicate-commit gap).

## What is real and what is simulated

- **Real:** the simulator, detectors, localizer, forecaster, control rules, console, the Go chaincode and the
  TypeScript Drunix gateway, with 106 automated tests.
- **Simulated:** all payment traffic, banks, PSPs and the switch.
- **Ledger:** the demo runs on the gateway's mock mode (same REST/SSE API and events). The chaincode is written but has
  not yet been run on a live Drunix network. That is the first build-phase task.

## Architecture at a glance

| Module | Role |
|---|---|
| M1 Ledger | Drunix chaincode (`paystate`, `advisory`, `decisionlog`) and REST + SSE gateway |
| M2 Simulator | Reactive UPI-like network, scenarios, comparison arena |
| M3 Detection | Features, detectors, localizer, lock-in forecaster, incidents |
| M4 Control | Rules, check budgets, operator decisions, advisories |
| M5 Console | Operator UI, replay mode, integration and demo |
