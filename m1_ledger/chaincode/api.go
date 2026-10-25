package main

// Exported chaincode functions (what the gateway invokes, e.g. "paystate:OpenUnknown").
//
// Each returns the record as a JSON string. fabric-contract-api-go v1.2.x rejects structs with pointer-to-basic
// fields (*int64, *string) as return types at start-up, and the stored records need those fields to serialise as
// null (contracts/schemas/ledger_payment.schema.json). Returning the JSON keeps the bytes identical to what is stored
// and emitted; the gateway parses it. TestChaincodeMetadataBuilds guards this.

import (
	"encoding/json"

	"github.com/hyperledger/fabric-contract-api-go/contractapi"
)

type txCtx = contractapi.TransactionContextInterface

func asJSON(v interface{}, err error) (string, error) {
	if err != nil {
		return "", err
	}
	raw, mErr := json.Marshal(v)
	if mErr != nil {
		return "", errInternal("encode result")
	}
	return string(raw), nil
}

func (c *PayState) OpenUnknown(ctx txCtx, txnRef, idemKeyHash, payerPsp, remitterBank, beneficiaryBank, runID string,
	simMs int64, tatSeconds int64) (string, error) {
	return asJSON(c.openUnknown(ctx, txnRef, idemKeyHash, payerPsp, remitterBank, beneficiaryBank, runID, simMs, tatSeconds))
}
func (c *PayState) AttestDebit(ctx txCtx, txnRef string, simMs int64) (string, error) {
	return asJSON(c.attestDebit(ctx, txnRef, simMs))
}
func (c *PayState) AttestCredit(ctx txCtx, txnRef string, simMs int64) (string, error) {
	return asJSON(c.attestCredit(ctx, txnRef, simMs))
}
func (c *PayState) AttestFailure(ctx txCtx, txnRef, leg, reasonCode string, simMs int64) (string, error) {
	return asJSON(c.attestFailure(ctx, txnRef, leg, reasonCode, simMs))
}
func (c *PayState) AttestReversal(ctx txCtx, txnRef string, simMs int64) (string, error) {
	return asJSON(c.attestReversal(ctx, txnRef, simMs))
}
func (c *PayState) GetStatus(ctx txCtx, txnRef string) (string, error) {
	return asJSON(c.getStatus(ctx, txnRef))
}
func (c *PayState) CheckTAT(ctx txCtx, txnRef string) (string, error) {
	return asJSON(c.checkTAT(ctx, txnRef))
}

func (c *Advisory) IssueAdvisory(ctx txCtx, advisoryJSON string) (string, error) {
	return asJSON(c.issueAdvisory(ctx, advisoryJSON))
}
func (c *Advisory) RevokeAdvisory(ctx txCtx, id, reason string) (string, error) {
	return asJSON(c.revokeAdvisory(ctx, id, reason))
}
func (c *Advisory) GetAdvisory(ctx txCtx, id string) (string, error) {
	return asJSON(c.getAdvisory(ctx, id))
}
func (c *Advisory) ListActive(ctx txCtx) (string, error) {
	return asJSON(c.listActive(ctx))
}

func (c *DecisionLog) RecordDecision(ctx txCtx, decisionJSON string) (string, error) {
	return asJSON(c.recordDecision(ctx, decisionJSON))
}
func (c *DecisionLog) GetDecision(ctx txCtx, id string) (string, error) {
	return asJSON(c.getDecision(ctx, id))
}
