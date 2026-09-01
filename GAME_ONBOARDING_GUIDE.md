# Game Onboarding Guide for Nakama

## Overview

This guide explains how to onboard a new game to the Nakama backend platform. It covers the complete process from game registration to RPC integration.

## Terminology

**Important**: Understanding the difference between these terms is critical:

- **gameId / gameUUID**: The unique identifier (UUID format) from the external game registry API (e.g., `33b245c8-a23f-4f9c-a06e-189885cc22a1`)
- **gameTitle**: The human-readable game name from the external API (e.g., "QuizVerse", "Last To Live", "Test")
- **gameID** (legacy): Hard-coded game names for built-in games only ("quizverse", "lasttolive") - used for backward compatibility

### External Game Registry API

Games are registered in the external IntelliVerse platform API:
```
GET https://gaming.intelli-verse-x.ai/api/games/games/all
```

Example response:
```json
{
  "status": true,
  "message": "All games list retrieved successfully",
  "data": [
    {
      "id": "33b245c8-a23f-4f9c-a06e-189885cc22a1",
      "gameTitle": "Test",
      "gameDescription": "Test description",
      "logoUrl": "https://...",
      "videoUrl": "https://...",
      "coverPhotos": ["https://..."],
      "zipFileUrl": "https://...",
      "status": "draft",
      "createdAt": "2025-11-14T12:08:09.772Z",
      "updatedAt": "2025-11-14T12:08:09.772Z",
      "gameCategories": ["Adventure", "Action"],
      "userId": "69f640e8-180a-4908-a484-926688fc0498",
      "userName": "support_yaq4q0"
    }
  ]
}
```

## Onboarding Process

### Step 1: Sync Game Metadata

Run the leaderboard creation RPC which automatically syncs game metadata from the external API:

```javascript
// RPC: create_time_period_leaderboards
// No payload required - automatically fetches from external API
```

This RPC performs the following:
1. Authenticates with IntelliVerse API using OAuth2
2. Fetches all games from the external registry
3. Stores game metadata in Nakama storage (`game_registry` collection)
4. Creates time-period leaderboards (daily, weekly, monthly, alltime) for each game
5. Creates global ecosystem leaderboards

**Storage Structure**:
```javascript
Collection: "game_registry"
Key: "all_games"
Value: {
  games: [
    {
      gameId: "UUID",              // From external API 'id' field
      gameTitle: "Game Name",      // From external API 'gameTitle' field
      gameDescription: "...",
      logoUrl: "...",
      status: "active",
      categories: ["Category1"],
      createdAt: "ISO8601",
      updatedAt: "ISO8601"
    }
  ],
  lastUpdated: "ISO8601",
  totalGames: 5
}
```

### Step 2: Verify Game Registration

Use the game registry RPCs to verify your game is registered:

```javascript
// Get all games
RPC: get_game_registry
Payload: {}
Response: {
  success: true,
  games: [...],
  totalGames: 5,
  lastUpdated: "2025-11-16T..."
}

// Get specific game
RPC: get_game_by_id
Payload: {
  "gameId": "33b245c8-a23f-4f9c-a06e-189885cc22a1"
}
Response: {
  success: true,
  game: {
    gameId: "33b245c8-a23f-4f9c-a06e-189885cc22a1",
    gameTitle: "Test",
    ...
  }
}
```

### Step 3: Verify Leaderboards

Check that leaderboards were created for your game:

```javascript
RPC: get_time_period_leaderboard
Payload: {
  "gameId": "33b245c8-a23f-4f9c-a06e-189885cc22a1",
  "period": "daily"  // or "weekly", "monthly", "alltime"
}
```

## Core RPCs Required for Each Game

### 1. Player Identity & Wallet Management

**Multi-game RPCs** support both legacy games (gameID) and new games (gameUUID):

```javascript
// Works for both legacy ("quizverse", "lasttolive") and new games (UUID)
RPC: quizverse_update_user_profile  // Or use game-specific equivalent
Payload: {
  "gameID": "33b245c8-a23f-4f9c-a06e-189885cc22a1",  // Use gameUUID for new games
  "displayName": "PlayerName",
  "avatar": "url",
  "level": 10,
  "xp": 1500
}

// Alternative for new games using gameUUID field
Payload: {
  "gameUUID": "33b245c8-a23f-4f9c-a06e-189885cc22a1",
  "displayName": "PlayerName"
}
```

### 2. Wallet Operations

**Grant Currency**:
```javascript
RPC: quizverse_grant_currency
Payload: {
  "gameID": "33b245c8-a23f-4f9c-a06e-189885cc22a1",
  "amount": 100
}

Storage: 
Collection: "game_wallets"
Key: "wallet:<deviceId>:<gameId>"
```

**Spend Currency**:
```javascript
RPC: quizverse_spend_currency
Payload: {
  "gameID": "33b245c8-a23f-4f9c-a06e-189885cc22a1",
  "amount": 50
}
```

### 3. Inventory Management

**Grant Item**:
```javascript
RPC: quizverse_grant_item
Payload: {
  "gameID": "33b245c8-a23f-4f9c-a06e-189885cc22a1",
  "itemId": "sword_legendary",
  "quantity": 1,
  "metadata": {
    "rarity": "legendary",
    "level": 5
  }
}

Storage:
Collection: "<gameId>_inventory"
Key: "inv_<userId>"
```

**Consume Item**:
```javascript
RPC: quizverse_consume_item
Payload: {
  "gameID": "33b245c8-a23f-4f9c-a06e-189885cc22a1",
  "itemId": "potion_health",
  "quantity": 1
}
```

**List Inventory**:
```javascript
RPC: quizverse_list_inventory
Payload: {
  "gameID": "33b245c8-a23f-4f9c-a06e-189885cc22a1"
}
```

### 4. Leaderboard Integration

**Submit Score**:
```javascript
// Time-period leaderboards (recommended)
RPC: submit_score_to_time_periods
Payload: {
  "gameId": "33b245c8-a23f-4f9c-a06e-189885cc22a1",
  "score": 1500,
  "subscore": 0,
  "metadata": {
    "level": 5,
    "completionTime": 120
  }
}

// This writes to ALL time periods (daily, weekly, monthly, alltime) 
// AND global ecosystem leaderboards
```

**Get Leaderboard**:
```javascript
RPC: get_time_period_leaderboard
Payload: {
  "gameId": "33b245c8-a23f-4f9c-a06e-189885cc22a1",
  "period": "weekly",
  "limit": 10
}
```

### 5. Player Data Storage

**Save Player Data**:
```javascript
RPC: quizverse_save_player_data
Payload: {
  "gameID": "33b245c8-a23f-4f9c-a06e-189885cc22a1",
  "key": "player_progress",
  "value": {
    "currentLevel": 10,
    "unlockedLevels": [1,2,3,4,5,6,7,8,9,10],
    "achievements": ["first_win", "speed_demon"]
  }
}

Storage:
Collection: "<gameId>_player_data"
Key: "<key>"
```

**Load Player Data**:
```javascript
RPC: quizverse_load_player_data
Payload: {
  "gameID": "33b245c8-a23f-4f9c-a06e-189885cc22a1",
  "key": "player_progress"
}
```

### 6. Daily Rewards

**Claim Daily Reward**:
```javascript
RPC: quizverse_claim_daily_reward
Payload: {
  "gameID": "33b245c8-a23f-4f9c-a06e-189885cc22a1"
}

Response: {
  "success": true,
  "data": {
    "rewardAmount": 150,
    "streak": 5,
    "nextReward": 160
  }
}

Storage:
Collection: "<gameId>_daily_rewards"
Key: "daily_<userId>"
```

### 7. Social Features

**Find Friends**:
```javascript
RPC: quizverse_find_friends
Payload: {
  "gameID": "33b245c8-a23f-4f9c-a06e-189885cc22a1",
  "query": "PlayerName",
  "limit": 20
}
```

### 8. Analytics & Telemetry

**Log Event**:
```javascript
RPC: quizverse_log_event
Payload: {
  "gameID": "33b245c8-a23f-4f9c-a06e-189885cc22a1",
  "eventName": "level_completed",
  "properties": {
    "level": 5,
    "score": 1500,
    "time": 120
  }
}

Storage:
Collection: "<gameId>_analytics"
Key: "event_<userId>_<timestamp>"
```

**Track Sessions**:
```javascript
// Session Start
RPC: quizverse_track_session_start
Payload: {
  "gameID": "33b245c8-a23f-4f9c-a06e-189885cc22a1",
  "deviceInfo": {
    "platform": "iOS",
    "version": "1.0.0"
  }
}

// Session End
RPC: quizverse_track_session_end
Payload: {
  "gameID": "33b245c8-a23f-4f9c-a06e-189885cc22a1",
  "sessionKey": "session_<userId>_<timestamp>",
  "duration": 3600
}
```

### 9. Guilds/Clans

**Create Guild**:
```javascript
RPC: quizverse_guild_create
Payload: {
  "gameID": "33b245c8-a23f-4f9c-a06e-189885cc22a1",
  "name": "Elite Warriors",
  "description": "Top players only",
  "open": true,
  "maxCount": 50
}
```

**Join/Leave Guild**:
```javascript
RPC: quizverse_guild_join
Payload: {
  "gameID": "33b245c8-a23f-4f9c-a06e-189885cc22a1",
  "guildId": "<group_id>"
}

RPC: quizverse_guild_leave
Payload: {
  "gameID": "33b245c8-a23f-4f9c-a06e-189885cc22a1",
  "guildId": "<group_id>"
}
```

## Storage Collections by Game

All game-specific data is stored in namespaced collections using the gameId:

```
<gameId>_profiles          - Player profiles
<gameId>_wallets           - Per-game wallets
<gameId>_inventory         - Player inventories
<gameId>_player_data       - Custom player data
<gameId>_daily_rewards     - Daily reward state
<gameId>_sessions          - Session tracking
<gameId>_analytics         - Analytics events
<gameId>_catalog           - Item catalog
<gameId>_categories        - Quiz categories (QuizVerse-specific)
<gameId>_weapon_stats      - Weapon stats (LastToLive-specific)
<gameId>_config            - Server configuration

game_wallets               - All game wallets (unified collection)
game_registry              - Game metadata from external API
leaderboards_registry      - Leaderboard metadata
```

## Leaderboard Naming Convention

For each game, the following leaderboards are created:

```
leaderboard_<gameId>_daily      - Daily leaderboard
leaderboard_<gameId>_weekly     - Weekly leaderboard
leaderboard_<gameId>_monthly    - Monthly leaderboard
leaderboard_<gameId>_alltime    - All-time leaderboard

leaderboard_global_daily        - Global ecosystem (all games)
leaderboard_global_weekly
leaderboard_global_monthly
leaderboard_global_alltime
```

## Metadata in Storage Objects

All storage objects should include game identification:

```javascript
{
  gameId: "33b245c8-a23f-4f9c-a06e-189885cc22a1",  // UUID from registry
  gameTitle: "Test Game",                          // Human-readable name
  // ... other data
  createdAt: "2025-11-16T...",
  updatedAt: "2025-11-16T..."
}
```

Leaderboard metadata example:
```javascript
{
  gameId: "33b245c8-a23f-4f9c-a06e-189885cc22a1",
  gameTitle: "Test Game",
  scope: "game",
  timePeriod: "weekly",
  resetSchedule: "0 0 * * 0",
  description: "Weekly Leaderboard for Test Game",
  createdAt: "2025-11-16T..."
}
```

## Nakama Admin Console

After onboarding, you can view game data in the Nakama Admin Console:

1. **Storage Browser**: View collections organized by gameId
2. **Leaderboards**: View all game and global leaderboards with metadata
3. **Users**: View player profiles with game-specific data
4. **Groups**: View guilds/clans filtered by gameId metadata

## Quest A/B (existing quest engine)

Quest tests overlay the **same** quest list (`qv_quest_config`) for that game. There is no second quest system.

- Every player RPC (`quest_engine_get`, `quest_engine_record_event`, `quest_engine_claim_reward`) and quest experiment setup must send `gameId` as the registry UUID.
- `"default"` aliases to the QuizVerse UUID only. Missing `gameId` is an error — it does not fall through to QuizVerse.
- Unity payload stays `{ "gameId": "<registry UUID>" }`. Do not send experiment ids to the client.
- LiveOps starts quest tests from **Admin > Quests** (`New A/B` / `A/B this`). Two recipes only: same quest new prize, or this quest vs that quest. Do not paste overlay JSON on the Experiments page for quests.
- Preview a QA user from the Quests page (or `hiro_personalizer_preview` with `system=quest_engine`).
- One running `quest_engine` experiment per game. Overlay may change reward / hidden / enabled / name / description only.
- Guest → registered merge ports `satori_assignments` copy-if-absent, so the A/B bucket stays sticky.

### Player RPCs (Unity / device session)

`POST /v2/rpc/{id}` with a player session. Always send the registry UUID. Never send experiment ids.

| RPC | Call | Payload | What comes back |
|-----|------|---------|-----------------|
| `quest_engine_get` | Home / quests screen | `{ "gameId": "<uuid>" }` | Visible quests with progress. Overlay already applied. No experiment ids (admin + `debug:true` may add `debug.experiment`). |
| `quest_engine_record_event` | After a player action (optional; EventBus also feeds the engine) | `{ "gameId": "<uuid>", "eventType": "match_won", "value": 1, "metadata": {} }` | `{ updatedQuests, quests }` |
| `quest_engine_claim_reward` | Claim button | `{ "gameId": "<uuid>", "questId": "daily_win_3" }` | Pays the **snapshot** prize from when the quest started, not a later overlay |

Unity C# shape:

```csharp
await client.RpcAsync(session, "quest_engine_get", JsonUtility.ToJson(new { gameId }));
await client.RpcAsync(session, "quest_engine_record_event", JsonUtility.ToJson(new { gameId, eventType = "match_won", value = 1 }));
await client.RpcAsync(session, "quest_engine_claim_reward", JsonUtility.ToJson(new { gameId, questId }));
```

### Admin RPCs (http_key / Admin Console)

These are **not** Unity calls. Quests page + Experiments page use them.

| RPC | Call | Payload notes |
|-----|------|----------------|
| `quest_engine_admin_get_config` | Load quest list | `{ "gameId": "<uuid>" }` — **raw** config, no overlay |
| `quest_engine_admin_save_config` | Save quest list | `{ "gameId": "<uuid>", "config": { "quests": { ... } } }` or `{ "gameId", "quests": [ { "id": "...", ... } ] }` |
| `hiro_personalizer_preview` | Preview one player | `{ "userId": "<nakama user id>", "system": "quest_engine", "gameId": "<uuid>" }` |
| `satori_experiments_get_all` | List experiments | `{ "game_id": "<uuid>" }` (admin list helper: `admin_satori_experiments_list`) |
| `satori_experiment_setup` | Create / update a quest overlay test | `configSystem: "quest_engine"`, `goalMetric: "quest_completed"`, `game_id`, variants with `config` and/or `data`, `trackedQuestIds`, `minSamplePerArm`. Ban `splitKey=random`. |
| `satori_experiments_results` | Funnel card | `{ "experimentId": "...", "game_id": "<uuid>", "goal_event": "quest_completed" }` — Assigned → Exposed → Started → Completed → Claimed, SRM, min-sample, `byDay` |
| `satori_experiments_declare_winner` | Pause or Promote | `{ "experimentId": "...", "variantId": "...", "game_id": "<uuid>", "promote": true\|false }` — `promote:true` writes the winning sticker onto `qv_quest_config` |
| `satori_experiments_undo_promote` | Undo Promote | `{ "experimentId": "...", "game_id": "<uuid>", "auditKey": "<optional>" }` |

Admin TypeScript wrappers live in `web/packages/shared/src/rpc/quest-engine/index.ts` and `web/packages/shared/src/rpc/satori/index.ts` (`setupExperiment`, `getExperimentResults`, `declareExperimentWinner`, `undoExperimentPromote`, `previewPersonalizer`).

### Local two-user proof

From `data/modules` against docker Nakama (`127.0.0.1:7350`):

```
node tests/quest_ab_overlay_live_rpc.mjs
```

That script saves a throwaway `ab_probe` quest on two unused game UUIDs (it does **not** overwrite QuizVerse), runs a 50/50 prize test, checks two players land on 100 vs 200 and stay sticky, proves kill-without-promote keeps the promised 200, and checks Promote stays blocked until min-sample.

### QA then 10% prod checklist

Do not call this production-ready until every box is green.

1. **QA audience first** — 100% test variant, internal accounts only. Two devices, same `userId`, reinstall still sticky. Watch claim errors. Pause can take up to 1 minute to reach every server.
2. **10% test / 90% control**, 48h. Goal = `quest_completed`. Watch session_start and claim errors. If SRM fails or crash-ish drop → status `ended` / Pause, **no Promote**.
3. Optionally **25%** then **50%** (stable ID split so the 10% stay in test).
4. Promote only after min-sample + SRM + significance. This writes the winning sticker onto the real quest list. Spot-check 5 live players see **one** list.
5. Leave the experiment `ended`. Do not start a second quest overlay on the same reward until this one is done.
6. Rollback: Pause or `status=ended` without Promote. Base `qv_quest_config` is unchanged until Promote succeeds. Undo from the Quests results card restores the audit snapshot.

## Migration from Legacy Games

For existing games using hard-coded gameID ("quizverse", "lasttolive"):

1. These continue to work with the legacy gameID
2. Multi-game RPCs support both `gameID` and `gameUUID` fields
3. New games should use UUID from external registry
4. Storage collections remain namespaced by the identifier used

## Best Practices

1. **Always use gameId (UUID)** from the external registry for new games
2. **Include gameTitle** in metadata for human readability in admin console
3. **Use time-period leaderboards** for automatic reset scheduling
4. **Store game-specific data** in namespaced collections
5. **Log analytics events** for player behavior tracking
6. **Implement session tracking** for engagement metrics
7. **Test with get_game_registry** before integrating

## Complete RPC Checklist for Game Onboarding

### Phase 1: Initial Setup
- [ ] Run `create_time_period_leaderboards` to sync game metadata
- [ ] Verify game in registry with `get_game_registry`
- [ ] Verify leaderboards with `get_time_period_leaderboard`

### Phase 2: Core Integration
- [ ] Implement player profile management (`update_user_profile`)
- [ ] Implement wallet operations (`grant_currency`, `spend_currency`)
- [ ] Implement inventory system (`grant_item`, `consume_item`, `list_inventory`)
- [ ] Implement score submission (`submit_score_to_time_periods`)
- [ ] Implement player data storage (`save_player_data`, `load_player_data`)

### Phase 3: Engagement Features
- [ ] Implement daily rewards (`claim_daily_reward`)
- [ ] Implement quests (`quest_engine_get`, `quest_engine_record_event`, `quest_engine_claim_reward`) with `{ gameId }` only
- [ ] Implement social features (`find_friends`)
- [ ] Implement guild system (`guild_create`, `guild_join`, `guild_leave`)

### Phase 4: Analytics
- [ ] Implement event logging (`log_event`)
- [ ] Implement session tracking (`track_session_start`, `track_session_end`)

### Phase 5: Testing
- [ ] Test all RPCs with actual gameId from registry
- [ ] Verify data appears correctly in Nakama Admin Console
- [ ] Test leaderboard submissions and retrieval
- [ ] Verify storage collections are properly namespaced

## Support

For issues or questions:
1. Check game is in registry: `get_game_registry`
2. Verify gameId matches external API
3. Check Nakama logs for RPC errors
4. Review storage collections in Admin Console
