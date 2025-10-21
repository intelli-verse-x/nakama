# AWS Cognito Module - Quick Reference

## What This Module Does

This Nakama runtime module integrates AWS Cognito as a single identity provider for all games and websites, providing:

- **Unified Authentication**: One Cognito User Pool for all platforms (iOS, Android, Web, Unity)
- **Social Sign-In**: Support for Email, Google, Apple, and other identity providers
- **Custodial Wallets**: Automatic wallet creation for each Cognito user
- **Cross-Platform SSO**: Single sign-on across all games and applications

## Architecture Overview

```
┌─────────────────┐
│   Client App    │
│  (iOS/Android/  │
│   Web/Unity)    │
└────────┬────────┘
         │
         │ 1. Sign in with Cognito
         ▼
┌─────────────────┐
│  AWS Cognito    │
│   User Pool     │
│ (Email/Google/  │
│     Apple)      │
└────────┬────────┘
         │
         │ 2. Get ID token (JWT)
         ▼
┌─────────────────┐
│ Nakama Server   │
│  + Cognito      │
│    Module       │
└────────┬────────┘
         │
         │ 3. Verify & Authenticate
         ├──────────────┬──────────────┐
         ▼              ▼              ▼
┌──────────────┐ ┌────────────┐ ┌──────────┐
│ JWKS Cache   │ │   Nakama   │ │  Wallet  │
│ (RSA Keys)   │ │  Account   │ │ Storage  │
└──────────────┘ └────────────┘ └──────────┘
         │              │              │
         └──────────────┴──────────────┘
                        │
                        │ 4. Return session + wallet
                        ▼
                ┌──────────────┐
                │  Client App  │
                │ (Authenticated)│
                └──────────────┘
```

## RPC Endpoints

| Endpoint | Auth Required | Purpose |
|----------|---------------|---------|
| `rpc_cognito_login` | No | Authenticate with Cognito ID token |
| `rpc_link_cognito` | Yes | Link Cognito to existing account |
| `rpc_get_wallet` | Yes | Get wallet address and chain |
| `rpc_sign_and_send` | Yes | Sign and send transaction (custodial) |

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NAKAMA_COGNITO_ISS` | ✅ | - | Cognito User Pool issuer URL |
| `NAKAMA_COGNITO_AUDIENCE` | ✅ | - | App Client ID |
| `NAKAMA_JWKS_CACHE_TTL` | ❌ | 3600 | Cache TTL in seconds |
| `NAKAMA_WALLET_CHAIN` | ❌ | evm | Blockchain (evm/solana) |
| `NAKAMA_WALLET_MASTER_KEY_ARN` | ❌ | - | AWS KMS key ARN |
| `NAKAMA_WALLET_DERIVATION_PATH` | ❌ | m/44'/60'/0'/0 | HD derivation path |

## Quick Start

### 1. Build Module
```bash
cd cognito_module
./build.sh
```

### 2. Configure Environment
```bash
export NAKAMA_COGNITO_ISS=https://cognito-idp.us-east-1.amazonaws.com/us-east-1_XXXXX
export NAKAMA_COGNITO_AUDIENCE=your-app-client-id
```

### 3. Run Nakama
```bash
cp cognito_module.so ../data/modules/
cd ..
./nakama --runtime.path ./data/modules
```

## Client Example (JavaScript)

```javascript
// 1. Sign in with Cognito
import { Auth } from 'aws-amplify';
const user = await Auth.signIn(email, password);
const idToken = user.signInUserSession.idToken.jwtToken;

// 2. Authenticate with Nakama
const response = await nakamaClient.rpc(null, "rpc_cognito_login", {
  id_token: idToken
});

const { token, wallet } = JSON.parse(response.payload);

// 3. Use Nakama session
const session = Session.restore(token);
console.log(`Wallet: ${wallet.address} on ${wallet.chain}`);
```

## Security Features

✅ JWT signature verification using JWKS  
✅ Issuer and audience validation  
✅ Token expiration checking  
✅ Deterministic wallet derivation  
✅ Secure key caching  

## Files Structure

```
cognito_module/
├── README.md                      # Detailed API documentation
├── INTEGRATION_GUIDE.md           # Complete setup guide
├── QUICK_REFERENCE.md            # This file
├── cognito.go                     # Main module + RPC endpoints
├── jwt.go                         # JWT verification + JWKS cache
├── wallet.go                      # Wallet management
├── wallet_test.go                 # Unit tests
├── go.mod                         # Go module definition
├── go.sum                         # Dependency checksums
├── build.sh                       # Build script
├── .env.example                   # Environment variables example
└── docker-compose.example.yml     # Docker Compose example
```

## Common Use Cases

### 1. New User Sign-Up
1. User signs up via Cognito (Email/Google/Apple)
2. Client gets ID token
3. Call `rpc_cognito_login` with `create: true`
4. Nakama creates account + wallet
5. Return session token + wallet address

### 2. Returning User Login
1. User signs in via Cognito
2. Client gets ID token
3. Call `rpc_cognito_login`
4. Nakama authenticates existing user
5. Return session token + wallet address

### 3. Guest Upgrade
1. User starts as guest (device auth)
2. Later signs up with Cognito
3. Call `rpc_link_cognito` with ID token
4. Cognito account linked to existing user
5. Wallet created/retrieved

## Production Checklist

- [ ] Configure AWS Cognito User Pool
- [ ] Set up identity providers (Google, Apple)
- [ ] Create app clients for each platform
- [ ] Configure environment variables
- [ ] Build and deploy module
- [ ] Test authentication flow
- [ ] Set up monitoring and logging
- [ ] Configure AWS KMS for production wallets
- [ ] Implement rate limiting
- [ ] Set up backup strategy

## Support & Documentation

- **Detailed API Docs**: See `README.md`
- **Integration Guide**: See `INTEGRATION_GUIDE.md`
- **Nakama Docs**: https://heroiclabs.com/docs
- **AWS Cognito Docs**: https://docs.aws.amazon.com/cognito/
- **Issues**: https://github.com/intelli-verse-x/nakama/issues

## License

Apache License 2.0 - See LICENSE file
