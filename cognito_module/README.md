# AWS Cognito Authentication Module for Nakama

This module integrates AWS Cognito authentication with Nakama, providing a unified identity provider for all games and websites.

## Features

- **Cognito Sign-in**: Authenticate users with Cognito ID tokens (Email/Apple/Google)
- **Guest to Cognito Linking**: Link existing device-authenticated users to Cognito accounts
- **Custodial Wallets**: Automatic creation of deterministic wallets for each Cognito user
- **JWT Verification**: Secure verification of Cognito ID tokens with JWKS caching

## Environment Variables

Configure the module using the following environment variables:

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `NAKAMA_COGNITO_ISS` | Cognito User Pool Issuer URL | - | Yes |
| `NAKAMA_COGNITO_AUDIENCE` | App Client ID | - | Yes |
| `NAKAMA_JWKS_CACHE_TTL` | JWKS cache TTL in seconds | 3600 | No |
| `NAKAMA_WALLET_CHAIN` | Blockchain chain (evm or solana) | evm | No |
| `NAKAMA_WALLET_MASTER_KEY_ARN` | AWS KMS/HSM key ARN | - | No |
| `NAKAMA_WALLET_DERIVATION_PATH` | HD wallet derivation path | m/44'/60'/0'/0 | No |

### Example Configuration

```bash
NAKAMA_COGNITO_ISS=https://cognito-idp.us-east-1.amazonaws.com/us-east-1_XXXXXXXXX
NAKAMA_COGNITO_AUDIENCE=1234567890abcdefghijklmnop
NAKAMA_JWKS_CACHE_TTL=3600
NAKAMA_WALLET_CHAIN=evm
```

## RPC Endpoints

### rpc_cognito_login

Authenticate a user with a Cognito ID token.

**Request:**
```json
{
  "id_token": "eyJraWQiOiI...",
  "create": true,
  "username": "player123"
}
```

**Response:**
```json
{
  "token": "nakama_session_token...",
  "wallet": {
    "address": "0x1234567890abcdef...",
    "chain": "evm"
  }
}
```

### rpc_link_cognito

Link a Cognito account to an existing Nakama user (requires authentication).

**Request:**
```json
{
  "id_token": "eyJraWQiOiI..."
}
```

**Response:**
```json
{
  "address": "0x1234567890abcdef...",
  "chain": "evm"
}
```

### rpc_get_wallet

Get the wallet information for the authenticated user (requires authentication).

**Request:**
```json
{}
```

**Response:**
```json
{
  "address": "0x1234567890abcdef...",
  "chain": "evm"
}
```

### rpc_sign_and_send

Sign and send a blockchain transaction using the custodial wallet (requires authentication).

**Request (EVM):**
```json
{
  "to": "0xabcdef1234567890...",
  "valueWei": "1000000000000000000",
  "data": "0x...",
  "gasLimit": "21000",
  "maxFeePerGasWei": "50000000000",
  "maxPriorityFeePerGasWei": "2000000000",
  "nonce": 0
}
```

**Response:**
```json
{
  "txHash": "0xabcdef..."
}
```

**Note:** The transaction signing implementation is currently a placeholder. In production, this should integrate with AWS KMS/HSM for secure key management.

## Building the Module

1. Navigate to the module directory:
   ```bash
   cd cognito_module
   ```

2. Build the module as a shared library:
   ```bash
   go build -buildmode=plugin -trimpath -o ./cognito_module.so
   ```

3. Copy the module to Nakama's modules directory:
   ```bash
   cp cognito_module.so /path/to/nakama/modules/
   ```

## Running with Nakama

### Local Development

```bash
./nakama --runtime.path /path/to/nakama/modules
```

### Docker

1. Build the module using the plugin builder:
   ```bash
   docker run --rm -w "/builder" -v "${PWD}:/builder" \
     heroiclabs/nakama-pluginbuilder:3.12.0 \
     build -buildmode=plugin -trimpath -o ./cognito_module.so
   ```

2. Update docker-compose.yml to mount the module:
   ```yaml
   nakama:
     image: heroiclabs/nakama:3.12.0
     volumes:
       - ./cognito_module.so:/nakama/data/modules/cognito_module.so
     environment:
       - NAKAMA_COGNITO_ISS=https://cognito-idp.us-east-1.amazonaws.com/...
       - NAKAMA_COGNITO_AUDIENCE=your-app-client-id
   ```

## AWS Cognito Setup

1. **Create a User Pool** in AWS Cognito
2. **Create App Clients** for each platform (iOS, Android, Web, Unity)
3. **Configure Identity Providers** (Google, Apple, etc.)
4. **Set up Hosted UI** domain
5. **Configure Redirect URIs** for each app client
6. **Note the Issuer URL**: `https://cognito-idp.<region>.amazonaws.com/<user_pool_id>`

## Security Considerations

- **JWKS Caching**: Keys are cached with a configurable TTL to minimize requests to Cognito
- **Token Verification**: All tokens are verified for signature, issuer, audience, token_use, and expiration
- **Custodial Wallets**: Private keys should be managed using AWS KMS or HSM in production
- **Deterministic Derivation**: Wallet addresses are derived deterministically from the Cognito sub claim

## Development Status

- ✅ JWT verification with JWKS caching
- ✅ rpc_cognito_login endpoint
- ✅ rpc_link_cognito endpoint
- ✅ rpc_get_wallet endpoint
- ✅ Deterministic wallet creation
- ✅ User metadata updates
- ⚠️ rpc_sign_and_send (placeholder implementation - requires KMS/HSM integration)

## License

Copyright 2024 The Nakama Authors. Licensed under the Apache License, Version 2.0.
