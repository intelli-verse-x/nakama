# Setup Instructions

This document provides step-by-step instructions to get the Cognito authentication module working with Nakama.

## Quick Start

### Step 1: Build the Module

```bash
# From the nakama repository root
cd runtime

# Download dependencies
go mod tidy

# Build the plugin
go build -buildmode=plugin -trimpath -o ../modules/cognito_auth.so

# Verify the plugin was created
ls -lh ../modules/cognito_auth.so
```

### Step 2: Configure AWS Cognito

1. **Create a Cognito User Pool** (if you don't have one):
   - Go to AWS Console → Cognito
   - Click "Create user pool"
   - Configure sign-in options (email, phone, username, etc.)
   - Configure security requirements
   - Note the Pool ID (e.g., `us-east-1_ABC123`)

2. **Create an App Client**:
   - In your User Pool, go to "App integration"
   - Click "Create app client"
   - Note the App Client ID (this is your AUDIENCE)

3. **Get your Issuer URL**:
   - Format: `https://cognito-idp.<region>.amazonaws.com/<pool_id>`
   - Example: `https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123`

### Step 3: Configure Environment Variables

Create a `.env` file or export these variables:

```bash
# Required Configuration
export NAKAMA_COGNITO_ISS="https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123"
export NAKAMA_COGNITO_AUDIENCE="1234567890abcdefghijklmno"

# Optional - Enable Wallets
export NAKAMA_WALLET_ENABLED="false"  # Set to "true" to enable

# Optional - If wallets enabled
# export NAKAMA_WALLET_CHAIN="evm"
# export NAKAMA_WALLET_MASTER_KEY_ARN="arn:aws:kms:us-east-1:123456789012:key/your-key-id"
```

### Step 4: Run Nakama

#### Option A: Using Docker Compose (Recommended)

1. Create `docker-compose.yml` in the nakama root directory:

```yaml
version: '3'
services:
  postgres:
    image: postgres:12.2-alpine
    environment:
      POSTGRES_DB: nakama
      POSTGRES_PASSWORD: localdb
    volumes:
      - data:/var/lib/postgresql/data
    ports:
      - "5432:5432"

  nakama:
    image: heroiclabs/nakama:3.12.0
    depends_on:
      - postgres
    environment:
      # Cognito Configuration - UPDATE THESE
      - NAKAMA_COGNITO_ISS=https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123
      - NAKAMA_COGNITO_AUDIENCE=your-app-client-id
      - NAKAMA_WALLET_ENABLED=false
    entrypoint:
      - "/bin/sh"
      - "-ecx"
      - >
        /nakama/nakama migrate up --database.address postgres:localdb@postgres:5432/nakama &&
        /nakama/nakama --database.address postgres:localdb@postgres:5432/nakama --runtime.path /nakama/data/modules --logger.level DEBUG
    ports:
      - "7349:7349"  # gRPC
      - "7350:7350"  # HTTP
      - "7351:7351"  # Console
    volumes:
      - ./modules:/nakama/data/modules

volumes:
  data:
```

2. Start the services:

```bash
docker-compose up
```

3. Check logs for successful initialization:

```
INFO Initializing Cognito authentication module
INFO Configuration loaded:
INFO   Cognito Issuer: https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123
INFO   Cognito Audience: your-app-client-id
INFO JWKS manager initialized successfully
INFO Registered RPC: rpc_cognito_login
INFO Registered RPC: rpc_link_cognito
INFO Registered RPC: rpc_get_wallet
INFO Cognito authentication module initialized successfully
```

#### Option B: Using Nakama Binary

```bash
# Start your database (e.g., CockroachDB or PostgreSQL)
# ...

# Run migration
./nakama migrate up --database.address "root@localhost:26257"

# Start Nakama with the module
./nakama \
  --database.address "root@localhost:26257" \
  --runtime.path ./modules \
  --logger.level DEBUG
```

### Step 5: Test the Integration

#### Get a Test Token from Cognito

Use AWS CLI to create a test user and get a token:

```bash
# Create a test user
aws cognito-idp admin-create-user \
  --user-pool-id us-east-1_ABC123 \
  --username testuser \
  --temporary-password TempPassword123! \
  --user-attributes Name=email,Value=test@example.com

# Initiate auth to get tokens
aws cognito-idp admin-initiate-auth \
  --user-pool-id us-east-1_ABC123 \
  --client-id your-app-client-id \
  --auth-flow ADMIN_NO_SRP_AUTH \
  --auth-parameters USERNAME=testuser,PASSWORD=TempPassword123!
```

Or use the Cognito hosted UI:
1. Go to your User Pool → App integration → App client
2. Configure callback URL (e.g., http://localhost:3000/callback)
3. Open the hosted UI URL
4. Sign in and capture the ID token from the callback

#### Test RPC Endpoints

1. **Test Login**:

```bash
curl -X POST http://localhost:7350/v2/rpc/rpc_cognito_login \
  -H "Content-Type: application/json" \
  -d '{
    "id_token": "eyJraWQiOiI...",
    "create": true,
    "username": "testuser"
  }'
```

Expected response:
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "wallet": null
}
```

2. **Test Get Wallet** (if enabled):

```bash
curl -X POST http://localhost:7350/v2/rpc/rpc_get_wallet \
  -H "Authorization: Bearer <nakama-session-token>" \
  -H "Content-Type: application/json"
```

Expected response:
```json
{
  "address": "0x...",
  "chain": "evm"
}
```

## Advanced Configuration

### Enable Wallet Features

1. Set environment variables:

```bash
export NAKAMA_WALLET_ENABLED="true"
export NAKAMA_WALLET_CHAIN="evm"
export NAKAMA_WALLET_MASTER_KEY_ARN="arn:aws:kms:us-east-1:123456789012:key/your-key-id"
```

2. **IMPORTANT**: The current implementation uses a mock KMS signer. For production:
   - Implement actual AWS KMS integration in `kms.go`
   - Uncomment and complete the `AWSKMSSigner` implementation
   - Configure AWS credentials for KMS access

### Custom JWKS Cache TTL

```bash
export NAKAMA_JWKS_CACHE_TTL="7200"  # 2 hours in seconds
```

### Multiple App Clients

If you have multiple Cognito app clients (e.g., iOS, Android, Web), you need to:

1. Use the same Cognito User Pool for all
2. Either:
   - Configure each app client with the same ID (share app client)
   - OR modify the code to accept multiple audiences
   - OR set up separate Nakama instances per platform

### Production Deployment

For production deployment:

1. **Use proper secrets management**:
   - Don't hardcode credentials
   - Use AWS Secrets Manager or Parameter Store
   - Or use environment-specific configs

2. **Enable monitoring**:
   - Set up CloudWatch or Prometheus metrics
   - Monitor authentication success/failure rates
   - Alert on JWKS refresh failures

3. **Configure proper logging**:
   - Set log level to INFO or WARN in production
   - Ensure no PII is logged
   - Use structured logging

4. **Implement KMS integration**:
   - Complete the AWS KMS signer implementation
   - Test key derivation and signing
   - Set up proper IAM policies

## Troubleshooting

### Issue: Module fails to load

**Error**: `plugin was built with a different version of package`

**Solution**: Ensure you're using the correct version of nakama-common:
```bash
cd runtime
go get github.com/heroiclabs/nakama-common@v1.42.1
go mod tidy
go build -buildmode=plugin -trimpath -o ../modules/cognito_auth.so
```

### Issue: JWKS initialization fails

**Error**: `Failed to initialize JWKS`

**Check**:
1. Verify `NAKAMA_COGNITO_ISS` is correct
2. Test JWKS URL manually:
   ```bash
   curl https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ABC123/.well-known/jwks.json
   ```
3. Check network connectivity from Nakama to AWS

### Issue: Token verification fails

**Error**: `Invalid issuer` or `Invalid audience`

**Check**:
1. Verify the token is an ID token (not access token)
2. Check `token_use` claim in the token: should be `"id"`
3. Decode the token at jwt.io and verify:
   - `iss` matches `NAKAMA_COGNITO_ISS`
   - `aud` matches `NAKAMA_COGNITO_AUDIENCE`
   - `exp` is in the future

### Issue: Wallet not created

**Error**: `Wallet not enabled` or `Wallet not found`

**Check**:
1. Verify `NAKAMA_WALLET_ENABLED=true` is set
2. Check logs for wallet provisioning errors
3. Verify `NAKAMA_WALLET_MASTER_KEY_ARN` is set if wallets enabled

### Issue: Authentication succeeds but no Nakama account created

**Check**:
1. Ensure `create: true` in the login request
2. Check Nakama logs for authentication errors
3. Verify database connectivity

## Next Steps

Now that the module is running:

1. **Integration**:
   - Integrate with your client application (Unity, Unreal, etc.)
   - Use Nakama client SDKs to call RPCs
   - Handle session tokens properly

2. **Security Review**:
   - Review and test token validation
   - Implement rate limiting
   - Add transaction policies if using wallets

3. **Production Prep**:
   - Replace mock KMS with real KMS integration
   - Set up monitoring and alerting
   - Configure proper logging
   - Load test the authentication flow

4. **Documentation**:
   - Document your specific Cognito setup
   - Create runbooks for common issues
   - Train your team on the authentication flow

## Additional Resources

- [Nakama Runtime Documentation](https://heroiclabs.com/docs/runtime-code-basics/)
- [AWS Cognito Documentation](https://docs.aws.amazon.com/cognito/)
- [JWT Best Practices](https://tools.ietf.org/html/rfc8725)
- [Nakama Client SDKs](https://github.com/heroiclabs)

## Support

For issues specific to this module:
1. Check the troubleshooting section above
2. Review Nakama logs with DEBUG level
3. Test JWKS and token validation separately

For general Nakama support:
- [Nakama Community Forum](https://forum.heroiclabs.com)
- [Nakama Documentation](https://heroiclabs.com/docs)
