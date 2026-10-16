// Phase 7 (qv-insights-loop) — privacy + consent forwarder RPCs.
//
// The Nakama orchestrator + Privacy team tooling call these RPCs to:
//   - cascade-erase a user's footprint from the AI svc (GDPR Art.17 / CCPA)
//   - update the AI svc's consent gate cache (COPPA / GDPR / CCPA)
//   - invalidate the consent cache when a user changes settings
//
// Why route through Nakama?
//   1. Same shared-secret HMAC chain as every other AI svc call —
//      the AI svc has ONE trust anchor (IVX_INSIGHTS_SHARED_SECRET).
//   2. Nakama owns the upstream consent record and underage flag.
//   3. Audit trail lives in the Nakama session; AI svc only sees the
//      derived gate decision.
//
// Behaviour:
//   privacy_erase_user      → /privacy/erase
//   privacy_erase_discord   → /privacy/erase-discord
//   consent_upsert          → /consent/upsert  (called on every consent flip)
//   consent_invalidate      → /consent/invalidate (drops the cache key)
//
// Legacy forwarding RPCs are also used by clients. Erasure binds the player
// subject to the authenticated session. Other callers historically include:
// are called by:
//   - Nakama-internal account-deletion handler (bound to the user's
//     /v2/account DELETE webhook)
//   - the consent-set Nakama RPC fired from the SDK whenever a user
//     toggles a privacy / personalization / marketing / push setting
//   - the Privacy team's admin tool for manual erasures.

namespace QvPrivacy {

  interface EraseUserRequest {
    game_id?: string;
    user_id?: string;
    reason?: string;
  }

  interface EraseDiscordRequest {
    discord_user_id?: string;
    reason?: string;
  }

  interface ConsentUpsertRequest {
    game_id?: string;
    user_id?: string;
    underage?: boolean;
    region?: string;
    analytics_consent?: boolean;
    personalization_consent?: boolean;
    marketing_consent?: boolean;
    push_consent?: boolean;
    set_at?: string;
    source?: string;
  }

  interface ConsentInvalidateRequest {
    game_id?: string;
    user_id?: string;
  }

  function aiSvcBase(ctx: nkruntime.Context, logger: nkruntime.Logger): string | null {
    var base = (ctx.env && ctx.env["IVX_AI_SVC_BASE_URL"]) || "";
    if (!base) {
      logger.warn("[QvPrivacy] IVX_AI_SVC_BASE_URL unset");
      return null;
    }
    return base.replace(/\/$/, "");
  }

  function computeHmac(
    ctx: nkruntime.Context,
    nk: nkruntime.Nakama,
    ts: string,
    path: string,
    body: string,
    logger: nkruntime.Logger,
  ): string {
    var secret = (ctx.env && ctx.env["IVX_INSIGHTS_SHARED_SECRET"]) || "";
    if (!secret) {
      logger.warn("[QvPrivacy] IVX_INSIGHTS_SHARED_SECRET unset");
      return "";
    }
    var msg = ts + ":" + path + ":" + body;
    try {
      var raw = nk.hmacSha256Hash(msg, secret);
      return nk.base16Encode(raw, false).toLowerCase();
    } catch (e: any) {
      logger.warn("[QvPrivacy] hmac compute failed: " + ((e && e.message) ? e.message : String(e)));
      return "";
    }
  }

  function postJson(
    ctx: nkruntime.Context,
    nk: nkruntime.Nakama,
    logger: nkruntime.Logger,
    path: string,
    body: string,
  ): string | null {
    var base = aiSvcBase(ctx, logger);
    if (!base) return null;
    var ts = String(Date.now());
    var basePath = base.replace(/^https?:\/\/[^/]+/, "");
    var sig = computeHmac(ctx, nk, ts, basePath + path, body, logger);
    if (!sig) return null;
    try {
      var resp = nk.httpRequest(base + path, "post", {
        "Content-Type": "application/json",
        "X-IVX-Service": "nakama",
        "X-IVX-Timestamp": ts,
        "X-IVX-Signature": sig,
      }, body, 4500);
      if (!resp || resp.code < 200 || resp.code >= 300) {
        logger.warn("[QvPrivacy] post " + path + " HTTP " + (resp ? resp.code : "no_resp"));
        return null;
      }
      return resp.body || "";
    } catch (e: any) {
      logger.warn("[QvPrivacy] post failed");
      return null;
    }
  }

  function rpcEraseUser(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string,
  ): string {
    var data: EraseUserRequest;
    try { data = JSON.parse(payload || "{}"); }
    catch (e: any) { return JSON.stringify({ ok: false, error: "invalid_json" }); }
    if (!data || !data.game_id || !data.user_id) {
      return JSON.stringify({ ok: false, error: "missing_required_fields" });
    }
    if (!ctx.userId) return JSON.stringify({ ok: false, error: "unauthenticated" });
    if (data.user_id !== ctx.userId) return JSON.stringify({ ok: false, error: "subject_mismatch" });
    if (!isQuizverse(data.game_id)) return JSON.stringify({ ok: false, error: "unsupported_game" });
    var body = JSON.stringify({
      gameId: "quizverse",
      userId: ctx.userId,
      reason: typeof data.reason === "string" ? data.reason.slice(0, 64) : "user_request",
    });
    var resp = postJson(ctx, nk, logger, "/privacy/erase", body);
    if (resp == null) return JSON.stringify({ ok: false, error: "ai_svc_unavailable" });
    try {
      var result = JSON.parse(resp);
      if (result.ok === true && result.cacheErasureVerified === true) return resp;
    } catch (_) {}
    return JSON.stringify({ ok: false, error: "ai_erasure_unverified", retryable: true });
  }

  // Explicit adapter aliases; no caller-selected collection or shared identity deletion.
  function isQuizverse(gameId: string): boolean {
    return gameId === "126bf539-dae2-4bcf-964d-316c0fa1f92b" ||
      gameId === "quizverse" || gameId === "quiz-verse";
  }

  function eraseQuizverseStorage(nk: nkruntime.Nakama, userId: string): void {
    var aliases = ["126bf539-dae2-4bcf-964d-316c0fa1f92b", "quizverse", "quiz-verse"];
    // Each collection below uses Constants.gameKey; unprefixed default keys are retained.
    var scoped = ["hiro_achievements", "hiro_inventory", "hiro_progression", "hiro_energy",
      "hiro_stats", "hiro_streaks", "hiro_tutorials", "hiro_unlockables", "hiro_mailbox"];
    var collections = scoped.slice();
    collections.push("qv_quests", "game_inventory");
    var ownedStart = collections.length;
    collections.push("qv_onboarding_profiles");
    for (var a = 0; a < aliases.length; a++) {
      // quizverse_depth writers: single-player, owner-scoped data only.
      var suffixes = ["_quiz_history", "_streak_quizzes", "_adaptive_difficulty", "_daily_puzzles", "_study_progress"];
      for (var s = 0; s < suffixes.length; s++) collections.push(aliases[a] + suffixes[s]);
    }
    for (var c = 0; c < collections.length; c++) {
      var cursor: string | undefined;
      var pages = 0;
      do {
        var page = nk.storageList(userId, collections[c], 100, cursor);
        var deletes: nkruntime.StorageDeleteRequest[] = [];
        for (var i = 0; i < page.objects.length; i++) {
          var row = page.objects[i];
          var owned = c >= ownedStart;
          for (var j = 0; j < aliases.length; j++) {
            if (c < scoped.length && row.key.indexOf(aliases[j] + ":") === 0) owned = true;
            if ((collections[c] === "qv_quests" || collections[c] === "game_inventory") && row.key === aliases[j] + "_" + userId) owned = true;
          }
          if (owned) deletes.push({ collection: collections[c], key: row.key, userId: userId, version: row.version });
        }
        if (deletes.length) nk.storageDelete(deletes);
        cursor = page.cursor;
        if (++pages >= 100 && cursor) throw new Error("storage_batch_limit");
      } while (cursor);
    }
  }

  function eraseQuizverseLeaderboards(nk: nkruntime.Nakama, userId: string): void {
    // quizverse_depth daily-puzzle writer uses exactly these game aliases.
    // Existing boards only: absent boards are already erased, not an error.
    var ids = ["quizverse_leaderboard", "126bf539-dae2-4bcf-964d-316c0fa1f92b_daily_puzzle_leaderboard",
      "quizverse_daily_puzzle_leaderboard", "quiz-verse_daily_puzzle_leaderboard"];
    var boards = nk.leaderboardsGetId(ids);
    for (var i = 0; i < boards.length; i++) nk.leaderboardRecordDelete(boards[i].id, userId);
  }

  function rpcEraseGame(ctx: nkruntime.Context, logger: nkruntime.Logger,
    nk: nkruntime.Nakama, payload: string): string {
    if (!ctx.userId) return JSON.stringify({ ok: false, error: "unauthenticated" });
    var data: any;
    try { data = JSON.parse(payload || "{}"); }
    catch (_) { return JSON.stringify({ ok: false, error: "invalid_json" }); }
    if (!data || typeof data !== "object" || Array.isArray(data)) return JSON.stringify({ ok: false, error: "invalid_payload" });
    if (data.confirmUserId !== ctx.userId) return JSON.stringify({ ok: false, error: "confirmation_mismatch" });
    if (!isQuizverse(data.gameId)) return JSON.stringify({ ok: false, error: "unsupported_game" });
    if (data.reason !== undefined && typeof data.reason !== "string") return JSON.stringify({ ok: false, error: "invalid_reason" });

    // Server-only CAS lease survives runtime/process loss. All following erasures
    // are idempotent, so an expired lease or partial result can safely be retried.
    var key = { collection: "privacy_game_erasure", key: "quizverse", userId: ctx.userId };
    var claimVersion: string;
    try {
      var prior = nk.storageRead([key]);
      if (prior.length && prior[0].value.leaseUntil > Date.now()) {
        return JSON.stringify({ ok: false, status: "in_progress", retryable: true, retryAfterSeconds: 120 });
      }
      var claim = nk.storageWrite([{
        collection: key.collection, key: key.key, userId: key.userId,
        version: prior.length ? prior[0].version : "*", permissionRead: 0, permissionWrite: 0,
        value: { status: "in_progress", leaseUntil: Date.now() + 120000 }
      }]);
      claimVersion = claim[0].version;
    } catch (_) { return JSON.stringify({ ok: false, error: "claim_unavailable", retryable: true }); }

    var subsystems = { ai: "failed", storage: "failed", leaderboards: "failed" };
    var response = postJson(ctx, nk, logger, "/privacy/erase", JSON.stringify({
      gameId: "quizverse", userId: ctx.userId, reason: (data.reason || "user_request").slice(0, 64)
    }));
    try {
      var ai = response && JSON.parse(response);
      if (ai && ai.ok === true && ai.cacheErasureVerified === true) subsystems.ai = "erased";
    } catch (_) {}
    try { eraseQuizverseStorage(nk, ctx.userId); subsystems.storage = "erased"; } catch (_) {}
    try { eraseQuizverseLeaderboards(nk, ctx.userId); subsystems.leaderboards = "erased"; } catch (_) {}
    var ok = subsystems.ai === "erased" && subsystems.storage === "erased" && subsystems.leaderboards === "erased";
    var result = { ok: ok, status: ok ? "completed" : "partial", retryable: !ok,
      gameId: "quizverse", scope: "audited_game_data", subsystems: subsystems,
      retained: ["shared_identity", "cognito", "wallets_and_financial_records", "discord",
        "legacy_unscoped_progress_and_profile", "shared_social_and_multiplayer_records", "historical_leaderboard_records", "system_owned_onboarding_analytics"] };
    try {
      nk.storageWrite([{ collection: key.collection, key: key.key, userId: key.userId,
        version: claimVersion, permissionRead: 0, permissionWrite: 0,
        value: { status: result.status, leaseUntil: 0, result: result } }]);
    } catch (_) {
      return JSON.stringify({ ok: false, status: "partial", error: "receipt_unavailable",
        retryable: true, retryAfterSeconds: 120, subsystems: subsystems });
    }
    return JSON.stringify(result);
  }

  function rpcEraseDiscord(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string,
  ): string {
    var data: EraseDiscordRequest;
    try { data = JSON.parse(payload || "{}"); }
    catch (e: any) { return JSON.stringify({ ok: false, error: "invalid_json" }); }
    if (!data.discord_user_id) {
      return JSON.stringify({ ok: false, error: "missing_required_fields" });
    }
    var body = JSON.stringify({
      discordUserId: data.discord_user_id,
      reason: data.reason || "user_request",
    });
    var resp = postJson(ctx, nk, logger, "/privacy/erase-discord", body);
    if (resp == null) return JSON.stringify({ ok: false, error: "ai_svc_unavailable" });
    return resp;
  }

  function rpcConsentUpsert(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string,
  ): string {
    var data: ConsentUpsertRequest;
    try { data = JSON.parse(payload || "{}"); }
    catch (e: any) { return JSON.stringify({ ok: false, error: "invalid_json" }); }
    if (!data.game_id || !data.user_id) {
      return JSON.stringify({ ok: false, error: "missing_required_fields" });
    }
    var body = JSON.stringify({
      gameId: data.game_id,
      userId: data.user_id,
      underage: !!data.underage,
      region: data.region || "OTHER",
      analyticsConsent: !!data.analytics_consent,
      personalizationConsent: !!data.personalization_consent,
      marketingConsent: !!data.marketing_consent,
      pushConsent: !!data.push_consent,
      setAt: data.set_at || new Date().toISOString(),
      source: data.source || "settings",
    });
    var resp = postJson(ctx, nk, logger, "/consent/upsert", body);
    if (resp == null) return JSON.stringify({ ok: false, error: "ai_svc_unavailable" });
    return resp;
  }

  function rpcConsentInvalidate(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string,
  ): string {
    var data: ConsentInvalidateRequest;
    try { data = JSON.parse(payload || "{}"); }
    catch (e: any) { return JSON.stringify({ ok: false, error: "invalid_json" }); }
    if (!data.game_id || !data.user_id) {
      return JSON.stringify({ ok: false, error: "missing_required_fields" });
    }
    var body = JSON.stringify({
      gameId: data.game_id,
      userId: data.user_id,
    });
    var resp = postJson(ctx, nk, logger, "/consent/invalidate", body);
    if (resp == null) return JSON.stringify({ ok: false, error: "ai_svc_unavailable" });
    return resp;
  }

  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("privacy_erase_game", rpcEraseGame);
    initializer.registerRpc("privacy_erase_user", rpcEraseUser);
    initializer.registerRpc("privacy_erase_discord", rpcEraseDiscord);
    initializer.registerRpc("consent_upsert", rpcConsentUpsert);
    initializer.registerRpc("consent_invalidate", rpcConsentInvalidate);
  }
}
