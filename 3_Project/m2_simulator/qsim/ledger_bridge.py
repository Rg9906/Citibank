"""Ledger bridge (docs/M2_SIMULATOR.md §5, docs/01_SYSTEM.md §5, test S-11).

- model: implemented inside engine.py (`_h_ledger_open`, `_truth_changed`, `_h_ledger_resolve`), lognormal submit
  latency + event lag from config `ledger_model` (replace with `data/ledger_bench.json` once M1 measures it).
- live / mock: `LedgerBridge` below talks to the M1 gateway (live Drunix or the M1 mock: same routes).
  Unknown payments are opened with `POST /v1/payments`, banks attest legs with `POST /v1/payments/{txnRef}/attest`
  (the gateway picks the owning org), and a payment is resolved **only** on a terminal `PaymentUpdated` read from
  `GET /v1/stream`. Writes run on one background thread in order (open before attest); the engine never blocks on
  HTTP. Nothing is faked: if the gateway is unreachable the bridge reports `healthy = False`, the engine falls back
  to `model` for new unknowns, and `/v1/status` shows the backlog and health `degraded` (docs/01_SYSTEM.md §10).
"""
from __future__ import annotations

import json
import queue
import threading
import time
from typing import Optional

import httpx

from qsim import contracts, ids, jsonlog

SUPPORTED_MODES = ("model", "live", "mock")
TERMINAL = {"SUCCESS": "SUCCESS", "FAILED_NO_DEBIT": "FAILED_NO_DEBIT", "REVERSED": "REVERSED",
            "DISPUTED": "DISPUTED"}           # DISPUTED releases the payment to the client's own checks
FINAL_FACTS = ("CREDIT", "REVERSAL", "FAILURE_REMITTER")
FAIL_LIMIT = 3            # consecutive failed writes before the bridge declares itself unhealthy
WRITERS = 16              # parallel writers; one txnRef always maps to the same writer, so its order is kept


def mode_supported(mode: str) -> bool:
    return mode in SUPPORTED_MODES


def facts(p) -> list:
    """Bank-side facts for a payment, in the order the banks would attest them (payment level, all attempts)."""
    out = []
    debited = any(a.debited for a in p.attempts)
    if debited:
        out.append("DEBIT")
    if any(a.credited for a in p.attempts):
        out.append("CREDIT")
        return out
    if debited and any(a.failed for a in p.attempts):
        out.append("FAILURE_BENEFICIARY")
        if any(a.reversed for a in p.attempts) and p.truth() == "FAILED":
            out.append("REVERSAL")
    if not debited and p.truth() == "FAILED":
        out.append("FAILURE_REMITTER")
    return out


class LedgerBridge:
    def __init__(self, url: str, run_id: str, api_key: str = "", max_backlog: int = 50_000,
                 timeout_s: float = 5.0, writers: int = WRITERS) -> None:
        self.url, self.run_id = url.rstrip("/"), run_id
        self.headers = {"X-QS-Key": api_key}
        self.timeout_s = timeout_s
        self.ops = [queue.Queue(maxsize=max(1, max_backlog // writers)) for _ in range(writers)]
        self.inbox: queue.Queue = queue.Queue()          # (txnRef, terminal state) for the engine thread
        self.sent: dict = {}                              # txnRef -> facts already enqueued
        self.healthy = True
        self.stats = {"opened": 0, "attested": 0, "resolved_events": 0, "write_errors": 0, "disputed": 0,
                      "dropped": 0}
        self._fails = 0
        self._stop = threading.Event()
        self._lock = threading.Lock()                     # stats/health are touched by every writer
        self._threads = [threading.Thread(target=self._writer, args=(q,), name=f"ledger-writer-{i}", daemon=True)
                         for i, q in enumerate(self.ops)]
        self._threads.append(threading.Thread(target=self._subscriber, name="ledger-stream", daemon=True))
        self._stream_ready = threading.Event()

    # ------------------------------------------------------------------ lifecycle
    def start(self, wait_stream_s: float = 5.0) -> "LedgerBridge":
        for t in self._threads:
            t.start()
        self._stream_ready.wait(wait_stream_s)          # subscribe before the first write so no event is missed
        return self

    def stop(self) -> None:
        self._stop.set()
        for t in self._threads:
            t.join(timeout=3)

    @property
    def backlog(self) -> int:
        return sum(q.qsize() for q in self.ops)

    def status(self) -> dict:
        return {"healthy": self.healthy, "backlog": self.backlog, **self.stats}

    # ------------------------------------------------------------------ engine side (engine thread, no I/O)
    def txn_ref(self, p) -> str:
        return ids.txn_ref(self.run_id, p.pid)

    def open(self, p, engine) -> None:
        ref = self.txn_ref(p)
        body = {"txnRef": ref, "idemKeyHash": ids.idem_key_hash(p.ik or ids.idempotency_key(p.n), self.run_id), "payerPsp": engine.psp_names[p.home],
                "remitterBank": engine.bank_names[p.rem], "beneficiaryBank": engine.bank_names[p.ben],
                "runId": self.run_id, "simMs": int(engine.now)}
        contracts.validate("ledger_open_request", body)
        self.sent[ref] = []
        self._put(("open", ref, body))
        self.truth_changed(p, engine)                   # banks backfill legs that completed before the open

    def truth_changed(self, p, engine) -> None:
        ref = self.txn_ref(p)
        done = self.sent.get(ref)
        if done is None or any(k in FINAL_FACTS for k in done):
            return                                      # the ledger record is final; later retries are new money
        for kind in facts(p):
            if kind not in done:
                done.append(kind)
                self._put(("attest", ref, {"kind": kind, "simMs": int(engine.now)}))

    def _put(self, op: tuple) -> None:
        try:
            self.ops[hash(op[1]) % len(self.ops)].put_nowait(op)
        except queue.Full:                              # never silent: counted and logged
            self.stats["dropped"] += 1
            self.healthy = False
            jsonlog.error("ledger backlog full; write dropped", run_id=self.run_id, txn_ref=op[1])

    # ------------------------------------------------------------------ writer thread
    def _writer(self, ops: queue.Queue) -> None:
        http = httpx.Client(timeout=self.timeout_s, headers=self.headers)
        try:
            while not self._stop.is_set():
                try:
                    op = ops.get(timeout=0.2)
                except queue.Empty:
                    continue
                self._send(http, op)
        finally:
            http.close()

    def _send(self, http: httpx.Client, op: tuple) -> None:
        kind, ref, body = op
        path = "/v1/payments" if kind == "open" else f"/v1/payments/{ref}/attest"
        for attempt in range(FAIL_LIMIT):
            try:
                r = http.post(f"{self.url}{path}", json=body)
            except httpx.HTTPError as exc:
                err = type(exc).__name__
            else:
                if r.status_code in (200, 201):
                    with self._lock:
                        self._fails = 0
                        self.healthy = True
                        self.stats["opened" if kind == "open" else "attested"] += 1
                    return
                if 400 <= r.status_code < 500:          # a contract problem, not an outage: log and move on
                    with self._lock:
                        self.stats["write_errors"] += 1
                    jsonlog.error("ledger rejected write", run_id=self.run_id, txn_ref=ref, op=kind,
                                  status=r.status_code, body=r.text[:200])
                    return
                err = f"HTTP {r.status_code}"
            if self._stop.is_set():
                return
            time.sleep(0.2 * (attempt + 1))
        with self._lock:
            self.stats["write_errors"] += 1
            self._fails += 1
            if self._fails >= FAIL_LIMIT:
                self.healthy = False
        jsonlog.warn("ledger write failed", run_id=self.run_id, txn_ref=ref, op=kind, err=err)

    # ------------------------------------------------------------------ stream subscriber thread
    def _subscriber(self) -> None:
        last_id: Optional[str] = None
        backoff = 0.5
        while not self._stop.is_set():
            headers = dict(self.headers)
            if last_id:
                headers["Last-Event-ID"] = last_id
            try:
                with httpx.stream("GET", f"{self.url}/v1/stream", headers=headers,
                                  timeout=httpx.Timeout(self.timeout_s, read=None)) as r:
                    r.raise_for_status()
                    self._stream_ready.set()
                    backoff = 0.5
                    ev_name, data, eid = None, [], None
                    for line in r.iter_lines():
                        if self._stop.is_set():
                            return
                        if line.startswith("id:"):
                            eid = line[3:].strip()
                        elif line.startswith("event:"):
                            ev_name = line[6:].strip()
                        elif line.startswith("data:"):
                            data.append(line[5:].strip())
                        elif line == "":
                            if ev_name == "ledger_event" and data:
                                self._on_event(json.loads("\n".join(data)))
                            if eid:
                                last_id = eid
                            ev_name, data, eid = None, [], None
            except (httpx.HTTPError, json.JSONDecodeError) as exc:
                if self._stop.is_set():
                    return
                jsonlog.warn("ledger stream reconnect", run_id=self.run_id, err=type(exc).__name__)
                self._stream_ready.set()                # do not block start() forever on a dead gateway
                time.sleep(backoff)
                backoff = min(backoff * 2, 10.0)

    def _on_event(self, ev: dict) -> None:
        if ev.get("name") != "PaymentUpdated":
            return
        p = ev.get("payload", {})
        if p.get("runId") != self.run_id or p.get("state") not in TERMINAL:
            return
        self.stats["disputed" if p["state"] == "DISPUTED" else "resolved_events"] += 1
        self.inbox.put((p["txnRef"], TERMINAL[p["state"]]))

    def drain(self) -> list:
        out = []
        while True:
            try:
                out.append(self.inbox.get_nowait())
            except queue.Empty:
                return out
