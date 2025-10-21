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
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"github.com/heroiclabs/nakama-common/runtime"
)

// CognitoConfig holds the configuration for AWS Cognito integration
type CognitoConfig struct {
	Issuer             string
	Audience           string
	JWKSCacheTTL       int
	WalletChain        string
	WalletMasterKeyARN string
	WalletDerivePath   string
}

// CognitoModule manages AWS Cognito integration
type CognitoModule struct {
	config    CognitoConfig
	jwksCache *JWKSCache
}

var cognitoModule *CognitoModule

// InitModule initializes the Cognito authentication module
func InitModule(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, initializer runtime.Initializer) error {
	// Load configuration from environment
	env := ctx.Value(runtime.RUNTIME_CTX_ENV).(map[string]string)
	
	config := CognitoConfig{
		Issuer:             getEnvOrDefault(env, "NAKAMA_COGNITO_ISS", ""),
		Audience:           getEnvOrDefault(env, "NAKAMA_COGNITO_AUDIENCE", ""),
		JWKSCacheTTL:       getEnvIntOrDefault(env, "NAKAMA_JWKS_CACHE_TTL", 3600),
		WalletChain:        getEnvOrDefault(env, "NAKAMA_WALLET_CHAIN", "evm"),
		WalletMasterKeyARN: getEnvOrDefault(env, "NAKAMA_WALLET_MASTER_KEY_ARN", ""),
		WalletDerivePath:   getEnvOrDefault(env, "NAKAMA_WALLET_DERIVATION_PATH", "m/44'/60'/0'/0"),
	}

	if config.Issuer == "" {
		logger.Warn("NAKAMA_COGNITO_ISS not set - Cognito authentication disabled")
	}
	if config.Audience == "" {
		logger.Warn("NAKAMA_COGNITO_AUDIENCE not set - Cognito authentication disabled")
	}

	// Initialize JWKS cache
	jwksCache := NewJWKSCache(config.Issuer, time.Duration(config.JWKSCacheTTL)*time.Second, logger)

	cognitoModule = &CognitoModule{
		config:    config,
		jwksCache: jwksCache,
	}

	// Register RPC endpoints
	if err := initializer.RegisterRpc("rpc_cognito_login", func(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
		return rpcCognitoLogin(ctx, logger, db, nk, payload, cognitoModule)
	}); err != nil {
		return err
	}

	if err := initializer.RegisterRpc("rpc_link_cognito", func(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
		return rpcLinkCognito(ctx, logger, db, nk, payload, cognitoModule)
	}); err != nil {
		return err
	}

	if err := initializer.RegisterRpc("rpc_get_wallet", func(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
		return rpcGetWallet(ctx, logger, db, nk, payload, cognitoModule)
	}); err != nil {
		return err
	}

	if err := initializer.RegisterRpc("rpc_sign_and_send", func(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
		return rpcSignAndSend(ctx, logger, db, nk, payload, cognitoModule)
	}); err != nil {
		return err
	}

	logger.Info("Cognito module initialized with issuer: %s", config.Issuer)
	return nil
}

func getEnvOrDefault(env map[string]string, key, defaultValue string) string {
	if val, ok := env[key]; ok && val != "" {
		return val
	}
	return defaultValue
}

func getEnvIntOrDefault(env map[string]string, key string, defaultValue int) int {
	if val, ok := env[key]; ok && val != "" {
		var intVal int
		if _, err := fmt.Sscanf(val, "%d", &intVal); err == nil {
			return intVal
		}
	}
	return defaultValue
}

// LoginRequest represents the payload for cognito login
type LoginRequest struct {
	IDToken  string `json:"id_token"`
	Create   *bool  `json:"create,omitempty"`
	Username string `json:"username,omitempty"`
}

// LoginResponse represents the response from cognito login
type LoginResponse struct {
	Token  string        `json:"token"`
	Wallet WalletSummary `json:"wallet"`
}

// LinkRequest represents the payload for linking cognito
type LinkRequest struct {
	IDToken string `json:"id_token"`
}

// WalletSummary represents wallet information
type WalletSummary struct {
	Address string `json:"address"`
	Chain   string `json:"chain"`
}

// TransactionRequest represents a transaction to sign and send
type TransactionRequest struct {
	To                     string  `json:"to"`
	ValueWei               string  `json:"valueWei"`
	Data                   *string `json:"data,omitempty"`
	GasLimit               *string `json:"gasLimit,omitempty"`
	MaxFeePerGasWei        *string `json:"maxFeePerGasWei,omitempty"`
	MaxPriorityFeePerGasWei *string `json:"maxPriorityFeePerGasWei,omitempty"`
	Nonce                  *int    `json:"nonce,omitempty"`
}

// TransactionResponse represents the response from signing and sending a transaction
type TransactionResponse struct {
	TxHash string `json:"txHash"`
}

// rpcCognitoLogin handles the login with Cognito ID token
func rpcCognitoLogin(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string, module *CognitoModule) (string, error) {
	var req LoginRequest
	if err := json.Unmarshal([]byte(payload), &req); err != nil {
		return "", fmt.Errorf("invalid request payload: %w", err)
	}

	if req.IDToken == "" {
		return "", fmt.Errorf("id_token is required")
	}

	// Verify the Cognito ID token
	claims, err := module.verifyCognitoIDToken(req.IDToken)
	if err != nil {
		return "", fmt.Errorf("token verification failed: %w", err)
	}

	// Extract the subject (user ID) from claims
	sub, ok := claims["sub"].(string)
	if !ok || sub == "" {
		return "", fmt.Errorf("missing or invalid 'sub' claim in token")
	}

	// Create external ID with cognito prefix
	externalID := "cognito:" + sub

	// Determine create flag (default to true)
	create := true
	if req.Create != nil {
		create = *req.Create
	}

	// Extract username from claims or use provided username
	username := req.Username
	if username == "" {
		if email, ok := claims["email"].(string); ok && email != "" {
			username = email
		} else if cognitoUsername, ok := claims["cognito:username"].(string); ok && cognitoUsername != "" {
			username = cognitoUsername
		}
	}

	// Authenticate with custom ID
	userID, usernameResult, created, err := nk.AuthenticateCustom(ctx, externalID, username, create)
	if err != nil {
		return "", fmt.Errorf("authentication failed: %w", err)
	}

	logger.Info("User authenticated: userID=%s, username=%s, created=%v", userID, usernameResult, created)

	// Update user metadata with Cognito claims
	if err := updateUserMetadata(ctx, nk, userID, claims); err != nil {
		logger.Warn("Failed to update user metadata: %v", err)
	}

	// Ensure wallet exists for this user
	wallet, err := ensureWallet(ctx, logger, nk, externalID, module.config.WalletChain)
	if err != nil {
		return "", fmt.Errorf("failed to ensure wallet: %w", err)
	}

	// Generate session token
	token, _, err := nk.AuthenticateTokenGenerate(userID, usernameResult, 0, nil)
	if err != nil {
		return "", fmt.Errorf("failed to generate token: %w", err)
	}

	// Prepare response
	response := LoginResponse{
		Token: token,
		Wallet: WalletSummary{
			Address: wallet.Address,
			Chain:   wallet.Chain,
		},
	}

	responseBytes, err := json.Marshal(response)
	if err != nil {
		return "", fmt.Errorf("failed to marshal response: %w", err)
	}

	return string(responseBytes), nil
}

// rpcLinkCognito handles linking a Cognito account to an existing Nakama account
func rpcLinkCognito(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string, module *CognitoModule) (string, error) {
	// Get user ID from context
	userID, ok := ctx.Value(runtime.RUNTIME_CTX_USER_ID).(string)
	if !ok || userID == "" {
		return "", fmt.Errorf("user must be authenticated to link Cognito account")
	}

	var req LinkRequest
	if err := json.Unmarshal([]byte(payload), &req); err != nil {
		return "", fmt.Errorf("invalid request payload: %w", err)
	}

	if req.IDToken == "" {
		return "", fmt.Errorf("id_token is required")
	}

	// Verify the Cognito ID token
	claims, err := module.verifyCognitoIDToken(req.IDToken)
	if err != nil {
		return "", fmt.Errorf("token verification failed: %w", err)
	}

	// Extract the subject (user ID) from claims
	sub, ok := claims["sub"].(string)
	if !ok || sub == "" {
		return "", fmt.Errorf("missing or invalid 'sub' claim in token")
	}

	// Create external ID with cognito prefix
	externalID := "cognito:" + sub

	// Link custom ID to user
	if err := nk.LinkCustom(ctx, userID, externalID); err != nil {
		return "", fmt.Errorf("failed to link custom ID: %w", err)
	}

	logger.Info("Cognito account linked: userID=%s, externalID=%s", userID, externalID)

	// Update user metadata with Cognito claims
	if err := updateUserMetadata(ctx, nk, userID, claims); err != nil {
		logger.Warn("Failed to update user metadata: %v", err)
	}

	// Ensure wallet exists
	wallet, err := ensureWallet(ctx, logger, nk, externalID, module.config.WalletChain)
	if err != nil {
		return "", fmt.Errorf("failed to ensure wallet: %w", err)
	}

	// Prepare response
	response := WalletSummary{
		Address: wallet.Address,
		Chain:   wallet.Chain,
	}

	responseBytes, err := json.Marshal(response)
	if err != nil {
		return "", fmt.Errorf("failed to marshal response: %w", err)
	}

	return string(responseBytes), nil
}

// rpcGetWallet returns the wallet information for the authenticated user
func rpcGetWallet(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string, module *CognitoModule) (string, error) {
	// Get user ID from context
	userID, ok := ctx.Value(runtime.RUNTIME_CTX_USER_ID).(string)
	if !ok || userID == "" {
		return "", fmt.Errorf("user must be authenticated")
	}

	// Get user account to find custom ID
	account, err := nk.AccountGetId(ctx, userID)
	if err != nil {
		return "", fmt.Errorf("failed to get account: %w", err)
	}

	// Find cognito custom ID
	var externalID string
	if account.CustomId != "" && len(account.CustomId) > 8 && account.CustomId[:8] == "cognito:" {
		externalID = account.CustomId
	} else {
		return "", fmt.Errorf("no Cognito account linked")
	}

	// Read wallet from storage
	walletRecord, err := readWallet(ctx, nk, externalID)
	if err != nil {
		return "", fmt.Errorf("failed to read wallet: %w", err)
	}

	// Prepare response
	response := WalletSummary{
		Address: walletRecord.Address,
		Chain:   walletRecord.Chain,
	}

	responseBytes, err := json.Marshal(response)
	if err != nil {
		return "", fmt.Errorf("failed to marshal response: %w", err)
	}

	return string(responseBytes), nil
}

// rpcSignAndSend signs and sends a transaction (custodial mode)
func rpcSignAndSend(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string, module *CognitoModule) (string, error) {
	// Get user ID from context
	userID, ok := ctx.Value(runtime.RUNTIME_CTX_USER_ID).(string)
	if !ok || userID == "" {
		return "", fmt.Errorf("user must be authenticated")
	}

	var req TransactionRequest
	if err := json.Unmarshal([]byte(payload), &req); err != nil {
		return "", fmt.Errorf("invalid request payload: %w", err)
	}

	if req.To == "" {
		return "", fmt.Errorf("'to' address is required")
	}

	// Get user account to find custom ID
	account, err := nk.AccountGetId(ctx, userID)
	if err != nil {
		return "", fmt.Errorf("failed to get account: %w", err)
	}

	// Find cognito custom ID
	var externalID string
	if account.CustomId != "" && len(account.CustomId) > 8 && account.CustomId[:8] == "cognito:" {
		externalID = account.CustomId
	} else {
		return "", fmt.Errorf("no Cognito account linked")
	}

	// TODO: Implement actual transaction signing and sending
	// This would require integration with KMS/HSM for key management
	// and blockchain node for transaction broadcasting
	logger.Warn("Transaction signing not fully implemented for externalID=%s - returning mock response", externalID)

	// For now, return a mock response
	response := TransactionResponse{
		TxHash: "0x" + fmt.Sprintf("%064x", time.Now().UnixNano()),
	}

	responseBytes, err := json.Marshal(response)
	if err != nil {
		return "", fmt.Errorf("failed to marshal response: %w", err)
	}

	return string(responseBytes), nil
}

// updateUserMetadata updates user metadata with Cognito claims
func updateUserMetadata(ctx context.Context, nk runtime.NakamaModule, userID string, claims map[string]interface{}) error {
	metadata := make(map[string]interface{})

	if email, ok := claims["email"].(string); ok {
		metadata["email"] = email
	}
	if emailVerified, ok := claims["email_verified"].(bool); ok {
		metadata["email_verified"] = emailVerified
	}
	if name, ok := claims["name"].(string); ok {
		metadata["name"] = name
	}
	if picture, ok := claims["picture"].(string); ok {
		metadata["picture"] = picture
	}
	
	// Determine provider from identities claim
	if identities, ok := claims["identities"].([]interface{}); ok && len(identities) > 0 {
		if identity, ok := identities[0].(map[string]interface{}); ok {
			if providerName, ok := identity["providerName"].(string); ok {
				metadata["provider"] = providerName
			}
		}
	}

	if len(metadata) > 0 {
		return nk.AccountUpdateId(ctx, userID, "", metadata, "", "", "", "", "")
	}

	return nil
}
