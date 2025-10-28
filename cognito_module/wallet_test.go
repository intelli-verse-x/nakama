// Copyright 2024 The Nakama Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package main

import (
	"strings"
	"testing"
)

func TestDeriveAddress_EVM(t *testing.T) {
	externalID := "cognito:test-user-123"
	chain := "evm"

	address, err := deriveAddress(externalID, chain)
	if err != nil {
		t.Fatalf("deriveAddress failed: %v", err)
	}

	// Check EVM address format: 0x + 40 hex characters
	if !strings.HasPrefix(address, "0x") {
		t.Errorf("EVM address should start with '0x', got: %s", address)
	}

	if len(address) != 42 { // 0x + 40 chars
		t.Errorf("EVM address should be 42 characters, got: %d", len(address))
	}

	// Check it's deterministic
	address2, err := deriveAddress(externalID, chain)
	if err != nil {
		t.Fatalf("deriveAddress failed on second call: %v", err)
	}

	if address != address2 {
		t.Errorf("Address derivation should be deterministic: %s != %s", address, address2)
	}
}

func TestDeriveAddress_Solana(t *testing.T) {
	externalID := "cognito:test-user-456"
	chain := "solana"

	address, err := deriveAddress(externalID, chain)
	if err != nil {
		t.Fatalf("deriveAddress failed: %v", err)
	}

	// Check Solana address format: 64 hex characters (placeholder implementation)
	if len(address) != 64 {
		t.Errorf("Solana address should be 64 characters, got: %d", len(address))
	}

	// Check it's deterministic
	address2, err := deriveAddress(externalID, chain)
	if err != nil {
		t.Fatalf("deriveAddress failed on second call: %v", err)
	}

	if address != address2 {
		t.Errorf("Address derivation should be deterministic: %s != %s", address, address2)
	}
}

func TestDeriveAddress_DifferentUsers(t *testing.T) {
	externalID1 := "cognito:user-1"
	externalID2 := "cognito:user-2"
	chain := "evm"

	address1, err := deriveAddress(externalID1, chain)
	if err != nil {
		t.Fatalf("deriveAddress failed for user 1: %v", err)
	}

	address2, err := deriveAddress(externalID2, chain)
	if err != nil {
		t.Fatalf("deriveAddress failed for user 2: %v", err)
	}

	if address1 == address2 {
		t.Errorf("Different users should have different addresses")
	}
}

func TestDeriveAddress_UnsupportedChain(t *testing.T) {
	externalID := "cognito:test-user"
	chain := "bitcoin"

	_, err := deriveAddress(externalID, chain)
	if err == nil {
		t.Error("Expected error for unsupported chain, got nil")
	}

	if !strings.Contains(err.Error(), "unsupported chain") {
		t.Errorf("Expected 'unsupported chain' error, got: %v", err)
	}
}
