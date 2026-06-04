// entitlement.ts — Unified QuizVerse premium-entitlement source of truth.
//
// WHY THIS EXISTS
// ---------------
// Today "is this user premium?" has THREE disconnected answers:
//   1. Unity `StoreData` (PlayerPrefs, client-trust)
//   2. RevenueCat (web `/api/rc/entitlement`, keys library_plus / library_pro)
//   3. Nakama `hiro_iap_validate` (receipt audit only — no entitlement doc)
// Worse, the web ALREADY references three Nakama entitlement RPCs that were
// never implemented (verified absent from the bundle):
//   - `analytics.iap.event`        — RC webhook write   (web/app/api/rc/webhook/route.ts)
//   - `quizverse_rc_sync`          — Stripe webhook write(web/app/api/stripe/webhook/route.ts)
//   - `quizverse_get_entitlements` — web proxy read      (web/app/api/nakama/rpc/[id]/route.ts allow-list)
// So those calls are dead today. This module implements the names the web
// already expects, all backed by ONE storage document, so the existing
// webhooks + proxy light up with zero web renames.
//
// RPCs:
//   quizverse_get_entitlements   (auth)        → caller reads own entitlement.
//   quizverse_entitlement_get    (auth, alias) → same handler (Unity-friendly name).
//   analytics.iap.event          (http_key)    → RC webhook grant/revoke write.
//   quizverse_entitlement_set    (service tok) → generic upsert (Unity IAP-validate / admin).
//
// All write paths are SERVER-ONLY: a signed-in user session can never grant
// itself premium (the http_key/service-token RPCs reject calls that carry a
// ctx.userId). Storage is permissionWrite:0 so clients can't poke it directly.
namespace QuizVerseEntitlement {

  const COLLECTION = "qv_entitlements";
  const STATE_KEY = "active";

  // Reuse the already-wired learner-toolbelt service token by default (same
  // trust boundary: our own web/gateway backend). A dedicated
  // QV_ENTITLEMENT_SERVICE_TOKEN overrides it when present. Either must be in
  // RUNTIME_ENV_KEYS in docker-compose for ctx.env to see it.
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

  interface Entitlement {
    plus: boolean;
    pro: boolean;
    noAds: boolean;
    entitlements: string[]; // raw RC entitlement ids (faithful, future-proof)
    source: string;         // "revenuecat" | "stripe" | "iap" | "grant" | ""
    expiresAt: number;      // unix seconds; 0 = no expiry / not set
    updatedAt: number;      // unix seconds of last write
  }

  function nowSec(): number {
    return Math.floor(Date.now() / 1000);
  }

  function defaultEntitlement(): Entitlement {
    return { plus: false, pro: false, noAds: false, entitlements: [], source: "", expiresAt: 0, updatedAt: 0 };
  }

  function load(nk: nkruntime.Nakama, userId: string): { state: Entitlement; version: string | undefined } {
    try {
      var records = nk.storageRead([{ collection: COLLECTION, key: STATE_KEY, userId: userId }]);
      if (records && records.length > 0 && records[0].value) {
        var v = records[0].value as Partial<Entitlement>;
        var s = defaultEntitlement();
        if (typeof v.plus === "boolean") s.plus = v.plus;
        if (typeof v.pro === "boolean") s.pro = v.pro;
        if (typeof v.noAds === "boolean") s.noAds = v.noAds;
        if (v.entitlements && v.entitlements.length) s.entitlements = v.entitlements;
        if (typeof v.source === "string") s.source = v.source;
        if (typeof v.expiresAt === "number") s.expiresAt = v.expiresAt;
        if (typeof v.updatedAt === "number") s.updatedAt = v.updatedAt;
        return { state: s, version: records[0].version };
      }
    } catch (_) {
      // fall through to default
    }
    return { state: defaultEntitlement(), version: undefined };
  }

  function save(nk: nkruntime.Nakama, userId: string, state: Entitlement, version: string | undefined): void {
    var write: nkruntime.StorageWriteRequest = {
      collection: COLLECTION,
      key: STATE_KEY,
      userId: userId,
      value: state as any,
      permissionRead: 1,   // owner can read their own entitlement
      permissionWrite: 0,  // server-only writes — clients cannot self-grant
    };
    if (version) (write as any).version = version;
    nk.storageWrite([write]);
  }

  // A tier is only "active" if it's set AND not past its expiry.
  function isActive(state: Entitlement): boolean {
    var hasTier = state.plus || state.pro || state.noAds || state.entitlements.length > 0;
    if (!hasTier) return false;
    if (state.expiresAt > 0 && state.expiresAt < nowSec()) return false;
    return true;
  }

  function projection(state: Entitlement): any {
    var active = isActive(state);
    var expired = state.expiresAt > 0 && state.expiresAt < nowSec();
    return {
      // When expired, surface tiers as false so clients gate correctly without
      // us having to mutate storage on a read.
      plus: active && state.plus,
      pro: active && state.pro,
      noAds: active && state.noAds,
      entitlements: active ? state.entitlements : [],
      active: active,
      expired: expired,
      source: state.source,
      expiresAt: state.expiresAt,
      updatedAt: state.updatedAt,
    };
  }

  // Derive boolean tier flags from a list of RC/store entitlement ids.
  // pro implies plus; any subscription implies ad-free.
  function applyEntitlementIds(state: Entitlement, ids: string[]): void {
    state.entitlements = ids.slice(0);
    var pro = false, plus = false, noAds = false;
    for (var i = 0; i < ids.length; i++) {
      var id = ("" + ids[i]).toLowerCase();
      if (id.indexOf("pro") >= 0) { pro = true; plus = true; noAds = true; }
      else if (id.indexOf("plus") >= 0) { plus = true; noAds = true; }
      else if (id.indexOf("voyage") >= 0) { noAds = true; }
      else if (id.indexOf("noads") >= 0 || id.indexOf("no_ads") >= 0) { noAds = true; }
    }
    state.pro = pro;
    state.plus = plus;
    state.noAds = noAds;
  }

  // ─── Server-only write guard ─────────────────────────────────────────
  // The grant/sync RPCs are reached via http_key (server-to-server, no
  // ctx.userId). If a real user session somehow calls them, reject — nobody
  // can self-grant premium.
  function rejectIfUserSession(ctx: nkruntime.Context): string | null {
    if (ctx.userId) {
      return RpcHelpers.errorResponse("server-only RPC — not callable from a user session", 403);
    }
    return null;
  }

  // ─── RPC: quizverse_get_entitlements / quizverse_entitlement_get ─────
  // Auth required (caller reads their OWN entitlement).
  function rpcGet(ctx: nkruntime.Context, _logger: nkruntime.Logger, nk: nkruntime.Nakama, _payload: string): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var loaded = load(nk, userId);
    return RpcHelpers.successResponse(projection(loaded.state));
  }

  // ─── RPC: analytics.iap.event ────────────────────────────────────────
  // RevenueCat webhook write (http_key). Payload shape (from rc/webhook):
  //   { event_type, user_id, transaction_id, product_id, entitlement_ids[],
  //     expiration_at_ms, store, environment, status }
  function rpcIapEvent(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var blocked = rejectIfUserSession(ctx);
    if (blocked) return blocked;

    var data = RpcHelpers.parseRpcPayload(payload);
    var targetUserId = "" + (data.user_id || data.userId || data.app_user_id || "");
    if (!targetUserId) {
      return RpcHelpers.errorResponse("user_id required", 400);
    }

    var status = ("" + (data.status || "")).toLowerCase();
    var ids: string[] = (data.entitlement_ids && data.entitlement_ids.length) ? data.entitlement_ids : [];

    var loaded = load(nk, targetUserId);
    var s = loaded.state;
    s.source = "revenuecat";

    if (status === "expired") {
      // Revoke: clear tiers but keep the record for history/source.
      s.plus = false; s.pro = false; s.noAds = false; s.entitlements = [];
      s.expiresAt = nowSec();
    } else {
      // active / trial / cancelled / billing_issue / product_change → grant.
      // (cancelled & billing_issue stay active until expiresAt elapses.)
      if (ids.length) applyEntitlementIds(s, ids);
      var expMs = (typeof data.expiration_at_ms === "number") ? data.expiration_at_ms : 0;
      if (expMs > 0) s.expiresAt = Math.floor(expMs / 1000);
    }
    s.updatedAt = nowSec();

    try {
      save(nk, targetUserId, s, loaded.version);
    } catch (err: any) {
      logger.warn("[QuizVerseEntitlement] iap.event save failed for " + targetUserId + ": " + (err && err.message ? err.message : String(err)));
      return RpcHelpers.errorResponse("write failed", 500);
    }

    var result = projection(s);
    result.user_id = targetUserId;
    return RpcHelpers.successResponse(result);
  }

  // ─── RPC: quizverse_entitlement_set ──────────────────────────────────
  // Generic SERVICE-ONLY upsert (service_token). Used by Unity IAP-validate /
  // admin tooling. Payload:
  //   { service_token, user_id, plus?, pro?, noAds?, entitlements?[], source?, expiresAt? }
  function rpcSet(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = RpcHelpers.parseRpcPayload(payload);

    if (!isServiceCaller(ctx, data)) {
      return RpcHelpers.errorResponse("not authorised — entitlement_set is service-only", 403);
    }

    var targetUserId = "" + (data.user_id || data.userId || "");
    if (!targetUserId) {
      return RpcHelpers.errorResponse("user_id required", 400);
    }

    var loaded = load(nk, targetUserId);
    var s = loaded.state;

    // Only overwrite fields that were explicitly provided.
    if (data.entitlements && data.entitlements.length) applyEntitlementIds(s, data.entitlements);
    if (typeof data.plus === "boolean") s.plus = data.plus;
    if (typeof data.pro === "boolean") s.pro = data.pro;
    if (typeof data.noAds === "boolean") s.noAds = data.noAds;
    if (typeof data.source === "string") s.source = data.source;
    if (typeof data.expiresAt === "number" && isFinite(data.expiresAt)) {
      s.expiresAt = Math.floor(data.expiresAt);
    }
    s.updatedAt = nowSec();

    try {
      save(nk, targetUserId, s, loaded.version);
    } catch (err: any) {
      logger.warn("[QuizVerseEntitlement] set save failed for " + targetUserId + ": " + (err && err.message ? err.message : String(err)));
      return RpcHelpers.errorResponse("write failed", 500);
    }

    var result = projection(s);
    result.user_id = targetUserId;
    return RpcHelpers.successResponse(result);
  }

  // ─── Registration ────────────────────────────────────────────────────
  export function register(initializer: nkruntime.Initializer): void {
    // Reads (auth) — primary web-proxy name + Unity-friendly alias.
    initializer.registerRpc("quizverse_get_entitlements", RpcHelpers.withCleanAuthError(rpcGet));
    initializer.registerRpc("quizverse_entitlement_get", RpcHelpers.withCleanAuthError(rpcGet));
    // Writes — server-only.
    initializer.registerRpc("analytics.iap.event", rpcIapEvent);  // RC webhook
    initializer.registerRpc("quizverse_entitlement_set", rpcSet); // generic service upsert
  }
}
