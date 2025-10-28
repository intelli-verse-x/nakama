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
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	"github.com/heroiclabs/nakama-common/runtime"
)

const (
	walletCollection = "wallet"
)

// WalletRecord represents a wallet stored in Nakama storage
type WalletRecord struct {
	Chain     string `json:"chain"`
	Address   string `json:"address"`
	CreatedAt int64  `json:"createdAt"`
}

// ensureWallet ensures a wallet exists for the given external ID, creating it if necessary
func ensureWallet(ctx context.Context, logger runtime.Logger, nk runtime.NakamaModule, externalID string, chain string) (*WalletRecord, error) {
	// Try to read existing wallet
	wallet, err := readWallet(ctx, nk, externalID)
	if err == nil {
		// Wallet exists
		return wallet, nil
	}

	// Wallet doesn't exist, create it
	logger.Info("Creating new wallet for externalID: %s", externalID)

	address, err := deriveAddress(externalID, chain)
	if err != nil {
		return nil, fmt.Errorf("failed to derive address: %w", err)
	}

	wallet = &WalletRecord{
		Chain:     chain,
		Address:   address,
		CreatedAt: time.Now().Unix(),
	}

	if err := writeWallet(ctx, nk, externalID, wallet); err != nil {
		return nil, fmt.Errorf("failed to write wallet: %w", err)
	}

	logger.Info("Created wallet: chain=%s, address=%s", wallet.Chain, wallet.Address)
	return wallet, nil
}

// readWallet reads a wallet from storage
func readWallet(ctx context.Context, nk runtime.NakamaModule, externalID string) (*WalletRecord, error) {
	objects, err := nk.StorageRead(ctx, []*runtime.StorageRead{
		{
			Collection: walletCollection,
			Key:        externalID,
			UserID:     "",
		},
	})

	if err != nil {
		return nil, fmt.Errorf("storage read failed: %w", err)
	}

	if len(objects) == 0 {
		return nil, fmt.Errorf("wallet not found")
	}

	var wallet WalletRecord
	if err := json.Unmarshal([]byte(objects[0].Value), &wallet); err != nil {
		return nil, fmt.Errorf("failed to unmarshal wallet: %w", err)
	}

	return &wallet, nil
}

// writeWallet writes a wallet to storage
func writeWallet(ctx context.Context, nk runtime.NakamaModule, externalID string, wallet *WalletRecord) error {
	walletBytes, err := json.Marshal(wallet)
	if err != nil {
		return fmt.Errorf("failed to marshal wallet: %w", err)
	}

	writes := []*runtime.StorageWrite{
		{
			Collection: walletCollection,
			Key:        externalID,
			UserID:     "",
			Value:      string(walletBytes),
			PermissionRead: 0,
			PermissionWrite: 0,
		},
	}

	if _, err := nk.StorageWrite(ctx, writes); err != nil {
		return fmt.Errorf("storage write failed: %w", err)
	}

	return nil
}

// deriveAddress derives a deterministic wallet address from an external ID
// This is a simplified implementation. In production, you would use KMS/HSM
// for actual key derivation and management.
func deriveAddress(externalID string, chain string) (string, error) {
	// Create a deterministic hash of the external ID
	hash := sha256.Sum256([]byte(externalID))
	
	switch chain {
	case "evm":
		// For EVM (Ethereum), addresses are 20 bytes (40 hex chars) with 0x prefix
		// This is a simplified derivation - in production use proper HD wallet derivation
		addressBytes := hash[:20]
		return "0x" + hex.EncodeToString(addressBytes), nil
		
	case "solana":
		// For Solana, addresses are base58 encoded public keys (32 bytes)
		// This is a simplified derivation - in production use proper Solana key derivation
		addressBytes := hash[:32]
		// In a real implementation, you would base58 encode this
		// For now, we'll use hex encoding as a placeholder
		return hex.EncodeToString(addressBytes), nil
		
	default:
		return "", fmt.Errorf("unsupported chain: %s", chain)
	}
}
