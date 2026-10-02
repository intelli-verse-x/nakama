// ============================================================
// Quest Event Bridge — closes the analytics_log_event gap
//
// RPC: quest_game_event
//
// Called by game clients (or internally by other RPCs) when a
// game-play event should trigger quest progress in QuestX.
//
// Payload:
//   { gameId: string, eventName: string, eventData: object }
//
// Flow:
//   game client → Nakama RPC quest_game_event
//              → maps eventName → QuestX GameEventType
//              → POST /game-bridge/s2s/quest-event   (HMAC-signed)
//              → QuestX processNakamaEvent()
//              → GameQuestProgress updated
//              → Points awarded when quest completes
//
// Environment variables used (resolved from ctx.env):
//   QUESTS_ECONOMY_API_URL   — e.g. https://quests.intelli-verse-x.ai
//   NAKAMA_WEBHOOK_SECRET    — shared secret for NakamaS2sGuard
// ============================================================

namespace QuestEventBridge {

  // ── Analytics event name → QuestX GameEventType ──────────────
  // Matches the goal-type map in GameBridgeService.getActiveGameQuestsForEvent()
  var EVENT_MAP: { [key: string]: string } = {
    // Matches / battles
    "match_complete":      "match_result",
    "multiplayer_win":     "match_result",
    // Scores
    "score_submit":        "score_update",
    "quiz_complete":       "score_update",
    "quiz_accuracy":       "score_update",
    // Levels / progression
    "level_up":            "level_reached",
    "season_pass_xp":      "level_reached",
    "collection_unlock":   "level_reached",
    // Achievements
    "achievement_unlock":  "achievement_completed",
    // Missions / daily engagement
    "mission_complete":    "mission_completed",
    "daily_login":         "mission_completed",
    "weekly_goal_complete":"mission_completed",
    // Playtime / streaks
    "session_end":         "playtime_update",
    "playtime_update":     "playtime_update",
    "streak_continue":     "playtime_update",
    // Purchases
    "item_purchase":       "purchase_made",
    // Everything else
    "currency_earn":       "custom_event",
    "friend_challenge":    "custom_event",
    "referral_signup":     "custom_event",
    "ad_watched":          "custom_event",
    "receipt_scanned":     "custom_event",
    "tournament_join":     "custom_event",
    "tournament_win":      "custom_event",
    "weekly_goal_complete_bonus": "custom_event",
    "leaderboard_rank":    "leaderboard_rank",
    "leaderboard_update":  "leaderboard_rank",
  };

  function mapEventType(eventName: string): string {
    return EVENT_MAP[eventName] || "custom_event";
  }

  function questEventUrl(base: string): string {
    var b = (base || "http://localhost:3001").replace(/\/$/, "");
    if (b.length >= 4 && b.substring(b.length - 4) === "/api") {
      return b + "/game-bridge/s2s/quest-event";
    }
    return b + "/api/game-bridge/s2s/quest-event";
  }

  function forwardQuestEvent(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    gameId: string,
    eventName: string,
    eventData: any,
  ): { [key: string]: any } {
    var userId = RpcHelpers.requireUserId(ctx);
    var eventType = mapEventType(eventName);
    var questsApiUrl = (ctx.env && ctx.env["QUESTS_ECONOMY_API_URL"]) || "http://localhost:3001";
    var webhookSecret = (ctx.env && ctx.env["NAKAMA_WEBHOOK_SECRET"]) || "";

    if (!webhookSecret) {
      logger.warn("[QuestEventBridge] NAKAMA_WEBHOOK_SECRET not set — skipping quest sync");
      return { forwarded: false, reason: "webhook_secret_not_configured" };
    }

    var body = JSON.stringify({
      userId:       userId,
      nakamaGameId: gameId,
      eventType:    eventType,
      eventName:    eventName,
      data:         eventData || {},
    });

    // HMAC-SHA256 of the exact body — NakamaS2sGuard checks raw bytes first.
    var sig = (nk.hmacSha256Hash(webhookSecret, body) as unknown) as string;
    var url = questEventUrl(questsApiUrl);

    try {
      var resp: any = nk.httpRequest(
        url,
        "post",
        {
          "Content-Type":       "application/json",
          "X-Source":           "nakama-rpc",
          "X-Webhook-Signature": sig,
          "X-User-Id":          userId,
          "X-Game-Id":          gameId,
        },
        body,
        5000,
      );
      if (resp && typeof resp.code === "number" && resp.code >= 400) {
        logger.warn("[QuestEventBridge] HTTP " + resp.code + " event=" + eventName);
        return { forwarded: false, reason: "http_error", status: resp.code };
      }
      logger.debug("[QuestEventBridge] forwarded event=" + eventName + " type=" + eventType + " user=" + userId + " game=" + gameId);
    } catch (httpErr: any) {
      // Non-fatal: quest sync failure must never break the game session
      logger.warn("[QuestEventBridge] HTTP call failed: " + (httpErr.message || String(httpErr)));
      return { forwarded: false, reason: "http_error", error: httpErr.message };
    }

    return {
      forwarded:  true,
      eventType:  eventType,
      eventName:  eventName,
      userId:     userId,
      gameId:     gameId,
    };
  }

  export function forwardNamedEvent(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    gameId: string,
    eventName: string,
    eventData: any,
  ): { [key: string]: any } {
    return forwardQuestEvent(ctx, logger, nk, gameId, eventName, eventData);
  }

  export function forwardLeaderboardRank(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    gameId: string,
    leaderboardId: string,
    rank: number,
  ): void {
    try {
      if (!gameId || !leaderboardId) return;
      if (typeof rank !== "number" || rank < 1 || Math.floor(rank) !== rank) return;
      forwardQuestEvent(ctx, logger, nk, gameId, "leaderboard_rank", {
        rank: rank,
        leaderboardId: leaderboardId,
      });
    } catch (e: any) {
      logger.warn("[QuestEventBridge] leaderboard forward failed: " + (e && e.message ? e.message : String(e)));
    }
  }

  function rpcQuestGameEvent(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string,
  ): string {
    try {
      RpcHelpers.requireUserId(ctx);
      var data = RpcHelpers.parseRpcPayload(payload);

      var gameId = data.gameId || data.game_id;
      var eventName = data.eventName || data.event_name || data.name;
      var eventData = data.eventData || data.event_data || data.data || {};

      if (!gameId) return RpcHelpers.errorResponse("gameId required");
      if (!eventName) return RpcHelpers.errorResponse("eventName required");

      var result = forwardQuestEvent(ctx, logger, nk, gameId, eventName, eventData);
      return RpcHelpers.successResponse(result);
    } catch (e: any) {
      return RpcHelpers.errorResponse("quest_game_event failed: " + (e.message || String(e)));
    }
  }

  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("quest_game_event", rpcQuestGameEvent);
  }
}
