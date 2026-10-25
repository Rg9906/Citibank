"""Per-run control state machine shared by live, mock and batch (docs/M4_CONTROL.md §5-§9).

Inputs: M3 ticks (with incidents) and M1 ledger events. Outputs: recommendations (to M5), actions (to M2),
decisions and advisories (to M1). Every sim-time field uses the latest tick's clock, never wall time.
Safety invariants are enforced here and property-tested in tests/: SI-2 (blocked never approved),
SI-3 (no OPERATOR_APPROVED action without a decision), SI-5 (budget bounds), SI-9 (no advisory without decision).
"""
from __future__ import annotations

import hashlib
import json
import threading
from typing import Callable, Optional

from qctl import contracts, governor, jsonlog, policy
from qctl.ledger import LedgerUnavailable


class Conflict(Exception):
    pass


class BadRequest(Exception):
    pass


def canonical_sha256(obj) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def scope_of(segment_id: str) -> dict:
    _, p, b = segment_id.split(":")
    out = {}
    if p != "*":
        out["psp"] = p
    if b != "*":
        out["bank"] = b
    return out


class RunControl:
    def __init__(self, cfg, run_id: str, ledger, operator_mode: str = "human",
                 operator_delay_s: Optional[float] = None, publish: Optional[Callable[[str, dict], None]] = None) -> None:
        self.cfg, self.run_id, self.ledger = cfg, run_id, ledger
        self.operator_mode = operator_mode
        self.operator_delay_ms = int(1000 * (operator_delay_s if operator_delay_s is not None
                                             else cfg.c.operator.delay_s))
        self.publish = publish or (lambda ev, data: None)
        self.lock = threading.RLock()
        self.now_ms = 0
        self.snapshot: Optional[dict] = None
        self.incidents: dict = {}
        self.recs: dict = {}
        self.rec_of_incident: dict = {}
        self.last_key: dict = {}                 # incident_id -> (severity, verdict) of its last recommendation
        self.actions: list = []
        self.applied: dict = {}
        self.decisions: dict = {}                # rec_id -> response
        self.budgets: dict = {}
        self.budget_sent_ms: dict = {}           # psp -> sim time of the last CHECK_BUDGET (M4-T02)
        self.budget_force = False                # set when a DEFER_CHECKS is approved or rolled back
        self.active: dict = {}                   # action_id -> rollback tracking (M4-T03 / C-9)
        self.ledger_pending: list = []           # (kind, body, owner) awaiting a successful write
        self.ledger_status: dict = {}            # decision/advisory id -> {"tx_id", "block_number"} or pending
        self.decision_events: dict = {}          # decision id -> last published `decision` payload (M4-T01)
        self._n = {"rec": 0, "act": 0, "adv": 0, "dec": 0}

    def _id(self, kind: str, width: int) -> str:
        self._n[kind] += 1
        return f"{kind}-{self._n[kind]:0{width}d}"

    # ------------------------------------------------------------------ inputs
    def on_tick(self, snapshot: dict) -> dict:
        """Process one M3 tick. Returns what changed (used by the batch response)."""
        with self.lock:
            self.snapshot = snapshot
            self.now_ms = snapshot["tick_sim_ms"]
            new_recs, new_actions, new_adv = [], [], []
            for inc in snapshot.get("incidents", []):
                r = self.on_incident(inc)
                if r:
                    new_recs.append(r)
            self._expire()
            r = self._rollbacks()
            if r:
                new_recs.append(r)
            new_actions += self._budgets()
            if self.operator_mode == "auto":
                for res in self._auto_operator():
                    new_actions += res["actions"]
                    new_adv += res["advisories"]
            self.retry_ledger()
            return {"recommendations": new_recs, "actions": new_actions, "advisories": new_adv}

    def on_incident(self, inc: dict) -> Optional[dict]:
        if not contracts.accept("incident", inc):
            return None
        self.incidents[inc["incident_id"]] = inc
        old_id = self.rec_of_incident.get(inc["incident_id"])
        old = self.recs.get(old_id) if old_id else None
        if inc["state"] == "CLOSED":
            if old and old["status"] == "PENDING":          # IBM bug: recs stayed approvable after close
                self._set_status(old, "EXPIRED")
            return None
        key = (inc["severity"], inc["verdict"])
        if old and old["status"] == "PENDING" and self.last_key.get(inc["incident_id"]) == key:
            return None
        if old and old["status"] == "PENDING":
            self._set_status(old, "SUPERSEDED")
        if old and old["status"] != "PENDING" and self.last_key.get(inc["incident_id"]) == key:
            return None                                      # already decided for this severity/verdict
        rec = policy.recommendation(self.cfg, self._id("rec", 4), inc, self.snapshot, self.now_ms)
        contracts.validate("recommendation", rec)
        if rec["verdict"] == "BANK_SIDE":                    # M4-T04: one package per bank fault
            bank = policy.context(inc, self.snapshot)["bank"]
            for other in self.pending():
                if other["verdict"] == "BANK_SIDE" and other["incident_id"] != inc["incident_id"] and                         bank and policy.context(self.incidents.get(other["incident_id"], inc),
                                                self.snapshot)["bank"] == bank:
                    self._set_status(other, "SUPERSEDED")
        self.recs[rec["rec_id"]] = rec
        self.rec_of_incident[inc["incident_id"]] = rec["rec_id"]
        self.last_key[inc["incident_id"]] = key
        self.publish("recommendation", rec)
        return rec

    def on_ledger_event(self, ev: dict) -> None:
        if not contracts.accept("ledger_event", ev):
            return
        p = ev["payload"]
        if ev["name"] not in ("DecisionRecorded", "AdvisoryIssued") or "id" not in p:
            return
        with self.lock:
            self.ledger_status[p["id"]] = {"tx_id": ev["tx_id"], "block_number": ev["block_number"]}
            # M4-T01: re-publish the decision with its ledger proof so M5 can show "tx … · block …"
            dec_id = p["id"] if ev["name"] == "DecisionRecorded" else p.get("decisionId")
            out = self.decision_events.get(dec_id)
            if out is None:
                return
            ledger = dict(out["ledger"])
            if ev["name"] == "DecisionRecorded":
                ledger.update(decision_tx=ev["tx_id"], block_number=ev["block_number"])
            elif ev["tx_id"] not in ledger["advisory_txs"]:
                ledger["advisory_txs"] = ledger["advisory_txs"] + [ev["tx_id"]]
            ledger["pending"] = any(self.ledger_status.get(i, {}).get("pending") for i in out["ledger_ids"])
            if ledger == out["ledger"]:
                return
            out["ledger"] = ledger
            self.publish("decision", {k: v for k, v in out.items() if k != "ledger_ids"})

    # ------------------------------------------------------------------ recommendations
    def _set_status(self, rec: dict, status: str) -> None:
        rec["status"] = status
        self.publish("recommendation", rec)

    def _expire(self) -> None:
        ttl = self.cfg.c.recommendations.expiry_sim_s * 1000
        for rec in self.recs.values():
            if rec["status"] == "PENDING" and self.now_ms - rec["created_sim_ms"] >= ttl:
                self._set_status(rec, "EXPIRED")
                if self.rec_of_incident.get(rec["incident_id"]) == rec["rec_id"]:   # not a rollback proposal
                    self.last_key.pop(rec["incident_id"], None)        # rebuilt next tick if the incident persists

    def pending(self) -> list:
        return [r for r in self.recs.values() if r["status"] == "PENDING"]

    # ------------------------------------------------------------------ governor
    def _budgets(self) -> list:
        if self.snapshot is None:
            return []
        out = []
        gap = self.cfg.c.governor.min_publish_interval_s * 1000
        force, self.budget_force = self.budget_force, False
        for psp, b in governor.compute_budgets(self.cfg, self.snapshot).items():
            old = self.budgets.get(psp)
            if not governor.changed(self.cfg, old, b):
                continue
            tighter = old is not None and b["rate_per_s"] < old["rate_per_s"]
            recent = psp in self.budget_sent_ms and self.now_ms - self.budget_sent_ms[psp] < gap
            if recent and not tighter and not force:
                continue                                     # loosening waits; SI-5 bounds hold either way
            self.budgets[psp] = b
            self.budget_sent_ms[psp] = self.now_ms
            a = self._new_action("CHECK_BUDGET", {"psp": psp}, b, None, "POLICY_DEFAULT")
            out.append(a)
            self.publish("budget", {"psp": psp, "rate_per_s": b["rate_per_s"], "burst": b["burst"],
                                    "first_check_delay_ms": b["first_check_delay_ms"],
                                    "ledger_wait_ms": b["ledger_wait_ms"], "origin": "POLICY_DEFAULT"})
        return out

    # ------------------------------------------------------------------ decisions
    def _new_action(self, atype: str, scope: dict, params: dict, rec_id: Optional[str], origin: str) -> dict:
        a = {"action_id": self._id("act", 5), "rec_id": rec_id, "run_id": self.run_id, "action_type": atype,
             "scope": scope, "params": params, "effective_from_sim_ms": int(self.now_ms), "expires_sim_ms": None,
             "origin": origin}
        contracts.validate("action", a)
        self.actions.append(a)
        return a

    def decide(self, d: dict) -> dict:
        """POST /v1/decisions. Raises BadRequest (400) or Conflict (409)."""
        errs = contracts.errors("decision", d)
        if errs:
            raise BadRequest(errs[0])
        with self.lock:
            if d["operator"] not in self.cfg.operators:
                raise BadRequest(f"unknown operator {d['operator']}")
            rec = self.recs.get(d["rec_id"])
            if rec is None:
                raise BadRequest(f"unknown recommendation {d['rec_id']}")
            if rec["status"] != "PENDING":
                raise Conflict(f"{d['rec_id']} is {rec['status']}")
            if d["decision"] == "REJECT":
                chosen = []
            elif d["decision"] == "APPROVE_ALL":
                chosen = [a for a in rec["actions"] if a["eligible"]]
            else:
                want = set(d["actions_selected"])
                blocked = [a["action_type"] for a in rec["actions"] if a["action_type"] in want and not a["eligible"]]
                if blocked:
                    raise Conflict(f"blocked actions cannot be approved (SI-2): {blocked}")
                missing = want - {a["action_type"] for a in rec["actions"]}
                if missing:
                    raise BadRequest(f"not in the recommendation: {sorted(missing)}")
                chosen = [a for a in rec["actions"] if a["action_type"] in want]
            n_eligible = sum(1 for a in rec["actions"] if a["eligible"])
            status = "REJECTED" if not chosen else ("APPROVED" if len(chosen) == n_eligible else "PARTIAL")
            # 1. decision record first (SI-3: an OPERATOR_APPROVED action always has a decision)
            dec_id = self._id("dec", 5)
            dec_body = {"id": dec_id, "recId": rec["rec_id"], "decision": d["decision"], "operator": d["operator"],
                        "actionsApproved": [a["action_type"] for a in chosen],
                        "modelVersions": rec["model_versions"], "featuresSha256": rec["features_sha256"],
                        "decidedSimMs": int(self.now_ms)}
            contracts.validate("ledger_decision", dec_body)
            self._set_status(rec, status)
            if any(a["action_type"] in ("DEFER_CHECKS", "ROLLBACK") for a in chosen):
                self.budget_force = True                     # M4-T02: republish budgets on the next tick
            # 2. actions for M2 (HOLD_MONITOR / ESCALATE_HUMAN have no simulator effect)
            actions = [self._new_action(a["action_type"], scope_of(a["scope_segment_id"]), a["params"],
                                        rec["rec_id"], "OPERATOR_APPROVED")
                       for a in chosen if a["action_type"] not in policy.NO_SIM_EFFECT]
            # 3-4. ledger: decision, then advisories (SI-9: each carries the decision id)
            advisories = []
            evidence = "sha256:" + canonical_sha256(rec)
            for a in rec["actions"]:
                is_chosen = a in chosen
                blocked_shift = a["action_type"] == "SHIFT_TRAFFIC" and not a["eligible"] and chosen
                if not a.get("advisory_kind") or not (is_chosen or blocked_shift):
                    continue
                adv = {"id": self._id("adv", 5), "kind": a["advisory_kind"], "segmentId": a["scope_segment_id"],
                       "params": a["params"], "reason": (a.get("blocked_by") or a["side_effect"])[:200],
                       "evidenceHash": evidence, "decisionId": dec_id, "issuedSimMs": int(self.now_ms),
                       "validForSec": (self.cfg.c.ledger.do_not_shift_valid_s if a["advisory_kind"] == "DO_NOT_SHIFT"
                                       else self.cfg.c.ledger.advisory_valid_s)}
                contracts.validate("advisory", adv)
                advisories.append(adv)
            ledger = {"decision_tx": None, "block_number": None, "advisory_txs": [], "pending": False}
            for kind, body in [("decisions", dec_body)] + [("advisories", a) for a in advisories]:
                tx = self._ledger_write(kind, body)
                if tx is None:
                    ledger["pending"] = True
                elif kind == "decisions":
                    ledger["decision_tx"] = tx
                    ledger["block_number"] = self.ledger_status[dec_id].get("block_number")
                else:
                    ledger["advisory_txs"].append(tx)
            self._track(rec, chosen, actions, advisories)
            resp = {"rec_id": rec["rec_id"], "status": status, "action_ids": [a["action_id"] for a in actions],
                    "decision_id": dec_id, "ledger": ledger}
            self.decisions[rec["rec_id"]] = {**resp, "decision": d}
            event = {**resp, "ledger": dict(ledger), "operator": d["operator"], "decision": d["decision"],
                     "decided_sim_ms": int(self.now_ms)}
            self.decision_events[dec_id] = {**event, "ledger_ids": [dec_id] + [a["id"] for a in advisories]}
            self.publish("decision", event)
            return {"resp": resp, "actions": actions, "advisories": advisories}

    # ------------------------------------------------------------------ rollback proposals (§5, C-9)
    def _track(self, rec: dict, chosen: list, actions: list, advisories: list) -> None:
        """Remember approved actions so they can be rolled back; on a ROLLBACK approval, revoke advisories."""
        by_kind = {a["kind"]: a["id"] for a in advisories}
        sim = iter(actions)
        for ra in chosen:
            if ra["action_type"] in policy.NO_SIM_EFFECT:
                continue
            act = next(sim)
            if ra["action_type"] == "ROLLBACK":
                orig = self.active.pop(ra["params"]["action_id"], None)
                for adv_id in (orig or {}).get("advisories", []):
                    try:
                        self.ledger.revoke(adv_id, f"rolled back by {act['action_id']}")
                    except LedgerUnavailable as exc:   # the advisory still expires on its own (validForSec)
                        jsonlog.warn("advisory revoke failed", run_id=self.run_id, id=adv_id, err=str(exc))
                continue
            if ra["rollback_condition"] == "n/a":
                continue
            kind = ra.get("advisory_kind")
            self.active[act["action_id"]] = {
                "action": act, "segment_id": ra["scope_segment_id"], "rec": rec, "clean": 0, "proposal": None,
                "advisories": [by_kind[kind]] if kind in by_kind else []}

    def _rollbacks(self) -> Optional[dict]:
        """After `rollback.clean_ticks` clean ticks on an action's scope, propose one ROLLBACK (PENDING)."""
        need = self.cfg.c.rollback.clean_ticks
        for action_id, st in self.active.items():
            prop = self.recs.get(st["proposal"]) if st["proposal"] else None
            if prop is not None and prop["status"] == "PENDING":
                continue
            if prop is not None and prop["status"] == "REJECTED":
                continue                                    # the operator chose to keep it; do not nag
            if prop is not None:                            # EXPIRED: start counting again
                st["proposal"], st["clean"] = None, 0
            seg = policy._seg(self.snapshot, st["segment_id"])
            clean = seg is not None and seg["state"] == "MONITORING" and                 self.snapshot.get("global_state") != "DEGRADED_MONITORING"
            st["clean"] = st["clean"] + 1 if clean else 0
            if st["clean"] < need:
                continue
            src, a = st["rec"], st["action"]
            rec = {"rec_id": self._id("rec", 4), "incident_id": src["incident_id"], "run_id": self.run_id,
                   "created_sim_ms": int(self.now_ms), "segment_id": st["segment_id"], "severity": "WARNING",
                   "verdict": src["verdict"], "p_stuck": None, "confidence": 1.0, "countdown_s_estimate": None,
                   "actions": [{"action_type": "ROLLBACK", "params": {"action_id": action_id},
                                "scope_segment_id": st["segment_id"], "eligible": True, "blocked_by": None,
                                "advisory_kind": None,
                                "side_effect": f"{self.cfg.policy['text']['side_effect']['ROLLBACK']} "
                                               f"({a['action_type']} {action_id})",
                                "rollback_condition": "n/a"}],
                   "reasons": [], "status": "PENDING", "model_versions": src["model_versions"],
                   "features_sha256": src["features_sha256"]}
            contracts.validate("recommendation", rec)
            self.recs[rec["rec_id"]] = rec
            st["proposal"] = rec["rec_id"]
            self.publish("recommendation", rec)
            return rec                                       # at most one new proposal per tick
        return None

    def _ledger_write(self, kind: str, body: dict) -> Optional[str]:
        try:
            r = self.ledger.write(kind, body)
            self.ledger_status[body["id"]] = {"tx_id": r.get("tx_id"), "block_number": r.get("block_number")}
            return r.get("tx_id")
        except LedgerUnavailable as exc:
            jsonlog.warn("ledger write failed; queued", run_id=self.run_id, id=body["id"], err=str(exc))
            self.ledger_pending.append((kind, body))
            self.ledger_status[body["id"]] = {"pending": True}
            return None

    def retry_ledger(self) -> None:
        """Retry queued writes (called every tick and by the live retry timer every pending_retry_s)."""
        queue, self.ledger_pending = self.ledger_pending, []
        for kind, body in queue:
            self._ledger_write(kind, body)

    # ------------------------------------------------------------------ simulated operator (§8)
    def _auto_operator(self) -> list:
        out = []
        for rec in list(self.pending()):
            if self.now_ms - rec["created_sim_ms"] < self.operator_delay_ms:
                continue
            if rec["confidence"] < self.cfg.c.recommendations.min_confidence_auto:
                continue                                         # waits and re-checks next tick
            res = self.decide({"rec_id": rec["rec_id"], "decision": "APPROVE_ALL", "operator": "auto_operator",
                               "actions_selected": []})
            out.append(res)
        return out

    # ------------------------------------------------------------------ action queue (§7)
    def pending_actions(self, since: Optional[str]) -> list:
        with self.lock:
            return [a for a in self.actions if since is None or a["action_id"] > since]

    def mark_applied(self, action_id: str, body: dict) -> None:
        with self.lock:
            if not any(a["action_id"] == action_id for a in self.actions):
                raise BadRequest(f"unknown action {action_id}")
            self.applied[action_id] = body
