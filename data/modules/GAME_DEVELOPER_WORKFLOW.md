# Game Developer Workflow - Complete Integration Guide

## Introduction

This document provides a **step-by-step workflow** for game developers integrating with the Nakama multi-game backend system. It covers everything from initial setup to advanced features, assuming you only have a **gameID** to start with.

---

## Prerequisites

### What You Need

1. **Game ID (UUID)**: Your unique game identifier
   - Example: `7d4322ae-cd95-4cd9-b003-4ffad2dc31b4`
   - Provided when you register your game in the IntelliVerse system

2. **Nakama Server Details**:
   - Server URL: e.g., `nakama.yourdomain.com`
   - Server Port: Usually `7350`
   - Server Key: e.g., `defaultkey`

3. **Development Environment**:
   - Unity 2019.4 or later
   - Nakama Unity SDK installed

---

## Workflow Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         GAME DEVELOPER WORKFLOW                      │
└─────────────────────────────────────────────────────────────────────┘

Step 1: AUTHENTICATION
├─ Option A: Device Authentication (Simplest)
│  ├─ SystemInfo.deviceUniqueIdentifier → Nakama
│  └─ Receive: Session Token
│
├─ Option B: Email/Custom Authentication
│  ├─ Email + Password → Nakama
│  └─ Receive: Session Token
│
└─ Option C: AWS Cognito Integration
   ├─ User Login → AWS Cognito
   ├─ Receive: Cognito JWT Token
   ├─ JWT Token → Nakama RPC: get_user_wallet
   ├─ Receive: Wallet ID
   ├─ Link to Game → Nakama RPC: link_wallet_to_game
   └─ Receive: Nakama Session Token

           ↓

Step 2: INITIALIZE GAME FEATURES
├─ Daily Rewards
│  ├─ RPC: daily_rewards_get_status (gameId)
│  ├─ Check: canClaimToday?
│  └─ If yes → RPC: daily_rewards_claim (gameId)
│
├─ Daily Missions
│  ├─ RPC: get_daily_missions (gameId)
│  └─ Display missions to player
│
├─ Wallet
│  ├─ RPC: wallet_get_all
│  └─ Display player's currency balance
│
└─ Analytics
   └─ RPC: analytics_log_event ("session_start", gameId)

           ↓

Step 3: GAMEPLAY INTEGRATION
├─ During Gameplay:
│  ├─ Track Mission Progress
│  │  └─ RPC: submit_mission_progress (gameId, missionId, value)
│  │
│  ├─ Update Wallet
│  │  ├─ Earn Currency → RPC: wallet_update_game_wallet (add)
│  │  └─ Spend Currency → RPC: wallet_update_game_wallet (subtract)
│  │
│  └─ Log Analytics Events
│     ├─ Level Start → RPC: analytics_log_event ("level_start")
│     ├─ Purchase → RPC: analytics_log_event ("purchase")
│     └─ Other Events → RPC: analytics_log_event (eventName, eventData)
│
└─ After Match/Level Completion:
   ├─ Submit Score
   │  └─ RPC: submit_score_to_time_periods (gameId, score)
   │     ├─ Submits to: Daily Leaderboard
   │     ├─ Submits to: Weekly Leaderboard
   │     ├─ Submits to: Monthly Leaderboard
   │     ├─ Submits to: All-Time Leaderboard
   │     ├─ Submits to: Global Daily
   │     ├─ Submits to: Global Weekly
   │     ├─ Submits to: Global Monthly
   │     └─ Submits to: Global All-Time
   │
   └─ Check Mission Completion
      ├─ If mission completed → RPC: claim_mission_reward (gameId, missionId)
      └─ Grant rewards to player

           ↓

Step 4: SOCIAL FEATURES
├─ Friends Management
│  ├─ Get Friends → RPC: friends_list
│  ├─ Block User → RPC: friends_block (targetUserId)
│  ├─ Unblock User → RPC: friends_unblock (targetUserId)
│  └─ Remove Friend → RPC: friends_remove (friendUserId)
│
├─ Challenges
│  ├─ Challenge Friend → RPC: friends_challenge_user (friendUserId, gameId)
│  └─ Spectate Friend → RPC: friends_spectate (friendUserId)
│
└─ Leaderboards
   ├─ View Daily → RPC: get_time_period_leaderboard (gameId, "daily")
   ├─ View Weekly → RPC: get_time_period_leaderboard (gameId, "weekly")
   ├─ View Monthly → RPC: get_time_period_leaderboard (gameId, "monthly")
   ├─ View All-Time → RPC: get_time_period_leaderboard (gameId, "alltime")
   └─ View Global → RPC: get_time_period_leaderboard (scope: "global", period)

           ↓

Step 5: SESSION CLEANUP
├─ Before App Quit:
│  └─ RPC: analytics_log_event ("session_end", gameId)
│
└─ Session Management:
   ├─ Save session token → PlayerPrefs
   ├─ On next launch → Restore session
   └─ If expired → Refresh session → Save new token
```

---

## Detailed Step-by-Step Implementation

### Step 1: Authentication

#### 1.1 Device Authentication (Recommended for Single-Player Games)

```csharp
using Nakama;
using System.Threading.Tasks;
using UnityEngine;

public class GameAuthManager : MonoBehaviour
{
    private IClient client;
    private ISession session;
    private string gameId = "YOUR-GAME-UUID";
    
    async void Start()
    {
        await AuthenticateWithDevice();
    }
    
    async Task AuthenticateWithDevice()
    {
        // Create Nakama client
        client = new Client("http", "127.0.0.1", 7350, "defaultkey");
        
        // Authenticate with device ID
        try
        {
            session = await client.AuthenticateDeviceAsync(
                SystemInfo.deviceUniqueIdentifier,
                null, // username (optional)
                true  // create account if doesn't exist
            );
            
            Debug.Log($"✓ Authenticated! User ID: {session.UserId}");
            
            // Save session for next time
            SaveSession();
            
            // Initialize game features
            await InitializeGameFeatures();
        }
        catch (ApiResponseException ex)
        {
            Debug.LogError($"✗ Authentication failed: {ex.Message}");
        }
    }
    
    void SaveSession()
    {
        PlayerPrefs.SetString("nakama_auth_token", session.AuthToken);
        PlayerPrefs.SetString("nakama_refresh_token", session.RefreshToken);
        PlayerPrefs.Save();
    }
}
```

#### 1.2 AWS Cognito Integration (For Cross-Platform Games)

```csharp
using Nakama;
using System.Threading.Tasks;
using UnityEngine;

public class CognitoAuthManager : MonoBehaviour
{
    private IClient client;
    private ISession session;
    private string gameId = "YOUR-GAME-UUID";
    
    async Task AuthenticateWithCognito(string cognitoJwtToken)
    {
        client = new Client("http", "127.0.0.1", 7350, "defaultkey");
        
        try
        {
            // Step 1: Get/Create wallet using Cognito token
            var walletPayload = new { token = cognitoJwtToken };
            var walletResult = await client.RpcAsync(
                session, 
                "get_user_wallet", 
                JsonUtility.ToJson(walletPayload)
            );
            
            Debug.Log("✓ Wallet created/retrieved");
            
            // Step 2: Link wallet to this game
            var linkPayload = new { gameId = gameId, token = cognitoJwtToken };
            var linkResult = await client.RpcAsync(
                session, 
                "link_wallet_to_game", 
                JsonUtility.ToJson(linkPayload)
            );
            
            Debug.Log("✓ Wallet linked to game");
            
            // Initialize game features
            await InitializeGameFeatures();
        }
        catch (ApiResponseException ex)
        {
            Debug.LogError($"✗ Cognito authentication failed: {ex.Message}");
        }
    }
}
```

### Step 2: Initialize Game Features

```csharp
async Task InitializeGameFeatures()
{
    Debug.Log("=== Initializing Game Features ===");
    
    // 1. Check and claim daily rewards
    await InitializeDailyRewards();
    
    // 2. Load daily missions
    await InitializeDailyMissions();
    
    // 3. Load wallet
    await InitializeWallet();
    
    // 4. Log session start
    await LogSessionStart();
    
    Debug.Log("=== Initialization Complete ===");
}

async Task InitializeDailyRewards()
{
    try
    {
        // Get status
        var payload = new { gameId = gameId };
        var statusResult = await client.RpcAsync(
            session, 
            "daily_rewards_get_status", 
            JsonUtility.ToJson(payload)
        );
        
        var status = JsonUtility.FromJson<DailyRewardStatus>(statusResult.Payload);
        
        Debug.Log($"✓ Daily Reward: Streak {status.currentStreak}");
        
        // Auto-claim if available
        if (status.canClaimToday)
        {
            var claimResult = await client.RpcAsync(
                session, 
                "daily_rewards_claim", 
                JsonUtility.ToJson(payload)
            );
            
            var claim = JsonUtility.FromJson<DailyRewardClaim>(claimResult.Payload);
            Debug.Log($"✓ Claimed: {claim.reward.xp} XP, {claim.reward.tokens} Tokens");
            
            // Show reward popup to player
            ShowRewardPopup(claim.reward);
        }
    }
    catch (ApiResponseException ex)
    {
        Debug.LogError($"Daily rewards error: {ex.Message}");
    }
}

async Task InitializeDailyMissions()
{
    try
    {
        var payload = new { gameId = gameId };
        var result = await client.RpcAsync(
            session, 
            "get_daily_missions", 
            JsonUtility.ToJson(payload)
        );
        
        var missions = JsonUtility.FromJson<DailyMissionsData>(result.Payload);
        
        Debug.Log($"✓ Loaded {missions.missions.Length} missions");
        
        // Update UI with missions
        UpdateMissionsUI(missions.missions);
    }
    catch (ApiResponseException ex)
    {
        Debug.LogError($"Daily missions error: {ex.Message}");
    }
}

async Task InitializeWallet()
{
    try
    {
        var result = await client.RpcAsync(session, "wallet_get_all", "{}");
        var wallets = JsonUtility.FromJson<UserWallets>(result.Payload);
        
        Debug.Log($"✓ Wallet loaded - Tokens: {GetGameWalletTokens(wallets)}");
        
        // Update UI with wallet balance
        UpdateWalletUI(wallets);
    }
    catch (ApiResponseException ex)
    {
        Debug.LogError($"Wallet error: {ex.Message}");
    }
}

async Task LogSessionStart()
{
    try
    {
        var payload = new { 
            gameId = gameId, 
            eventName = "session_start" 
        };
        
        await client.RpcAsync(
            session, 
            "analytics_log_event", 
            JsonUtility.ToJson(payload)
        );
        
        Debug.Log("✓ Analytics: Session started");
    }
    catch (ApiResponseException ex)
    {
        Debug.LogError($"Analytics error: {ex.Message}");
    }
}
```

### Step 3: Gameplay Integration

#### 3.1 Track Mission Progress

```csharp
public class MissionTracker : MonoBehaviour
{
    private string gameId = "YOUR-GAME-UUID";
    private IClient client;
    private ISession session;
    
    // Call when player completes a match
    public async void OnMatchCompleted()
    {
        await UpdateMissionProgress("play_matches", 1);
    }
    
    // Call when player wins a match
    public async void OnMatchWon()
    {
        await UpdateMissionProgress("win_matches", 1);
    }
    
    // Call when player reaches a score milestone
    public async void OnScoreReached(int score)
    {
        if (score >= 1000)
        {
            await UpdateMissionProgress("reach_1000_score", 1);
        }
    }
    
    async Task UpdateMissionProgress(string missionId, int value)
    {
        try
        {
            var payload = new { 
                gameId = gameId, 
                missionId = missionId, 
                value = value 
            };
            
            var result = await client.RpcAsync(
                session, 
                "submit_mission_progress", 
                JsonUtility.ToJson(payload)
            );
            
            var response = JsonUtility.FromJson<MissionProgressResponse>(result.Payload);
            
            if (response.completed)
            {
                Debug.Log($"✓ Mission '{missionId}' completed!");
                ShowMissionCompletedNotification(missionId);
            }
        }
        catch (ApiResponseException ex)
        {
            Debug.LogError($"Mission progress error: {ex.Message}");
        }
    }
    
    void ShowMissionCompletedNotification(string missionId)
    {
        // Show UI notification
        Debug.Log($"🎯 Mission Completed: {missionId}");
    }
}
```

#### 3.2 Wallet Updates

```csharp
public class WalletManager : MonoBehaviour
{
    private string gameId = "YOUR-GAME-UUID";
    private IClient client;
    private ISession session;
    
    // Earn currency
    public async Task AddTokens(int amount, string reason = "reward")
    {
        await UpdateWallet("tokens", amount, "add");
        
        // Log analytics
        await LogAnalyticsEvent("currency_earned", new {
            currency = "tokens",
            amount = amount,
            reason = reason
        });
    }
    
    // Spend currency
    public async Task<bool> SpendTokens(int amount, string reason = "purchase")
    {
        // Check if player has enough
        var wallets = await GetWallets();
        var currentBalance = GetGameWalletTokens(wallets);
        
        if (currentBalance < amount)
        {
            Debug.LogWarning("Insufficient tokens");
            return false;
        }
        
        await UpdateWallet("tokens", amount, "subtract");
        
        // Log analytics
        await LogAnalyticsEvent("currency_spent", new {
            currency = "tokens",
            amount = amount,
            reason = reason
        });
        
        return true;
    }
    
    async Task UpdateWallet(string currency, int amount, string operation)
    {
        try
        {
            var payload = new {
                gameId = gameId,
                currency = currency,
                amount = amount,
                operation = operation
            };
            
            var result = await client.RpcAsync(
                session, 
                "wallet_update_game_wallet", 
                JsonUtility.ToJson(payload)
            );
            
            var response = JsonUtility.FromJson<WalletUpdateResponse>(result.Payload);
            
            Debug.Log($"✓ Wallet updated: {currency} = {response.newBalance}");
            
            // Update UI
            UpdateWalletUI(response.newBalance);
        }
        catch (ApiResponseException ex)
        {
            Debug.LogError($"Wallet update error: {ex.Message}");
        }
    }
}
```

#### 3.3 Analytics Events

```csharp
public class AnalyticsTracker : MonoBehaviour
{
    private string gameId = "YOUR-GAME-UUID";
    private IClient client;
    private ISession session;
    
    // Track level events
    public async void OnLevelStart(int level)
    {
        await LogEvent("level_start", new { level = level });
    }
    
    public async void OnLevelComplete(int level, int score, float time)
    {
        await LogEvent("level_complete", new { 
            level = level, 
            score = score, 
            time = time 
        });
    }
    
    public async void OnLevelFailed(int level, string reason)
    {
        await LogEvent("level_failed", new { 
            level = level, 
            reason = reason 
        });
    }
    
    // Track purchase events
    public async void OnPurchase(string itemId, int price, string currency)
    {
        await LogEvent("purchase", new { 
            itemId = itemId, 
            price = price, 
            currency = currency 
        });
    }
    
    // Track social events
    public async void OnFriendAdded(string friendId)
    {
        await LogEvent("friend_added", new { friendId = friendId });
    }
    
    async Task LogEvent(string eventName, object eventData = null)
    {
        try
        {
            var payload = new {
                gameId = gameId,
                eventName = eventName,
                eventData = eventData
            };
            
            await client.RpcAsync(
                session, 
                "analytics_log_event", 
                JsonUtility.ToJson(payload)
            );
        }
        catch (ApiResponseException ex)
        {
            Debug.LogError($"Analytics error: {ex.Message}");
        }
    }
}
```

#### 3.4 Submit Scores to Leaderboards

```csharp
public class LeaderboardManager : MonoBehaviour
{
    private string gameId = "YOUR-GAME-UUID";
    private IClient client;
    private ISession session;
    
    // Call after match/level completion
    public async Task SubmitScore(long score, ScoreMetadata metadata = null)
    {
        try
        {
            var payload = new {
                gameId = gameId,
                score = score,
                subscore = 0,
                metadata = metadata ?? new ScoreMetadata()
            };
            
            var result = await client.RpcAsync(
                session, 
                "submit_score_to_time_periods", 
                JsonUtility.ToJson(payload)
            );
            
            var response = JsonUtility.FromJson<ScoreSubmissionResponse>(result.Payload);
            
            if (response.success)
            {
                Debug.Log($"✓ Score {score} submitted to all leaderboards");
                Debug.Log($"  Submitted to {response.results.Length} leaderboards");
                
                // Show notification
                ShowScoreSubmittedNotification(score);
            }
        }
        catch (ApiResponseException ex)
        {
            Debug.LogError($"Score submission error: {ex.Message}");
        }
    }
    
    void ShowScoreSubmittedNotification(long score)
    {
        Debug.Log($"📊 Score {score} submitted to leaderboards!");
    }
}
```

### Step 4: Social Features

#### 4.1 Friends Management

```csharp
public class FriendsManager : MonoBehaviour
{
    private IClient client;
    private ISession session;
    
    public async Task<Friend[]> GetFriendsList()
    {
        try
        {
            var payload = new { limit = 100 };
            var result = await client.RpcAsync(
                session, 
                "friends_list", 
                JsonUtility.ToJson(payload)
            );
            
            var response = JsonUtility.FromJson<FriendsListResponse>(result.Payload);
            
            if (response.success)
            {
                Debug.Log($"✓ Loaded {response.count} friends");
                return response.friends;
            }
        }
        catch (ApiResponseException ex)
        {
            Debug.LogError($"Friends list error: {ex.Message}");
        }
        
        return new Friend[0];
    }
    
    public async Task<bool> BlockUser(string targetUserId)
    {
        try
        {
            var payload = new { targetUserId = targetUserId };
            var result = await client.RpcAsync(
                session, 
                "friends_block", 
                JsonUtility.ToJson(payload)
            );
            
            var response = JsonUtility.FromJson<BlockResponse>(result.Payload);
            return response.success;
        }
        catch (ApiResponseException ex)
        {
            Debug.LogError($"Block user error: {ex.Message}");
            return false;
        }
    }
}
```

#### 4.2 View Leaderboards

```csharp
public class LeaderboardViewer : MonoBehaviour
{
    private string gameId = "YOUR-GAME-UUID";
    private IClient client;
    private ISession session;
    
    public async Task ShowWeeklyLeaderboard()
    {
        var data = await GetLeaderboard("weekly", false);
        DisplayLeaderboard(data);
    }
    
    public async Task ShowGlobalMonthlyLeaderboard()
    {
        var data = await GetLeaderboard("monthly", true);
        DisplayLeaderboard(data);
    }
    
    async Task<LeaderboardData> GetLeaderboard(string period, bool isGlobal)
    {
        try
        {
            var payload = new {
                gameId = isGlobal ? null : gameId,
                scope = isGlobal ? "global" : "game",
                period = period,
                limit = 50
            };
            
            var result = await client.RpcAsync(
                session, 
                "get_time_period_leaderboard", 
                JsonUtility.ToJson(payload)
            );
            
            var response = JsonUtility.FromJson<LeaderboardDataResponse>(result.Payload);
            
            if (response.success)
            {
                return new LeaderboardData { 
                    Records = response.records 
                };
            }
        }
        catch (ApiResponseException ex)
        {
            Debug.LogError($"Leaderboard error: {ex.Message}");
        }
        
        return null;
    }
    
    void DisplayLeaderboard(LeaderboardData data)
    {
        if (data == null || data.Records == null) return;
        
        foreach (var record in data.Records)
        {
            Debug.Log($"#{record.rank} - {record.username}: {record.score}");
        }
    }
}
```

### Step 5: Session Cleanup

```csharp
void OnApplicationQuit()
{
    // Log session end
    _ = LogSessionEnd();
}

async Task LogSessionEnd()
{
    try
    {
        var payload = new { 
            gameId = gameId, 
            eventName = "session_end" 
        };
        
        await client.RpcAsync(
            session, 
            "analytics_log_event", 
            JsonUtility.ToJson(payload)
        );
        
        Debug.Log("✓ Session ended");
    }
    catch (ApiResponseException ex)
    {
        Debug.LogError($"Session end error: {ex.Message}");
    }
}
```

---

## Complete Integration Example

Here's a complete manager that ties everything together:

```csharp
using Nakama;
using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using UnityEngine;

public class CompleteGameBackend : MonoBehaviour
{
    [Header("Configuration")]
    [SerializeField] private string gameId = "YOUR-GAME-UUID";
    [SerializeField] private string serverHost = "127.0.0.1";
    [SerializeField] private int serverPort = 7350;
    [SerializeField] private string serverKey = "defaultkey";
    
    private IClient client;
    private ISession session;
    
    void Start()
    {
        InitializeBackend();
    }
    
    async void InitializeBackend()
    {
        Debug.Log("=== Starting Backend Initialization ===");
        
        try
        {
            // 1. Create client
            client = new Client("http", serverHost, serverPort, serverKey);
            Debug.Log("✓ Client created");
            
            // 2. Authenticate
            session = await RestoreOrCreateSession();
            Debug.Log($"✓ Authenticated as {session.UserId}");
            
            // 3. Initialize features
            await InitializeFeatures();
            
            Debug.Log("=== Backend Ready ===");
        }
        catch (Exception ex)
        {
            Debug.LogError($"✗ Initialization failed: {ex.Message}");
        }
    }
    
    async Task<ISession> RestoreOrCreateSession()
    {
        // Try to restore saved session
        var authToken = PlayerPrefs.GetString("nakama_auth_token", "");
        
        if (!string.IsNullOrEmpty(authToken))
        {
            var refreshToken = PlayerPrefs.GetString("nakama_refresh_token", "");
            var restoredSession = Session.Restore(authToken, refreshToken);
            
            if (!restoredSession.IsExpired)
            {
                Debug.Log("✓ Session restored");
                return restoredSession;
            }
            
            // Try to refresh
            try
            {
                restoredSession = await client.SessionRefreshAsync(restoredSession);
                SaveSession(restoredSession);
                Debug.Log("✓ Session refreshed");
                return restoredSession;
            }
            catch
            {
                Debug.Log("Session refresh failed, creating new session");
            }
        }
        
        // Create new session
        var newSession = await client.AuthenticateDeviceAsync(
            SystemInfo.deviceUniqueIdentifier, null, true);
        SaveSession(newSession);
        return newSession;
    }
    
    void SaveSession(ISession session)
    {
        PlayerPrefs.SetString("nakama_auth_token", session.AuthToken);
        PlayerPrefs.SetString("nakama_refresh_token", session.RefreshToken);
        PlayerPrefs.Save();
    }
    
    async Task InitializeFeatures()
    {
        // Daily Rewards
        var rewardStatus = await CheckDailyReward();
        if (rewardStatus != null && rewardStatus.canClaimToday)
        {
            var claim = await ClaimDailyReward();
            Debug.Log($"✓ Daily reward claimed: {claim.reward.tokens} tokens");
        }
        
        // Daily Missions
        var missions = await GetDailyMissions();
        Debug.Log($"✓ Loaded {missions.missions.Length} missions");
        
        // Wallet
        var wallets = await GetWallets();
        Debug.Log($"✓ Wallet loaded");
        
        // Analytics
        await LogAnalyticsEvent("session_start");
        Debug.Log("✓ Session started");
    }
    
    // === Daily Rewards ===
    async Task<DailyRewardStatus> CheckDailyReward()
    {
        var payload = new { gameId = gameId };
        var result = await client.RpcAsync(
            session, "daily_rewards_get_status", JsonUtility.ToJson(payload));
        return JsonUtility.FromJson<DailyRewardStatus>(result.Payload);
    }
    
    async Task<DailyRewardClaim> ClaimDailyReward()
    {
        var payload = new { gameId = gameId };
        var result = await client.RpcAsync(
            session, "daily_rewards_claim", JsonUtility.ToJson(payload));
        return JsonUtility.FromJson<DailyRewardClaim>(result.Payload);
    }
    
    // === Daily Missions ===
    async Task<DailyMissionsData> GetDailyMissions()
    {
        var payload = new { gameId = gameId };
        var result = await client.RpcAsync(
            session, "get_daily_missions", JsonUtility.ToJson(payload));
        return JsonUtility.FromJson<DailyMissionsData>(result.Payload);
    }
    
    public async Task SubmitMissionProgress(string missionId, int value)
    {
        var payload = new { gameId = gameId, missionId = missionId, value = value };
        var result = await client.RpcAsync(
            session, "submit_mission_progress", JsonUtility.ToJson(payload));
        var response = JsonUtility.FromJson<MissionProgressResponse>(result.Payload);
        
        if (response.completed)
        {
            Debug.Log($"Mission '{missionId}' completed!");
        }
    }
    
    // === Wallet ===
    async Task<UserWallets> GetWallets()
    {
        var result = await client.RpcAsync(session, "wallet_get_all", "{}");
        return JsonUtility.FromJson<UserWallets>(result.Payload);
    }
    
    public async Task AddTokens(int amount)
    {
        var payload = new { 
            gameId = gameId, 
            currency = "tokens", 
            amount = amount, 
            operation = "add" 
        };
        
        await client.RpcAsync(
            session, "wallet_update_game_wallet", JsonUtility.ToJson(payload));
        Debug.Log($"Added {amount} tokens");
    }
    
    // === Leaderboards ===
    public async Task SubmitScore(long score)
    {
        var payload = new { gameId = gameId, score = score, subscore = 0 };
        var result = await client.RpcAsync(
            session, "submit_score_to_time_periods", JsonUtility.ToJson(payload));
        var response = JsonUtility.FromJson<ScoreSubmissionResponse>(result.Payload);
        
        Debug.Log($"Score {score} submitted to {response.results.Length} leaderboards");
    }
    
    // === Analytics ===
    async Task LogAnalyticsEvent(string eventName, object eventData = null)
    {
        var payload = new { gameId = gameId, eventName = eventName, eventData = eventData };
        await client.RpcAsync(session, "analytics_log_event", JsonUtility.ToJson(payload));
    }
    
    void OnApplicationQuit()
    {
        _ = LogAnalyticsEvent("session_end");
    }
}
```

---

## Summary Checklist

Use this checklist to ensure you've integrated all features:

### Setup
- [ ] Installed Nakama Unity SDK
- [ ] Obtained Game ID (UUID)
- [ ] Configured server connection details
- [ ] Tested authentication

### Core Features
- [ ] Implemented device/email/Cognito authentication
- [ ] Integrated daily rewards system
- [ ] Integrated daily missions system
- [ ] Integrated wallet system
- [ ] Integrated analytics tracking

### Gameplay Integration
- [ ] Submit mission progress during gameplay
- [ ] Update wallet on currency earn/spend
- [ ] Log key analytics events
- [ ] Submit scores to leaderboards after matches

### Social Features
- [ ] Implemented friends list
- [ ] Implemented leaderboard viewing
- [ ] Optional: Friend challenges
- [ ] Optional: Spectate feature

### Polish
- [ ] Session persistence (save/restore)
- [ ] Error handling for network issues
- [ ] UI notifications for rewards/achievements
- [ ] Loading indicators
- [ ] Session cleanup on quit

---

## Support

For additional help:
- See `UNITY_DEVELOPER_COMPLETE_GUIDE.md` for detailed API documentation
- See `LEADERBOARD_TIME_PERIODS_GUIDE.md` for leaderboard specifics
- See `QUICK_REFERENCE.md` for quick code snippets
- Check Nakama docs: https://heroiclabs.com/docs

---

**Last Updated**: 2025-11-13  
**Version**: 1.0
