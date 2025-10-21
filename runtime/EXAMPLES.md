# Example Client Integration

This directory contains example code for integrating the Cognito authentication module with various client platforms.

## JavaScript/TypeScript Example

### Using Nakama JavaScript SDK

```javascript
import { Client } from "@heroiclabs/nakama-js";
import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
} from "amazon-cognito-identity-js";

// Configure Cognito
const poolData = {
  UserPoolId: "us-east-1_ABC123",
  ClientId: "your-app-client-id",
};
const userPool = new CognitoUserPool(poolData);

// Configure Nakama
const client = new Client("defaultkey", "localhost", "7350");
client.ssl = false;

// Authenticate with Cognito and get ID token
async function authenticateWithCognito(username, password) {
  return new Promise((resolve, reject) => {
    const authenticationData = {
      Username: username,
      Password: password,
    };
    const authenticationDetails = new AuthenticationDetails(authenticationData);

    const userData = {
      Username: username,
      Pool: userPool,
    };
    const cognitoUser = new CognitoUser(userData);

    cognitoUser.authenticateUser(authenticationDetails, {
      onSuccess: (result) => {
        const idToken = result.getIdToken().getJwtToken();
        resolve(idToken);
      },
      onFailure: (err) => {
        reject(err);
      },
    });
  });
}

// Login to Nakama using Cognito token
async function loginToNakama(cognitoIdToken, username = null) {
  // Call the rpc_cognito_login RPC
  const session = await client.rpc(
    null, // no session needed for login
    "rpc_cognito_login",
    {
      id_token: cognitoIdToken,
      create: true,
      username: username,
    }
  );

  const response = JSON.parse(session.payload);
  return response;
}

// Full authentication flow
async function login(username, password) {
  try {
    // Step 1: Get Cognito ID token
    console.log("Authenticating with Cognito...");
    const idToken = await authenticateWithCognito(username, password);

    // Step 2: Login to Nakama
    console.log("Logging in to Nakama...");
    const result = await loginToNakama(idToken, username);

    console.log("Login successful!");
    console.log("Nakama token:", result.token);

    if (result.wallet) {
      console.log("Wallet:", result.wallet);
    }

    return result;
  } catch (error) {
    console.error("Login failed:", error);
    throw error;
  }
}

// Example: Get wallet information
async function getWallet(session) {
  const result = await client.rpc(session, "rpc_get_wallet", {});
  return JSON.parse(result.payload);
}

// Example: Link Cognito to existing account
async function linkCognito(session, cognitoIdToken) {
  const result = await client.rpc(session, "rpc_link_cognito", {
    id_token: cognitoIdToken,
  });
  return JSON.parse(result.payload);
}

// Example usage
(async () => {
  try {
    // Login
    const loginResult = await login("testuser", "password123");

    // Create a session from the token
    const session = { token: loginResult.token };

    // Get wallet info
    if (loginResult.wallet) {
      const wallet = await getWallet(session);
      console.log("Wallet info:", wallet);
    }
  } catch (error) {
    console.error("Error:", error);
  }
})();
```

## Unity C# Example

### Using Nakama Unity SDK

```csharp
using System;
using System.Threading.Tasks;
using Nakama;
using Amazon.CognitoIdentityProvider;
using Amazon.CognitoIdentityProvider.Model;
using UnityEngine;

public class NakamaCognitoAuth : MonoBehaviour
{
    private IClient _client;
    private ISession _session;
    private AmazonCognitoIdentityProviderClient _cognitoClient;

    private const string COGNITO_USER_POOL_ID = "us-east-1_ABC123";
    private const string COGNITO_CLIENT_ID = "your-app-client-id";
    private const string COGNITO_REGION = "us-east-1";
    
    private const string NAKAMA_HOST = "localhost";
    private const int NAKAMA_PORT = 7350;
    private const string NAKAMA_SERVER_KEY = "defaultkey";

    void Start()
    {
        // Initialize Nakama client
        _client = new Client("http", NAKAMA_HOST, NAKAMA_PORT, NAKAMA_SERVER_KEY);
        
        // Initialize Cognito client
        _cognitoClient = new AmazonCognitoIdentityProviderClient(
            Amazon.RegionEndpoint.GetBySystemName(COGNITO_REGION)
        );
    }

    // Authenticate with Cognito and get ID token
    public async Task<string> AuthenticateWithCognito(string username, string password)
    {
        var authRequest = new AdminInitiateAuthRequest
        {
            UserPoolId = COGNITO_USER_POOL_ID,
            ClientId = COGNITO_CLIENT_ID,
            AuthFlow = AuthFlowType.ADMIN_NO_SRP_AUTH,
            AuthParameters = new Dictionary<string, string>
            {
                { "USERNAME", username },
                { "PASSWORD", password }
            }
        };

        try
        {
            var authResponse = await _cognitoClient.AdminInitiateAuthAsync(authRequest);
            return authResponse.AuthenticationResult.IdToken;
        }
        catch (Exception e)
        {
            Debug.LogError($"Cognito authentication failed: {e.Message}");
            throw;
        }
    }

    // Login to Nakama using Cognito token
    public async Task<LoginResponse> LoginToNakama(string cognitoIdToken, string username = null)
    {
        try
        {
            var payload = new LoginRequest
            {
                id_token = cognitoIdToken,
                create = true,
                username = username
            };

            var jsonPayload = JsonUtility.ToJson(payload);
            var response = await _client.RpcAsync(null, "rpc_cognito_login", jsonPayload);
            
            var loginResponse = JsonUtility.FromJson<LoginResponse>(response.Payload);
            return loginResponse;
        }
        catch (Exception e)
        {
            Debug.LogError($"Nakama login failed: {e.Message}");
            throw;
        }
    }

    // Full login flow
    public async Task Login(string username, string password)
    {
        try
        {
            Debug.Log("Authenticating with Cognito...");
            var idToken = await AuthenticateWithCognito(username, password);

            Debug.Log("Logging in to Nakama...");
            var loginResponse = await LoginToNakama(idToken, username);

            // Create session from token
            _session = Session.Restore(loginResponse.token);

            Debug.Log($"Login successful! User ID: {_session.UserId}");
            
            if (loginResponse.wallet != null)
            {
                Debug.Log($"Wallet: {loginResponse.wallet.address} ({loginResponse.wallet.chain})");
            }
        }
        catch (Exception e)
        {
            Debug.LogError($"Login failed: {e.Message}");
            throw;
        }
    }

    // Get wallet information
    public async Task<WalletResponse> GetWallet()
    {
        try
        {
            var response = await _client.RpcAsync(_session, "rpc_get_wallet", "{}");
            return JsonUtility.FromJson<WalletResponse>(response.Payload);
        }
        catch (Exception e)
        {
            Debug.LogError($"Get wallet failed: {e.Message}");
            throw;
        }
    }

    // Link Cognito to existing account
    public async Task<LinkResponse> LinkCognito(string cognitoIdToken)
    {
        try
        {
            var payload = new LinkRequest { id_token = cognitoIdToken };
            var jsonPayload = JsonUtility.ToJson(payload);
            
            var response = await _client.RpcAsync(_session, "rpc_link_cognito", jsonPayload);
            return JsonUtility.FromJson<LinkResponse>(response.Payload);
        }
        catch (Exception e)
        {
            Debug.LogError($"Link Cognito failed: {e.Message}");
            throw;
        }
    }

    // Data classes
    [Serializable]
    public class LoginRequest
    {
        public string id_token;
        public bool create;
        public string username;
    }

    [Serializable]
    public class LoginResponse
    {
        public string token;
        public WalletInfo wallet;
    }

    [Serializable]
    public class WalletInfo
    {
        public string address;
        public string chain;
    }

    [Serializable]
    public class WalletResponse
    {
        public string address;
        public string chain;
    }

    [Serializable]
    public class LinkRequest
    {
        public string id_token;
    }

    [Serializable]
    public class LinkResponse
    {
        public bool success;
        public WalletInfo wallet;
    }
}
```

## Python Example

### Using Nakama Python SDK

```python
import asyncio
from nakama import Client
import boto3
import json

# Cognito configuration
COGNITO_USER_POOL_ID = "us-east-1_ABC123"
COGNITO_CLIENT_ID = "your-app-client-id"
COGNITO_REGION = "us-east-1"

# Nakama configuration
NAKAMA_HOST = "localhost"
NAKAMA_PORT = 7350
NAKAMA_SERVER_KEY = "defaultkey"

# Initialize Cognito client
cognito_client = boto3.client('cognito-idp', region_name=COGNITO_REGION)

# Initialize Nakama client
nakama_client = Client(
    host=NAKAMA_HOST,
    port=NAKAMA_PORT,
    ssl=False,
    server_key=NAKAMA_SERVER_KEY
)

async def authenticate_with_cognito(username: str, password: str) -> str:
    """Authenticate with Cognito and get ID token."""
    try:
        response = cognito_client.admin_initiate_auth(
            UserPoolId=COGNITO_USER_POOL_ID,
            ClientId=COGNITO_CLIENT_ID,
            AuthFlow='ADMIN_NO_SRP_AUTH',
            AuthParameters={
                'USERNAME': username,
                'PASSWORD': password
            }
        )
        return response['AuthenticationResult']['IdToken']
    except Exception as e:
        print(f"Cognito authentication failed: {e}")
        raise

async def login_to_nakama(cognito_id_token: str, username: str = None):
    """Login to Nakama using Cognito token."""
    try:
        payload = {
            'id_token': cognito_id_token,
            'create': True,
            'username': username
        }
        
        response = await nakama_client.rpc(
            session=None,  # No session needed for login
            id_="rpc_cognito_login",
            payload=json.dumps(payload)
        )
        
        return json.loads(response.payload)
    except Exception as e:
        print(f"Nakama login failed: {e}")
        raise

async def get_wallet(session):
    """Get wallet information."""
    try:
        response = await nakama_client.rpc(
            session=session,
            id_="rpc_get_wallet",
            payload="{}"
        )
        return json.loads(response.payload)
    except Exception as e:
        print(f"Get wallet failed: {e}")
        raise

async def link_cognito(session, cognito_id_token: str):
    """Link Cognito to existing account."""
    try:
        payload = {'id_token': cognito_id_token}
        response = await nakama_client.rpc(
            session=session,
            id_="rpc_link_cognito",
            payload=json.dumps(payload)
        )
        return json.loads(response.payload)
    except Exception as e:
        print(f"Link Cognito failed: {e}")
        raise

async def main():
    """Main example flow."""
    try:
        # Step 1: Authenticate with Cognito
        print("Authenticating with Cognito...")
        id_token = await authenticate_with_cognito("testuser", "password123")
        
        # Step 2: Login to Nakama
        print("Logging in to Nakama...")
        login_result = await login_to_nakama(id_token, "testuser")
        
        print(f"Login successful!")
        print(f"Nakama token: {login_result['token']}")
        
        # Create session from token
        session = nakama_client.create_session(login_result['token'])
        
        # Step 3: Get wallet info (if enabled)
        if login_result.get('wallet'):
            wallet = await get_wallet(session)
            print(f"Wallet: {wallet['address']} ({wallet['chain']})")
            
    except Exception as e:
        print(f"Error: {e}")

# Run the example
if __name__ == "__main__":
    asyncio.run(main())
```

## curl Examples

### Basic Authentication Flow

```bash
# 1. Get Cognito ID token (using AWS CLI)
ID_TOKEN=$(aws cognito-idp admin-initiate-auth \
  --user-pool-id us-east-1_ABC123 \
  --client-id your-app-client-id \
  --auth-flow ADMIN_NO_SRP_AUTH \
  --auth-parameters USERNAME=testuser,PASSWORD=password123 \
  --query 'AuthenticationResult.IdToken' \
  --output text)

# 2. Login to Nakama
curl -X POST http://localhost:7350/v2/rpc/rpc_cognito_login \
  -H "Content-Type: application/json" \
  -d "{
    \"id_token\": \"$ID_TOKEN\",
    \"create\": true,
    \"username\": \"testuser\"
  }" | jq

# 3. Extract Nakama session token (save to variable)
SESSION_TOKEN=$(curl -s -X POST http://localhost:7350/v2/rpc/rpc_cognito_login \
  -H "Content-Type: application/json" \
  -d "{
    \"id_token\": \"$ID_TOKEN\",
    \"create\": true,
    \"username\": \"testuser\"
  }" | jq -r '.token')

# 4. Get wallet info
curl -X POST http://localhost:7350/v2/rpc/rpc_get_wallet \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H "Content-Type: application/json" | jq

# 5. Link Cognito to existing account
curl -X POST http://localhost:7350/v2/rpc/rpc_link_cognito \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"id_token\": \"$ID_TOKEN\"}" | jq
```

## Testing Tips

1. **Use JWT Debugger**: Paste your ID token at [jwt.io](https://jwt.io) to inspect claims
2. **Check Token Type**: Ensure you're using the ID token, not the access token
3. **Verify Claims**: Check that `iss`, `aud`, and `token_use` match your configuration
4. **Enable Debug Logs**: Set Nakama log level to DEBUG to see detailed authentication flow

## Common Integration Patterns

### Pattern 1: Guest → Cognito Upgrade

```javascript
// Start as guest
const guestSession = await client.authenticateDevice("device-id-123", true);

// Later, upgrade to Cognito
const cognitoIdToken = await getCognitoToken();
await linkCognito(guestSession, cognitoIdToken);
```

### Pattern 2: Social Login via Cognito

```javascript
// Sign in with Apple/Google via Cognito
const cognitoIdToken = await signInWithAppleViaCognito();

// Login to Nakama - same user across all platforms
await loginToNakama(cognitoIdToken);
```

### Pattern 3: Multi-Game Single Identity

```javascript
// Game A
await loginToNakama(cognitoIdToken); // Creates user + wallet

// Game B (same Cognito user)
await loginToNakama(cognitoIdToken); // Same user + same wallet
```

## Security Best Practices

1. **Never expose ID tokens**: Don't log or store ID tokens client-side
2. **Use HTTPS**: Always use SSL/TLS in production
3. **Validate on server**: Never trust client-provided tokens without verification
4. **Rotate sessions**: Implement session refresh logic
5. **Handle errors gracefully**: Don't expose sensitive error details to clients
