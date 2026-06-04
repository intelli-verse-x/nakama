// entitlement.ts — Unified QuizVerse premium-entitlement source of truth.
//
// WHY THIS EXISTS
// ---------------
// Today "is this user premium?" has THREE disconnected answers:
//   1. Unity `StoreData` (PlayerPrefs, client-trust)
//   2. RevenueCat (web `/api/rc/entitlement`, keys library_plus / library_pro)
//   3. Nakama `hiro_iap_validate` (receipt audit only — no entitlement doc)
// There is no server-side document both web AND Unity can read to agree on the
// user's tier. This module adds that ONE document + a read RPC (for clients)
// and a write RPC (for the RevenueCat webhook / IAP-validate path).
//
// RPCs:
//   quizverse_entitlement_get → read the caller's entitlement (auth required).
//                               Returns { plus, pro, noAds, active, source,
//                               expiresAt, updatedAt }. `active` already factors
//                               in expiry, so clients can gate on it directly.
//   quizverse_entitlement_set → upsert a user's entitlement. SERVICE-ONLY:
//                               requires service_token === ctx.env token (the
//                               RC webhook / gateway calls this). A signed-in
//                               user can NEVER grant themselves premium.
//
// Storage: collection `qv_entitlements`, key `active`, ONE record per user,
// server-only writes (permissionWrite: 0) so the value is tamper-proof.
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
    source: string;     // "revenuecat" | "iap" | "grant" | ""
    expiresAt: number;  // unix seconds; 0 = no expiry / not set
    updatedAt: number;  // unix seconds of last write
  }

  function nowSec(): number {
    return Math.floor(Date.now() / 1000);
  }

  function defaultEntitlement(): Entitlement {
    return { plus: false, pro: false, noAds: false, source: "", expiresAt: 0, updatedAt: 0 };
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
    var hasTier = state.plus || state.pro || state.noAds;
    if (!hasTier) return false;
    if (state.expiresAt > 0 && state.expiresAt < nowSec()) return false;
    return true;
  }

  function projection(state: Entitlement): any {
    var active = isActive(state);
    var expired = state.expiresAt > 0 && state.expiresAt < nowSec();
    return {
      // When expired, surface the tiers as false so clients gate correctly
      // without us having to mutate storage on a read.
      plus: active && state.plus,
      pro: active && state.pro,
      noAds: active && state.noAds,
      active: active,
      expired: expired,
      source: state.source,
      expiresAt: state.expiresAt,
      updatedAt: state.updatedAt,
    };
  }

  // ─── RPC: quizverse_entitlement_get ──────────────────────────────────
  // Auth required (the caller reads their OWN entitlement).
  function rpcGet(ctx: nkruntime.Context, _logger: nkruntime.Logger, nk: nkruntime.Nakama, _payload: string): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var loaded = load(nk, userId);
    return RpcHelpers.successResponse(projection(loaded.state));
  }

  // ─── RPC: quizverse_entitlement_set ──────────────────────────────────
  // SERVICE-ONLY upsert. Called by the RevenueCat webhook / IAP-validate path
  // with { service_token, user_id, plus?, pro?, noAds?, source?, expiresAt? }.
  // A signed-in user (no service_token) is rejected so nobody can self-grant.
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

    // Only overwrite fields that were explicitly provided, so a webhook that
    // only flips one flag doesn't clobber the rest.
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
    initializer.registerRpc("quizverse_entitlement_get", RpcHelpers.withCleanAuthError(rpcGet));
    initializer.registerRpc("quizverse_entitlement_set", rpcSet);
  }
}
