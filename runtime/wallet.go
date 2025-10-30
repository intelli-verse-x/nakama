// Copyright 2025 The Nakama Authors
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
	"database/sql"
	"encoding/json"
	"time"

	"github.com/heroiclabs/nakama-common/runtime"
)

const (
	WalletCollection = "wallet"
)

// Wallet represents a user's wallet stored in Nakama
type Wallet struct {
	Chain     string `json:"chain"`
	Address   string `json:"address"`
	CreatedAt int64  `json:"createdAt"` // epoch milliseconds
}

// ensureWallet ensures a wallet exists for the given external ID
// If wallet doesn't exist, it provisions one using KMS/HSM
func ensureWallet(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, externalID string, config *Config) (*Wallet, error) {
	if !config.WalletEnabled {
		return nil, ErrWalletNotEnabled
	}

	// Try to read existing wallet from storage
	objectIds := []*runtime.StorageRead{
		{
			Collection: WalletCollection,
			Key:        externalID,
		},
	}

	objects, err := nk.StorageRead(ctx, objectIds)
	if err != nil {
		logger.Error("Failed to read wallet from storage: %v", err)
		return nil, err
	}

	// If wallet exists, return it
	if len(objects) > 0 && objects[0] != nil {
		var wallet Wallet
		if err := json.Unmarshal([]byte(objects[0].Value), &wallet); err != nil {
			logger.Error("Failed to unmarshal wallet: %v", err)
			return nil, err
		}
		return &wallet, nil
	}

	// Wallet doesn't exist, provision a new one
	address, err := deriveWalletAddress(ctx, logger, externalID, config)
	if err != nil {
		logger.Error("Failed to derive wallet address: %v", err)
		return nil, err
	}

	wallet := &Wallet{
		Chain:     config.WalletChain,
		Address:   address,
		CreatedAt: time.Now().UnixMilli(),
	}

	// Store wallet in Nakama storage
	walletData, err := json.Marshal(wallet)
	if err != nil {
		logger.Error("Failed to marshal wallet: %v", err)
		return nil, err
	}

	writeOps := []*runtime.StorageWrite{
		{
			Collection: WalletCollection,
			Key:        externalID,
			Value:      string(walletData),
			// PermissionRead allows the user to read their own wallet
			PermissionRead: 1,
			// PermissionWrite prevents users from modifying their wallet directly
			PermissionWrite: 0,
		},
	}

	if _, err := nk.StorageWrite(ctx, writeOps); err != nil {
		logger.Error("Failed to write wallet to storage: %v", err)
		return nil, err
	}

	logger.Info("Provisioned new wallet for %s: %s on %s", externalID, address, wallet.Chain)

	// Emit metric
	// TODO: Add metrics tracking for wallet.provisioned

	return wallet, nil
}

// getWallet retrieves a user's wallet from storage
func getWallet(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, externalID string) (*Wallet, error) {
	objectIds := []*runtime.StorageRead{
		{
			Collection: WalletCollection,
			Key:        externalID,
		},
	}

	objects, err := nk.StorageRead(ctx, objectIds)
	if err != nil {
		logger.Error("Failed to read wallet from storage: %v", err)
		return nil, err
	}

	if len(objects) == 0 || objects[0] == nil {
		return nil, ErrWalletNotFound
	}

	var wallet Wallet
	if err := json.Unmarshal([]byte(objects[0].Value), &wallet); err != nil {
		logger.Error("Failed to unmarshal wallet: %v", err)
		return nil, err
	}

	return &wallet, nil
}

// deriveWalletAddress derives a wallet address for the given external ID
// This is a placeholder that delegates to the KMS/HSM integration
func deriveWalletAddress(ctx context.Context, logger runtime.Logger, externalID string, config *Config) (string, error) {
	// TODO: Integrate with actual KMS/HSM service
	// For now, we'll use a deterministic derivation based on the external ID
	// In production, this should:
	// 1. Connect to AWS KMS or HSM
	// 2. Use the master key ARN to derive a child key for this user
	// 3. Use the derivation path specified in config
	// 4. Return the public address without storing the private key

	switch config.WalletChain {
	case "evm":
		// For EVM chains, derive an Ethereum address
		// TODO: Replace with actual KMS-based derivation
		return deriveEVMAddress(ctx, logger, externalID, config)
	case "solana":
		// For Solana, derive a Solana address
		// TODO: Implement Solana address derivation
		logger.Warn("Solana wallet derivation not yet implemented")
		return "", ErrInvalidChain
	default:
		logger.Error("Unsupported wallet chain: %s", config.WalletChain)
		return "", ErrInvalidChain
	}
}
