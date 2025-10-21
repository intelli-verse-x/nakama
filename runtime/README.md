# AWS Cognito Authentication Module for Nakama

This Go runtime module enables Nakama to authenticate users with AWS Cognito ID tokens (JWT), manage custodial wallets, and provide blockchain transaction signing capabilities.

## Features

- **Cognito Authentication**: Verify AWS Cognito ID tokens against JWKS
- **Nakama Integration**: Authenticate/link accounts via AuthenticateCustom/LinkCustom
- **Custodial Wallets**: Optional wallet provisioning keyed by Cognito subject
- **EVM Support**: Sign and broadcast EVM transactions (custodial)
- **Cross-Platform**: Single Cognito User Pool for all games + website
- **Security**: Private keys stored in KMS/HSM, only public wallet data in Nakama

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   Client    │────▶│   Cognito    │────▶│   Nakama    │
│  (Game/Web) │     │  User Pool   │     │   Server    │
└─────────────┘     └──────────────┘     └─────────────┘
                           │                     │
                           │                     │
                           ▼                     ▼
                    ┌─────────────┐      ┌─────────────┐
                    │    JWKS     │      │  KMS/HSM    │
                    │   (Public   │      │  (Private   │
                    │    Keys)    │      │   Keys)     │
                    └─────────────┘      └─────────────┘
```

## RPC Endpoints

### 1. `rpc_cognito_login`

Authenticate a user with a Cognito ID token.

**Input:**
```json
{
  "id_token": "<Cognito ID JWT>",
  "create": true,
  "username": "optional-username"
}
```

**Output:**
```json
{
  "token": "<nakama-session-token>",
  "wallet": {
    "address": "0x...",
    "chain": "evm"
  }
}
```

**Behavior:**
- Verifies the ID token signature, issuer, audience, token_use, and expiration
- Creates external ID as `cognito:<sub>`
- Authenticates/creates Nakama account
- Provisions wallet if enabled
- Returns Nakama session token

### 2. `rpc_link_cognito`

Link a Cognito account to an existing Nakama session.

**Input:**
```json
{
  "id_token": "<Cognito ID JWT>"
}
```

**Output:**
```json
{
  "success": true,
  "wallet": {
    "address": "0x...",
    "chain": "evm"
  }
}
```

**Behavior:**
- Requires active Nakama session
- Verifies ID token
- Links Cognito identity to existing user
- Provisions wallet if enabled

### 3. `rpc_get_wallet`

Get wallet information for the current user.

**Input:** None (uses session context)

**Output:**
```json
{
  "address": "0x...",
  "chain": "evm"
}
```

**Behavior:**
- Requires active Nakama session
- Returns wallet address and chain
- Returns error if wallet not found

### 4. `rpc_sign_and_send` (Optional, custodial)

Sign and broadcast an EVM transaction.

**Input:**
```json
{
  "to": "0x...",
  "valueWei": "0x...",
  "data": "0x...",
  "gasLimit": "0x...",
  "maxFeePerGasWei": "0x...",
  "maxPriorityFeePerGasWei": "0x...",
  "nonce": 12
}
```

**Output:**
```json
{
  "txHash": "0x..."
}
```

**Behavior:**
- Requires active Nakama session with Cognito link
- Validates transaction parameters
- Signs transaction using KMS/HSM
- Broadcasts to blockchain (placeholder for now)
- Returns transaction hash

## Environment Variables

Configure these environment variables before starting Nakama:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NAKAMA_COGNITO_ISS` | Yes | - | Cognito issuer URL (e.g., `https://cognito-idp.us-east-1.amazonaws.com/us-east-1_XXXXXXXXX`) |
| `NAKAMA_COGNITO_AUDIENCE` | Yes | - | Cognito App Client ID |
| `NAKAMA_JWKS_CACHE_TTL` | No | 3600 | JWKS cache TTL in seconds |
| `NAKAMA_WALLET_ENABLED` | No | false | Enable wallet features |
| `NAKAMA_WALLET_CHAIN` | No | evm | Blockchain chain (evm or solana) |
| `NAKAMA_WALLET_MASTER_KEY_ARN` | Yes* | - | KMS/HSM master key ARN (*required if wallet enabled) |
| `NAKAMA_WALLET_DERIVATION_PATH` | No | m/44'/60'/0'/0 | HD wallet derivation path |

### Example Configuration

```bash
# Required
export NAKAMA_COGNITO_ISS="https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123"
export NAKAMA_COGNITO_AUDIENCE="1234567890abcdefghijklmno"

# Optional - Wallet Features
export NAKAMA_WALLET_ENABLED="true"
export NAKAMA_WALLET_CHAIN="evm"
export NAKAMA_WALLET_MASTER_KEY_ARN="arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012"
export NAKAMA_WALLET_DERIVATION_PATH="m/44'/60'/0'/0"

# Optional - JWKS
export NAKAMA_JWKS_CACHE_TTL="3600"
```

## Build Instructions

### Prerequisites

- Go 1.25.0 or later
- Nakama server (latest stable)
- Access to Nakama source code (for plugin building)

### Build the Plugin

```bash
# Navigate to the runtime directory
cd runtime

# Install dependencies
go mod tidy

# Build the plugin
go build -buildmode=plugin -trimpath -o ../modules/cognito_auth.so

# The plugin will be created in the modules directory
ls -lh ../modules/cognito_auth.so
```

### Using Docker Plugin Builder

For consistent builds across environments:

```bash
# From the nakama repository root
docker run --rm \
  -w "/builder" \
  -v "${PWD}/runtime:/builder" \
  heroiclabs/nakama-pluginbuilder:3.12.0 \
  build -buildmode=plugin -trimpath -o /builder/../modules/cognito_auth.so
```

## Running Nakama with the Module

### Using Docker Compose

1. Create a `docker-compose.yml`:

```yaml
version: '3'
services:
  postgres:
    image: postgres:12.2-alpine
    environment:
      POSTGRES_DB: nakama
      POSTGRES_PASSWORD: localdb
    ports:
      - "5432:5432"
    volumes:
      - data:/var/lib/postgresql/data

  nakama:
    image: heroiclabs/nakama:3.12.0
    depends_on:
      - postgres
    environment:
      # Cognito Configuration
      - NAKAMA_COGNITO_ISS=https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123
      - NAKAMA_COGNITO_AUDIENCE=1234567890abcdefghijklmno
      - NAKAMA_WALLET_ENABLED=true
      - NAKAMA_WALLET_CHAIN=evm
      - NAKAMA_WALLET_MASTER_KEY_ARN=arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012
    entrypoint:
      - "/bin/sh"
      - "-ecx"
      - >
        /nakama/nakama migrate up --database.address postgres:localdb@postgres:5432/nakama &&
        /nakama/nakama --database.address postgres:localdb@postgres:5432/nakama --runtime.path /nakama/data/modules
    ports:
      - "7349:7349"
      - "7350:7350"
      - "7351:7351"
    volumes:
      - ./modules:/nakama/data/modules

volumes:
  data:
```

2. Start the services:

```bash
docker-compose up
```

### Using Binary

```bash
# Set environment variables
export NAKAMA_COGNITO_ISS="https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123"
export NAKAMA_COGNITO_AUDIENCE="1234567890abcdefghijklmno"
export NAKAMA_WALLET_ENABLED="true"

# Run Nakama with the module
./nakama --runtime.path ./modules --database.address "root@localhost:26257"
```

## Testing

### Test with curl

1. Get a Cognito ID token from your app or AWS console

2. Login with Cognito:

```bash
curl -X POST http://localhost:7350/v2/rpc/rpc_cognito_login \
  -H "Content-Type: application/json" \
  -d '{
    "id_token": "eyJraWQiOiI...",
    "create": true,
    "username": "testuser"
  }'
```

3. Get wallet info (using the session token from login):

```bash
curl -X POST http://localhost:7350/v2/rpc/rpc_get_wallet \
  -H "Authorization: Bearer <session-token>" \
  -H "Content-Type: application/json"
```

## Security Considerations

### Token Verification

- All Cognito tokens are verified against the JWKS endpoint
- Issuer, audience, token_use, and expiration are validated
- Invalid tokens are rejected with clear error messages

### JWKS Rotation

- JWKS keys are automatically refreshed by the keyfunc library
- No manual intervention needed for key rotation
- Failed refreshes are logged but don't interrupt service

### Wallet Security

- **CRITICAL**: The current implementation uses a mock KMS signer for development
- **DO NOT USE IN PRODUCTION** without implementing actual KMS/HSM integration
- Private keys must NEVER be stored in Nakama's database
- Only public addresses are stored in Nakama storage

### Rate Limiting

- TODO: Implement rate limiting for `rpc_sign_and_send`
- Recommended: 10 transactions per minute per user
- Consider implementing spending limits and transaction policies

## Production Checklist

Before deploying to production:

- [ ] Replace `MockKMSSigner` with actual AWS KMS integration
- [ ] Configure AWS credentials for KMS access
- [ ] Set up proper key management and rotation policies
- [ ] Implement transaction broadcaster for blockchain network
- [ ] Add rate limiting for transaction signing
- [ ] Implement transaction policy checks (max value, allowed contracts)
- [ ] Set up monitoring and alerting for:
  - [ ] Authentication failures
  - [ ] JWKS refresh failures
  - [ ] Wallet provisioning errors
  - [ ] Transaction signing errors
- [ ] Configure proper CORS policies
- [ ] Use HTTPS/TLS for all connections
- [ ] Review and adjust JWKS cache TTL based on your security requirements
- [ ] Implement proper logging without PII
- [ ] Set up metrics collection

## Integration with KMS/HSM

### AWS KMS Integration (TODO)

The module is designed to work with AWS KMS. To integrate:

1. Uncomment and implement the `AWSKMSSigner` in `kms.go`
2. Install AWS SDK: `go get github.com/aws/aws-sdk-go-v2/service/kms`
3. Configure AWS credentials (IAM role, environment variables, or config file)
4. Update `GetKMSSigner` to return `AWSKMSSigner` instead of `MockKMSSigner`

### Key Derivation Strategy

- Use master key ARN to derive per-user keys
- Each Cognito subject gets a unique child key
- Derivation is deterministic but secure
- Private keys never leave KMS

## Troubleshooting

### Common Issues

**Module fails to load**
- Check Go version compatibility (1.25.0 required)
- Ensure nakama-common version matches server version
- Rebuild module with correct nakama-pluginbuilder version

**JWKS initialization fails**
- Verify `NAKAMA_COGNITO_ISS` is correct
- Check network connectivity to Cognito
- Ensure JWKS URL is accessible: `<ISS>/.well-known/jwks.json`

**Token verification fails**
- Check token hasn't expired
- Verify audience matches your Cognito App Client ID
- Ensure token is an ID token (not access token)
- Check issuer URL matches exactly

**Wallet not provisioned**
- Verify `NAKAMA_WALLET_ENABLED=true`
- Check `NAKAMA_WALLET_MASTER_KEY_ARN` is set
- Review logs for wallet provisioning errors

## Metrics and Logging

### Logged Events

- JWT verification success/failure (with reason, kid, iss, aud)
- Authentication success/failure
- Link success/failure
- Wallet provisioning
- Transaction signing attempts

### Recommended Metrics

- `auth.success` - Successful authentications
- `auth.failure` - Failed authentications (by reason)
- `link.success` - Successful account links
- `wallet.provisioned` - New wallets created
- `tx.signed` - Transactions signed
- `tx.broadcast` - Transactions broadcast

## Architecture Decisions

### External ID Format

- Format: `cognito:<sub>`
- Ensures uniqueness across authentication providers
- Allows same Cognito user across multiple games/apps
- Prevents collisions with other auth methods

### Wallet Storage

- Collection: `wallet`
- Key: external ID (e.g., `cognito:abc-123-def`)
- Value: JSON with chain, address, createdAt
- Permissions: Read-only for users, write-only for system

### Single User Pool Strategy

- One Cognito User Pool for all games and website
- Same user account across all apps
- Single wallet per user (shared across games)
- Simplified user management and identity

## Contributing

When contributing:

1. Follow existing code style and conventions
2. Add tests for new features
3. Update documentation
4. Run `go fmt` before committing
5. Ensure module builds without errors

## License

Copyright 2025 The Nakama Authors

Licensed under the Apache License, Version 2.0
