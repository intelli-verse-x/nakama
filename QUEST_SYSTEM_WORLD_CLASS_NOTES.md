# Quest System — World-Class Deep-Dive & Improvements

> **Scope**: Nakama backend (`data/modules/src/quests/`), Unity client (`Quests/`), Admin UI (`web/packages/admin/`).
> **Date**: 2026-08-12
> **Goal**: Read the code to depth, expose every supported reward type, and ship production-ready improvements.

---

## 1. Architecture Overview

```
Admin UI                 Nakama Backend                    Unity Client
   |                           |                                  |
   |  quest_engine_admin_      |                                  |
   |  save_config(gameId)      |                                  |
   |-------------------------->|                                  |
   |                           |  qv_quest_config/{gameId}        |
   |                           |  qv_quest_config_audit/{gameId}  |
   |                           |                                  |
   |<--------------------------|                                  |
   |  get_config(gameId)       |                                  |
   |                           |                                  |
   |                           |<---------------------------------|
   |                           |  quest_engine_get(gameId)        |
   |                           |                                  |
   |                           |  quest_engine_record_event       |
   |                           |  (auto-grants on completion)     |
   |                           |                                  |
   |                           |<---------------------------------|
   |                           |  quest_engine_claim_reward       |
   |                           |  (manual claim / deferred UI)    |
```

Every collection is prefixed/scoped by `gameId`.

---

## 2. Supported Reward Types (Verified in Code)

| Type | Backend | Admin UI | Unity Rendering |
|------|---------|----------|-----------------|
| Currencies (`game`, `tokens`, `coins`, `xp`, `global`, `xut`) | ✅ `RewardEngine` | ✅ RewardBuilder | ✅ Coins + XP |
| Inventory Items | ✅ `HiroInventory.grantItem` | ✅ RewardBuilder | ✅ New model |
| Energy Refills | ✅ `HiroEnergy.addEnergy` | ✅ RewardBuilder | ✅ New model |
| XP (standalone) | ✅ | ✅ RewardBuilder | ✅ New model |
| Gifts (`physical`, `voucher`, `experience`, `digital`, `merch`) | ✅ queued to `gift_claims` | ✅ RewardBuilder | ✅ New model |
| Energy Modifiers | ✅ EventBus | ✅ RewardBuilder | ✅ New model |
| Reward Modifiers | ✅ EventBus | ✅ RewardBuilder | ✅ New model |
| Weighted loot rolls | ✅ `resolveReward` | ✅ RewardBuilder JSON | ⚠ needs client UX |
| IAP Products | ❌ NOT implemented | ❌ | ❌ |
| Subscriptions / Entitlements | ❌ NOT implemented | ❌ | ❌ |

---

## 3. What Was Changed

### 3.1 Backend — `src/quests/quest_engine.ts`

| Change | Why |
|--------|-----|
| Added `enabled?: boolean` to `QuestConfig` | Soft-disable quests without deleting them |
| Added `requiresOptIn?: boolean` | "Choose your own quest" bucket support |
| Added `maxConcurrent?: number` | Limit active opt-in bucket quests per player |
| Added `validateQuestConfig()` + `validateReward()` | Server rejects broken quest configs before saving |
| Added `auditConfigChange()` + `qv_quest_config_audit` collection | Who changed what, when, from which IP |
| `quest_engine_get` now skips disabled quests via `isQuestVisible()` | Enforces `enabled` flag |

**Build verified**: `npm run build` → `Build complete` (8.9 MB index.js, 1332 RPCs).

### 3.2 Admin UI — New `QuestEngineConfigPage.tsx`

| Change | Why |
|--------|-----|
| New dedicated page at `/quest-engine-config` | Old `/quests-config` was editing **Hiro Challenges**, not the Quest Engine |
| Uses `quest_engine_admin_get_config` / `save_config` | Correct backend surface |
| Full steps editor (event type, required count, filters) | Quest Engine requires steps, old page had no step UI |
| Reward Builder integration | Visual editor for all reward types |
| Client-side validation | Immediate feedback before server round-trip |
| Bulk JSON import/export | Fast migrations and backups |
| Duplicate, delete, search, filter | Operator workflow |
| Enabled/hidden/repeatable/opt-in toggles | New backend fields exposed |

**Build verified**: `pnpm lint` ✅ + `pnpm --filter @nakama/admin build` ✅.

### 3.3 Unity Client — `QuestEngineManager.cs` + `QuestCompletePopupUI.cs`

| Change | Why |
|--------|-----|
| Expanded `QuestRewardPreview` with items, energies, XP, gifts, modifiers | Previously only `currencies` |
| Added `QuestRewardGift`, `QuestRewardModifier`, `QuestRewardItemRange` models | Deserialize full reward JSON |
| Added `PreviewXpAmount`, `PreviewRewardSummary`, `HasPremiumReward` | Drive richer UI |
| `QuestCompletePopupUI` now renders XP + gift names + energy + modifiers | Previously showed only coins |

---

## 4. How to Configure a "Free Product" Quest from Admin UI Only

1. Open admin → **Configuration → Quest Engine** (new nav item).
2. Select the game from the app selector (defaults to QuizVerse UUID).
3. Click **Create Quest**.
4. Fill:
   - **Quest ID**: `bucket_free_skin_001`
   - **Display Name**: `Unlock Dragon Skin`
   - **Category**: `bucket`
   - **Requires opt-in**: ✅
   - **Max Concurrent**: `3`
5. Add a step:
   - **Step ID**: `s1`
   - **Event Type**: `bucket_progress`
   - **Required Count**: `50`
6. In the **Reward** section:
   - Currencies → `game`: `500`
   - XP: `250`
   - Gifts → Add gift:
     - ID: `dragon_skin_download`
     - Name: `Dragon Skin 3D Model`
     - Type: `digital`
     - Asset URL: `https://cdn.quizverse.com/skins/dragon.glb`
     - Deliver email: ✅
7. Click **Create Quest**.

The quest is now live **only for that game**. No code deploy, no server restart.

---

## 5. Remaining Gaps & Recommended Next Steps

| # | Gap | Effort | Recommendation |
|---|-----|--------|----------------|
| 1 | **IAP product / subscription grants** | 2–3 days | Add `iapProducts` to reward schema + new `quest_grant_iap_product` RPC that calls RevenueCat. See §6 below. |
| 2 | **Reward Catalog admin page** | 1 day | A separate page to configure gift email templates, asset URLs, and fulfillment rules. Currently embedded per-quest. |
| 3 | **Player opt-in RPC** | 1 day | Backend RPC `quest_engine_opt_in` so a player can choose which bucket quests to pursue. |
| 4 | **Unity reward catalog fetch** | 1 day | Client fetches `reward_catalog_admin_get_config` to show gift thumbnails/icons before claiming. |
| 5 | **Weighted reward UX** | ½ day | Show "chance to win" preview in Unity when `weighted` rewards are configured. |
| 6 | **Quest list cards** | 1 day | Update `QuestListScreen` to use `PreviewRewardSummary` for non-currency rewards. |
| 7 | **Offline fallback** | 1 day | Cache last `quest_engine_get` response locally; degrade gracefully. |
| 8 | **Unit/regression tests** | 1 day | Add Nakama VM test for validation + bucket opt-in logic. |

---

## 6. IAP Product Grant — Recommended Design

When you want to give a paid IAP product (e.g., a skin pack or subscription) as a quest reward:

```json
{
  "reward": {
    "guaranteed": {
      "currencies": { "game": 100 },
      "iapProducts": [
        {
          "sku": "premium_monthly",
          "platform": "ios",
          "revenueCatEntitlement": "quizverse_pro",
          "durationDays": 30
        }
      ]
    }
  }
}
```

Backend flow:
1. Quest completes → `RewardEngine.grantReward()`
2. New branch detects `iapProducts`
3. Calls RevenueCat server API to grant entitlement to the user
4. Writes an audit record to `iap_grant_log/{gameId}`
5. Client sees the entitlement on next wallet/entitlements fetch

This requires RevenueCat server API key + webhook verification for Apple/Google receipts.

---

## 7. Files Modified

### Backend
- `C:\Office\Backend\nakama\data\modules\src\quests\quest_engine.ts`

### Admin UI
- `C:\Office\Backend\nakama\web\packages\admin\src\App.tsx`
- `C:\Office\Backend\nakama\web\packages\admin\src\layouts\AdminLayout.tsx`
- `C:\Office\Backend\nakama\web\packages\admin\src\pages\QuestEngineConfigPage.tsx` (new)
- `C:\Office\Backend\nakama\web\packages\admin\src\components\RewardBuilder.tsx` (from earlier)
- `C:\Office\Backend\nakama\web\packages\shared\src\rpc\quest-engine\index.ts`

### Unity Client
- `C:\Office\Unity\intelliverse-x-games-platform-2\games\quiz-verse\Assets\_QuizVerse\Scripts\Quests\QuestEngineManager.cs`
- `C:\Office\Unity\intelliverse-x-games-platform-2\games\quiz-verse\Assets\_QuizVerse\Scripts\Quests\UI\QuestCompletePopupUI.cs`

### Documentation
- `C:\Office\Backend\nakama\QUEST_SYSTEM_WORLD_CLASS_NOTES.md`
- `C:\Office\Backend\nakama\quest-system-flow-demo.html`
- `C:\Office\Flutter\quiz-verse-flutter\quest-system-flow-demo.html`

---

## 8. Verification Commands

```bash
# Nakama backend
cd /c/Office/Backend/nakama/data/modules
npm run build

# Admin UI
cd /c/Office/Backend/nakama/web/packages/admin
pnpm lint

cd /c/Office/Backend/nakama/web
pnpm --filter @nakama/admin build
```

All three pass as of this writing.
