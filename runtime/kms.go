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
	"encoding/hex"
	"fmt"

	"github.com/ethereum/go-ethereum/crypto"
	"github.com/heroiclabs/nakama-common/runtime"
)

// KMSSigner is an interface for signing operations using KMS/HSM
type KMSSigner interface {
	// Sign signs a hash using the key associated with the external ID
	Sign(ctx context.Context, externalID string, hash []byte) ([]byte, error)

	// GetPublicKey retrieves the public key for the given external ID
	GetPublicKey(ctx context.Context, externalID string) ([]byte, error)
}

// MockKMSSigner is a mock implementation for development/testing
// In production, replace this with actual AWS KMS or HSM integration
type MockKMSSigner struct {
	logger runtime.Logger
	config *Config
}

// NewMockKMSSigner creates a new mock KMS signer
// TODO: Replace with actual KMS implementation
func NewMockKMSSigner(logger runtime.Logger, config *Config) *MockKMSSigner {
	return &MockKMSSigner{
		logger: logger,
		config: config,
	}
}

// Sign signs a hash using a deterministic key derived from external ID
// WARNING: This is for development only. In production, use AWS KMS or HSM
func (m *MockKMSSigner) Sign(ctx context.Context, externalID string, hash []byte) ([]byte, error) {
	m.logger.Warn("Using mock KMS signer - NOT FOR PRODUCTION")

	// Derive a deterministic private key (for testing only)
	privateKey, err := m.derivePrivateKey(externalID)
	if err != nil {
		return nil, fmt.Errorf("failed to derive private key: %w", err)
	}

	// Sign the hash
	signature, err := crypto.Sign(hash, privateKey)
	if err != nil {
		return nil, fmt.Errorf("failed to sign: %w", err)
	}

	return signature, nil
}

// GetPublicKey retrieves the public key for the given external ID
func (m *MockKMSSigner) GetPublicKey(ctx context.Context, externalID string) ([]byte, error) {
	privateKey, err := m.derivePrivateKey(externalID)
	if err != nil {
		return nil, fmt.Errorf("failed to derive private key: %w", err)
	}

	publicKey := privateKey.Public().(*ecdsa.PublicKey)
	return crypto.FromECDSAPub(publicKey), nil
}

// derivePrivateKey derives a deterministic private key from external ID
// WARNING: This is insecure and only for development
func (m *MockKMSSigner) derivePrivateKey(externalID string) (*ecdsa.PrivateKey, error) {
	// Create a deterministic seed from external ID and master key ARN
	seed := fmt.Sprintf("%s:%s", m.config.WalletMasterKeyARN, externalID)
	hash := sha256.Sum256([]byte(seed))

	// Generate private key from hash
	privateKey, err := crypto.ToECDSA(hash[:])
	if err != nil {
		return nil, err
	}

	return privateKey, nil
}

// TODO: Implement AWS KMS Signer
// type AWSKMSSigner struct {
//     client    *kms.Client
//     logger    runtime.Logger
//     config    *Config
//     masterKey string
// }
//
// func NewAWSKMSSigner(logger runtime.Logger, config *Config) (*AWSKMSSigner, error) {
//     // Initialize AWS KMS client
//     cfg, err := awsconfig.LoadDefaultConfig(context.Background())
//     if err != nil {
//         return nil, fmt.Errorf("failed to load AWS config: %w", err)
//     }
//
//     client := kms.NewFromConfig(cfg)
//
//     return &AWSKMSSigner{
//         client:    client,
//         logger:    logger,
//         config:    config,
//         masterKey: config.WalletMasterKeyARN,
//     }, nil
// }
//
// func (a *AWSKMSSigner) Sign(ctx context.Context, externalID string, hash []byte) ([]byte, error) {
//     // Use AWS KMS to sign the hash
//     // 1. Derive a key identifier from externalID and masterKey
//     // 2. Use KMS.Sign API to sign the hash
//     // 3. Return the signature
//     return nil, fmt.Errorf("not implemented")
// }
//
// func (a *AWSKMSSigner) GetPublicKey(ctx context.Context, externalID string) ([]byte, error) {
//     // Use AWS KMS to get the public key
//     // 1. Derive a key identifier from externalID and masterKey
//     // 2. Use KMS.GetPublicKey API
//     // 3. Return the public key bytes
//     return nil, fmt.Errorf("not implemented")
// }

// GetKMSSigner returns the appropriate KMS signer based on configuration
func GetKMSSigner(logger runtime.Logger, config *Config) KMSSigner {
	// TODO: Check environment or config to determine which signer to use
	// For now, always return mock signer
	logger.Warn("Using mock KMS signer. Configure AWS KMS for production use.")
	return NewMockKMSSigner(logger, config)
}

// deriveKeyPath generates a full derivation path for a user
func deriveKeyPath(basePath, externalID string) string {
	// Hash the external ID to get a deterministic index
	hash := sha256.Sum256([]byte(externalID))
	index := hex.EncodeToString(hash[:4]) // Use first 4 bytes as hex

	return fmt.Sprintf("%s/%s", basePath, index)
}
