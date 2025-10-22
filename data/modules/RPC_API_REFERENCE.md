# Leaderboard & Social Features RPC API Reference

## Overview
This document provides a quick reference for all available RPC endpoints in the leaderboard and social features module.

## RPC Endpoints

### Leaderboard Management

#### 1. create_all_leaderboards_persistent
Create standard leaderboards for all games from IntelliVerse.

**Endpoint:** `create_all_leaderboards_persistent`

**Authentication:** Required (Admin/Server token recommended)

**Request Payload:** Empty string or `{}`

**Response:**
```json
{
  "success": true,
  "created": ["leaderboard_global", "leaderboard_game1", ...],
  "skipped": ["leaderboard_existing", ...],
  "totalProcessed": 10,
  "storedRecords": 15
}
```

---

#### 2. create_all_leaderboards_with_friends
Create both standard and friend leaderboards for all games.

**Endpoint:** `create_all_leaderboards_with_friends`

**Authentication:** Required (Admin/Server token recommended)

**Request Payload:** Empty string or `{}`

**Response:**
```json
{
  "success": true,
  "created": ["leaderboard_global", "leaderboard_friends_global", ...],
  "skipped": [...],
  "totalProcessed": 10,
  "storedRecords": 30
}
```

---

### Score Submission

#### 3. submit_score_sync
Submit score and sync to both game-specific and global leaderboards.

**Endpoint:** `submit_score_sync`

**Authentication:** Required (Player session token)

**Request Payload:**
```json
{
  "gameId": "fc3db911-42e8-4f95-96d1-41c3e7b9812d",
  "score": 4200,
  "metadata": {
    "level": 5,
    "bonus": 200
  }
}
```

**Response:**
```json
{
  "success": true,
  "message": "Score successfully synced across game and global leaderboards.",
  "gameId": "fc3db911-42e8-4f95-96d1-41c3e7b9812d",
  "userId": "user-id-123",
  "score": 4200
}
```

---

#### 4. submit_score_with_aggregate
Submit score and calculate aggregated total across all games.

**Endpoint:** `submit_score_with_aggregate`

**Authentication:** Required (Player session token)

**Request Payload:**
```json
{
  "gameId": "fc3db911-42e8-4f95-96d1-41c3e7b9812d",
  "score": 4200,
  "metadata": {}
}
```

**Response:**
```json
{
  "success": true,
  "message": "Score and aggregate updated successfully",
  "gameId": "fc3db911-42e8-4f95-96d1-41c3e7b9812d",
  "userId": "user-id-123",
  "individualScore": 4200,
  "aggregateScore": 12500
}
```

---

#### 5. submit_score_with_friends_sync
Submit score and sync to all leaderboard types (normal + friend).

**Endpoint:** `submit_score_with_friends_sync`

**Authentication:** Required (Player session token)

**Request Payload:**
```json
{
  "gameId": "game1",
  "score": 2500,
  "metadata": {}
}
```

**Response:**
```json
{
  "success": true,
  "message": "Scores synced to normal and friend leaderboards."
}
```

---

### Leaderboard Queries

#### 6. get_friend_leaderboard
Retrieve friend-only leaderboard for a specific game or globally.

**Endpoint:** `get_friend_leaderboard`

**Authentication:** Required (Player session token)

**Request Payload:**
```json
{
  "gameId": "game1",
  "limit": 10
}
```

_For global friend leaderboard, omit `gameId`:_
```json
{
  "limit": 20
}
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
      "rank": 1,
      "metadata": {}
    },
    {
      "userId": "user-id-2",
      "username": "player2",
      "score": 4500,
      "rank": 2,
      "metadata": {}
    }
  ]
}
```

---

### Social Features - Friend Management

#### 7. send_friend_invite
Send a friend request to another user.

**Endpoint:** `send_friend_invite`

**Authentication:** Required (Player session token)

**Request Payload:**
```json
{
  "targetUserId": "target-user-id-123"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Friend invite sent."
}
```

---

#### 8. accept_friend_invite
Accept a friend request from another user.

**Endpoint:** `accept_friend_invite`

**Authentication:** Required (Player session token)

**Request Payload:**
```json
{
  "requesterUserId": "requester-user-id-456"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Friend invite accepted."
}
```

---

#### 9. decline_friend_invite
Decline/block a friend request from another user.

**Endpoint:** `decline_friend_invite`

**Authentication:** Required (Player session token)

**Request Payload:**
```json
{
  "requesterUserId": "requester-user-id-789"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Friend invite declined."
}
```

---

### Notifications

#### 10. get_notifications
Retrieve user's notifications (up to 30 most recent).

**Endpoint:** `get_notifications`

**Authentication:** Required (Player session token)

**Request Payload:** Empty string or `{}`

**Response:**
```json
{
  "success": true,
  "notifications": [
    {
      "id": "notification-id-1",
      "subject": "Friend Score Update",
      "content": {
        "message": "Alice scored 5000 in game1!"
      },
      "createTime": "2025-10-22T01:00:00Z"
    }
  ]
}
```

---

## Error Responses

All endpoints return consistent error responses:

```json
{
  "success": false,
  "error": "Error description here"
}
```

### Common Error Messages

- `"Missing payload."` - No data provided in request
- `"Invalid JSON payload."` - Malformed JSON in request body
- `"Missing gameId or score."` - Required fields missing
- `"Auth required."` - User must be authenticated
- `"targetUserId missing."` - Required field for friend operations
- `"requesterUserId missing."` - Required field for friend operations
- `"User must be authenticated."` - User session required
- `"Friend leaderboard does not exist."` - Leaderboard not found
- `"Failed to retrieve friends."` - Error accessing social graph
- `"Failed to retrieve notifications."` - Error accessing notification system

---

## Helper Functions (Internal)

These functions are available for server-side use but not exposed as RPCs:

### sendNotificationToUser
```typescript
function sendNotificationToUser(
  userId: string, 
  content: Record<string, any>, 
  subject: string
): void
```

Sends a notification to a specific user.

### notifyFriendsOnScore
```typescript
function notifyFriendsOnScore(
  ctx: nkruntime.Context, 
  userId: string, 
  gameId: string, 
  score: number
): void
```

Notifies all friends when a user submits a score.

---

## Usage Tips

1. **Always validate authentication**: Most RPCs require a valid player session token
2. **Use aggregation for global rankings**: `submit_score_with_aggregate` provides the best user experience for cross-game competitions
3. **Friend leaderboards require friend leaderboard creation**: Use `create_all_leaderboards_with_friends` instead of the standard creation RPC
4. **Metadata is optional**: All score submission endpoints accept optional metadata for custom tracking
5. **Error handling**: Always check the `success` field in responses before processing data

---

## Quick Start Example

```bash
# 1. Create leaderboards (admin/server)
curl -X POST "http://127.0.0.1:7350/v2/rpc/create_all_leaderboards_with_friends" \
  -H "Authorization: Bearer <admin_token>"

# 2. Submit a score (player)
curl -X POST "http://127.0.0.1:7350/v2/rpc/submit_score_with_aggregate" \
  -H "Authorization: Bearer <player_token>" \
  -H "Content-Type: application/json" \
  -d '{"gameId":"game1","score":5000}'

# 3. Get friend leaderboard (player)
curl -X POST "http://127.0.0.1:7350/v2/rpc/get_friend_leaderboard" \
  -H "Authorization: Bearer <player_token>" \
  -H "Content-Type: application/json" \
  -d '{"gameId":"game1","limit":10}'

# 4. Send friend invite (player)
curl -X POST "http://127.0.0.1:7350/v2/rpc/send_friend_invite" \
  -H "Authorization: Bearer <player_token>" \
  -H "Content-Type: application/json" \
  -d '{"targetUserId":"friend-user-id"}'
```

---

## Version Information

- **Module Version**: 1.0.0
- **Nakama Compatibility**: 3.x+
- **Last Updated**: 2025-10-22
