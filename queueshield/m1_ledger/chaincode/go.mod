module queueshield/m1_ledger/chaincode

// [VERIFY] the Go version inside npcioss/drunix-ccenv:1.0 (`docker run --rm npcioss/drunix-ccenv:1.0 go version`)
// and pick fabric-contract-api-go v1.2.x (Go >= 1.20) or v2 (Go >= 1.21) to match; then `go mod tidy && go mod vendor`.
go 1.20

require github.com/hyperledger/fabric-contract-api-go v1.2.2
