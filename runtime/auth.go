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
	"fmt"
	"time"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
	"github.com/heroiclabs/nakama-common/runtime"
)

// CognitoTokenClaims represents the claims in a Cognito ID token
type CognitoTokenClaims struct {
	jwt.RegisteredClaims
	TokenUse      string `json:"token_use"`
	Email         string `json:"email"`
	EmailVerified bool   `json:"email_verified"`
	Name          string `json:"name"`
	Picture       string `json:"picture"`
	CognitoGroups []string `json:"cognito:groups"`
}

// JWKSManager manages JWKS fetching and caching
type JWKSManager struct {
	jwks   keyfunc.Keyfunc
	logger runtime.Logger
	config *Config
}

// NewJWKSManager creates a new JWKS manager
func NewJWKSManager(ctx context.Context, logger runtime.Logger, config *Config) (*JWKSManager, error) {
	if config.CognitoIssuer == "" {
		return nil, fmt.Errorf("NAKAMA_COGNITO_ISS is required")
	}

	// Construct JWKS URL from issuer
	jwksURL := fmt.Sprintf("%s/.well-known/jwks.json", config.CognitoIssuer)

	logger.Info("Initializing JWKS from %s", jwksURL)

	// Create JWKS keyfunc with default options
	jwks, err := keyfunc.NewDefault([]string{jwksURL})
	if err != nil {
		logger.Error("Failed to create JWKS keyfunc: %v", err)
		return nil, NewAuthError("JWKS_INIT_FAILED", "Failed to initialize JWKS", err)
	}

	logger.Info("JWKS manager initialized successfully")

	return &JWKSManager{
		jwks:   jwks,
		logger: logger,
		config: config,
	}, nil
}

// Close stops the JWKS background refresh
func (m *JWKSManager) Close() {
	// In keyfunc v3, background refresh is automatic and doesn't need explicit cleanup
	// The library manages its own lifecycle
}

// VerifyCognitoIDToken verifies a Cognito ID token and returns the claims
func (m *JWKSManager) VerifyCognitoIDToken(ctx context.Context, tokenStr string) (*CognitoTokenClaims, error) {
	// Parse and validate the token
	token, err := jwt.ParseWithClaims(tokenStr, &CognitoTokenClaims{}, m.jwks.Keyfunc)
	if err != nil {
		m.logger.Warn("Token parsing failed: %v", err)
		return nil, NewAuthError("TOKEN_PARSE_FAILED", "Failed to parse token", err)
	}

	// Check if token is valid
	if !token.Valid {
		m.logger.Warn("Token is invalid")
		return nil, NewAuthError("TOKEN_INVALID", "Token validation failed", ErrInvalidToken)
	}

	// Extract claims
	claims, ok := token.Claims.(*CognitoTokenClaims)
	if !ok {
		m.logger.Error("Failed to extract claims from token")
		return nil, NewAuthError("CLAIMS_EXTRACTION_FAILED", "Failed to extract claims", ErrInvalidToken)
	}

	// Validate issuer
	if claims.Issuer != m.config.CognitoIssuer {
		m.logger.Warn("Invalid issuer: expected %s, got %s", m.config.CognitoIssuer, claims.Issuer)
		return nil, NewAuthError("INVALID_ISSUER", fmt.Sprintf("Expected issuer %s", m.config.CognitoIssuer), ErrInvalidIssuer)
	}

	// Validate audience
	validAudience := false
	for _, aud := range claims.Audience {
		if aud == m.config.CognitoAudience {
			validAudience = true
			break
		}
	}
	if !validAudience {
		m.logger.Warn("Invalid audience: expected %s, got %v", m.config.CognitoAudience, claims.Audience)
		return nil, NewAuthError("INVALID_AUDIENCE", fmt.Sprintf("Expected audience %s", m.config.CognitoAudience), ErrInvalidAudience)
	}

	// Validate token_use claim
	if claims.TokenUse != "id" {
		m.logger.Warn("Invalid token_use: expected 'id', got '%s'", claims.TokenUse)
		return nil, NewAuthError("INVALID_TOKEN_USE", "Expected token_use=id", ErrInvalidTokenType)
	}

	// Validate expiration (already checked by jwt library, but double-check)
	if time.Now().After(claims.ExpiresAt.Time) {
		m.logger.Warn("Token expired at %v", claims.ExpiresAt)
		return nil, NewAuthError("TOKEN_EXPIRED", "Token has expired", ErrTokenExpired)
	}

	// Validate subject exists
	if claims.Subject == "" {
		m.logger.Warn("Token missing subject claim")
		return nil, NewAuthError("MISSING_SUBJECT", "Token missing subject claim", ErrMissingSubject)
	}

	m.logger.Info("Token verified successfully for subject: %s", claims.Subject)

	// Emit success metric
	// TODO: Add metrics tracking for auth.success

	return claims, nil
}

// ExtractUserVars extracts user variables from Cognito claims
func ExtractUserVars(claims *CognitoTokenClaims) map[string]string {
	vars := make(map[string]string)

	if claims.Email != "" {
		vars["email"] = claims.Email
	}

	vars["email_verified"] = fmt.Sprintf("%t", claims.EmailVerified)

	if claims.Name != "" {
		vars["name"] = claims.Name
	}

	if claims.Picture != "" {
		vars["picture"] = claims.Picture
	}

	vars["provider"] = "cognito"

	// Add Cognito groups if present
	if len(claims.CognitoGroups) > 0 {
		// Join groups as comma-separated string
		groups := ""
		for i, group := range claims.CognitoGroups {
			if i > 0 {
				groups += ","
			}
			groups += group
		}
		vars["cognito_groups"] = groups
	}

	return vars
}
