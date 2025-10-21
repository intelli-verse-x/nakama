# AWS Cognito Integration Guide

This guide walks you through integrating AWS Cognito authentication with Nakama using the Cognito module.

## Prerequisites

- Nakama server 3.12.0 or later
- AWS account with Cognito User Pool configured
- Go 1.25.0 or later (for building the module)

## Quick Start

### 1. AWS Cognito Setup

1. **Create a User Pool** in AWS Cognito Console
   - Navigate to Amazon Cognito → User Pools → Create user pool
   - Choose sign-in options (Email, Phone, Username)
   - Configure password policies and MFA as needed

2. **Configure App Clients**
   - Create separate app clients for each platform (iOS, Android, Web, Unity)
   - For native apps: **Do not generate a client secret**
   - For web apps: You can optionally use client secrets

3. **Enable Identity Providers**
   - Go to User pool → Sign-in experience → Federated identity providers
   - Add Google, Apple, or other IdPs
   - Configure OAuth scopes (openid, email, profile)

4. **Set up Hosted UI Domain**
   - Go to App integration → Domain
   - Create a Cognito domain or custom domain
   - Configure redirect URIs for each app client

5. **Note Configuration Values**
   ```
   User Pool ID: us-east-1_XXXXXXXXX
   App Client ID: 1234567890abcdefghijklmnop
   Issuer: https://cognito-idp.<region>.amazonaws.com/<user_pool_id>
   ```

### 2. Build the Module

```bash
# Clone the repository
git clone https://github.com/intelli-verse-x/nakama.git
cd nakama/cognito_module

# Download dependencies
go mod download

# Build the module
go build -buildmode=plugin -trimpath -o cognito_module.so

# Copy to Nakama modules directory
mkdir -p ../data/modules
cp cognito_module.so ../data/modules/
```

### 3. Configure Environment Variables

Create a `.env` file or set environment variables:

```bash
export NAKAMA_COGNITO_ISS=https://cognito-idp.us-east-1.amazonaws.com/us-east-1_XXXXXXXXX
export NAKAMA_COGNITO_AUDIENCE=your-app-client-id
export NAKAMA_JWKS_CACHE_TTL=3600
export NAKAMA_WALLET_CHAIN=evm
```

### 4. Run Nakama with the Module

#### Local Development

```bash
cd ..
./nakama --runtime.path ./data/modules
```

#### Docker Compose

Use the provided `docker-compose.example.yml`:

```bash
# First, build the module
docker run --rm -w "/builder" -v "${PWD}:/builder" \
  heroiclabs/nakama-pluginbuilder:3.12.0 \
  build -buildmode=plugin -trimpath -o ./cognito_module.so

# Copy example config
cp docker-compose.example.yml docker-compose.yml

# Edit docker-compose.yml to set your Cognito configuration
nano docker-compose.yml

# Start services
docker-compose up -d
```

## Client Integration

### Authentication Flow

#### Option 1: Direct Cognito Login

```javascript
// 1. Get Cognito ID token using AWS Amplify or Cognito SDK
import { Auth } from 'aws-amplify';

const user = await Auth.signIn(email, password);
const idToken = user.signInUserSession.idToken.jwtToken;

// 2. Call Nakama RPC to authenticate
const response = await nakamaClient.rpc(session, "rpc_cognito_login", {
  id_token: idToken,
  create: true,
  username: "player123"
});

const result = JSON.parse(response.payload);
// result.token - Nakama session token
// result.wallet.address - User's wallet address
// result.wallet.chain - Blockchain chain (evm/solana)

// 3. Create Nakama session with returned token
const nakamaSession = Session.restore(result.token);
```

#### Option 2: Guest to Cognito Linking

```javascript
// 1. Start with device authentication
const session = await nakamaClient.authenticateDevice(deviceId, true);

// 2. Later, user signs up with Cognito
const user = await Auth.signIn(email, password);
const idToken = user.signInUserSession.idToken.jwtToken;

// 3. Link Cognito account to existing Nakama account
const response = await nakamaClient.rpc(session, "rpc_link_cognito", {
  id_token: idToken
});

const wallet = JSON.parse(response.payload);
// wallet.address - User's wallet address
// wallet.chain - Blockchain chain
```

### Get Wallet Information

```javascript
const response = await nakamaClient.rpc(session, "rpc_get_wallet", {});
const wallet = JSON.parse(response.payload);
console.log(`Wallet: ${wallet.address} on ${wallet.chain}`);
```

### Sign and Send Transaction (Custodial)

```javascript
const response = await nakamaClient.rpc(session, "rpc_sign_and_send", {
  to: "0xRecipientAddress...",
  valueWei: "1000000000000000000", // 1 ETH in wei
  gasLimit: "21000",
  maxFeePerGasWei: "50000000000",
  maxPriorityFeePerGasWei: "2000000000"
});

const result = JSON.parse(response.payload);
console.log(`Transaction hash: ${result.txHash}`);
```

**Note:** The transaction signing is currently a placeholder. For production, integrate with AWS KMS/HSM.

## Architecture

### Components

1. **JWT Verification**: Validates Cognito ID tokens using JWKS
   - Fetches public keys from Cognito JWKS endpoint
   - Caches keys with configurable TTL
   - Verifies token signature, issuer, audience, and expiration

2. **Authentication**: Creates or links Nakama accounts
   - Uses Cognito `sub` claim as unique identifier
   - Format: `cognito:<sub>`
   - Supports both new account creation and linking

3. **Wallet Management**: Creates deterministic custodial wallets
   - One wallet per Cognito user
   - Deterministic derivation from `cognito:sub`
   - Stored in Nakama storage

4. **RPC Endpoints**:
   - `rpc_cognito_login`: Login with Cognito ID token
   - `rpc_link_cognito`: Link Cognito to existing account
   - `rpc_get_wallet`: Retrieve wallet information
   - `rpc_sign_and_send`: Sign and send transactions (custodial)

### Data Flow

```
Client App
    |
    | (Get ID token)
    v
AWS Cognito
    |
    | (ID token)
    v
Nakama RPC (rpc_cognito_login)
    |
    | (Verify token)
    v
JWKS Cache
    |
    | (Authenticate)
    v
Nakama Account (cognito:<sub>)
    |
    | (Create/load wallet)
    v
Wallet Storage
    |
    | (Return)
    v
Client (Nakama session + wallet info)
```

## Security Considerations

### Token Verification
- All ID tokens are verified for:
  - Valid signature using JWKS
  - Correct issuer (Cognito User Pool)
  - Correct audience (App Client ID)
  - Token type (`token_use: "id"`)
  - Not expired

### JWKS Caching
- Public keys are cached to minimize requests to Cognito
- Cache automatically refreshes based on TTL
- Missing keys trigger immediate fetch

### Wallet Security
- **Current Implementation**: Simplified deterministic derivation
- **Production Recommendation**:
  - Use AWS KMS or HSM for key management
  - Implement proper HD wallet derivation (BIP-32/BIP-44)
  - Store only public addresses in Nakama
  - Sign transactions server-side using KMS

### Environment Isolation
- Use separate Cognito User Pools for dev/staging/production
- Use different App Client IDs per environment
- Rotate credentials regularly

## Troubleshooting

### Module Not Loading

Check Nakama logs for errors:
```bash
docker-compose logs nakama | grep -i cognito
```

Common issues:
- Module not in correct path (`/nakama/data/modules/`)
- Environment variables not set
- Module built with wrong Go/Nakama version

### Token Verification Failed

Possible causes:
1. **Invalid issuer**: Check `NAKAMA_COGNITO_ISS` matches User Pool
2. **Invalid audience**: Check `NAKAMA_COGNITO_AUDIENCE` matches App Client ID
3. **Expired token**: Tokens are typically valid for 1 hour
4. **JWKS fetch failed**: Check network connectivity to Cognito
5. **Token type**: Ensure you're using ID token, not access token

### Authentication Failed

1. Verify Cognito user exists and is confirmed
2. Check that `create` flag is set appropriately
3. Review Nakama server logs for detailed errors
4. Verify user pool allows username/password authentication

## Production Deployment

### Recommended Setup

1. **Use AWS KMS for Key Management**
   ```bash
   NAKAMA_WALLET_MASTER_KEY_ARN=arn:aws:kms:region:account:key/key-id
   ```

2. **Enable Monitoring**
   - Monitor JWKS fetch failures
   - Track authentication success/failure rates
   - Alert on unusual wallet creation patterns

3. **Implement Rate Limiting**
   - Limit login attempts per IP
   - Throttle RPC calls per user
   - Monitor for abuse patterns

4. **Backup Strategy**
   - Regular backups of Nakama database
   - Wallet records are critical - ensure redundancy
   - Document key recovery procedures

5. **High Availability**
   - Run multiple Nakama instances behind load balancer
   - Use managed database (RDS, Cloud SQL)
   - Replicate across availability zones

## Testing

### Unit Tests

```bash
cd cognito_module
go test -v
```

### Integration Testing

1. Set up test Cognito User Pool
2. Create test users
3. Generate test ID tokens
4. Call RPC endpoints with test tokens

Example test script:
```javascript
// test-cognito.js
const { Client } = require("@heroiclabs/nakama-js");

async function testCognitoLogin() {
  const client = new Client("defaultkey", "localhost", "7350");
  
  // Replace with real test ID token
  const testIdToken = "eyJraWQiOi...";
  
  const response = await client.rpc(null, "rpc_cognito_login", {
    id_token: testIdToken,
    create: true
  });
  
  console.log("Login response:", JSON.parse(response.payload));
}

testCognitoLogin().catch(console.error);
```

## Support

For issues or questions:
- Check Nakama documentation: https://heroiclabs.com/docs
- AWS Cognito documentation: https://docs.aws.amazon.com/cognito/
- File issues on GitHub: https://github.com/intelli-verse-x/nakama

## License

Copyright 2024 The Nakama Authors. Licensed under the Apache License, Version 2.0.
