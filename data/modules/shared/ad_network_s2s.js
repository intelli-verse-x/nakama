/**
 * ad_network_s2s.js — http_key-only registration of ad-network verification rows.
 *
 * Wire Applixir / LevelPlay / AdMob S2S postbacks to this RPC (via API gateway
 * or Nakama console HTTP key). Session clients must never call it.
 *
 * Networks in production use:
 *   - Applixir (web.quizverse.world rewarded ads)
 *   - LevelPlay / ironSource + AdMob + Appodeal (Unity QuizVerse via ILRD)
 */
function rpcAdNetworkS2sVerify(ctx, logger, nk, payload) {
    if (ctx.userId) {
        return JSON.stringify({
            success: false,
            error: "service-only",
            errorCode: "FORBIDDEN",
            http_status: 403
        });
    }

    var data = {};
    try { data = JSON.parse(payload || "{}"); } catch (_e) {
        return JSON.stringify({ success: false, error: "invalid json" });
    }

    var userId = String(data.userId || data.user_id || "");
    var txnId = String(data.txnId || data.transaction_id || data.verificationId || "");
    var network = String(data.network || data.adNetwork || "unknown");
    var placement = String(data.placement || "");
    var rewardToken = String(data.rewardToken || data.token || "");

    if (!userId || !txnId) {
        return JSON.stringify({ success: false, error: "userId and txnId required" });
    }

    if (typeof WalletGrantGate === "undefined" || !WalletGrantGate) {
        return JSON.stringify({ success: false, error: "WalletGrantGate unavailable" });
    }

    try {
        WalletGrantGate.registerAdNetworkVerification(nk, network, txnId, userId, {
            placement: placement,
            rewardToken: rewardToken,
            source: "ad_network_s2s_verify"
        });
    } catch (e) {
        logger.error("[AdNetworkS2S] register failed: " + (e.message || e));
        return JSON.stringify({ success: false, error: "register failed" });
    }

    logger.info("[AdNetworkS2S] verified network=" + network + " user=" + userId + " txn=" + txnId.substring(0, 8) + "...");
    return JSON.stringify({ success: true, network: WalletGrantGate.normalizeAdNetwork(network), txnId: txnId });
}

function _AdNetworkS2SInit(ctx, logger, nk, initializer) {
    initializer.registerRpc("ad_network_s2s_verify", rpcAdNetworkS2sVerify);
    logger.info("[AdNetworkS2S] Registered ad_network_s2s_verify (http_key service RPC)");
}
