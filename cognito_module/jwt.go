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
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/heroiclabs/nakama-common/runtime"
)

// JWK represents a JSON Web Key
type JWK struct {
	Kid string `json:"kid"`
	Kty string `json:"kty"`
	Alg string `json:"alg"`
	Use string `json:"use"`
	N   string `json:"n"`
	E   string `json:"e"`
}

// JWKS represents a set of JSON Web Keys
type JWKS struct {
	Keys []JWK `json:"keys"`
}

// JWKSCache manages caching of JWKS keys
type JWKSCache struct {
	issuer     string
	jwksURL    string
	cache      map[string]*rsa.PublicKey
	cacheMutex sync.RWMutex
	ttl        time.Duration
	lastFetch  time.Time
	logger     runtime.Logger
}

// NewJWKSCache creates a new JWKS cache
func NewJWKSCache(issuer string, ttl time.Duration, logger runtime.Logger) *JWKSCache {
	jwksURL := issuer + "/.well-known/jwks.json"
	return &JWKSCache{
		issuer:  issuer,
		jwksURL: jwksURL,
		cache:   make(map[string]*rsa.PublicKey),
		ttl:     ttl,
		logger:  logger,
	}
}

// GetKey retrieves a public key by kid, fetching from JWKS if necessary
func (c *JWKSCache) GetKey(kid string) (*rsa.PublicKey, error) {
	c.cacheMutex.RLock()
	key, exists := c.cache[kid]
	needsRefresh := time.Since(c.lastFetch) > c.ttl
	c.cacheMutex.RUnlock()

	if exists && !needsRefresh {
		return key, nil
	}

	// Fetch JWKS
	if err := c.fetchJWKS(); err != nil {
		return nil, fmt.Errorf("failed to fetch JWKS: %w", err)
	}

	// Try again after fetching
	c.cacheMutex.RLock()
	key, exists = c.cache[kid]
	c.cacheMutex.RUnlock()

	if !exists {
		return nil, fmt.Errorf("key with kid '%s' not found in JWKS", kid)
	}

	return key, nil
}

// fetchJWKS fetches the JWKS from the issuer
func (c *JWKSCache) fetchJWKS() error {
	c.logger.Info("Fetching JWKS from %s", c.jwksURL)

	resp, err := http.Get(c.jwksURL)
	if err != nil {
		return fmt.Errorf("failed to fetch JWKS: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("JWKS endpoint returned status %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("failed to read JWKS response: %w", err)
	}

	var jwks JWKS
	if err := json.Unmarshal(body, &jwks); err != nil {
		return fmt.Errorf("failed to parse JWKS: %w", err)
	}

	// Update cache
	c.cacheMutex.Lock()
	defer c.cacheMutex.Unlock()

	for _, jwk := range jwks.Keys {
		if jwk.Kty != "RSA" {
			continue
		}

		key, err := jwkToRSAPublicKey(jwk)
		if err != nil {
			c.logger.Warn("Failed to convert JWK to RSA public key: %v", err)
			continue
		}

		c.cache[jwk.Kid] = key
	}

	c.lastFetch = time.Now()
	c.logger.Info("JWKS cache updated with %d keys", len(c.cache))

	return nil
}

// jwkToRSAPublicKey converts a JWK to an RSA public key
func jwkToRSAPublicKey(jwk JWK) (*rsa.PublicKey, error) {
	// Decode base64url encoded n and e
	nBytes, err := base64.RawURLEncoding.DecodeString(jwk.N)
	if err != nil {
		return nil, fmt.Errorf("failed to decode n: %w", err)
	}

	eBytes, err := base64.RawURLEncoding.DecodeString(jwk.E)
	if err != nil {
		return nil, fmt.Errorf("failed to decode e: %w", err)
	}

	// Convert to big integers
	n := new(big.Int).SetBytes(nBytes)
	e := new(big.Int).SetBytes(eBytes)

	return &rsa.PublicKey{
		N: n,
		E: int(e.Int64()),
	}, nil
}

// verifyCognitoIDToken verifies a Cognito ID token and returns the claims
func (m *CognitoModule) verifyCognitoIDToken(idToken string) (map[string]interface{}, error) {
	// Parse token to get header
	token, err := jwt.Parse(idToken, func(token *jwt.Token) (interface{}, error) {
		// Verify signing method
		if _, ok := token.Method.(*jwt.SigningMethodRSA); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
		}

		// Get kid from header
		kid, ok := token.Header["kid"].(string)
		if !ok {
			return nil, fmt.Errorf("missing kid in token header")
		}

		// Get public key from JWKS cache
		return m.jwksCache.GetKey(kid)
	})

	if err != nil {
		return nil, fmt.Errorf("failed to parse/verify token: %w", err)
	}

	if !token.Valid {
		return nil, fmt.Errorf("token is invalid")
	}

	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return nil, fmt.Errorf("failed to extract claims")
	}

	// Verify issuer
	iss, ok := claims["iss"].(string)
	if !ok || iss != m.config.Issuer {
		return nil, fmt.Errorf("invalid issuer: expected %s, got %s", m.config.Issuer, iss)
	}

	// Verify audience
	aud, ok := claims["aud"].(string)
	if !ok {
		// aud might be an array
		if audArray, ok := claims["aud"].([]interface{}); ok && len(audArray) > 0 {
			if audStr, ok := audArray[0].(string); ok {
				aud = audStr
			}
		}
	}
	if aud != m.config.Audience {
		return nil, fmt.Errorf("invalid audience: expected %s, got %s", m.config.Audience, aud)
	}

	// Verify token_use
	tokenUse, ok := claims["token_use"].(string)
	if !ok || tokenUse != "id" {
		return nil, fmt.Errorf("invalid token_use: expected 'id', got '%s'", tokenUse)
	}

	// Verify expiration
	exp, ok := claims["exp"].(float64)
	if !ok {
		return nil, fmt.Errorf("missing or invalid exp claim")
	}
	if time.Now().Unix() >= int64(exp) {
		return nil, fmt.Errorf("token has expired")
	}

	return claims, nil
}

// decodeHeader decodes the JWT header without verification
func decodeHeader(tokenString string) (map[string]interface{}, error) {
	parts := strings.Split(tokenString, ".")
	if len(parts) != 3 {
		return nil, fmt.Errorf("invalid token format")
	}

	headerBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return nil, fmt.Errorf("failed to decode header: %w", err)
	}

	var header map[string]interface{}
	if err := json.Unmarshal(headerBytes, &header); err != nil {
		return nil, fmt.Errorf("failed to unmarshal header: %w", err)
	}

	return header, nil
}
