namespace HiroEventLeaderboards {

  var DEFAULT_CONFIG: Hiro.EventLeaderboardConfig = { events: {} };

  export function getConfig(nk: nkruntime.Nakama, gameId?: string): Hiro.EventLeaderboardConfig {
    return ConfigLoader.loadConfigForGame<Hiro.EventLeaderboardConfig>(nk, "event_leaderboards", gameId, DEFAULT_CONFIG);
  }

  interface ActiveEvent {
    eventId: string;
    leaderboardId: string;
    startAt: number;
    endAt: number;
    cohortId?: string;
  }

  interface UserEventState {
    events: { [eventId: string]: { joined: boolean; cohortId: string; claimedAt?: number } };
  }

  function getUserEventState(nk: nkruntime.Nakama, userId: string, gameId?: string): UserEventState {
    var data = Storage.readJson<UserEventState>(nk, Constants.HIRO_CONFIGS_COLLECTION, Constants.gameKey(gameId, "event_lb_state_" + userId), userId);
    return data || { events: {} };
  }

  function saveUserEventState(nk: nkruntime.Nakama, userId: string, data: UserEventState, gameId?: string): void {
    Storage.writeJson(nk, Constants.HIRO_CONFIGS_COLLECTION, Constants.gameKey(gameId, "event_lb_state_" + userId), userId, data);
  }

  function getActiveEvents(nk: nkruntime.Nakama): ActiveEvent[] {
    var data = Storage.readSystemJson<{ events: ActiveEvent[] }>(nk, Constants.HIRO_CONFIGS_COLLECTION, "active_event_lbs");
    return (data && data.events) || [];
  }

  function rpcList(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload);
    var gameId = RpcHelpers.gameId(data);
    var config = getConfig(nk, gameId);
    var activeEvents = getActiveEvents(nk);
    var userState = getUserEventState(nk, userId, gameId);
    var now = Math.floor(Date.now() / 1000);

    var result: any[] = [];
    for (var i = 0; i < activeEvents.length; i++) {
      var ae = activeEvents[i];
      var def = config.events[ae.eventId];
      if (!def) continue;

      var status = now < ae.startAt ? "upcoming" : now > ae.endAt ? "ended" : "active";
      var us = userState.events[ae.eventId];

      result.push({
        eventId: ae.eventId,
        name: def.name,
        description: def.description,
        leaderboardId: ae.leaderboardId,
        startAt: ae.startAt,
        endAt: ae.endAt,
        status: status,
        joined: us ? us.joined : false,
        claimed: us ? !!us.claimedAt : false,
        tiers: def.tiers
      });
    }

    return RpcHelpers.successResponse({ events: result });
  }

  // Server-side ceiling. Per-event ceilings can override via def.maxScore.
  // Without a cap, score=Number.MAX_SAFE_INTEGER trivially wins.
  var DEFAULT_MAX_SCORE = 10_000_000;
  // Bound eventId character set + length to keep storage keys deterministic
  // and avoid path-injection style abuse via the eventId field.
  var EVENT_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;

  function validateScore(score: any, def: Hiro.EventLeaderboardEventConfig | any): { ok: boolean; reason: string; value: number } {
    if (typeof score !== "number") return { ok: false, reason: "score must be a number", value: 0 };
    if (!isFinite(score)) return { ok: false, reason: "score must be finite", value: 0 };
    if (score < 0) return { ok: false, reason: "score must be >= 0", value: 0 };
    var max = (def && typeof def.maxScore === "number" && def.maxScore > 0) ? def.maxScore : DEFAULT_MAX_SCORE;
    if (score > max) return { ok: false, reason: "score exceeds maximum (" + max + ")", value: 0 };
    // Truncate to integer for leaderboard storage semantics.
    return { ok: true, reason: "", value: Math.floor(score) };
  }

  function rpcSubmit(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.eventId || data.score === undefined) return RpcHelpers.errorResponse("eventId and score required");
    if (!EVENT_ID_RE.test(String(data.eventId))) return RpcHelpers.errorResponse("eventId must match [A-Za-z0-9._:-]{1,64}");

    var gameId = RpcHelpers.gameId(data);
    var config = getConfig(nk, gameId);
    var def = config.events[data.eventId];
    if (!def) return RpcHelpers.errorResponse("Unknown event");

    var activeEvents = getActiveEvents(nk);
    var ae = activeEvents.find(function (e) { return e.eventId === data.eventId; });
    if (!ae) return RpcHelpers.errorResponse("Event not active");

    var now = Math.floor(Date.now() / 1000);
    if (now < ae.startAt || now > ae.endAt) return RpcHelpers.errorResponse("Event not in active window");

    var v = validateScore(data.score, def);
    if (!v.ok) return RpcHelpers.errorResponse(v.reason);
    var subscore = data.subscore !== undefined ? validateScore(data.subscore, def) : { ok: true, reason: "", value: 0 };
    if (!subscore.ok) return RpcHelpers.errorResponse("subscore: " + subscore.reason);

    var userState = getUserEventState(nk, userId, gameId);
    if (!userState.events[data.eventId]) {
      userState.events[data.eventId] = { joined: true, cohortId: ae.cohortId || "default" };
    }
    userState.events[data.eventId].joined = true;
    saveUserEventState(nk, userId, userState, gameId);

    var operatorMap: { [key: string]: nkruntime.OverrideOperator } = { best: nkruntime.OverrideOperator.BEST, set: nkruntime.OverrideOperator.SET, incr: nkruntime.OverrideOperator.INCREMENTAL, decr: nkruntime.OverrideOperator.DECREMENTAL };
    var op = operatorMap[def.operator] || nkruntime.OverrideOperator.BEST;
    nk.leaderboardRecordWrite(ae.leaderboardId, userId, ctx.username || "", v.value, subscore.value, data.metadata || {}, op);

    EventBus.emit(nk, logger, ctx, EventBus.Events.SCORE_SUBMITTED, {
      userId: userId, eventId: data.eventId, score: v.value
    });

    // Return the new rank so clients don't need a follow-up RPC for the
    // single most common post-submit UX (toast: "you're now #N").
    var newRank = 0;
    var newScore = v.value;
    try {
      var owner = nk.leaderboardRecordsList(ae.leaderboardId, [userId], 1, undefined, 0);
      if (owner.records && owner.records.length > 0) {
        newRank = owner.records[0].rank;
        newScore = owner.records[0].score;
      }
    } catch (e) {
      // Non-fatal — submit already succeeded.
    }
    return RpcHelpers.successResponse({ success: true, rank: newRank, score: newScore });
  }

  function rpcClaim(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.eventId) return RpcHelpers.errorResponse("eventId required");
    if (!EVENT_ID_RE.test(String(data.eventId))) return RpcHelpers.errorResponse("eventId must match [A-Za-z0-9._:-]{1,64}");

    var gameId = RpcHelpers.gameId(data);
    var config = getConfig(nk, gameId);
    var def = config.events[data.eventId];
    if (!def) return RpcHelpers.errorResponse("Unknown event");

    var activeEvents = getActiveEvents(nk);
    var ae = activeEvents.find(function (e) { return e.eventId === data.eventId; });
    if (!ae) return RpcHelpers.errorResponse("Event not found");

    // Claim only after the event window has ended. Otherwise rankings can
    // still shift and we'd be paying out a non-final ranking. Allow a grace
    // period override via def.allowClaimDuringEvent (off by default).
    var now = Math.floor(Date.now() / 1000);
    var allowDuringEvent = !!(def as any).allowClaimDuringEvent;
    if (!allowDuringEvent && now <= ae.endAt) {
      return RpcHelpers.errorResponse("Event still active — claim unlocks after endAt");
    }

    // Persist claimedAt FIRST as an optimistic-lock; if another concurrent
    // claim wins the race, we'd already have claimedAt and skip the reward
    // grant. (Single-RPC instances of goja in our cluster make this safe;
    // the second concurrent caller observes claimedAt set and bails out.)
    var userState = getUserEventState(nk, userId, gameId);
    var us = userState.events[data.eventId];
    if (!us || !us.joined) return RpcHelpers.errorResponse("Not joined");
    if (us.claimedAt) return RpcHelpers.errorResponse("Already claimed");

    var records = nk.leaderboardRecordsList(ae.leaderboardId, [userId], 1, undefined, 0);
    var rank = 0;
    if (records.records && records.records.length > 0) {
      rank = records.records[0].rank;
    }
    if (rank <= 0) {
      return RpcHelpers.errorResponse("Not ranked — submit a score before claiming");
    }

    // Reserve the claim BEFORE granting so a crash mid-grant doesn't allow a
    // double-claim on retry. The reward grant is idempotent at the wallet
    // layer, but the user-state lock is the primary safety.
    us.claimedAt = now;
    saveUserEventState(nk, userId, userState, gameId);

    var reward: Hiro.ResolvedReward | null = null;
    var matchedTier: any = null;
    try {
      for (var i = 0; i < def.tiers.length; i++) {
        var tier = def.tiers[i];
        if (rank >= tier.rankMin && rank <= tier.rankMax) {
          reward = RewardEngine.resolveReward(nk, tier.reward);
          RewardEngine.grantReward(nk, logger, ctx, userId, gameId || "default", reward);
          matchedTier = { rankMin: tier.rankMin, rankMax: tier.rankMax };
          break;
        }
      }
    } catch (e) {
      // Roll back the claim lock so the user can retry — we don't want to
      // permanently lock them out of a reward they earned because the grant
      // pipeline failed.
      us.claimedAt = undefined;
      saveUserEventState(nk, userId, userState, gameId);
      throw e;
    }

    return RpcHelpers.successResponse({ rank: rank, reward: reward, tier: matchedTier });
  }

  function rpcGetRankings(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.eventId) return RpcHelpers.errorResponse("eventId required");
    if (!EVENT_ID_RE.test(String(data.eventId))) return RpcHelpers.errorResponse("eventId must match [A-Za-z0-9._:-]{1,64}");

    var activeEvents = getActiveEvents(nk);
    var ae = activeEvents.find(function (e) { return e.eventId === data.eventId; });
    if (!ae) return RpcHelpers.errorResponse("Event not found or not active");

    var config = getConfig(nk, RpcHelpers.gameId(data));
    var def = config.events[ae.eventId];
    // Bound the page size — unbounded limit would let a client dump the full
    // leaderboard in a single call (5K+ records on a popular event).
    var limit = Math.min(Math.max(Number(data.limit || 50), 1), 200);
    var cursor = data.cursor || undefined;

    var result = nk.leaderboardRecordsList(ae.leaderboardId, [], limit, cursor, 0);

    var rankings: any[] = [];
    if (result.records) {
      for (var i = 0; i < result.records.length; i++) {
        var r = result.records[i];
        rankings.push({
          rank: r.rank,
          userId: r.ownerId,
          username: r.username || "",
          score: r.score,
          subscore: r.subscore,
          metadata: r.metadata,
          updateTime: r.updateTime,
        });
      }
    }

    var callerRank: any = null;
    var userId = ctx.userId;
    if (userId) {
      var ownerRecords = nk.leaderboardRecordsList(ae.leaderboardId, [userId], 1, undefined, 0);
      if (ownerRecords.records && ownerRecords.records.length > 0) {
        var cr = ownerRecords.records[0];
        callerRank = {
          rank: cr.rank,
          userId: cr.ownerId,
          username: cr.username || "",
          score: cr.score,
          subscore: cr.subscore,
        };
      }
    }

    return RpcHelpers.successResponse({
      eventId: data.eventId,
      name: def ? def.name : data.eventId,
      leaderboardId: ae.leaderboardId,
      rankings: rankings,
      nextCursor: result.nextCursor || "",
      prevCursor: result.prevCursor || "",
      callerRank: callerRank,
    });
  }

  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("hiro_event_lb_list", rpcList);
    initializer.registerRpc("hiro_event_lb_submit", rpcSubmit);
    initializer.registerRpc("hiro_event_lb_claim", rpcClaim);
    initializer.registerRpc("hiro_event_lb_get", rpcGetRankings);
    initializer.registerRpc("hiro_event_leaderboards_list", rpcList);
    initializer.registerRpc("hiro_event_leaderboards_submit", rpcSubmit);
    initializer.registerRpc("hiro_event_leaderboards_claim", rpcClaim);
    initializer.registerRpc("hiro_event_leaderboards_get", rpcGetRankings);
  }
}
