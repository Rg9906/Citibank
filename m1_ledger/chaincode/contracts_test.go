package main

// Contract-level tests with an in-memory fake stub (no Fabric peer needed). They exercise the three contracts the
// way the gateway calls them: MSP checks, idempotent open, one event per write, append-only decisions, advisory
// listing order. The pure state machine is covered separately by logic/transitions_test.go (golden vectors).

import (
	"encoding/json"
	"sort"
	"strings"
	"testing"

	"github.com/hyperledger/fabric-chaincode-go/pkg/cid"
	"github.com/hyperledger/fabric-chaincode-go/shim"
	"github.com/hyperledger/fabric-contract-api-go/contractapi"
	"github.com/hyperledger/fabric-protos-go/ledger/queryresult"
	"google.golang.org/protobuf/types/known/timestamppb"

	"queueshield/m1_ledger/chaincode/logic"
)

type fakeStub struct {
	shim.ChaincodeStubInterface // unimplemented methods panic: the contracts must not call them
	state                       map[string][]byte
	events                      []string
	eventPayloads               [][]byte
	txSec                       int64
}

func (s *fakeStub) GetState(k string) ([]byte, error) { return s.state[k], nil }
func (s *fakeStub) PutState(k string, v []byte) error { s.state[k] = v; return nil }
func (s *fakeStub) SetEvent(name string, payload []byte) error {
	s.events = append(s.events, name)
	s.eventPayloads = append(s.eventPayloads, payload)
	return nil
}
func (s *fakeStub) GetTxTimestamp() (*timestamppb.Timestamp, error) {
	return &timestamppb.Timestamp{Seconds: s.txSec}, nil
}
func (s *fakeStub) GetStateByRange(start, end string) (shim.StateQueryIteratorInterface, error) {
	keys := []string{}
	for k := range s.state {
		if k >= start && k < end {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	// deliberately reversed: ListActive must sort itself rather than rely on state-DB order
	for i, j := 0, len(keys)-1; i < j; i, j = i+1, j-1 {
		keys[i], keys[j] = keys[j], keys[i]
	}
	kvs := make([]*queryresult.KV, 0, len(keys))
	for _, k := range keys {
		kvs = append(kvs, &queryresult.KV{Key: k, Value: s.state[k]})
	}
	return &fakeIter{kvs: kvs}, nil
}

type fakeIter struct {
	kvs []*queryresult.KV
	i   int
}

func (it *fakeIter) HasNext() bool { return it.i < len(it.kvs) }
func (it *fakeIter) Close() error  { return nil }
func (it *fakeIter) Next() (*queryresult.KV, error) {
	kv := it.kvs[it.i]
	it.i++
	return kv, nil
}

type fakeID struct {
	cid.ClientIdentity
	msp string
}

func (f fakeID) GetMSPID() (string, error) { return f.msp, nil }

type fakeCtx struct {
	stub *fakeStub
	msp  string
}

func (c *fakeCtx) GetStub() shim.ChaincodeStubInterface  { return c.stub }
func (c *fakeCtx) GetClientIdentity() cid.ClientIdentity { return fakeID{msp: c.msp} }

func newWorld() *fakeStub                 { return &fakeStub{state: map[string][]byte{}, txSec: 1_000} }
func as(s *fakeStub, msp string) *fakeCtx { return &fakeCtx{stub: s, msp: msp} }

const (
	txn  = "r-S6-7-U4:p-0000042"
	run  = "r-S6-7-U4"
	idem = "sha256:" + "ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12ab12"
)

func mustCode(t *testing.T, err error, code string) {
	t.Helper()
	if err == nil || !strings.HasPrefix(err.Error(), "QS_ERR_"+code) {
		t.Fatalf("want QS_ERR_%s, got %v", code, err)
	}
}

// The chaincode must build its metadata (contractapi validates every exported signature at start-up).
func TestChaincodeMetadataBuilds(t *testing.T) {
	_, err := contractapi.NewChaincode(
		&PayState{Contract: contractapi.Contract{Name: "paystate"}},
		&Advisory{Contract: contractapi.Contract{Name: "advisory"}},
		&DecisionLog{Contract: contractapi.Contract{Name: "decisionlog"}},
	)
	if err != nil {
		t.Fatalf("NewChaincode: %v", err)
	}
}

func TestPayStateHappyPathOneEventPerWrite(t *testing.T) {
	s, c := newWorld(), &PayState{}
	p, err := c.openUnknown(as(s, logic.RemitterMSP), txn, idem, "P1", "B1", "B2", run, 5_000, 60)
	if err != nil || p.State != logic.Unknown {
		t.Fatalf("open: %v %+v", err, p)
	}
	if _, err := c.attestDebit(as(s, logic.RemitterMSP), txn, 5_100); err != nil {
		t.Fatalf("debit: %v", err)
	}
	p, err = c.attestCredit(as(s, logic.BeneficiaryMSP), txn, 5_200)
	if err != nil || p.State != logic.Success {
		t.Fatalf("credit: %v %+v", err, p)
	}
	if len(s.events) != 3 {
		t.Fatalf("want 3 PaymentUpdated events, got %v", s.events)
	}
	for _, e := range s.events {
		if e != "PaymentUpdated" {
			t.Fatalf("unexpected event %s", e)
		}
	}
	var last map[string]interface{}
	_ = json.Unmarshal(s.eventPayloads[2], &last)
	if last["state"] != "SUCCESS" || last["prevState"] != "DEBITED" {
		t.Fatalf("bad last event %v", last)
	}
}

func TestOpenRulesAndIdempotency(t *testing.T) {
	s, c := newWorld(), &PayState{}
	_, err := c.openUnknown(as(s, logic.BeneficiaryMSP), txn, idem, "P1", "B1", "B2", run, 0, 60)
	mustCode(t, err, "FORBIDDEN")
	_, err = c.openUnknown(as(s, logic.RemitterMSP), "bad", idem, "P1", "B1", "B2", run, 0, 60)
	mustCode(t, err, "BAD_ARG")
	_, err = c.openUnknown(as(s, logic.RemitterMSP), txn, idem, "P1", "B1", "B2", run, 0, 5)
	mustCode(t, err, "BAD_ARG")
	if _, err = c.openUnknown(as(s, logic.RemitterMSP), txn, idem, "P1", "B1", "B2", run, 0, 60); err != nil {
		t.Fatal(err)
	}
	if _, err = c.openUnknown(as(s, logic.RemitterMSP), txn, idem, "P1", "B1", "B2", run, 0, 60); err != nil {
		t.Fatalf("identical re-open must be idempotent: %v", err)
	}
	if len(s.events) != 1 {
		t.Fatalf("identical re-open must not emit: %v", s.events)
	}
	_, err = c.openUnknown(as(s, logic.RemitterMSP), txn, idem, "P2", "B1", "B2", run, 0, 60)
	mustCode(t, err, "CONFLICT")
	_, err = c.attestDebit(as(s, logic.RemitterMSP), "r-S6-7-U4:p-9999999", 0)
	mustCode(t, err, "NOT_FOUND")
	_, err = c.attestFailure(as(s, logic.RemitterMSP), txn, "SIDEWAYS", "U30", 0)
	mustCode(t, err, "BAD_ARG")
}

func TestCheckTATUsesTxTime(t *testing.T) {
	s, c := newWorld(), &PayState{}
	_, _ = c.openUnknown(as(s, logic.RemitterMSP), txn, idem, "P1", "B1", "B2", run, 0, 60)
	_, _ = c.attestDebit(as(s, logic.RemitterMSP), txn, 10)
	n := len(s.events)
	if p, _ := c.checkTAT(as(s, logic.RemitterMSP), txn); p.TatBreached || len(s.events) != n {
		t.Fatal("no breach before the deadline")
	}
	s.txSec += 10_000
	p, err := c.checkTAT(as(s, logic.RemitterMSP), txn)
	if err != nil || !p.TatBreached || s.events[len(s.events)-1] != "TATBreach" {
		t.Fatalf("want breach: %v %+v %v", err, p, s.events)
	}
	n = len(s.events)
	if _, err := c.checkTAT(as(s, logic.RemitterMSP), txn); err != nil || len(s.events) != n {
		t.Fatal("second CheckTAT must be a no-op")
	}
}

func advJSON(id string, validFor int) string {
	b, _ := json.Marshal(map[string]interface{}{
		"id": id, "kind": "DO_NOT_SHIFT", "segmentId": "bank:*:B1", "params": map[string]interface{}{},
		"reason": "shared bank B1", "validForSec": validFor, "decisionId": "dec-00001",
		"evidenceHash": "sha256:" + strings.Repeat("0", 64),
	})
	return string(b)
}

func TestAdvisoryLifecycleAndOrder(t *testing.T) {
	s, a := newWorld(), &Advisory{}
	_, err := a.issueAdvisory(as(s, logic.BeneficiaryMSP), advJSON("adv-00001", 60))
	mustCode(t, err, "FORBIDDEN")
	for _, id := range []string{"adv-00003", "adv-00001", "adv-00002"} {
		if _, err := a.issueAdvisory(as(s, logic.AuthorityMSP), advJSON(id, 60)); err != nil {
			t.Fatalf("issue %s: %v", id, err)
		}
	}
	_, err = a.issueAdvisory(as(s, logic.AuthorityMSP), advJSON("adv-00001", 60))
	mustCode(t, err, "CONFLICT")
	_, err = a.issueAdvisory(as(s, logic.AuthorityMSP), advJSON("adv-00009", 1))
	mustCode(t, err, "BAD_ARG")

	if _, err := a.revokeAdvisory(as(s, logic.AuthorityMSP), "adv-00002", "rolled back"); err != nil {
		t.Fatal(err)
	}
	n := len(s.events)
	if _, err := a.revokeAdvisory(as(s, logic.AuthorityMSP), "adv-00002", "again"); err != nil || len(s.events) != n {
		t.Fatalf("revoking a revoked advisory must be a no-op without an event: %v", err)
	}
	active, err := a.listActive(as(s, logic.AuthorityMSP))
	if err != nil || len(active) != 2 || active[0].ID != "adv-00001" || active[1].ID != "adv-00003" {
		t.Fatalf("ListActive must return unrevoked advisories sorted by id: %v %+v", err, active)
	}
	s.txSec += 61
	if active, _ = a.listActive(as(s, logic.AuthorityMSP)); len(active) != 0 {
		t.Fatalf("expired advisories must not be listed: %+v", active)
	}
}

func TestDecisionAppendOnly(t *testing.T) {
	s, d := newWorld(), &DecisionLog{}
	dj := `{"id":"dec-00001","recId":"rec-00001","decision":"APPROVE_ALL","operator":"op-a",` +
		`"actionsApproved":["act-00001"],"modelVersions":{"rules":"r1"},"featuresSha256":"sha256:` +
		strings.Repeat("1", 64) + `","decidedSimMs":1000}`
	_, err := d.recordDecision(as(s, logic.BeneficiaryMSP), dj)
	mustCode(t, err, "FORBIDDEN")
	if _, err := d.recordDecision(as(s, logic.AuthorityMSP), dj); err != nil {
		t.Fatal(err)
	}
	_, err = d.recordDecision(as(s, logic.AuthorityMSP), dj)
	mustCode(t, err, "CONFLICT")
	got, err := d.getDecision(as(s, logic.AuthorityMSP), "dec-00001")
	if err != nil || got.RecorderMspID != logic.AuthorityMSP || got.RecordedAt != s.txSec {
		t.Fatalf("get: %v %+v", err, got)
	}
}

// The exported functions return the stored JSON (identical bytes, nulls kept).
func TestExportedFunctionsReturnStoredJSON(t *testing.T) {
	s, c := newWorld(), &PayState{}
	out, err := c.OpenUnknown(as(s, logic.RemitterMSP), txn, idem, "P1", "B1", "B2", run, 0, 60)
	if err != nil {
		t.Fatal(err)
	}
	if out != string(s.state[payKey(txn)]) || !strings.Contains(out, `"debitAt":null`) {
		t.Fatalf("returned JSON must equal the stored record: %s", out)
	}
	if _, err := c.GetStatus(as(s, logic.RemitterMSP), "r-S6-7-U4:p-0000001"); err == nil {
		t.Fatal("errors must pass through the wrapper")
	}
	list, err := (&Advisory{}).ListActive(as(s, logic.AuthorityMSP))
	if err != nil || list != "[]" {
		t.Fatalf("empty list must be [] not null: %q %v", list, err)
	}
}
