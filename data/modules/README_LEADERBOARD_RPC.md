# Persistent Dynamic Leaderboard & Social Features for Nakama

## Overview

This module provides comprehensive Nakama RPCs for dynamic leaderboard management, score synchronization, friend leaderboards, and social features for the IntelliVerse ecosystem.

## Features

- **OAuth Authentication**: Authenticates with IntelliVerse API using client credentials
- **Dynamic Game Discovery**: Automatically fetches all onboarded games from IntelliVerse
- **Persistent Storage**: Tracks created leaderboards in Nakama storage to avoid duplicates
- **Global & Per-Game Leaderboards**: Creates both ecosystem-wide and game-specific leaderboards
- **Friend Leaderboards**: Separate leaderboards for friend-only rankings
- **Score Synchronization**: Automatic syncing of scores across multiple leaderboard types
- **Score Aggregation**: Calculate total scores across all games for global power ranking
- **Social Features**: Friend invites, notifications, and real-time friend activity
- **Idempotent**: Safe to run multiple times - skips already created leaderboards

## Implementation Details

### File Location
`/data/modules/leaderboard_rpc.ts`

### RPC Endpoint
`create_all_leaderboards_persistent`

### Available RPCs

#### Leaderboard Management
- `create_all_leaderboards_persistent` - Create normal leaderboards for all games
- `create_all_leaderboards_with_friends` - Create both normal and friend leaderboards

#### Score Submission
- `submit_score_sync` - Submit score with sync to game and global leaderboards
- `submit_score_with_aggregate` - Submit score with automatic aggregation across all games
- `submit_score_with_friends_sync` - Submit score to both normal and friend leaderboards

#### Leaderboard Queries
- `get_friend_leaderboard` - Fetch friend-filtered leaderboard for a game or globally

#### Social Features
- `send_friend_invite` - Send a friend request
- `accept_friend_invite` - Accept a friend request
- `decline_friend_invite` - Decline/block a friend request
- `get_notifications` - Retrieve user notifications

### Leaderboard Configuration
- **Sort Order**: Descending (highest scores first)
- **Operator**: Best (keeps best score per user)
- **Reset Schedule**: Weekly (every Sunday at midnight UTC - `0 0 * * 0`)

### Storage Collection
Created leaderboards are tracked in the `leaderboards_registry` collection with key `all_created`.

## Deployment

1. Ensure the TypeScript file is present in `/data/modules/leaderboard_rpc.ts`
2. Restart Nakama server:
   ```bash
   docker-compose restart nakama
   ```

## Error Handling

All RPCs return consistent error responses:
```json
{
  "success": false,
  "error": "Error description here"
}
```

Common errors:
- `"Missing payload"`: No data provided in request
- `"Invalid JSON payload"`: Malformed JSON in request body
- `"Missing gameId or score"`: Required fields missing
- `"Auth required"`: User must be authenticated for this operation
- `"Token request failed"`: Unable to authenticate with IntelliVerse OAuth
- `"Game fetch failed"`: Unable to retrieve games from IntelliVerse API
- `"Failed writing score"`: Error writing to leaderboard
- `"Friend leaderboard does not exist"`: Requested leaderboard not found
- `"Failed to retrieve friends"`: Error accessing user's social graph

## IntelliVerse API Integration

### OAuth Endpoint
- **URL**: `https://api.intelli-verse-x.ai/api/admin/oauth/token`
- **Method**: POST
- **Credentials**: Client ID and secret (configured in the module)

### Games List Endpoint
- **URL**: `https://api.intelli-verse-x.ai/api/games/all`
- **Method**: GET
- **Authentication**: Bearer token from OAuth

## Leaderboard Naming Convention

- **Global Leaderboard**: `leaderboard_global`
- **Global Friend Leaderboard**: `leaderboard_friends_global`
- **Per-Game Leaderboards**: `leaderboard_{gameId}`
- **Per-Game Friend Leaderboards**: `leaderboard_friends_{gameId}`

## Usage Examples

### 1. Creating Leaderboards

#### Create Standard Leaderboards
```bash
curl -X POST "http://127.0.0.1:7350/v2/rpc/create_all_leaderboards_persistent" \
  -H "Authorization: Bearer <admin_or_server_token>" \
  -H "Content-Type: application/json"
```

#### Create Leaderboards with Friend Support
```bash
curl -X POST "http://127.0.0.1:7350/v2/rpc/create_all_leaderboards_with_friends" \
  -H "Authorization: Bearer <admin_or_server_token>" \
  -H "Content-Type: application/json"
```

### 2. Submitting Scores

#### Basic Score Sync (Game + Global)
```bash
curl -X POST "http://127.0.0.1:7350/v2/rpc/submit_score_sync" \
  -H "Authorization: Bearer <player_session_token>" \
  -H "Content-Type: application/json" \
  -d '{"gameId":"fc3db911-42e8-4f95-96d1-41c3e7b9812d","score":4200}'
```

**Response:**
```json
{
  "success": true,
  "message": "Score successfully synced across game and global leaderboards.",
  "gameId": "fc3db911-42e8-4f95-96d1-41c3e7b9812d",
  "userId": "1b09d434-6b4c-4b06-a21d-523cc6030aee",
  "score": 4200
}
```

#### Score with Aggregation
```bash
curl -X POST "http://127.0.0.1:7350/v2/rpc/submit_score_with_aggregate" \
  -H "Authorization: Bearer <player_session_token>" \
  -H "Content-Type: application/json" \
  -d '{"gameId":"fc3db911-42e8-4f95-96d1-41c3e7b9812d","score":4200}'
```

**Response:**
```json
{
  "success": true,
  "message": "Score and aggregate updated successfully",
  "gameId": "fc3db911-42e8-4f95-96d1-41c3e7b9812d",
  "userId": "1b09d434-6b4c-4b06-a21d-523cc6030aee",
  "individualScore": 4200,
  "aggregateScore": 12500
}
```

#### Score with Friend Leaderboard Sync
```bash
curl -X POST "http://127.0.0.1:7350/v2/rpc/submit_score_with_friends_sync" \
  -H "Authorization: Bearer <player_token>" \
  -H "Content-Type: application/json" \
  -d '{"gameId":"game1","score":2500}'
```

**Response:**
```json
{
  "success": true,
  "message": "Scores synced to normal and friend leaderboards."
}
```

### 3. Querying Friend Leaderboards

#### Get Friend Leaderboard for a Game
```bash
curl -X POST "http://127.0.0.1:7350/v2/rpc/get_friend_leaderboard" \
  -H "Authorization: Bearer <player_token>" \
  -H "Content-Type: application/json" \
  -d '{"gameId":"game1","limit":10}'
```

#### Get Global Friend Leaderboard
```bash
curl -X POST "http://127.0.0.1:7350/v2/rpc/get_friend_leaderboard" \
  -H "Authorization: Bearer <player_token>" \
  -H "Content-Type: application/json" \
  -d '{"limit":20}'
```

**Response:**
```json
{
  "success": true,
  "leaderboard": [
    {
      "userId": "user-id-1",
      "username": "player1",
      "score": 5000,
      "rank": 1
    },
    {
      "userId": "user-id-2",
      "username": "player2",
      "score": 4500,
      "rank": 2
    }
  ]
}
```

### 4. Social Features - Friend Management

#### Send Friend Invite
```bash
curl -X POST "http://127.0.0.1:7350/v2/rpc/send_friend_invite" \
  -H "Authorization: Bearer <player_token>" \
  -H "Content-Type: application/json" \
  -d '{"targetUserId":"target-user-id-123"}'
```

**Response:**
```json
{
  "success": true,
  "message": "Friend invite sent."
}
```

#### Accept Friend Invite
```bash
curl -X POST "http://127.0.0.1:7350/v2/rpc/accept_friend_invite" \
  -H "Authorization: Bearer <player_token>" \
  -H "Content-Type: application/json" \
  -d '{"requesterUserId":"requester-user-id-456"}'
```

**Response:**
```json
{
  "success": true,
  "message": "Friend invite accepted."
}
```

#### Decline Friend Invite
```bash
curl -X POST "http://127.0.0.1:7350/v2/rpc/decline_friend_invite" \
  -H "Authorization: Bearer <player_token>" \
  -H "Content-Type: application/json" \
  -d '{"requesterUserId":"requester-user-id-789"}'
```

**Response:**
```json
{
  "success": true,
  "message": "Friend invite declined."
}
```

### 5. Notifications

#### Get User Notifications
```bash
curl -X POST "http://127.0.0.1:7350/v2/rpc/get_notifications" \
  -H "Authorization: Bearer <player_token>" \
  -H "Content-Type: application/json"
```

**Response:**
```json
{
  "success": true,
  "notifications": [
    {
      "id": "notification-id-1",
      "subject": "Friend Score Update",
      "content": {"message": "Alice scored 5000 in game1!"},
      "createTime": "2025-10-22T01:00:00Z"
    }
  ]
}
```

## Data Model

### LeaderboardRecord (Stored in Storage)
```typescript
{
  leaderboardId: string;    // e.g., "leaderboard_global" or "leaderboard_abc123"
  gameId?: string;          // Game ID (only for per-game leaderboards)
  scope: string;            // "global", "game", "global_friends", or "game_friends"
  createdAt: string;        // ISO 8601 timestamp
}
```

### ScorePayload (Input for Score Submission)
```typescript
{
  gameId: string;                    // Game identifier
  score: number;                     // User's score
  metadata?: Record<string, any>;    // Optional metadata
}
```

### Leaderboard Metadata
Each created leaderboard includes metadata:
- **Global**: `{ scope: "global", desc: "Global Ecosystem Leaderboard" }`
- **Global Friends**: `{ scope: "global_friends", desc: "Global Friends Leaderboard" }`
- **Per-Game**: `{ desc: "Leaderboard for {gameTitle}", gameId: "{id}", scope: "game" }`
- **Per-Game Friends**: `{ desc: "Friends Leaderboard for {gameTitle}", gameId: "{id}", scope: "game_friends" }`

### Score Metadata (Automatic)
Scores are automatically tagged with:
- `source`: Origin of the score (e.g., "game", "global", "global_aggregate", "friends_game", "friends_global")
- `gameId`: Associated game identifier
- `submittedAt`: ISO 8601 timestamp
- `aggregateScore`: (Only for aggregate submissions) Total score across all games

## Technical Details

### Score Synchronization Flow
1. User submits score via `submit_score_sync`
2. Score is written to game-specific leaderboard (`leaderboard_{gameId}`)
3. Same score is written to global leaderboard (`leaderboard_global`)
4. Both writes include metadata for tracking and analytics

### Score Aggregation Flow
1. User submits score via `submit_score_with_aggregate`
2. Score is written to game-specific leaderboard
3. Individual score is written to global leaderboard
4. System queries all game leaderboards for user's scores
5. Scores are summed to calculate total aggregate
6. Global leaderboard is updated with aggregate as the "Global Power Rank"

### Friend Leaderboard Flow
1. User submits score via `submit_score_with_friends_sync`
2. Score is written to all four leaderboard types:
   - Game leaderboard
   - Global leaderboard
   - Game friend leaderboard
   - Global friend leaderboard
3. When querying friend leaderboard:
   - System fetches user's friend list
   - Filters leaderboard results to only friends (+ self)
   - Returns ranked friend-only data

### Notification System
- Helper function `sendNotificationToUser()` sends notifications via Nakama's notification API
- `notifyFriendsOnScore()` can be integrated to notify friends of score updates
- Notifications persist and can be queried via `get_notifications`

## Maintenance

### Viewing Created Leaderboards

Query the storage collection to see all tracked leaderboards:
```bash
curl -X POST "http://127.0.0.1:7350/v2/rpc/storage_read" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "collection": "leaderboards_registry",
    "key": "all_created",
    "user_id": "system"
  }'
```

### Re-running the RPC

The RPC is idempotent and can be safely re-run:
- Already created leaderboards will be skipped
- New games will have their leaderboards created
- Storage will be updated with any new leaderboard records

## Integration Guide

### Client-Side Integration

#### JavaScript/TypeScript Example
```javascript
// Submit score with aggregation
const result = await client.rpc(
  session,
  "submit_score_with_aggregate",
  JSON.stringify({
    gameId: "fc3db911-42e8-4f95-96d1-41c3e7b9812d",
    score: 4200
  })
);
const response = JSON.parse(result.payload);
console.log(response.aggregateScore); // Total score across all games

// Get friend leaderboard
const friendLb = await client.rpc(
  session,
  "get_friend_leaderboard",
  JSON.stringify({ gameId: "game1", limit: 10 })
);
const leaderboard = JSON.parse(friendLb.payload);
console.log(leaderboard.leaderboard);

// Send friend invite
await client.rpc(
  session,
  "send_friend_invite",
  JSON.stringify({ targetUserId: "user-abc-123" })
);
```

#### Unity C# Example
```csharp
// Submit score
var payload = new Dictionary<string, object>
{
    { "gameId", "fc3db911-42e8-4f95-96d1-41c3e7b9812d" },
    { "score", 4200 }
};
var result = await client.RpcAsync(session, "submit_score_sync", 
    JsonWriter.ToJson(payload));
var response = JsonParser.FromJson<Dictionary<string, object>>(result.Payload);

// Get notifications
var notifs = await client.RpcAsync(session, "get_notifications", "");
var notifications = JsonParser.FromJson<Dictionary<string, object>>(notifs.Payload);
```

### Server-Side Hooks

You can integrate friend notifications into score submission:

```typescript
// Example: Notify friends when submitting aggregate score
function submitScoreWithAggregateAndNotify(ctx: nkruntime.Context, payload: string): string {
    // Submit score with aggregate (existing logic)
    const result = submitScoreWithAggregate(ctx, payload);
    
    // Parse to check success
    const response = JSON.parse(result);
    if (response.success) {
        const data = JSON.parse(payload);
        // Notify friends
        notifyFriendsOnScore(ctx, ctx.userId, data.gameId, data.score);
    }
    
    return result;
}
```

## Real-Time Features

### WebSocket Integration

Clients can subscribe to real-time updates using Nakama's real-time API:

```javascript
// Subscribe to notifications
socket.onnotification = (notification) => {
  console.log("Friend scored:", notification.content);
};

// Subscribe to status updates
socket.onstatuspresence = (presence) => {
  // Track when friends come online/offline
};
```

### Broadcasting Leaderboard Updates

For advanced use cases, you can create custom match handlers or use Nakama's streams to broadcast leaderboard changes in real-time to subscribed clients.

## Security Considerations

1. **Credentials**: Client ID and secret are hardcoded per requirements. In production, consider using environment variables.
2. **Storage Permissions**: Registry storage has read permission level 1 (owner read) and write permission 0 (owner write only).
3. **RPC Access**: Ensure proper authentication is configured for the RPC endpoint.

## License

Copyright 2025 The Nakama Authors

Licensed under the Apache License, Version 2.0
