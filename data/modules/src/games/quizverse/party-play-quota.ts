// ---------------------------------------------------------------------------
// party-play-quota.ts — server-authoritative Party & Trivia daily play quota.
//
// QVBF_345: the free-play limit used to live only in device-local PlayerPrefs,
// so the same account could bypass it by logging into another device (or
// reinstalling). This RPC is the single source of truth, keyed by userId.
//
// Free: 1 play per UTC day. Pro / Pro+ / Plus subscription, VIP allow-list,
// or the one-time Party Mode pack (qv_entitlements one_time.partyMode):
// unlimited. Reset boundary: 00:00 UTC.
//
// Contract (mirrors lap-note-quota.ts):
//   payload  {"action":"status"}  → never writes
//   payload  {"action":"consume"} → increments used, OCC conditional write;
//                                   at limit → allowed:false (HTTP 200, never throw)
//   response {"success":true,"data":{allowed,tier,limit,unlimited,used,
//             remaining,date,resetAt}}  (limit/remaining null when unlimited)
// ---------------------------------------------------------------------------

namespace QvPartyPlayQuota {
  var COLLECTION = "qv_party_daily_quota";
  var KEY_PREFIX = "plays_";
  var OCC_MAX_RETRIES = 4;
  var PARTY_FREE_PLAYS_PER_DAY = 1;

  interface QuotaState {
    date: string;
    used: number;
    updatedAt: string;
  }

  interface StoredQuota {
    value: QuotaState;
    version: string;
    exists: boolean;
  }

  function utcDate(now: Date): string {
    return now.toISOString().slice(0, 10);
  }

  function nextUtcReset(now: Date): string {
    return new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0,
      0,
      0
    )).toISOString();
  }

  function quotaKey(date: string): string {
    return KEY_PREFIX + date;
  }

  // Local copy of the lap-note-quota tier resolver (each quota module owns
  // its own policy), extended with the one-time Party Mode pack check.
  function subscriptionTier(nk: nkruntime.Nakama, userId: string, nowMs: number): string {
    // VIP Layer 0 — unlimited plays for hard-coded QA allow-list.
    if (QvVipOverride.isVipUserId(userId)) return "pro_plus";

    var rows = nk.storageRead([{
      collection: "qv_entitlements",
      key: "subscriptions",
      userId: userId
    }]);
    if (!rows || rows.length === 0 || !rows[0].value) return "free";

    var subs: any = rows[0].value;
    var tier = String(subs.tier || "").toLowerCase();
    var status = String(subs.status || "active").toLowerCase();
    if (!tier || status === "expired" || status === "revoked" || status === "inactive") {
      return "free";
    }
    if (subs.expiresAt) {
      var expiryMs = new Date(subs.expiresAt).getTime();
      if (!isNaN(expiryMs) && expiryMs <= nowMs) return "free";
    }
    return tier;
  }

  function hasPartyModePack(nk: nkruntime.Nakama, userId: string): boolean {
    var rows = nk.storageRead([{
      collection: "qv_entitlements",
      key: "one_time",
      userId: userId
    }]);
    if (!rows || rows.length === 0 || !rows[0].value) return false;
    var oneTime: any = rows[0].value;
    return oneTime.partyMode === true;
  }

  // -1 = unlimited.
  function limitForTier(tier: string): number {
    if (tier === "pro_plus" || tier === "pro" || tier === "plus") return -1;
    return PARTY_FREE_PLAYS_PER_DAY;
  }

  function readQuota(
    nk: nkruntime.Nakama,
    userId: string,
    date: string
  ): StoredQuota {
    var rows = nk.storageRead([{
      collection: COLLECTION,
      key: quotaKey(date),
      userId: userId
    }]);
    if (!rows || rows.length === 0) {
      return {
        value: { date: date, used: 0, updatedAt: new Date().toISOString() },
        version: "*",
        exists: false
      };
    }
    var value: any = rows[0].value || {};
    return {
      value: {
        date: date,
        used: Math.max(0, Number(value.used) || 0),
        updatedAt: String(value.updatedAt || "")
      },
      version: rows[0].version || "",
      exists: true
    };
  }

  function writeQuota(
    nk: nkruntime.Nakama,
    userId: string,
    stored: StoredQuota
  ): void {
    stored.value.updatedAt = new Date().toISOString();
    nk.storageWrite([{
      collection: COLLECTION,
      key: quotaKey(stored.value.date),
      userId: userId,
      value: stored.value as any,
      version: stored.exists ? stored.version : "*",
      permissionRead: 1,
      permissionWrite: 0
    }]);
  }

  function response(
    state: QuotaState,
    tier: string,
    limit: number,
    resetAt: string,
    allowed?: boolean
  ): string {
    return RpcHelpers.successResponse({
      allowed: allowed !== false,
      tier: tier,
      limit: limit < 0 ? null : limit,
      unlimited: limit < 0,
      used: state.used,
      remaining: limit < 0 ? null : Math.max(0, limit - state.used),
      date: state.date,
      resetAt: resetAt
    });
  }

  function rpcPartyPlayQuota(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string
  ): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload) || {};
    var action = String(data.action || "status").toLowerCase();

    if (action !== "status" && action !== "consume") {
      return RpcHelpers.errorResponse("action must be status or consume");
    }

    var now = new Date();
    var date = utcDate(now);
    var tier = subscriptionTier(nk, userId, now.getTime());
    var limit = limitForTier(tier);
    if (limit >= 0 && hasPartyModePack(nk, userId)) {
      limit = -1;
    }
    var resetAt = nextUtcReset(now);

    if (limit < 0) {
      // Unlimited access — never consume, storage untouched.
      return response(readQuota(nk, userId, date).value, tier, limit, resetAt, true);
    }

    if (action === "status") {
      // allowed must reflect whether a play is still available today —
      // otherwise the client's non-consuming pre-check always passes.
      var current = readQuota(nk, userId, date).value;
      return response(current, tier, limit, resetAt, current.used < limit);
    }

    // consume — OCC loop: two devices racing for the last slot serialize on
    // the storage version; exactly one write wins per version.
    var lastError: any = null;
    for (var attempt = 0; attempt < OCC_MAX_RETRIES; attempt++) {
      var stored = readQuota(nk, userId, date);
      var state = stored.value;

      if (state.used >= limit) {
        // Business denial, not an error — HTTP 200 with allowed:false.
        return response(state, tier, limit, resetAt, false);
      }
      state.used += 1;

      try {
        writeQuota(nk, userId, stored);
        return response(state, tier, limit, resetAt, true);
      } catch (err: any) {
        lastError = err;
      }
    }

    logger.error("[QvPartyPlayQuota] OCC exhausted user=" + userId);
    throw lastError || new Error("party_play_quota_contention");
  }

  export function register(initializer: nkruntime.Initializer): void {
    // withCleanAuthError wraps a handler once at registration time. When
    // register() is auto-invoked at IIFE scope by the postbuild script,
    // RpcHelpers may not be initialised yet (games/* IIFEs run before
    // shared/*). Lazy wrapper defers the wrapping to first-call time so
    // anonymous callers still get a clean 401-style JSON instead of a Goja
    // stack trace.
    type StrictRpc = (ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string) => string;
    function auth(fn: nkruntime.RpcFunction): nkruntime.RpcFunction {
      var wrapped: StrictRpc | null = null;
      return function (ctx, logger, nk, payload): string {
        if (!wrapped) {
          const strictFn = fn as StrictRpc;
          wrapped = (typeof RpcHelpers !== "undefined" && RpcHelpers.withCleanAuthError)
            ? RpcHelpers.withCleanAuthError(strictFn)
            : strictFn;
        }
        return wrapped(ctx, logger, nk, payload);
      };
    }
    initializer.registerRpc("quizverse_party_play_quota", auth(rpcPartyPlayQuota));
  }
}
