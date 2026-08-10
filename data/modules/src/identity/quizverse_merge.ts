// =============================================================================
// quizverse_merge.ts — QuizVerse guest (device account) → registered merge
//
// Companion to account_merge.ts (which is service-only + tournament-scoped).
// This RPC is the MOBILE path (Flutter W2-5, design: quiz-verse-flutter
// docs/engineering/40): the app has no server-side signup callback, so the
// client calls this RPC directly — with the GHOST's device session.
//
// Auth model (safe user-callable):
//   - Caller must BE the ghost: ctx.userId === payload.ghost_user_id. Only the
//     device holding the ghost session can merge that ghost away.
//   - OR a platform service token (web cognito-callback parity).
//   - Destination must exist and differ from the ghost.
//
// What moves (the QuizVerse game state account_merge.ts does NOT cover):
//   - wallets (sum-merge currencies+items, per-currency fraud cap, zero ghost)
//   - hiro_progression / hiro_streaks / hiro_stats / hiro_inventory /
//     hiro_achievements (copy-if-absent — destination keeps its own state)
//   - daily_rewards, qv_seen, qv_quests, badges, characters (copy-if-absent)
// Leaderboard records are owner-immutable → NOT ported (accepted, logged).
//
// Idempotency: merge_idem_{ghost}_{cognito} (same pattern as account_merge).
// Sentinel: ghost account metadata { merged_to } blocks reuse (E6).
// =============================================================================

namespace QuizverseMerge {

  const MERGE_LOG_COLLECTION = "account_merge_log";

  // Fraud cap (WC/Phase-3 hardening baked in): a single merge can move at most
  // this much of any one currency. Genuine guests never approach it.
  const MAX_MERGE_PER_CURRENCY = 100000;

  // Copy-if-absent collections (destination's own state always wins).
  const PORT_COLLECTIONS = [
    Constants.HIRO_PROGRESSION_COLLECTION,
    Constants.HIRO_STREAKS_COLLECTION,
    Constants.HIRO_STATS_COLLECTION,
    Constants.HIRO_INVENTORY_COLLECTION,
    Constants.HIRO_ACHIEVEMENTS_COLLECTION,
    Constants.DAILY_REWARDS_COLLECTION,
    "qv_seen",
    "qv_quests",
    "badges",
    "characters",
  ];

  function isServiceCaller(ctx: nkruntime.Context, payload: any): boolean {
    var token = payload && payload.service_token;
    if (!token) return false;
    var e = ctx.env || ({} as { [k: string]: string });
    var candidates = [
      "" + (e["ACCOUNT_MERGE_SERVICE_TOKEN"] || ""),
      "" + (e["BRAIN_COINS_SERVICE_TOKEN"] || ""),
      "" + (e["TOURNAMENT_SERVICE_TOKEN"] || ""),
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (candidates[i].length > 0 && token === candidates[i]) return true;
    }
    return false;
  }

  function nowSec(): number { return Math.floor(Date.now() / 1000); }

  interface WalletDoc {
    userId: string;
    currencies: { [k: string]: number };
    items: { [k: string]: number };
  }

  function readWallet(nk: nkruntime.Nakama, userId: string, key: string): WalletDoc {
    try {
      var rows = nk.storageRead([{ collection: Constants.WALLETS_COLLECTION, key: key, userId: userId }]);
      if (rows && rows.length > 0) {
        var v = rows[0].value as any;
        return {
          userId: userId,
          currencies: v.currencies || {},
          items: v.items || {},
        };
      }
    } catch (_) { }
    return { userId: userId, currencies: {}, items: {} };
  }

  function writeWallet(nk: nkruntime.Nakama, userId: string, key: string, w: WalletDoc): void {
    nk.storageWrite([{
      collection: Constants.WALLETS_COLLECTION,
      key: key,
      userId: userId,
      value: w,
      permissionRead: 1,
      permissionWrite: 0,
    }]);
  }

  // Sum-merge every wallet doc (global + per-game) ghost → destination.
  // Per-currency cap, source zeroed (double-merge can't double-credit).
  function mergeWallets(nk: nkruntime.Nakama, fromUserId: string, toUserId: string): { [k: string]: number } {
    var moved: { [k: string]: number } = {};
    var cursor = "";
    var safety = 0;
    while (safety < 20) {
      safety++;
      var page = nk.storageList(fromUserId, Constants.WALLETS_COLLECTION, 100, cursor);
      if (!page || !page.objects) break;
      for (var i = 0; i < page.objects.length; i++) {
        var o = page.objects[i];
        try {
          // Wallet doc keys embed the owner (global_{userId} etc.) — translate
          // the key suffix to the destination user, or the merge would write a
          // ghost-keyed doc under the destination instead of merging balances
          // (caught by quizverse_merge_regression_test B1).
          var destKey = o.key;
          // Suffix is the bare userId (the '_' separator belongs to the key
          // template: 'global_' + userId) — stripping it too loses the
          // separator ('globalcognito-…', caught by the regression test).
          var suffix = fromUserId;
          if (destKey.length > suffix.length &&
              destKey.lastIndexOf(suffix) === destKey.length - suffix.length) {
            destKey = destKey.slice(0, destKey.length - suffix.length) + toUserId;
          }
          var src = readWallet(nk, fromUserId, o.key);
          var dst = readWallet(nk, toUserId, destKey);
          var currencies = dst.currencies;
          var srcKeys = Object.keys(src.currencies);
          for (var c = 0; c < srcKeys.length; c++) {
            var cur = srcKeys[c];
            var amt = src.currencies[cur] | 0;
            if (amt <= 0) continue;
            if (amt > MAX_MERGE_PER_CURRENCY) amt = MAX_MERGE_PER_CURRENCY;
            currencies[cur] = ((currencies[cur] | 0) + amt);
            moved[cur] = (moved[cur] | 0) + amt;
          }
          var itemKeys = Object.keys(src.items);
          for (var it = 0; it < itemKeys.length; it++) {
            var ik = itemKeys[it];
            dst.items[ik] = ((dst.items[ik] | 0) + (src.items[ik] | 0));
          }
          writeWallet(nk, toUserId, destKey, dst);
          // Zero the ghost doc (keep shape; audit sentinel).
          writeWallet(nk, fromUserId, o.key, {
            userId: fromUserId,
            currencies: { merged_to: 0 } as any,
            items: {},
          });
        } catch (_) { /* best-effort per doc */ }
      }
      if (!page.cursor) break;
      cursor = page.cursor;
    }
    return moved;
  }

  // Copy-if-absent port (account_merge.ts pattern): destination never
  // overwritten; retry-safe because existing rows are skipped.
  function portCollection(nk: nkruntime.Nakama, collection: string, fromUserId: string, toUserId: string): number {
    var ported = 0;
    var cursor = "";
    var safety = 0;
    while (safety < 20) {
      safety++;
      var page;
      try {
        page = nk.storageList(fromUserId, collection, 100, cursor);
      } catch (_) {
        break; // collection may not exist for this game — not an error
      }
      if (!page || !page.objects) break;
      for (var i = 0; i < page.objects.length; i++) {
        var o = page.objects[i];
        try {
          var existing = nk.storageRead([{ collection: collection, key: o.key, userId: toUserId }]);
          if (existing && existing.length > 0) continue;
          nk.storageWrite([{
            collection: collection,
            key: o.key,
            userId: toUserId,
            value: o.value,
            permissionRead: 1,
            permissionWrite: 0,
          }]);
          ported++;
        } catch (_) { /* best-effort */ }
      }
      if (!page.cursor) break;
      cursor = page.cursor;
    }
    return ported;
  }

  // ── RPC: quizverse_merge_guest_to_account ─────────────────────────────────
  function rpcMerge(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    try {
      var data = RpcHelpers.parseRpcPayload(payload);
      var ghostUserId = "" + (data.ghost_user_id || "");
      var cognitoUserId = "" + (data.cognito_user_id || "");
      if (!ghostUserId || !cognitoUserId) {
        return RpcHelpers.errorResponse("ghost_user_id + cognito_user_id required", 400);
      }
      if (ghostUserId === cognitoUserId) {
        return RpcHelpers.errorResponse("ghost and cognito user_id are identical — nothing to merge", 400);
      }

      // AUTH: caller must BE the ghost (mobile path) or a platform service
      // (web path). Never trust a client-supplied ghost id from another session.
      var service = isServiceCaller(ctx, data);
      if (!service) {
        if (!ctx.userId) {
          return RpcHelpers.errorResponse("not authorised — login required", 401);
        }
        if (ctx.userId !== ghostUserId) {
          logger.warn("[QvMerge] REJECTED: caller " + ctx.userId + " tried to merge ghost " + ghostUserId);
          return RpcHelpers.errorResponse("not authorised — you can only merge your own guest account", 403);
        }
      }

      // Destination must exist.
      try {
        nk.accountGetId(cognitoUserId);
      } catch (_) {
        return RpcHelpers.errorResponse("destination account not found", 404);
      }

      // Idempotency: merged pair returns the cached result.
      var idemKey = "merge_idem_" + ghostUserId + "_" + cognitoUserId;
      try {
        var prior = nk.storageRead([{ collection: MERGE_LOG_COLLECTION, key: idemKey, userId: Constants.SYSTEM_USER_ID }]);
        if (prior && prior.length > 0) {
          return RpcHelpers.successResponse({ ok: true, idempotent: true, prior_merge: prior[0].value });
        }
      } catch (_) { }

      // Ghost sentinel: an already-merged ghost refuses a second merge (E6).
      try {
        var ghostAcc = nk.accountGetId(ghostUserId);
        var meta = (ghostAcc && (ghostAcc as any).user && (ghostAcc as any).user.metadata) || {};
        if ((meta as any).merged_to) {
          return RpcHelpers.errorResponse("guest account already merged", 409);
        }
      } catch (_) { }

      // Execute: wallets sum-merged (capped), game state copy-if-absent.
      var movedCurrencies = mergeWallets(nk, ghostUserId, cognitoUserId);
      var ported: { [k: string]: number } = {};
      for (var i = 0; i < PORT_COLLECTIONS.length; i++) {
        ported[PORT_COLLECTIONS[i]] = portCollection(nk, PORT_COLLECTIONS[i], ghostUserId, cognitoUserId);
      }

      var summary = {
        ghost_user_id: ghostUserId,
        cognito_user_id: cognitoUserId,
        merged_at: nowSec(),
        caller: service ? "service" : "ghost_session",
        transferred: { currencies: movedCurrencies, collections: ported },
        leaderboard_records: "not_ported_owner_immutable",
      };
      nk.storageWrite([{
        collection: MERGE_LOG_COLLECTION,
        key: idemKey,
        userId: Constants.SYSTEM_USER_ID,
        value: summary,
        permissionRead: 0,
        permissionWrite: 0,
      }]);

      try {
        nk.accountUpdateId(ghostUserId, undefined, undefined, undefined, undefined, undefined, undefined,
          { is_ghost: true, merged_to: cognitoUserId, merged_at: nowSec() });
      } catch (e) {
        logger.warn("[QvMerge] could not update ghost metadata: " + (e as any).message);
      }

      logger.info("[QvMerge] merged ghost " + ghostUserId + " → " + cognitoUserId);
      return RpcHelpers.successResponse({ ok: true, idempotent: false, transferred: summary.transferred });

    } catch (err: any) {
      var msg = err && err.message ? err.message : String(err);
      logger.error("[QvMerge] failed: " + msg);
      RpcHelpers.logRpcError(nk, logger, "quizverse_merge_guest_to_account", msg);
      return RpcHelpers.errorResponse("merge failed: " + msg, 500);
    }
  }

  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("quizverse_merge_guest_to_account", rpcMerge);
  }
}
