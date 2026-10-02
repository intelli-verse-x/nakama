// QuestX S2S bridge. Does not replace quest_engine, daily_missions, or quests_redeem_gift.
namespace QuestxBridge {

  function apiUrl(base: string, path: string): string {
    var b = (base || "http://localhost:3001").replace(/\/$/, "");
    if (b.length >= 4 && b.substring(b.length - 4) === "/api") return b + path;
    return b + "/api" + path;
  }

  function postSigned(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    path: string,
    bodyObj: { [key: string]: any },
  ): { [key: string]: any } {
    var userId = RpcHelpers.requireUserId(ctx);
    var questsApiUrl = (ctx.env && ctx.env["QUESTS_ECONOMY_API_URL"]) || "http://localhost:3001";
    var webhookSecret = (ctx.env && ctx.env["NAKAMA_WEBHOOK_SECRET"]) || "";
    if (!webhookSecret) {
      logger.warn("[QuestxBridge] NAKAMA_WEBHOOK_SECRET not set — skipping quest sync");
      return { forwarded: false, reason: "webhook_secret_not_configured" };
    }
    bodyObj.userId = userId;
    var body = JSON.stringify(bodyObj);
    var sig = (nk.hmacSha256Hash(webhookSecret, body) as unknown) as string;
    var gameId = bodyObj.nakamaGameId || "";
    try {
      var resp: any = nk.httpRequest(
        apiUrl(questsApiUrl, path),
        "post",
        {
          "Content-Type": "application/json",
          "X-Source": "nakama-rpc",
          "X-Webhook-Signature": sig,
          "X-User-Id": userId,
          "X-Game-Id": gameId,
        },
        body,
        5000,
      );
      if (resp && typeof resp.code === "number" && resp.code >= 400) {
        logger.warn("[QuestxBridge] HTTP " + resp.code + " path=" + path);
        return { forwarded: false, reason: "http_error", status: resp.code, body: resp.body };
      }
      var parsed: any = {};
      try { parsed = resp && resp.body ? JSON.parse(resp.body) : {}; } catch (_) { parsed = { raw: resp && resp.body }; }
      parsed.forwarded = true;
      return parsed;
    } catch (httpErr: any) {
      logger.warn("[QuestxBridge] HTTP call failed: " + (httpErr.message || String(httpErr)));
      return { forwarded: false, reason: "http_error", error: httpErr.message };
    }
  }

  function gameIdOf(data: any): string {
    return data.gameId || data.game_id || data.nakamaGameId || "";
  }

  function rpcLogEvent(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    try {
      var data = RpcHelpers.parseRpcPayload(payload);
      var gameId = gameIdOf(data);
      var eventName = data.eventName || data.event_name || data.name;
      if (!gameId) return RpcHelpers.errorResponse("gameId required");
      if (!eventName) return RpcHelpers.errorResponse("eventName required");
      var result = QuestEventBridge.forwardNamedEvent(ctx, logger, nk, gameId, eventName, data.eventData || data.data || {});
      return RpcHelpers.successResponse(result);
    } catch (e: any) {
      return RpcHelpers.errorResponse("questx_log_event failed: " + (e.message || String(e)));
    }
  }

  function rpcSubmitProgress(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    try {
      var data = RpcHelpers.parseRpcPayload(payload);
      var gameId = gameIdOf(data);
      var eventName = data.eventName || data.event_name || data.name;
      if (!gameId) return RpcHelpers.errorResponse("gameId required");
      if (!eventName) return RpcHelpers.errorResponse("eventName required");
      var result = QuestEventBridge.forwardNamedEvent(ctx, logger, nk, gameId, eventName, data.eventData || data.data || {});
      if (!result.forwarded) return RpcHelpers.errorResponse(result.reason || "quest sync failed");
      return RpcHelpers.successResponse(result);
    } catch (e: any) {
      return RpcHelpers.errorResponse("questx_submit_progress failed: " + (e.message || String(e)));
    }
  }

  function rpcFeed(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    return readFeed(ctx, logger, nk, payload, "/game-bridge/s2s/quest-feed", "questx_quest_feed");
  }

  function rpcDaily(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    return readFeed(ctx, logger, nk, payload, "/game-bridge/s2s/daily-missions", "questx_daily_missions");
  }

  function readFeed(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string,
    path: string,
    name: string,
  ): string {
    try {
      var data = RpcHelpers.parseRpcPayload(payload);
      var gameId = gameIdOf(data);
      if (!gameId) return RpcHelpers.errorResponse("gameId required");
      var result = postSigned(ctx, logger, nk, path, { nakamaGameId: gameId });
      if (!result.forwarded) return RpcHelpers.errorResponse(result.reason || "quest sync failed");
      return RpcHelpers.successResponse(result);
    } catch (e: any) {
      return RpcHelpers.errorResponse(name + " failed: " + (e.message || String(e)));
    }
  }

  function rpcClaim(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    try {
      var data = RpcHelpers.parseRpcPayload(payload);
      var gameId = gameIdOf(data);
      if (!gameId) return RpcHelpers.errorResponse("gameId required");
      var result = postSigned(ctx, logger, nk, "/game-bridge/s2s/quest-claim", {
        nakamaGameId: gameId,
        kind: data.kind || "coins",
        questId: data.questId || data.quest_id,
        cardId: data.cardId || data.card_id,
        rewardId: data.rewardId || data.reward_id,
        name: data.name,
        line1: data.line1,
        line2: data.line2,
        city: data.city,
        state: data.state,
        zip: data.zip,
        country: data.country,
        phone: data.phone,
      });
      if (!result.forwarded) return RpcHelpers.errorResponse(result.reason || "quest claim failed");
      return RpcHelpers.successResponse(result);
    } catch (e: any) {
      return RpcHelpers.errorResponse("questx_claim_reward failed: " + (e.message || String(e)));
    }
  }

  function rpcRedeem(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    return LegacyGiftCards.purchaseGiftCard(ctx, logger, nk, payload);
  }

  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("questx_log_event", rpcLogEvent);
    initializer.registerRpc("questx_submit_progress", rpcSubmitProgress);
    initializer.registerRpc("questx_quest_feed", rpcFeed);
    initializer.registerRpc("questx_daily_missions", rpcDaily);
    initializer.registerRpc("questx_claim_reward", rpcClaim);
    initializer.registerRpc("questx_redeem_gift_card", rpcRedeem);
  }
}
