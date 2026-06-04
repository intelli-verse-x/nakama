// entitlement.ts — Unified QuizVerse premium-entitlement source of truth.
//
// WHY THIS EXISTS
// ---------------
// The Unity client already ships `NakamaEntitlementCache` (Monetization/) which
// calls the `quizverse_get_entitlements` RPC on login + after every purchase and
// applies the result to StoreData. But that RPC was never implemented server-side
// (verified absent from the bundle), so the cache call always came back empty and
// silently fell through to the local PlayerPrefs cache. The web RC webhook
// likewise calls an unimplemented `analytics.iap.event` RPC to grant/revoke.
//
// This module implements BOTH names against ONE storage contract — the exact
// schema NakamaEntitlementCache.cs already parses — so a subscription bought on
// web (RC webhook → analytics.iap.event) is visible in the app on next refresh,
// and the app reads the same document. One ledger across web + Unity.
//
// STORAGE CONTRACT (collection `qv_entitlements`, server-only writes):
//   key "subscriptions": { tier, expiresAt?, productId }
//        tier ∈ pro | pro_plus | linkplay_pro | linkplay_proplus
//        expiresAt = ISO-8601 string (absent ⇒ lifetime)
//   key "consumables":   { aiVoiceCredits, voiceSessionsUsed }
//   key "one_time":      { inventorySlots, noAds, partyMode, microphone, examPacks[] }
//
// RPCs:
//   quizverse_get_entitlements  (auth)      → { success, data: { subscriptions,
//                                               consumables, one_time } }
//   quizverse_entitlement_get   (auth alias)→ same handler
//   analytics.iap.event         (http_key)  → RC webhook grant/revoke
//   quizverse_entitlement_set   (service)   → generic upsert (Unity IAP / admin)
//
// All write paths are SERVER-ONLY: http_key RPCs reject any call carrying a
// ctx.userId, and entitlement_set requires a service token — a user session can
// never self-grant. Storage is permissionWrite:0.
namespace QuizVerseEntitlement {

  const COLLECTION = "qv_entitlements";
  const KEY_SUBS = "subscriptions";
  const KEY_CONSUMABLES = "consumables";
  const KEY_ONE_TIME = "one_time";

  // Reuse the already-wired learner-toolbelt service token by default (same
  // trust boundary: our own web/gateway backend). QV_ENTITLEMENT_SERVICE_TOKEN
  // overrides it when present. Either must be in RUNTIME_ENV_KEYS for ctx.env.
  function serviceToken(ctx: nkruntime.Context): string {
    var dedicated = "" + ((ctx.env && ctx.env["QV_ENTITLEMENT_SERVICE_TOKEN"]) || "");
    if (dedicated.length > 0) return dedicated;
    return "" + ((ctx.env && ctx.env["LT_SERVICE_TOKEN"]) || "");
  }

  function isServiceCaller(ctx: nkruntime.Context, payload: any): boolean {
    var token = payload && payload.service_token;
    if (!token) return false;
    var expected = serviceToken(ctx);
    return expected.length > 0 && token === expected;
  }

  // The http_key grant/sync RPCs are reached server-to-server (no ctx.userId).
  // If a real user session calls them, reject — nobody self-grants premium.
  function rejectIfUserSession(ctx: nkruntime.Context): string | null {
    if (ctx.userId) {
      return RpcHelpers.errorResponse("server-only RPC — not callable from a user session", 403);
    }
    return null;
  }

  function readKey(nk: nkruntime.Nakama, userId: string, key: string): { value: any; version: string | undefined } {
    try {
      var records = nk.storageRead([{ collection: COLLECTION, key: key, userId: userId }]);
      if (records && records.length > 0 && records[0].value) {
        return { value: records[0].value, version: records[0].version };
      }
    } catch (_) { /* fall through */ }
    return { value: null, version: undefined };
  }

  function writeKey(nk: nkruntime.Nakama, userId: string, key: string, value: any, version: string | undefined): void {
    var write: nkruntime.StorageWriteRequest = {
      collection: COLLECTION,
      key: key,
      userId: userId,
      value: value,
      permissionRead: 1,   // owner can read their own entitlement
      permissionWrite: 0,  // server-only writes — clients cannot self-grant
    };
    if (version) (write as any).version = version;
    nk.storageWrite([write]);
  }

  // ─── RPC: quizverse_get_entitlements / quizverse_entitlement_get ─────
  // Auth required. Aggregates the three storage keys into the single envelope
  // NakamaEntitlementCache.RefreshAsync() parses (data.subscriptions /
  // .consumables / .one_time).
  function rpcGet(ctx: nkruntime.Context, _logger: nkruntime.Logger, nk: nkruntime.Nakama, _payload: string): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var subs = readKey(nk, userId, KEY_SUBS).value;
    var consumables = readKey(nk, userId, KEY_CONSUMABLES).value;
    var oneTime = readKey(nk, userId, KEY_ONE_TIME).value;

    return RpcHelpers.successResponse({
      // The cache reads each as a JSON string via .ToString(); returning the
      // objects (or {} when unset) keeps the envelope faithful and null-safe.
      subscriptions: subs || {},
      consumables: consumables || { aiVoiceCredits: 0, voiceSessionsUsed: 0 },
      one_time: oneTime || {},
    });
  }

  // Map a RevenueCat / store entitlement id to the cache's subscription tier.
  // Higher-priority tiers win when several ids are present. Returns "" for ids
  // that are not subscription tiers (e.g. no_ads handled separately).
  function tierRank(tier: string): number {
    switch (tier) {
      case "pro_plus": return 4;
      case "pro": return 3;
      case "linkplay_proplus": return 2;
      case "linkplay_pro": return 1;
      default: return 0;
    }
  }

  function tierFromEntitlementId(id: string): string {
    var s = ("" + id).toLowerCase();
    if (s.indexOf("linkplay") >= 0 || s.indexOf("lap") >= 0) {
      return (s.indexOf("plus") >= 0) ? "linkplay_proplus" : "linkplay_pro";
    }
    if (s.indexOf("plus") >= 0) return "pro_plus";          // pro_plus / proplus / library_proplus
    if (s.indexOf("pro") >= 0) return "pro";                // pro / library_pro
    return ""; // no_ads / voyage / library_plus / unknown — not a cache tier
  }

  function highestTier(ids: string[]): string {
    var best = "";
    for (var i = 0; i < ids.length; i++) {
      var t = tierFromEntitlementId(ids[i]);
      if (tierRank(t) > tierRank(best)) best = t;
    }
    return best;
  }

  function hasNoAdsId(ids: string[]): boolean {
    for (var i = 0; i < ids.length; i++) {
      var s = ("" + ids[i]).toLowerCase();
      if (s.indexOf("no_ads") >= 0 || s.indexOf("noads") >= 0) return true;
    }
    return false;
  }

  // ─── RPC: analytics.iap.event ────────────────────────────────────────
  // RevenueCat webhook write (http_key). Payload (from web rc/webhook):
  //   { event_type, user_id, transaction_id, product_id, entitlement_ids[],
  //     expiration_at_ms, store, environment, status }
  function rpcIapEvent(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var blocked = rejectIfUserSession(ctx);
    if (blocked) return blocked;

    var data = RpcHelpers.parseRpcPayload(payload);
    var userId = "" + (data.user_id || data.userId || data.app_user_id || "");
    if (!userId) return RpcHelpers.errorResponse("user_id required", 400);

    var status = ("" + (data.status || "")).toLowerCase();
    var ids: string[] = (data.entitlement_ids && data.entitlement_ids.length) ? data.entitlement_ids : [];
    var productId = "" + (data.product_id || "");

    try {
      if (status === "expired") {
        // Revoke the subscription record; the cache treats an expired/empty
        // subscription as "no access" and clears StoreData accordingly.
        var subsRec = readKey(nk, userId, KEY_SUBS);
        writeKey(nk, userId, KEY_SUBS, {
          tier: "",
          expiresAt: new Date().toISOString(),
          productId: productId,
        }, subsRec.version);
      } else {
        // active / trial / cancelled / billing_issue / product_change → grant.
        var tier = highestTier(ids);
        if (tier) {
          var rec = readKey(nk, userId, KEY_SUBS);
          var subValue: any = { tier: tier, productId: productId };
          var expMs = (typeof data.expiration_at_ms === "number") ? data.expiration_at_ms : 0;
          if (expMs > 0) subValue.expiresAt = new Date(expMs).toISOString();
          writeKey(nk, userId, KEY_SUBS, subValue, rec.version);
        }
        if (hasNoAdsId(ids)) {
          var otRec = readKey(nk, userId, KEY_ONE_TIME);
          var ot = otRec.value || {};
          ot.noAds = true;
          writeKey(nk, userId, KEY_ONE_TIME, ot, otRec.version);
        }
      }
    } catch (err: any) {
      logger.warn("[QuizVerseEntitlement] iap.event write failed for " + userId + ": " + (err && err.message ? err.message : String(err)));
      return RpcHelpers.errorResponse("write failed", 500);
    }

    return RpcHelpers.successResponse({ user_id: userId, status: status, tier: highestTier(ids) });
  }

  // ─── RPC: quizverse_entitlement_set ──────────────────────────────────
  // Generic SERVICE-ONLY upsert (service_token). For Unity IAP-validate / admin
  // tooling. Payload (any subset):
  //   { service_token, user_id, subscriptions?{}, consumables?{}, one_time?{} }
  function rpcSet(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!isServiceCaller(ctx, data)) {
      return RpcHelpers.errorResponse("not authorised — entitlement_set is service-only", 403);
    }
    var userId = "" + (data.user_id || data.userId || "");
    if (!userId) return RpcHelpers.errorResponse("user_id required", 400);

    try {
      if (data.subscriptions && typeof data.subscriptions === "object") {
        var s = readKey(nk, userId, KEY_SUBS);
        writeKey(nk, userId, KEY_SUBS, data.subscriptions, s.version);
      }
      if (data.consumables && typeof data.consumables === "object") {
        var c = readKey(nk, userId, KEY_CONSUMABLES);
        writeKey(nk, userId, KEY_CONSUMABLES, data.consumables, c.version);
      }
      if (data.one_time && typeof data.one_time === "object") {
        var o = readKey(nk, userId, KEY_ONE_TIME);
        writeKey(nk, userId, KEY_ONE_TIME, data.one_time, o.version);
      }
    } catch (err: any) {
      logger.warn("[QuizVerseEntitlement] set write failed for " + userId + ": " + (err && err.message ? err.message : String(err)));
      return RpcHelpers.errorResponse("write failed", 500);
    }

    return RpcHelpers.successResponse({ user_id: userId, updated: true });
  }

  // ─── Registration ────────────────────────────────────────────────────
  export function register(initializer: nkruntime.Initializer): void {
    // Reads (auth) — name the Unity NakamaEntitlementCache already calls + alias.
    initializer.registerRpc("quizverse_get_entitlements", RpcHelpers.withCleanAuthError(rpcGet));
    initializer.registerRpc("quizverse_entitlement_get", RpcHelpers.withCleanAuthError(rpcGet));
    // Writes — server-only.
    initializer.registerRpc("analytics.iap.event", rpcIapEvent);  // RC webhook
    initializer.registerRpc("quizverse_entitlement_set", rpcSet); // generic service upsert
  }
}
