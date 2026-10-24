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
        self.ledger_pending: list = []           # (kind, body, owner) awaiting a successful write
        self.ledger_status: dict = {}            # decision/advisory id -> {"tx_id", "block_number"} or pending
        self._n = {"rec": 0, "act": 0, "adv": 0, "dec": 0}
        # M4-T01: what each ledger id belongs to, so ledger confirmations can be re-published on `decision`
        self.dec_info: dict = {}                 # dec_id -> {"rec_id", "adv_ids": [...]}
        self.adv_dec: dict = {}                  # adv_id -> dec_id
        # M4-T02: budget publication pacing
        self._budget_last_ms: Optional[int] = None
        self._budget_force = False
        # M4-T03: rollback tracking. action_id -> {"action", "rec_action", "incident_id", "verdict", "adv_ids",
        #         "clean", "state": ACTIVE|PROPOSED|ROLLED_BACK|DECLINED|M2_REJECTED, "prop_rec_id"}
        self.rollbackable: dict = {}
        self.rollback_of_rec: dict = {}          # rollback rec_id -> original action_id

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
            new_recs += self._rollback_proposals()
            self._expire()
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
        self.recs[rec["rec_id"]] = rec
        self.rec_of_incident[inc["incident_id"]] = rec["rec_id"]
        self.last_key[inc["incident_id"]] = key
        self.publish("recommendation", rec)
        self._merge_bank_packages(rec)
        return rec

    @staticmethod
    def _bank_of(rec: dict) -> Optional[str]:
        b = rec["segment_id"].split(":")[2]
        return None if b == "*" else b

    def _merge_bank_packages(self, new: dict) -> None:
        """M4-T04: one bank fault seen on several segments (e.g. route:P1:B1 and route:P2:B1) gives one package.

        When two PENDING BANK_SIDE recommendations name the same bank, the older one is superseded by the newer.
        "At most one PENDING per incident" still holds: superseding never creates a package.
        """
        bank = self._bank_of(new)
        if new["verdict"] != "BANK_SIDE" or bank is None:
            return
        for old in list(self.recs.values()):
            if (old is not new and old["status"] == "PENDING" and old["rec_id"] not in self.rollback_of_rec
                    and old["verdict"] == "BANK_SIDE" and old["incident_id"] != new["incident_id"]
                    and self._bank_of(old) == bank):
                self._set_status(old, "SUPERSEDED")

    def on_ledger_event(self, ev: dict) -> None:
        if not contracts.accept("ledger_event", ev):
            return
        p = ev["payload"]
        if ev["name"] in ("DecisionRecorded", "AdvisoryIssued") and "id" in p:
            self.ledger_status[p["id"]] = {"tx_id": ev["tx_id"], "block_number": ev["block_number"]}
            dec_id = p["id"] if ev["name"] == "DecisionRecorded" else self.adv_dec.get(p["id"])
            if dec_id in self.dec_info:
                self._publish_ledger_status(dec_id)

    # ------------------------------------------------------------------ ledger status (M4-T01)
    def _ledger_view(self, dec_id: str) -> dict:
        info = self.dec_info[dec_id]
        ds = self.ledger_status.get(dec_id, {})
        ads = [self.ledger_status.get(a, {}) for a in info["adv_ids"]]
        pending = bool(ds.get("pending")) or any(a.get("pending") for a in ads)
        return {"decision_tx": ds.get("tx_id"), "decision_id": dec_id, "block_number": ds.get("block_number"),
                "advisory_txs": [a["tx_id"] for a in ads if a.get("tx_id")], "pending": pending}

    def _publish_ledger_status(self, dec_id: str) -> None:
        """Re-publish `event: decision` when the ledger confirms a write, so M5 can show "tx … · block …"."""
        info = self.dec_info[dec_id]
        self.publish("decision", {"rec_id": info["rec_id"], "decision_id": dec_id, "ledger": self._ledger_view(dec_id)})

    # ------------------------------------------------------------------ recommendations
    def _set_status(self, rec: dict, status: str) -> None:
        rec["status"] = status
        self.publish("recommendation", rec)

    def _expire(self) -> None:
        ttl = self.cfg.c.recommendations.expiry_sim_s * 1000
        for rec in self.recs.values():
            if rec["status"] == "PENDING" and self.now_ms - rec["created_sim_ms"] >= ttl:
                self._set_status(rec, "EXPIRED")
                orig = self.rollback_of_rec.get(rec["rec_id"])
                if orig is not None:                               # proposal ignored: propose again later
                    tr = self.rollbackable[orig]
                    tr["state"], tr["clean"] = "ACTIVE", 0
                else:
                    self.last_key.pop(rec["incident_id"], None)    # rebuilt next tick if the incident persists

    def pending(self) -> list:
        return [r for r in self.recs.values() if r["status"] == "PENDING"]

    # ------------------------------------------------------------------ governor
    def _budgets(self) -> list:
        if self.snapshot is None:
            return []
        out = []
        gap_ms = self.cfg.c.governor.min_publish_interval_s * 1000
        force = self._budget_force or self._budget_last_ms is None
        if not force and self.now_ms - self._budget_last_ms < gap_ms:
            return []                                            # M4-T02: at most one publication per interval
        self._budget_force = False
        for psp, b in governor.compute_budgets(self.cfg, self.snapshot).items():
            if not force and not governor.changed(self.cfg, self.budgets.get(psp), b):
                continue
            self.budgets[psp] = b
            a = self._new_action("CHECK_BUDGET", {"psp": psp}, b, None, "POLICY_DEFAULT")
            out.append(a)
            self.publish("budget", {"psp": psp, "rate_per_s": b["rate_per_s"], "burst": b["burst"],
                                    "first_check_delay_ms": b["first_check_delay_ms"],
                                    "ledger_wait_ms": b["ledger_wait_ms"], "origin": "POLICY_DEFAULT"})
        if out:
            self._budget_last_ms = int(self.now_ms)
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
            # 2. actions for M2 (HOLD_MONITOR / ESCALATE_HUMAN have no simulator effect)
            sim_chosen = [a for a in chosen if a["action_type"] not in policy.NO_SIM_EFFECT]
            actions = [self._new_action(a["action_type"], scope_of(a["scope_segment_id"]), a["params"],
                                        rec["rec_id"], "ROLLBACK" if a["action_type"] == "ROLLBACK"
                                        else "OPERATOR_APPROVED")
                       for a in sim_chosen]
            # 3-4. ledger: decision, then advisories (SI-9: each carries the decision id)
            advisories = []
            adv_by_type: dict = {}
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
                adv_by_type.setdefault(a["action_type"], []).append(adv["id"])
            self.dec_info[dec_id] = {"rec_id": rec["rec_id"], "adv_ids": [a["id"] for a in advisories]}
            for adv in advisories:
                self.adv_dec[adv["id"]] = dec_id
            for kind, body in [("decisions", dec_body)] + [("advisories", a) for a in advisories]:
                self._ledger_write(kind, body)
            ledger = self._ledger_view(dec_id)
            # M4-T03: track what can be rolled back, and carry out approved rollbacks
            for src, act in zip(sim_chosen, actions):
                if act["action_type"] == "ROLLBACK":
                    continue
                self.rollbackable[act["action_id"]] = {
                    "action": act, "rec_action": src, "incident_id": rec["incident_id"], "verdict": rec["verdict"],
                    "rec": rec, "adv_ids": adv_by_type.get(src["action_type"], []), "clean": 0, "state": "ACTIVE"}
                if act["action_type"] == "DEFER_CHECKS":
                    self._budget_force = True
            orig = self.rollback_of_rec.get(rec["rec_id"])
            if orig is not None:
                self._finish_rollback(orig, approved=bool(chosen))
            resp = {"rec_id": rec["rec_id"], "status": status, "action_ids": [a["action_id"] for a in actions],
                    "ledger": ledger}
            self.decisions[rec["rec_id"]] = {**resp, "decision": d, "decision_id": dec_id}
            self.publish("decision", {**resp, "decision_id": dec_id, "operator": d["operator"],
                                      "decision": d["decision"], "decided_sim_ms": int(self.now_ms)})
            return {"resp": resp, "actions": actions, "advisories": advisories}

    def _ledger_write(self, kind: str, body: dict, retry: bool = False) -> Optional[str]:
        try:
            if kind == "revoke":
                r = self.ledger.revoke(body["id"], body["reason"])
                return r.get("tx_id")
            r = self.ledger.write(kind, body)
            self.ledger_status[body["id"]] = {"tx_id": r.get("tx_id"), "block_number": r.get("block_number")}
            if retry:                                          # a queued write landed late: tell M5
                dec_id = body["id"] if kind == "decisions" else self.adv_dec.get(body["id"])
                if dec_id in self.dec_info:
                    self._publish_ledger_status(dec_id)
            return r.get("tx_id")
        except LedgerUnavailable as exc:
            jsonlog.warn("ledger write failed; queued", run_id=self.run_id, id=body["id"], err=str(exc))
            self.ledger_pending.append((kind, body))
            if kind != "revoke":
                self.ledger_status[body["id"]] = {"pending": True}
            return None

    def retry_ledger(self) -> None:
        """Retry queued writes (called every tick and by the live retry timer every pending_retry_s)."""
        queue, self.ledger_pending = self.ledger_pending, []
        for kind, body in queue:
            self._ledger_write(kind, body, retry=True)

    # ------------------------------------------------------------------ rollback proposals (M4-T03, C-9)
    def _segment_state(self, segment_id: str) -> Optional[str]:
        for seg in (self.snapshot or {}).get("segments", []):
            if seg["segment_id"] == segment_id:
                return seg["state"]
        return None

    def _is_clean(self, tr: dict) -> bool:
        """Clean tick for an applied action: its incident is closed, the network is MONITORING and the action's
        scope segment is MONITORING. (IBM bug avoided: no proposals while the incident is still open.)"""
        inc = self.incidents.get(tr["incident_id"])
        return ((inc is None or inc["state"] == "CLOSED")
                and (self.snapshot or {}).get("global_state") == "MONITORING"
                and self._segment_state(tr["rec_action"]["scope_segment_id"]) in ("MONITORING", None))

    def _rollback_proposals(self) -> list:
        need = self.cfg.c.rollback.clean_ticks
        out = []
        for action_id, tr in self.rollbackable.items():
            if tr["state"] != "ACTIVE":
                continue
            tr["clean"] = tr["clean"] + 1 if self._is_clean(tr) else 0
            if tr["clean"] < need:
                continue
            rec = self._rollback_rec(action_id, tr)
            contracts.validate("recommendation", rec)
            self.recs[rec["rec_id"]] = rec
            self.rollback_of_rec[rec["rec_id"]] = action_id
            tr["state"], tr["prop_rec_id"] = "PROPOSED", rec["rec_id"]
            self.publish("recommendation", rec)
            out.append(rec)
        return out

    def _rollback_rec(self, action_id: str, tr: dict) -> dict:
        src, orig = tr["rec_action"], tr["rec"]
        text = self.cfg.policy["text"]
        return {"rec_id": self._id("rec", 4), "incident_id": tr["incident_id"], "run_id": self.run_id,
                "created_sim_ms": int(self.now_ms), "segment_id": src["scope_segment_id"], "severity": "WARNING",
                "verdict": tr["verdict"], "p_stuck": None, "confidence": 1.0, "countdown_s_estimate": None,
                "actions": [{"action_type": "ROLLBACK", "params": {"action_id": action_id},
                             "scope_segment_id": src["scope_segment_id"], "eligible": True, "blocked_by": None,
                             "advisory_kind": None,
                             "side_effect": f"{text['side_effect']['ROLLBACK']} ({src['action_type']})",
                             "rollback_condition": text["rollback_condition"]["ROLLBACK"]}],
                "reasons": [], "status": "PENDING", "model_versions": orig["model_versions"],
                "features_sha256": orig["features_sha256"]}

    def _finish_rollback(self, action_id: str, approved: bool) -> None:
        tr = self.rollbackable[action_id]
        if not approved:
            tr["state"] = "DECLINED"                          # the operator chose to keep it: never re-proposed
            return
        tr["state"] = "ROLLED_BACK"
        if tr["action"]["action_type"] == "DEFER_CHECKS":
            self._budget_force = True
        for adv_id in tr["adv_ids"]:
            self._ledger_write("revoke", {"id": adv_id, "reason": f"rolled back ({action_id})"})

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
            tr = self.rollbackable.get(action_id)
            if tr is not None and body.get("result") == "REJECTED" and tr["state"] == "ACTIVE":
                tr["state"] = "M2_REJECTED"                   # never took effect: nothing to roll back
