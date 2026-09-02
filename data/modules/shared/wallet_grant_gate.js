/**
 * wallet_grant_gate.js — Fail-closed guards before nk.walletUpdate mints currency.
 *
 * Used by ad-reward RPCs, quests bridge, cross-game, and other economy paths.
 * Loaded as a discovered module (merged by postbuild.js into index.js).
 */
var WalletGrantGate = (function () {
    var AD_TOKEN_COLLECTION = "rewarded_ad_tokens";
    var LEDGER_COLLECTION = "wallet_grant_gate";
    var LEDGER_KEY = "promo_ledger";
    var YOUNG_ACCOUNT_SECONDS = 172800; // 48h
    var YOUNG_ACCOUNT_DAILY_CAP = 100; // promo coins per UTC day for accounts < 48h

    function utcDay() {
        return new Date().toISOString().slice(0, 10);
    }

    function rejectResponse(errorCode, error, extra) {
        var o = { success: false, error: error, errorCode: errorCode };
        if (extra) {
            for (var k in extra) {
                if (extra.hasOwnProperty(k)) o[k] = extra[k];
            }
        }
        return JSON.stringify(o);
    }

    function accountCreateTimeSec(nk, userId) {
        try {
            var accs = nk.accountsGetId([userId]);
            if (accs && accs.length > 0 && accs[0].user && accs[0].user.createTime) {
                return Math.floor(accs[0].user.createTime / 1000);
            }
        } catch (_) { /* fall through */ }
        return 0;
    }

    function accountAgeSeconds(nk, userId) {
        var ct = accountCreateTimeSec(nk, userId);
        if (!ct) return 999999999;
        return Math.floor(Date.now() / 1000) - ct;
    }

    function isServiceContext(ctx) {
        return !ctx.userId;
    }

    /**
     * Session-authenticated callers must never mint with client-supplied amounts.
     * Returns JSON error string, or null if allowed (service/http_key context).
     */
    function rejectSessionClientMint(ctx, rpcName) {
        if (ctx.userId) {
            return rejectResponse(
                "CLIENT_MINT_FORBIDDEN",
                "Authenticated clients cannot self-credit wallets via " + rpcName,
                { http_status: 403 }
            );
        }
        return null;
    }

    function readAdToken(nk, userId, token) {
        if (!token) return null;
        try {
            var recs = nk.storageRead([{
                collection: AD_TOKEN_COLLECTION,
                key: token,
                userId: userId
            }]);
            if (recs && recs.length > 0) return recs[0].value;
        } catch (_) { /* fall through */ }
        return null;
    }

    /**
     * Fail-closed ad verification: requires a rewarded_ad_request_token that is
     * valid, owned, unexpired, and consumed inline (or consumed within 120s).
     */
    function assertAdGrantAuthorized(nk, userId, token, placement, logger) {
        if (!token) {
            return {
                ok: false,
                errorCode: "AD_VERIFICATION_REQUIRED",
                error: "Rewarded ad token required — call rewarded_ad_request_token before the ad"
            };
        }

        var td = readAdToken(nk, userId, token);
        if (!td) {
            return { ok: false, errorCode: "AD_TOKEN_INVALID", error: "Invalid ad token" };
        }
        if (td.userId !== userId) {
            return { ok: false, errorCode: "AD_TOKEN_INVALID", error: "Token ownership mismatch" };
        }

        var now = Math.floor(Date.now() / 1000);
        if (now > td.expiresAt) {
            return { ok: false, errorCode: "AD_TOKEN_EXPIRED", error: "Ad token expired" };
        }

        if (placement && td.placement && td.placement !== placement) {
            return { ok: false, errorCode: "AD_PLACEMENT_MISMATCH", error: "Token placement mismatch" };
        }

        if (td.consumed) {
            if (td.consumedAt && (now - td.consumedAt) <= 120) {
                return { ok: true, tokenData: td };
            }
            return { ok: false, errorCode: "AD_TOKEN_CONSUMED", error: "Ad token already used" };
        }

        td.consumed = true;
        td.consumedAt = now;
        try {
            nk.storageWrite([{
                collection: AD_TOKEN_COLLECTION,
                key: token,
                userId: userId,
                value: td,
                permissionRead: 1,
                permissionWrite: 0
            }]);
        } catch (e) {
            if (logger) logger.warn("[WalletGrantGate] token consume failed: " + (e.message || e));
            return { ok: false, errorCode: "SERVER_ERROR", error: "Server error" };
        }
        return { ok: true, tokenData: td };
    }

    function readPromoLedger(nk, userId) {
        try {
            var recs = nk.storageRead([{
                collection: LEDGER_COLLECTION,
                key: LEDGER_KEY,
                userId: userId
            }]);
            if (recs && recs.length > 0 && recs[0].value) {
                var v = recs[0].value;
                return {
                    day: v.day || utcDay(),
                    coins: typeof v.coins === "number" ? v.coins : 0
                };
            }
        } catch (_) { /* fall through */ }
        return { day: utcDay(), coins: 0 };
    }

    function writePromoLedger(nk, userId, ledger) {
        nk.storageWrite([{
            collection: LEDGER_COLLECTION,
            key: LEDGER_KEY,
            userId: userId,
            value: ledger,
            permissionRead: 1,
            permissionWrite: 0
        }]);
    }

    /**
     * Soft cap for promo grants on young accounts (< 48h). Welcome bonus (50) fits
     * within cap; fortune-wheel farming is throttled without bricking onboarding.
     */
    function assertYoungAccountPromoBudget(nk, userId, coinsToGrant, logger) {
        if (!coinsToGrant || coinsToGrant <= 0) return { ok: true };
        var age = accountAgeSeconds(nk, userId);
        if (age >= YOUNG_ACCOUNT_SECONDS) return { ok: true };

        var today = utcDay();
        var ledger = readPromoLedger(nk, userId);
        if (ledger.day !== today) {
            ledger = { day: today, coins: 0 };
        }
        if (ledger.coins + coinsToGrant > YOUNG_ACCOUNT_DAILY_CAP) {
            return {
                ok: false,
                errorCode: "YOUNG_ACCOUNT_CAP",
                error: "Promotional grant cap exceeded for new account",
                grantedToday: ledger.coins,
                dailyCap: YOUNG_ACCOUNT_DAILY_CAP
            };
        }
        ledger.coins += coinsToGrant;
        try {
            writePromoLedger(nk, userId, ledger);
        } catch (e) {
            if (logger) logger.warn("[WalletGrantGate] ledger write failed: " + (e.message || e));
        }
        return { ok: true };
    }

    /**
     * Applixir S2S txn must be pre-registered before session RPC credits web ads.
     */
    var AD_NETWORK_ALIASES = {
        applixir: "applixir",
        ironsource: "levelplay",
        levelplay: "levelplay",
        unity: "levelplay",
        admob: "admob",
        appodeal: "appodeal",
        google: "admob"
    };

    var VERIFIED_TXN_COLLECTION = "ad_network_verified_txns";
    var SYSTEM_USER = "00000000-0000-0000-0000-000000000000";

    function normalizeNetwork(network) {
        var n = String(network || "unknown").toLowerCase();
        return AD_NETWORK_ALIASES[n] || n;
    }

    /**
     * Register a network-verified rewarded-ad txn (Applixir S2S, LevelPlay postback, etc.).
     * Called only from http_key service RPCs — never from session clients.
     */
    function registerAdNetworkVerification(nk, network, txnId, userId, meta) {
        var row = {
            network: normalizeNetwork(network),
            user_id: userId,
            placement: (meta && meta.placement) || "",
            reward_token: (meta && meta.rewardToken) || "",
            verified_at: Math.floor(Date.now() / 1000),
            source: (meta && meta.source) || "s2s"
        };
        nk.storageWrite([{
            collection: VERIFIED_TXN_COLLECTION,
            key: txnId,
            userId: SYSTEM_USER,
            value: row,
            permissionRead: 0,
            permissionWrite: 0
        }]);
        if (normalizeNetwork(network) === "applixir") {
            nk.storageWrite([{
                collection: "applixir_s2s_txns",
                key: txnId,
                userId: SYSTEM_USER,
                value: row,
                permissionRead: 0,
                permissionWrite: 0
            }]);
        }
    }

    function readVerifiedTxn(nk, txnId) {
        try {
            var recs = nk.storageRead([{
                collection: VERIFIED_TXN_COLLECTION,
                key: txnId,
                userId: SYSTEM_USER
            }]);
            if (recs && recs.length > 0) return recs[0].value;
        } catch (_) { /* fall through */ }
        try {
            var legacy = nk.storageRead([{
                collection: "applixir_s2s_txns",
                key: txnId,
                userId: SYSTEM_USER
            }]);
            if (legacy && legacy.length > 0) return legacy[0].value;
        } catch (_) { /* fall through */ }
        return null;
    }

    /**
     * Fail-closed rewarded-ad claim verification. Replaces client adCompleted trust.
     * Networks in production: Applixir (web), LevelPlay/ironSource + AdMob + Appodeal (Unity ILRD).
     */
    function assertRewardedAdClaimVerified(nk, userId, adNetwork, metadata, rewardToken, logger) {
        var meta = metadata || {};
        var txnId = String(meta.txnId || meta.verificationId || meta.transaction_id || meta.txn_id || "");
        var network = normalizeNetwork(adNetwork || meta.network || "unknown");

        if (!txnId) {
            return {
                ok: false,
                errorCode: "AD_VERIFICATION_REQUIRED",
                error: "Ad network verification id required (txnId / verificationId)"
            };
        }

        var row = readVerifiedTxn(nk, txnId);
        if (!row) {
            return {
                ok: false,
                errorCode: "AD_VERIFICATION_REQUIRED",
                error: "Ad not verified by network callback"
            };
        }
        if (row.user_id && row.user_id !== userId) {
            return { ok: false, errorCode: "AD_TXN_CLAIMED", error: "Verification belongs to another user" };
        }
        if (row.claimed_by && row.claimed_by !== userId) {
            return { ok: false, errorCode: "AD_TXN_CLAIMED", error: "Verification already claimed" };
        }
        if (rewardToken && row.reward_token && row.reward_token !== rewardToken) {
            return { ok: false, errorCode: "AD_TOKEN_MISMATCH", error: "Verification token mismatch" };
        }

        row.claimed_by = userId;
        row.claimed_at = Math.floor(Date.now() / 1000);
        try {
            nk.storageWrite([{
                collection: VERIFIED_TXN_COLLECTION,
                key: txnId,
                userId: SYSTEM_USER,
                value: row,
                permissionRead: 0,
                permissionWrite: 0
            }]);
        } catch (e) {
            if (logger) logger.warn("[WalletGrantGate] verify consume failed: " + (e.message || e));
        }
        return { ok: true, network: network, txnId: txnId };
    }

    function assertApplixirTxnVerified(nk, userId, txnId, logger) {
        if (!txnId) {
            return {
                ok: false,
                errorCode: "AD_VERIFICATION_REQUIRED",
                error: "Applixir transaction id required"
            };
        }
        try {
            var recs = nk.storageRead([{
                collection: "applixir_s2s_txns",
                key: txnId,
                userId: "00000000-0000-0000-0000-000000000000"
            }]);
            if (!recs || recs.length === 0) {
                return {
                    ok: false,
                    errorCode: "AD_VERIFICATION_REQUIRED",
                    error: "Ad not verified by Applixir callback"
                };
            }
            var row = recs[0].value || {};
            if (row.claimed_by && row.claimed_by !== userId) {
                return { ok: false, errorCode: "AD_TXN_CLAIMED", error: "Transaction already claimed" };
            }
            row.claimed_by = userId;
            row.claimed_at = Math.floor(Date.now() / 1000);
            nk.storageWrite([{
                collection: "applixir_s2s_txns",
                key: txnId,
                userId: "00000000-0000-0000-0000-000000000000",
                value: row,
                permissionRead: 0,
                permissionWrite: 0
            }]);
            return { ok: true };
        } catch (e) {
            if (logger) logger.warn("[WalletGrantGate] applixir txn check failed: " + (e.message || e));
            return { ok: false, errorCode: "SERVER_ERROR", error: "Server error" };
        }
    }

    return {
        rejectResponse: rejectResponse,
        accountAgeSeconds: accountAgeSeconds,
        isServiceContext: isServiceContext,
        rejectSessionClientMint: rejectSessionClientMint,
        assertAdGrantAuthorized: assertAdGrantAuthorized,
        assertYoungAccountPromoBudget: assertYoungAccountPromoBudget,
        assertApplixirTxnVerified: assertApplixirTxnVerified,
        registerAdNetworkVerification: registerAdNetworkVerification,
        assertRewardedAdClaimVerified: assertRewardedAdClaimVerified,
        normalizeAdNetwork: normalizeNetwork
    };
})();
