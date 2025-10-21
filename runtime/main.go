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
	"fmt"
	"os"
	"strconv"

	"github.com/heroiclabs/nakama-common/runtime"
)

// Config holds the module configuration
type Config struct {
	CognitoIssuer        string
	CognitoAudience      string
	JWKSCacheTTL         int
	WalletEnabled        bool
	WalletChain          string
	WalletMasterKeyARN   string
	WalletDerivationPath string
}

// Global state
var (
	jwksManager *JWKSManager
	kmsSigner   KMSSigner
	config      *Config
)

// InitModule initializes the Cognito authentication module
func InitModule(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, initializer runtime.Initializer) error {
	logger.Info("Initializing Cognito authentication module")

	// Load configuration from environment variables
	cfg, err := loadConfig()
	if err != nil {
		logger.Error("Failed to load configuration: %v", err)
		return err
	}
	config = cfg

	logger.Info("Configuration loaded:")
	logger.Info("  Cognito Issuer: %s", config.CognitoIssuer)
	logger.Info("  Cognito Audience: %s", config.CognitoAudience)
	logger.Info("  JWKS Cache TTL: %d seconds", config.JWKSCacheTTL)
	logger.Info("  Wallet Enabled: %t", config.WalletEnabled)
	if config.WalletEnabled {
		logger.Info("  Wallet Chain: %s", config.WalletChain)
		logger.Info("  Wallet Derivation Path: %s", config.WalletDerivationPath)
	}

	// Initialize JWKS manager
	jwksMgr, err := NewJWKSManager(ctx, logger, config)
	if err != nil {
		logger.Error("Failed to initialize JWKS manager: %v", err)
		return err
	}
	jwksManager = jwksMgr

	// Initialize KMS signer if wallet is enabled
	if config.WalletEnabled {
		kmsSigner = GetKMSSigner(logger, config)
		logger.Info("KMS signer initialized")
	}

	// Register RPC handlers
	if err := initializer.RegisterRpc("rpc_cognito_login", rpcCognitoLogin); err != nil {
		logger.Error("Failed to register rpc_cognito_login: %v", err)
		return err
	}
	logger.Info("Registered RPC: rpc_cognito_login")

	if err := initializer.RegisterRpc("rpc_link_cognito", rpcLinkCognito); err != nil {
		logger.Error("Failed to register rpc_link_cognito: %v", err)
		return err
	}
	logger.Info("Registered RPC: rpc_link_cognito")

	if err := initializer.RegisterRpc("rpc_get_wallet", rpcGetWallet); err != nil {
		logger.Error("Failed to register rpc_get_wallet: %v", err)
		return err
	}
	logger.Info("Registered RPC: rpc_get_wallet")

	// Only register rpc_sign_and_send if wallet is enabled
	if config.WalletEnabled {
		if err := initializer.RegisterRpc("rpc_sign_and_send", rpcSignAndSend); err != nil {
			logger.Error("Failed to register rpc_sign_and_send: %v", err)
			return err
		}
		logger.Info("Registered RPC: rpc_sign_and_send")
	}

	logger.Info("Cognito authentication module initialized successfully")

	return nil
}

// loadConfig loads configuration from environment variables
func loadConfig() (*Config, error) {
	cfg := &Config{
		CognitoIssuer:        getEnv("NAKAMA_COGNITO_ISS", ""),
		CognitoAudience:      getEnv("NAKAMA_COGNITO_AUDIENCE", ""),
		JWKSCacheTTL:         getEnvInt("NAKAMA_JWKS_CACHE_TTL", 3600),
		WalletEnabled:        getEnvBool("NAKAMA_WALLET_ENABLED", false),
		WalletChain:          getEnv("NAKAMA_WALLET_CHAIN", "evm"),
		WalletMasterKeyARN:   getEnv("NAKAMA_WALLET_MASTER_KEY_ARN", ""),
		WalletDerivationPath: getEnv("NAKAMA_WALLET_DERIVATION_PATH", "m/44'/60'/0'/0"),
	}

	// Validate required configuration
	if cfg.CognitoIssuer == "" {
		return nil, fmt.Errorf("NAKAMA_COGNITO_ISS is required")
	}

	if cfg.CognitoAudience == "" {
		return nil, fmt.Errorf("NAKAMA_COGNITO_AUDIENCE is required")
	}

	if cfg.WalletEnabled && cfg.WalletMasterKeyARN == "" {
		return nil, fmt.Errorf("NAKAMA_WALLET_MASTER_KEY_ARN is required when wallet is enabled")
	}

	return cfg, nil
}

// getEnv gets an environment variable with a default value
func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

// getEnvInt gets an integer environment variable with a default value
func getEnvInt(key string, defaultValue int) int {
	if value := os.Getenv(key); value != "" {
		if intValue, err := strconv.Atoi(value); err == nil {
			return intValue
		}
	}
	return defaultValue
}

// getEnvBool gets a boolean environment variable with a default value
func getEnvBool(key string, defaultValue bool) bool {
	if value := os.Getenv(key); value != "" {
		if boolValue, err := strconv.ParseBool(value); err == nil {
			return boolValue
		}
	}
	return defaultValue
}

// LoginRequest represents the input to rpc_cognito_login
type LoginRequest struct {
	IDToken  string `json:"id_token"`
	Create   bool   `json:"create"`
	Username string `json:"username,omitempty"`
}

// LinkRequest represents the input to rpc_link_cognito
type LinkRequest struct {
	IDToken string `json:"id_token"`
}

// rpcCognitoLogin handles the rpc_cognito_login RPC
func rpcCognitoLogin(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
	logger.Info("rpc_cognito_login called")

	// Parse request
	var request LoginRequest
	if err := FromJSON(payload, &request); err != nil {
		logger.Warn("Invalid request payload: %v", err)
		return "", NewAuthError("INVALID_PAYLOAD", "Failed to parse request", err)
	}

	// Verify the ID token
	claims, err := jwksManager.VerifyCognitoIDToken(ctx, request.IDToken)
	if err != nil {
		logger.Warn("Token verification failed: %v", err)
		return "", err
	}

	// Create external ID from Cognito subject
	externalID := fmt.Sprintf("cognito:%s", claims.Subject)

	// Extract user variables from claims
	userVars := ExtractUserVars(claims)

	// Authenticate with Nakama using custom authentication
	username := request.Username
	if username == "" {
		username = claims.Subject
	}

	logger.Info("Authenticating user: %s (external_id: %s)", username, externalID)

	// AuthenticateCustom returns session token, user ID, created flag, and error
	session, userId, created, err := nk.AuthenticateCustom(ctx, externalID, username, request.Create)
	if err != nil {
		logger.Error("Authentication failed: %v", err)
		return "", NewAuthError("AUTH_FAILED", "Failed to authenticate", err)
	}

	logger.Info("Authentication successful - userId: %s, created: %t", userId, created)

	// Update user metadata with extracted variables
	if len(userVars) > 0 {
		// Convert to map[string]interface{}
		metadata := make(map[string]interface{})
		for k, v := range userVars {
			metadata[k] = v
		}
		
		// Update account metadata
		if err := nk.AccountUpdateId(ctx, userId, "", metadata, "", "", "", "", ""); err != nil {
			logger.Warn("Failed to update user metadata: %v", err)
			// Don't fail authentication if metadata update fails
		}
	}

	// Prepare response
	response := LoginResponse{
		Token: session,
	}

	// Provision wallet if enabled
	if config.WalletEnabled {
		wallet, err := ensureWallet(ctx, logger, db, nk, externalID, config)
		if err != nil {
			logger.Error("Failed to provision wallet: %v", err)
			// Don't fail authentication if wallet provisioning fails
		} else {
			response.Wallet = &WalletInfo{
				Address: wallet.Address,
				Chain:   wallet.Chain,
			}
		}
	}

	logger.Info("Login successful for user: %s", username)

	// Convert response to JSON
	return ToJSON(response)
}

// rpcLinkCognito handles the rpc_link_cognito RPC
func rpcLinkCognito(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
	logger.Info("rpc_link_cognito called")

	// Get user ID from context
	userID, ok := ctx.Value(runtime.RUNTIME_CTX_USER_ID).(string)
	if !ok || userID == "" {
		logger.Warn("User ID not found in context")
		return "", NewAuthError("UNAUTHORIZED", "User session required", nil)
	}

	// Parse request
	var request LinkRequest
	if err := FromJSON(payload, &request); err != nil {
		logger.Warn("Invalid request payload: %v", err)
		return "", NewAuthError("INVALID_PAYLOAD", "Failed to parse request", err)
	}

	// Verify the ID token
	claims, err := jwksManager.VerifyCognitoIDToken(ctx, request.IDToken)
	if err != nil {
		logger.Warn("Token verification failed: %v", err)
		return "", err
	}

	// Create external ID from Cognito subject
	externalID := fmt.Sprintf("cognito:%s", claims.Subject)

	logger.Info("Linking Cognito account for user: %s (external_id: %s)", userID, externalID)

	// Link custom authentication to existing user
	if err := nk.LinkCustom(ctx, userID, externalID); err != nil {
		logger.Error("Link failed: %v", err)
		return "", NewAuthError("LINK_FAILED", "Failed to link account", err)
	}

	// Prepare response
	response := LinkResponse{
		Success: true,
	}

	// Provision wallet if enabled
	if config.WalletEnabled {
		wallet, err := ensureWallet(ctx, logger, db, nk, externalID, config)
		if err != nil {
			logger.Error("Failed to provision wallet: %v", err)
		} else {
			response.Wallet = &WalletInfo{
				Address: wallet.Address,
				Chain:   wallet.Chain,
			}
		}
	}

	logger.Info("Link successful for user: %s", userID)

	return ToJSON(response)
}

// rpcGetWallet handles the rpc_get_wallet RPC
func rpcGetWallet(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
	logger.Info("rpc_get_wallet called")

	if !config.WalletEnabled {
		return "", ErrWalletNotEnabled
	}

	// Get user ID from context
	userID, ok := ctx.Value(runtime.RUNTIME_CTX_USER_ID).(string)
	if !ok || userID == "" {
		logger.Warn("User ID not found in context")
		return "", NewAuthError("UNAUTHORIZED", "User session required", nil)
	}

	// Get user account to find external ID
	account, err := nk.AccountGetId(ctx, userID)
	if err != nil {
		logger.Error("Failed to get account: %v", err)
		return "", err
	}

	// Find Cognito external ID
	var externalID string
	if account.CustomId != "" && len(account.CustomId) > 8 && account.CustomId[:8] == "cognito:" {
		externalID = account.CustomId
	} else {
		logger.Warn("User %s does not have a Cognito external ID", userID)
		return "", ErrWalletNotFound
	}

	// Get wallet
	wallet, err := getWallet(ctx, logger, db, nk, externalID)
	if err != nil {
		logger.Error("Failed to get wallet: %v", err)
		return "", err
	}

	response := WalletResponse{
		Address: wallet.Address,
		Chain:   wallet.Chain,
	}

	return ToJSON(response)
}

// rpcSignAndSend handles the rpc_sign_and_send RPC
func rpcSignAndSend(ctx context.Context, logger runtime.Logger, db *sql.DB, nk runtime.NakamaModule, payload string) (string, error) {
	logger.Info("rpc_sign_and_send called")

	if !config.WalletEnabled {
		return "", ErrWalletNotEnabled
	}

	// Get user ID from context
	userID, ok := ctx.Value(runtime.RUNTIME_CTX_USER_ID).(string)
	if !ok || userID == "" {
		logger.Warn("User ID not found in context")
		return "", NewAuthError("UNAUTHORIZED", "User session required", nil)
	}

	// Get user account to find external ID
	account, err := nk.AccountGetId(ctx, userID)
	if err != nil {
		logger.Error("Failed to get account: %v", err)
		return "", err
	}

	// Find Cognito external ID
	var externalID string
	if account.CustomId != "" && len(account.CustomId) > 8 && account.CustomId[:8] == "cognito:" {
		externalID = account.CustomId
	} else {
		logger.Warn("User %s does not have a Cognito external ID", userID)
		return "", ErrAuthFailed
	}

	// Parse transaction request
	var txRequest EVMTransactionRequest
	if err := FromJSON(payload, &txRequest); err != nil {
		logger.Warn("Invalid transaction request: %v", err)
		return "", NewAuthError("INVALID_PAYLOAD", "Failed to parse transaction request", err)
	}

	// TODO: Apply rate limiting
	// if err := rateLimiter.CheckLimit(externalID, 10); err != nil {
	//     logger.Warn("Rate limit exceeded for %s", externalID)
	//     return "", err
	// }

	// TODO: Apply policy checks (e.g., max transaction value, allowed contracts)

	// Sign and send transaction
	txHash, err := signAndSendEVMTransaction(ctx, logger, db, nk, externalID, &txRequest, config, kmsSigner)
	if err != nil {
		logger.Error("Failed to sign and send transaction: %v", err)
		return "", err
	}

	response := SignAndSendResponse{
		TxHash: txHash,
	}

	logger.Info("Transaction sent successfully: %s", txHash)

	return ToJSON(response)
}
