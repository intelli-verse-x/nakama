/**
 * QuizVerse Quest Configuration Seed
 * 
 * Call `ensureQuizVerseQuests()` at server startup to seed default quests
 * if none exist. Safe to call multiple times — won't overwrite existing config.
 */

namespace QuizVerseQuestSeed {

  const QUIZVERSE_GAME_ID = "126bf539-dae2-4bcf-964d-316c0fa1f92b";
  const QUEST_CONFIG_COLLECTION = "qv_quest_config";

  interface QuestStepConfig {
    id: string;
    description: string;
    eventType: string;
    requiredCount: number;
    requiredValue?: number;
  }

  interface QuestConfig {
    id: string;
    name: string;
    description?: string;
    category?: string;
    steps: QuestStepConfig[];
    reward?: { currencies?: { [key: string]: number } };
    repeatable?: boolean;
    resetIntervalSec?: number;
  }

  interface QuestsConfig {
    quests: { [questId: string]: QuestConfig };
  }

  // Default quests — matching existing Unity events
  const DEFAULT_QUESTS: QuestsConfig = {
    quests: {
      // ─── Daily Quests ────────────────────────────────────────────────
      "daily_win_3": {
        id: "daily_win_3",
        name: "Win 3 Quizzes",
        description: "Play and win any quiz mode three times today.",
        category: "daily",
        repeatable: true,
        resetIntervalSec: 86400,
        steps: [{ id: "s1", description: "Win a quiz", eventType: "quiz_win", requiredCount: 3 }],
        reward: { currencies: { coins: 100 } }
      },
      "daily_perfect_round": {
        id: "daily_perfect_round",
        name: "Perfect Round",
        description: "Complete a quiz with no wrong answers.",
        category: "daily",
        repeatable: true,
        resetIntervalSec: 86400,
        steps: [{ id: "s1", description: "Get a perfect round", eventType: "perfect_round", requiredCount: 1 }],
        reward: { currencies: { coins: 150 } }
      },
      "daily_speed_win": {
        id: "daily_speed_win",
        name: "Speed Demon",
        description: "Win a speed quiz today.",
        category: "daily",
        repeatable: true,
        resetIntervalSec: 86400,
        steps: [{ id: "s1", description: "Win a speed quiz", eventType: "speed_quiz_win", requiredCount: 1 }],
        reward: { currencies: { coins: 75 } }
      },
      "daily_review_session": {
        id: "daily_review_session",
        name: "Study Session",
        description: "Complete a review session today.",
        category: "daily",
        repeatable: true,
        resetIntervalSec: 86400,
        steps: [{ id: "s1", description: "Complete a review", eventType: "review_session", requiredCount: 1 }],
        reward: { currencies: { coins: 50 } }
      },

      // ─── Weekly Quests ───────────────────────────────────────────────
      "weekly_win_15": {
        id: "weekly_win_15",
        name: "Weekly Winner",
        description: "Win 15 quizzes this week.",
        category: "weekly",
        repeatable: true,
        resetIntervalSec: 604800,
        steps: [{ id: "s1", description: "Win quizzes", eventType: "quiz_win", requiredCount: 15 }],
        reward: { currencies: { coins: 500 } }
      },
      "weekly_streak_5": {
        id: "weekly_streak_5",
        name: "5-Day Streak",
        description: "Maintain a 5-day login streak this week.",
        category: "weekly",
        repeatable: true,
        resetIntervalSec: 604800,
        steps: [{ id: "s1", description: "Reach 5-day streak", eventType: "streak_day_reached", requiredCount: 1, requiredValue: 5 }],
        reward: { currencies: { coins: 300 } }
      },
      "weekly_multiplayer_5": {
        id: "weekly_multiplayer_5",
        name: "Multiplayer Master",
        description: "Win 5 multiplayer games this week.",
        category: "weekly",
        repeatable: true,
        resetIntervalSec: 604800,
        steps: [{ id: "s1", description: "Win multiplayer games", eventType: "multiplayer_won", requiredCount: 5 }],
        reward: { currencies: { coins: 400 } }
      },
      "weekly_explore_3": {
        id: "weekly_explore_3",
        name: "Explorer",
        description: "Play 3 Geo Explore games this week.",
        category: "weekly",
        repeatable: true,
        resetIntervalSec: 604800,
        steps: [{ id: "s1", description: "Play Geo Explore", eventType: "geo_explore_play", requiredCount: 3 }],
        reward: { currencies: { coins: 200 } }
      },

      // ─── Monthly Quests ──────────────────────────────────────────────
      "monthly_champion": {
        id: "monthly_champion",
        name: "Monthly Champion",
        description: "Complete all milestone steps to become a monthly champion.",
        category: "monthly",
        repeatable: true,
        resetIntervalSec: 2592000,
        steps: [
          { id: "s1", description: "Win 50 quizzes", eventType: "quiz_win", requiredCount: 50 },
          { id: "s2", description: "Get 10 perfect rounds", eventType: "perfect_round", requiredCount: 10 },
          { id: "s3", description: "Win 10 multiplayer games", eventType: "multiplayer_won", requiredCount: 10 }
        ],
        reward: { currencies: { coins: 2000 } }
      },
      "monthly_level_up": {
        id: "monthly_level_up",
        name: "Level Up",
        description: "Reach a new level this month.",
        category: "monthly",
        repeatable: true,
        resetIntervalSec: 2592000,
        steps: [{ id: "s1", description: "Reach a new level", eventType: "level_reached", requiredCount: 1 }],
        reward: { currencies: { coins: 500 } }
      },
      "monthly_social_butterfly": {
        id: "monthly_social_butterfly",
        name: "Social Butterfly",
        description: "Join a guild and share your score this month.",
        category: "monthly",
        repeatable: true,
        resetIntervalSec: 2592000,
        steps: [
          { id: "s1", description: "Join a guild", eventType: "guild_joined", requiredCount: 1 },
          { id: "s2", description: "Share your score", eventType: "score_shared", requiredCount: 1 }
        ],
        reward: { currencies: { coins: 750 } }
      },

      // ─── Friend Quests ───────────────────────────────────────────────
      "friend_challenge_win": {
        id: "friend_challenge_win",
        name: "Beat a Friend",
        description: "Challenge a friend and win the match.",
        category: "friend",
        steps: [{ id: "s1", description: "Win a friend challenge", eventType: "friend_challenged", requiredCount: 1 }],
        reward: { currencies: { coins: 200 } }
      },
      "friend_quiz_together_3": {
        id: "friend_quiz_together_3",
        name: "Quiz Together",
        description: "Play 3 quizzes together with friends.",
        category: "friend",
        steps: [{ id: "s1", description: "Play quiz together", eventType: "quiz_together", requiredCount: 3 }],
        reward: { currencies: { coins: 300 } }
      },
      "friend_create_quiz": {
        id: "friend_create_quiz",
        name: "Quiz Creator",
        description: "Create a quiz and share it with friends.",
        category: "friend",
        steps: [{ id: "s1", description: "Create a quiz", eventType: "quiz_created", requiredCount: 1 }],
        reward: { currencies: { coins: 250 } }
      }
    }
  };

  /**
   * Check if quest config exists for QuizVerse. If not, seed the defaults.
   * Call this from main.ts InitModule or a startup hook.
   */
  export function ensureQuizVerseQuests(
    nk: nkruntime.Nakama,
    logger: nkruntime.Logger
  ): void {
    try {
      var rows = nk.storageRead([{
        collection: QUEST_CONFIG_COLLECTION,
        key: QUIZVERSE_GAME_ID,
        userId: Constants.SYSTEM_USER_ID
      }]);

      if (rows && rows.length > 0 && rows[0].value) {
        var existing = rows[0].value as QuestsConfig;
        var count = Object.keys(existing.quests || {}).length;
        if (count > 0) {
          logger.info("[QuestSeed] QuizVerse already has %d quests configured — skipping seed", count);
          return;
        }
      }

      // No config found — seed the defaults
      nk.storageWrite([{
        collection: QUEST_CONFIG_COLLECTION,
        key: QUIZVERSE_GAME_ID,
        userId: Constants.SYSTEM_USER_ID,
        value: DEFAULT_QUESTS,
        permissionRead: 2 as nkruntime.ReadPermissionValues,
        permissionWrite: 0 as nkruntime.WritePermissionValues
      }]);

      var seededCount = Object.keys(DEFAULT_QUESTS.quests).length;
      logger.info("[QuestSeed] Seeded %d default quests for QuizVerse", seededCount);

    } catch (err) {
      logger.error("[QuestSeed] Failed to seed quests: %s", String(err));
    }
  }
}
