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
	"crypto/ecdsa"
	"crypto/sha256"
	"database/sql"
	"fmt"
	"math/big"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/heroiclabs/nakama-common/runtime"
)

// EVMTransactionRequest represents a request to sign and send an EVM transaction
type EVMTransactionRequest struct {
	To                     string `json:"to"`
	ValueWei               string `json:"valueWei"`
	Data                   string `json:"data"`
	GasLimit               string `json:"gasLimit"`
	MaxFeePerGasWei        string `json:"maxFeePerGasWei"`
	MaxPriorityFeePerGasWei string `json:"maxPriorityFeePerGasWei"`
	Nonce                  uint64 `json:"nonce"`
}

// deriveEVMAddress derives an Ethereum address from an external ID
// This uses the KMS signer to get the public key and derives the address
func deriveEVMAddress(ctx context.Context, logger runtime.Logger, externalID string, config *Config) (string, error) {
	// For development, use deterministic key derivation
	// TODO: Replace with actual KMS/HSM derivation in production

	// Create a deterministic seed
	seed := fmt.Sprintf("%s:%s", config.WalletMasterKeyARN, externalID)
	hash := sha256.Sum256([]byte(seed))

	// Generate private key from hash
	privateKey, err := crypto.ToECDSA(hash[:])
	if err != nil {
		return "", fmt.Errorf("failed to derive private key: %w", err)
	}

	// Get public key and derive address
	publicKey := privateKey.Public().(*ecdsa.PublicKey)
	address := crypto.PubkeyToAddress(*publicKey)

	return address.Hex(), nil
}

// signAndSendEVMTransaction signs and broadcasts an EVM transaction
func signAndSendEVMTransaction(
	ctx context.Context,
	logger runtime.Logger,
	db *sql.DB,
	nk runtime.NakamaModule,
	externalID string,
	request *EVMTransactionRequest,
	config *Config,
	signer KMSSigner,
) (string, error) {
	logger.Info("Signing EVM transaction for %s", externalID)

	// Validate request
	if request.To == "" {
		return "", fmt.Errorf("missing 'to' address")
	}

	// Parse values from hex strings
	value := new(big.Int)
	if request.ValueWei != "" {
		if _, ok := value.SetString(request.ValueWei, 0); !ok {
			return "", fmt.Errorf("invalid value: %s", request.ValueWei)
		}
	}

	gasLimit := new(big.Int)
	if request.GasLimit != "" {
		if _, ok := gasLimit.SetString(request.GasLimit, 0); !ok {
			return "", fmt.Errorf("invalid gas limit: %s", request.GasLimit)
		}
	}

	maxFeePerGas := new(big.Int)
	if request.MaxFeePerGasWei != "" {
		if _, ok := maxFeePerGas.SetString(request.MaxFeePerGasWei, 0); !ok {
			return "", fmt.Errorf("invalid max fee per gas: %s", request.MaxFeePerGasWei)
		}
	}

	maxPriorityFeePerGas := new(big.Int)
	if request.MaxPriorityFeePerGasWei != "" {
		if _, ok := maxPriorityFeePerGas.SetString(request.MaxPriorityFeePerGasWei, 0); !ok {
			return "", fmt.Errorf("invalid max priority fee per gas: %s", request.MaxPriorityFeePerGasWei)
		}
	}

	// Parse data
	var data []byte
	if request.Data != "" {
		data = common.FromHex(request.Data)
	}

	// TODO: Get chain ID from config or environment
	chainID := big.NewInt(1) // Mainnet for example

	// Create transaction
	to := common.HexToAddress(request.To)
	tx := types.NewTx(&types.DynamicFeeTx{
		ChainID:   chainID,
		Nonce:     request.Nonce,
		GasTipCap: maxPriorityFeePerGas,
		GasFeeCap: maxFeePerGas,
		Gas:       gasLimit.Uint64(),
		To:        &to,
		Value:     value,
		Data:      data,
	})

	// Sign the transaction using KMS
	txSigner := types.LatestSignerForChainID(chainID)
	txHash := txSigner.Hash(tx)

	signature, err := signTransaction(ctx, logger, externalID, txHash.Bytes(), config, kmsSigner)
	if err != nil {
		logger.Error("Failed to sign transaction: %v", err)
		return "", fmt.Errorf("failed to sign transaction: %w", err)
	}

	// Apply signature to transaction
	signedTx, err := tx.WithSignature(txSigner, signature)
	if err != nil {
		logger.Error("Failed to apply signature: %v", err)
		return "", fmt.Errorf("failed to apply signature: %w", err)
	}

	// TODO: Broadcast transaction to blockchain
	// In production, you would:
	// 1. Connect to an Ethereum RPC endpoint
	// 2. Use ethclient.Client.SendTransaction to broadcast
	// 3. Wait for transaction receipt or return immediately with tx hash
	//
	// For now, we'll return a placeholder hash
	txHashHex := signedTx.Hash().Hex()

	logger.Info("Transaction signed successfully: %s", txHashHex)

	// TODO: Store transaction in database for tracking
	// TODO: Implement retry logic for failed broadcasts
	// TODO: Implement gas price estimation if not provided

	return txHashHex, nil
}

// signTransaction signs a transaction hash using KMS/HSM
func signTransaction(
	ctx context.Context,
	logger runtime.Logger,
	externalID string,
	hash []byte,
	config *Config,
	kmsSigner KMSSigner,
) ([]byte, error) {
	// Use KMS signer to sign the hash
	signature, err := kmsSigner.Sign(ctx, externalID, hash)
	if err != nil {
		return nil, fmt.Errorf("KMS signing failed: %w", err)
	}

	return signature, nil
}

// TODO: Implement transaction broadcaster
// type TransactionBroadcaster interface {
//     BroadcastTransaction(ctx context.Context, signedTx *types.Transaction) (string, error)
// }
//
// type EthereumBroadcaster struct {
//     client *ethclient.Client
//     logger runtime.Logger
// }
//
// func NewEthereumBroadcaster(rpcURL string, logger runtime.Logger) (*EthereumBroadcaster, error) {
//     client, err := ethclient.Dial(rpcURL)
//     if err != nil {
//         return nil, fmt.Errorf("failed to connect to Ethereum node: %w", err)
//     }
//
//     return &EthereumBroadcaster{
//         client: client,
//         logger: logger,
//     }, nil
// }
//
// func (e *EthereumBroadcaster) BroadcastTransaction(ctx context.Context, signedTx *types.Transaction) (string, error) {
//     err := e.client.SendTransaction(ctx, signedTx)
//     if err != nil {
//         return "", fmt.Errorf("failed to broadcast transaction: %w", err)
//     }
//
//     return signedTx.Hash().Hex(), nil
// }

// TODO: Implement rate limiting
// type RateLimiter struct {
//     limits map[string]*rateLimitEntry
//     mu     sync.Mutex
// }
//
// type rateLimitEntry struct {
//     count     int
//     resetTime time.Time
// }
//
// func (r *RateLimiter) CheckLimit(externalID string, maxPerMinute int) error {
//     r.mu.Lock()
//     defer r.mu.Unlock()
//
//     now := time.Now()
//     entry, exists := r.limits[externalID]
//
//     if !exists || now.After(entry.resetTime) {
//         r.limits[externalID] = &rateLimitEntry{
//             count:     1,
//             resetTime: now.Add(time.Minute),
//         }
//         return nil
//     }
//
//     if entry.count >= maxPerMinute {
//         return ErrRateLimitExceeded
//     }
//
//     entry.count++
//     return nil
// }
