# QuestX System — Unity Developer Guide

> Complete guide for Unity developers working with the QuizVerse Quest System.

## Overview

The QuestX system enables daily, weekly, monthly, and friend quests in QuizVerse. **All Unity code is already implemented** — this guide explains how it works and how to extend it.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         UNITY GAME                               │
│                                                                  │
│   Player Action → RecordEvent() → QuestEngineManager            │
│                                        │                         │
│                                        ▼                         │
│                              Nakama RPC Calls                    │
│                                        │                         │
└────────────────────────────────────────│─────────────────────────┘
                                         │
                                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                       NAKAMA SERVER                              │
│                                                                  │
│   quest_engine_get          → Returns all quests + progress     │
│   quest_engine_record_event → Updates quest progress            │
│   quest_engine_claim_reward → Grants reward, marks claimed      │
│                                                                  │
│   Storage: qv_quest_config (quest definitions)                  │
│            qv_quests (per-user progress)                        │
└─────────────────────────────────────────────────────────────────┘
                                         │
                                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                     ADMIN DASHBOARD                              │
│                   http://localhost:7351                          │
│                                                                  │
│   Quests Config page → Create/Edit/Delete quests (no code!)    │
└─────────────────────────────────────────────────────────────────┘
```

---

## Key Unity Files

| File | Purpose |
|------|---------|
| `Scripts/Quests/QuestEngineManager.cs` | Core manager — singleton, RPCs, events |
| `Scripts/Quests/UI/DailyQuestPopupUI.cs` | Daily quests UI |
| `Scripts/Quests/UI/WeeklyGoalsPopupUI.cs` | Weekly quests UI |
| `Scripts/Quests/UI/MonthlyMilestonesPopupUI.cs` | Monthly quests UI |
| `Scripts/Quests/UI/FriendQuestPopupUI.cs` | Friend/social quests UI |
| `Scripts/Quests/UI/QuestCompletePopupUI.cs` | Quest completion popup |

---

## How It Works — Real Example

### Scenario: Player wins a quiz

**Step 1: Game detects win**

```csharp
// ProgressionEventRouter.cs (line 820)
if (playerWon)
{
    QuestEngineManager.Instance?.RecordEvent("quiz_win");
}
```

**Step 2: Server updates progress**

```
Server receives: { eventType: "quiz_win", count: 1 }

Checks all quests:
  ✓ "Win 3 Quizzes" (daily) needs "quiz_win" → 0/3 → 1/3
  ✓ "Weekly Winner" needs "quiz_win" → 0/15 → 1/15
  ✗ "Perfect Round" needs "perfect_round" → no match

Returns: { updatedQuests: 2 }
```

**Step 3: UI updates**

```csharp
// QuestEngineManager fires OnQuestsUpdated(2)
// DailyQuestPopupUI refreshes progress bars
```

**Step 4: Quest completes (after 3 wins)**

```csharp
// QuestCompletePopupUI shows
// Player clicks "Claim Reward"
QuestEngineManager.Instance?.ClaimReward("daily_win_3");
// Server grants 100 coins
// OnRewardClaimed fires → coin animation plays
```

---

## QuestEngineManager API

### Initialization

```csharp
// Called automatically in D7D30RetentionBootstrap.Start()
QuestEngineManager.Instance.Initialize();
QuestEngineManager.Instance.LoadQuests();
```

### Recording Events

```csharp
// Simple event (count = 1)
QuestEngineManager.Instance?.RecordEvent("quiz_win");

// Event with value (for streak milestones)
QuestEngineManager.Instance?.RecordEvent("streak_day_reached", streakDays);

// Event with metadata
QuestEngineManager.Instance?.RecordEvent("level_reached", newLevel);
```

### Claiming Rewards

```csharp
QuestEngineManager.Instance?.ClaimReward(questId);
```

### Events to Subscribe

```csharp
void OnEnable()
{
    QuestEngineManager.Instance.OnQuestsLoaded += HandleQuestsLoaded;
    QuestEngineManager.Instance.OnQuestsUpdated += HandleQuestsUpdated;
    QuestEngineManager.Instance.OnRewardClaimed += HandleRewardClaimed;
}

void OnDisable()
{
    QuestEngineManager.Instance.OnQuestsLoaded -= HandleQuestsLoaded;
    QuestEngineManager.Instance.OnQuestsUpdated -= HandleQuestsUpdated;
    QuestEngineManager.Instance.OnRewardClaimed -= HandleRewardClaimed;
}

void HandleQuestsLoaded(List<QuestData> quests)
{
    // Populate UI with quests
    var dailyQuests = quests.Where(q => q.category == "daily").ToList();
}

void HandleQuestsUpdated(int updatedCount)
{
    // Refresh progress bars
    QuestEngineManager.Instance.LoadQuests(); // Reload fresh data
}

void HandleRewardClaimed(string questId)
{
    // Play coin animation, update wallet UI
}
```

### Getting Quests by Category

```csharp
var dailyQuests = QuestEngineManager.Instance.GetQuestsByCategory("daily");
var weeklyQuests = QuestEngineManager.Instance.GetQuestsByCategory("weekly");
var monthlyQuests = QuestEngineManager.Instance.GetQuestsByCategory("monthly");
var friendQuests = QuestEngineManager.Instance.GetQuestsByCategory("friend");
```

---

## Available Event Types

These events are **already wired** in the codebase. Just use `RecordEvent()` with the correct type.

| Event Type | Description | Already Called In |
|------------|-------------|-------------------|
| `quiz_win` | Player wins any quiz | ProgressionEventRouter.cs:820 |
| `perfect_round` | 100% correct answers | ProgressionEventRouter.cs:823 |
| `speed_quiz_win` | Wins speed quiz | ProgressionEventRouter.cs:829 |
| `daily_quiz_complete` | Completes daily quiz | ProgressionEventRouter.cs:826 |
| `multiplayer_won` | Wins multiplayer match | D7D30RetentionBootstrap.cs:191 |
| `friend_challenged` | Challenges a friend | D7D30RetentionBootstrap.cs:220 |
| `streak_day_reached` | Hits streak milestone | D7D30RetentionBootstrap.cs:236 |
| `level_reached` | Reaches new level | D7D30RetentionBootstrap.cs:229 |
| `review_session` | Completes review session | SmartReviewScreen.cs:406 |
| `guild_joined` | Joins a guild | GuildManager.cs:216 |
| `clan_joined` | Joins a clan | ClanManager.cs:1192 |
| `quiz_together` | Plays quiz with friends | ProgressionEventRouter.cs:842 |
| `quiz_created` | Creates a new quiz | D7D30RetentionBootstrap.cs:208 |
| `score_shared` | Shares score socially | AniDeeBeeShareManager.cs:1284 |
| `geo_explore_play` | Plays Geo Explore mode | ProgressionEventRouter.cs:832 |
| `tournament_rank_reached` | Tournament rank milestone | D7D30RetentionBootstrap.cs:243 |

---

## Data Models

### QuestData

```csharp
[Serializable]
public class QuestData
{
    public string id;
    public string name;
    public string description;
    public string category;        // "daily", "weekly", "monthly", "friend"
    public QuestStepData[] steps;
    public QuestReward reward;
    public long completedAt;       // Unix timestamp, 0 if not complete
    public long claimedAt;         // Unix timestamp, 0 if not claimed
    public long resetsAt;          // When quest resets (daily/weekly)
}
```

### QuestStepData

```csharp
[Serializable]
public class QuestStepData
{
    public string id;
    public string description;
    public string eventType;
    public int requiredCount;
    public int currentCount;
    public bool completed;
}
```

### QuestReward

```csharp
[Serializable]
public class QuestReward
{
    public Dictionary<string, int> currencies;  // e.g., { "coins": 100 }
    public QuestRewardItem[] items;
    public int xp;
}
```

---

## Adding a New Event Type

If you need to track a new player action:

### Step 1: Call RecordEvent in your code

```csharp
// Example: Player completes a tutorial
QuestEngineManager.Instance?.RecordEvent("tutorial_complete");
```

### Step 2: Add quest in Admin Dashboard

1. Go to http://localhost:7351
2. Quests Config → Create Quest
3. Set Objective Type to your new event (`tutorial_complete`)
4. Save

**No code changes needed on backend!**

---

## Quest Categories

| Category | Reset Period | Use Case |
|----------|--------------|----------|
| `daily` | Every day at midnight UTC | Daily challenges |
| `weekly` | Every Monday at midnight UTC | Weekly goals |
| `monthly` | First of month at midnight UTC | Monthly milestones |
| `friend` | No auto-reset | Social/friend quests |

---

## Testing Quests

### In Editor

1. Set `injectPreviewQuestForReview = true` in QuestEngineManager inspector
2. Play → Preview quests will appear even without server connection

### With Server

1. Start Nakama: `docker compose up -d`
2. Quests auto-seed on first run (14 default quests)
3. Play game → Check quest popups
4. Win quizzes → Watch progress update
5. Check Admin Dashboard to verify data

### Debug Logging

```csharp
// QuestEngineManager logs all RPC calls
// Look for "[QuestEngine]" in console:
// [QuestEngine] Loaded 14 quests
// [QuestEngine] RecordEvent: quiz_win (value=1)
// [QuestEngine] Updated 2 quests
```

---

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Quests not loading | Check Nakama connection, verify server is running |
| Progress not updating | Verify `RecordEvent()` is called with correct eventType |
| Reward not granting | Check server logs, verify quest is complete before claim |
| UI not refreshing | Subscribe to `OnQuestsUpdated` event |
| Preview quests showing | Set `injectPreviewQuestForReview = false` in production |

---

## FAQ

**Q: Do I need to modify Unity code to add new quests?**
A: No! Add quests via Admin Dashboard or backend config. Unity picks them up automatically.

**Q: How do I change quest rewards?**
A: Edit in Admin Dashboard → Quests Config → Edit quest → Change reward JSON.

**Q: Can I add quests that require multiple steps?**
A: Yes! Backend supports multi-step quests. Example: "Win 50 quizzes AND get 10 perfect rounds"

**Q: How do streaks work?**
A: Call `RecordEvent("streak_day_reached", currentStreakDays)` when streak updates. Quest config has `requiredValue` to match specific streak milestones.

**Q: When do daily quests reset?**
A: Midnight UTC. Server handles this automatically.

---

## Contact

For backend quest configuration issues, contact the Platform team.
For Unity integration issues, check `QuestEngineManager.cs` first.

---

*Last updated: June 2026*
