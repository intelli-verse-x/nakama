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
	"encoding/json"
)

// WalletInfo represents wallet information
type WalletInfo struct {
	Address string `json:"address"`
	Chain   string `json:"chain"`
}

// LoginResponse is returned from rpc_cognito_login
type LoginResponse struct {
	Token  string      `json:"token"`
	Wallet *WalletInfo `json:"wallet,omitempty"`
}

// LinkResponse is returned from rpc_link_cognito
type LinkResponse struct {
	Success bool        `json:"success"`
	Wallet  *WalletInfo `json:"wallet,omitempty"`
}

// WalletResponse is returned from rpc_get_wallet
type WalletResponse struct {
	Address string `json:"address"`
	Chain   string `json:"chain"`
}

// SignAndSendResponse is returned from rpc_sign_and_send
type SignAndSendResponse struct {
	TxHash string `json:"txHash"`
}

// ErrorResponse represents an error response
type ErrorResponse struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// ToJSON converts a struct to JSON string
func ToJSON(v interface{}) (string, error) {
	bytes, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	return string(bytes), nil
}

// FromJSON parses JSON string into a struct
func FromJSON(data string, v interface{}) error {
	return json.Unmarshal([]byte(data), v)
}
