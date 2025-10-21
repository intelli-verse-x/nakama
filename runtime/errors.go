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
	"errors"
	"fmt"
)

// Error codes for authentication
var (
	ErrInvalidToken      = errors.New("invalid token")
	ErrTokenExpired      = errors.New("token expired")
	ErrInvalidIssuer     = errors.New("invalid issuer")
	ErrInvalidAudience   = errors.New("invalid audience")
	ErrInvalidTokenType  = errors.New("invalid token type")
	ErrMissingSubject    = errors.New("missing subject claim")
	ErrJWKSFetch         = errors.New("failed to fetch JWKS")
	ErrInvalidSignature  = errors.New("invalid token signature")
	ErrAuthFailed        = errors.New("authentication failed")
	ErrLinkFailed        = errors.New("link failed")
	ErrWalletNotEnabled  = errors.New("wallet feature not enabled")
	ErrWalletNotFound    = errors.New("wallet not found")
	ErrKMSOperation      = errors.New("KMS operation failed")
	ErrInvalidChain      = errors.New("invalid blockchain chain")
	ErrRateLimitExceeded = errors.New("rate limit exceeded")
	ErrInsufficientFunds = errors.New("insufficient funds")
	ErrInvalidPayload    = errors.New("invalid payload")
)

// AuthError wraps authentication errors with context
type AuthError struct {
	Code    string
	Message string
	Err     error
}

func (e *AuthError) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("%s: %s (%v)", e.Code, e.Message, e.Err)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (e *AuthError) Unwrap() error {
	return e.Err
}

// NewAuthError creates a new authentication error
func NewAuthError(code, message string, err error) *AuthError {
	return &AuthError{
		Code:    code,
		Message: message,
		Err:     err,
	}
}
