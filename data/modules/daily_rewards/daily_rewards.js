    // daily_rewards.js - Daily Rewards & Streak System (Per gameId UUID)

    /**
     * Reward configurations per gameId UUID
     * This can be extended or moved to storage for dynamic configuration
     */
    /**
     * BALANCED DAILY REWARDS CONFIGURATION
     * 
     * Design Philosophy:
     * - Day 1: 40 coins = ~4 QuickPlay games (keeps them playing after free plays)
     * - Day 3: 65 coins = Can afford first Hint power-up (75) with Day 2 leftover (milestone!)
     * - Day 7: 200 coins = Big reward validates loyalty, can afford Extra Life (200)
     * - Weekly total: 660 coins (enough for ~6-8 sessions/day with free plays)
     * 
     * Key metrics:
     * - Creates "slightly short" feeling → drives ad watching & IAP
     * - Never leaves user completely stuck (can always play with free plays + Day 1)
     * - Milestone at Day 3 (first power-up affordable) creates mid-week retention hook
     * - Day 7 jackpot encourages full week completion (4x Day 1 reward)
     */
    // QVBF_166: Each row now carries a `game` field (coins — the primary game
    // currency displayed in the reward popup and granted to the wallet).
    // `tokens` is kept for legacy compatibility but is NOT granted to the wallet.
    // The client reads `reward.game` for the coin amount shown in the toast.
    // RCA fix (client/server reward mismatch): `game` (the coins actually granted to
    // the wallet) was a flat 50/day, contradicting BOTH the balanced-economy design
    // doc above (Day 1: 40 … Day 7: 200, weekly total 660) AND the client's canonical
    // display table (IVXDailyRewardsManager.DAILY_REWARD_COINS = 40,50,65,80,100,125,200).
    // The popup promised the ramp while the wallet received 50. `game` now follows the
    // documented ramp, so display == grant on every day.
    var REWARD_CONFIGS = {
        // Default rewards for any game - BALANCED FOR ENGAGEMENT + MONETIZATION
        "default": [
            { day: 1, game: 40, xp: 50, tokens: 40, description: "Welcome Back!" },
            { day: 2, game: 50, xp: 75, tokens: 50, description: "Day 2 Reward" },
            { day: 3, game: 65, xp: 100, tokens: 65, description: "Power-Up Unlocked! 💪" },
            { day: 4, game: 80, xp: 150, tokens: 80, description: "Halfway There!" },
            { day: 5, game: 100, xp: 200, tokens: 100, multiplier: "2x XP", description: "Day 5 Bonus! 🔥" },
            { day: 6, game: 125, xp: 275, tokens: 125, description: "Almost There!" },
            { day: 7, game: 200, xp: 400, tokens: 200, nft: "weekly_badge", description: "🎉 Weekly Champion!" }
        ],

        // QuizVerse specific - CORRECT GAME ID
        "126bf539-dae2-4bcf-964d-316c0fa1f92b": [
            { day: 1, game: 40, xp: 50, tokens: 40, description: "Welcome Back!" },
            { day: 2, game: 50, xp: 75, tokens: 50, description: "Day 2 Reward" },
            { day: 3, game: 65, xp: 100, tokens: 65, description: "Power-Up Unlocked! 💪" },
            { day: 4, game: 80, xp: 150, tokens: 80, description: "Halfway There!" },
            { day: 5, game: 100, xp: 200, tokens: 100, multiplier: "2x XP", description: "Day 5 Bonus! 🔥" },
            { day: 6, game: 125, xp: 275, tokens: 125, description: "Almost There!" },
            { day: 7, game: 200, xp: 400, tokens: 200, nft: "weekly_badge", description: "🎉 Weekly Champion!" }
        ]
    };

    /**
     * UTC day helpers — daily rewards use UTC dates (matches claimHistory writes
     * and LegacyDailyRewards.getTodayDateString). Do not use utils.getStartOfDay
     * here; it uses local timezone.
     */
    function pad2Utc(n) {
        return n < 10 ? "0" + n : String(n);
    }

    function getUtcDateStringFromUnix(ts) {
        var d = new Date(ts * 1000);
        return d.getUTCFullYear() + "-" + pad2Utc(d.getUTCMonth() + 1) + "-" + pad2Utc(d.getUTCDate());
    }

    function getTodayUtcDateString() {
        var d = new Date();
        return d.getUTCFullYear() + "-" + pad2Utc(d.getUTCMonth() + 1) + "-" + pad2Utc(d.getUTCDate());
    }

    function getUtcDayStartUnix(ts) {
        var d = new Date(ts * 1000);
        d.setUTCHours(0, 0, 0, 0);
        return Math.floor(d.getTime() / 1000);
    }

    function getUtcDayStartUnixFromDateString(dateStr) {
        if (!dateStr || typeof dateStr !== "string") return 0;
        var parts = dateStr.split("-");
        if (parts.length !== 3) return 0;
        var y = parseInt(parts[0], 10);
        var m = parseInt(parts[1], 10) - 1;
        var d = parseInt(parts[2], 10);
        if (isNaN(y) || isNaN(m) || isNaN(d)) return 0;
        return Math.floor(Date.UTC(y, m, d, 0, 0, 0, 0) / 1000);
    }

    function maxUtcDateString(a, b) {
        if (!a) return b || "";
        if (!b) return a || "";
        return a > b ? a : b;
    }

    /**
     * Reconcile lastClaimTimestamp against claimHistory and legacy daily_rewards
     * storage so eligibility checks use the true most-recent claim date.
     */
    function reconcileStreakLastClaim(nk, logger, userId, gameId, data) {
        var effectiveDate = "";
        var changed = false;

        if (data.lastClaimTimestamp > 0) {
            effectiveDate = getUtcDateStringFromUnix(data.lastClaimTimestamp);
        }

        if (data.claimHistory && data.claimHistory.length > 0) {
            var lastHistory = data.claimHistory[data.claimHistory.length - 1];
            effectiveDate = maxUtcDateString(effectiveDate, lastHistory);
        }

        try {
            var tsStatus = utils.readStorage(nk, logger, "daily_rewards", "status_" + userId, userId);
            if (tsStatus) {
                if (tsStatus.lastClaimDate) {
                    effectiveDate = maxUtcDateString(effectiveDate, tsStatus.lastClaimDate);
                }
                if (tsStatus.rewards && tsStatus.rewards.length) {
                    for (var ri = 0; ri < tsStatus.rewards.length; ri++) {
                        if (tsStatus.rewards[ri] && tsStatus.rewards[ri].date) {
                            effectiveDate = maxUtcDateString(effectiveDate, tsStatus.rewards[ri].date);
                        }
                    }
                }
            }
        } catch (reconcileErr) {
            utils.logWarn(logger, "[DailyRewards] Legacy reconcile skipped: " + reconcileErr.message);
        }

        if (effectiveDate) {
            var tsDate = data.lastClaimTimestamp > 0
                ? getUtcDateStringFromUnix(data.lastClaimTimestamp)
                : "";
            if (effectiveDate > tsDate) {
                data.lastClaimTimestamp = getUtcDayStartUnixFromDateString(effectiveDate);
                changed = true;
                utils.logInfo(logger, "[DailyRewards] Reconciled lastClaimTimestamp for " + userId +
                    ": " + (tsDate || "none") + " -> " + effectiveDate);
            }
        }

        if (changed) {
            saveStreakData(nk, logger, userId, gameId, data);
        }

        return data;
    }

    /**
     * Get or create streak data for user
     * @param {object} nk - Nakama runtime
     * @param {object} logger - Logger instance
     * @param {string} userId - User ID
     * @param {string} gameId - Game ID (UUID)
     * @returns {object} Streak data
     */
    function getStreakData(nk, logger, userId, gameId) {
        var collection = "daily_streaks";
        var key = utils.makeGameStorageKey("user_daily_streak", userId, gameId);
        
        var data = utils.readStorage(nk, logger, collection, key, userId);
        
        if (!data) {
            // Initialize new streak
            data = {
                userId: userId,
                gameId: gameId,
                currentStreak: 0,
                bestStreak: 0,
                lastClaimTimestamp: 0,
                totalClaims: 0,
                claimHistory: [],
                createdAt: utils.getCurrentTimestamp()
            };

            // QVBF_51 migration: while the TS LegacyDailyRewards handler was
            // (wrongly) serving daily_rewards_claim, it wrote streak state to
            // collection "daily_rewards", key "status_{userId}" as
            // { day, lastClaimDate: "YYYY-MM-DD", streak, rewards[] }.
            // Seed from that record once so those users don't lose their streak.
            try {
                var tsStatus = utils.readStorage(nk, logger, "daily_rewards", "status_" + userId, userId);
                if (tsStatus && tsStatus.streak > 0 && tsStatus.lastClaimDate) {
                    var migratedDate = tsStatus.lastClaimDate;
                    if (tsStatus.rewards && tsStatus.rewards.length) {
                        for (var mi = 0; mi < tsStatus.rewards.length; mi++) {
                            if (tsStatus.rewards[mi] && tsStatus.rewards[mi].date) {
                                migratedDate = maxUtcDateString(migratedDate, tsStatus.rewards[mi].date);
                            }
                        }
                    }
                    var migratedTs = getUtcDayStartUnixFromDateString(migratedDate);
                    if (migratedTs > 0) {
                        data.currentStreak = tsStatus.streak;
                        data.bestStreak = tsStatus.streak;
                        data.lastClaimTimestamp = migratedTs;
                        data.totalClaims = (tsStatus.rewards && tsStatus.rewards.length) || tsStatus.streak;
                        if (tsStatus.rewards && tsStatus.rewards.length) {
                            for (var ri = 0; ri < tsStatus.rewards.length && ri < 90; ri++) {
                                if (tsStatus.rewards[ri] && tsStatus.rewards[ri].date) {
                                    data.claimHistory.push(tsStatus.rewards[ri].date);
                                }
                            }
                        }
                        utils.logInfo(logger, "[DailyRewards] Migrated TS-legacy streak for " + userId + ": streak=" + tsStatus.streak);
                    }
                }
            } catch (migErr) {
                utils.logWarn(logger, "[DailyRewards] TS-legacy migration skipped: " + migErr.message);
            }
        }

        // Backfill fields for records created before QVBF_51
        if (typeof data.bestStreak !== "number") data.bestStreak = data.currentStreak || 0;
        if (!data.claimHistory) data.claimHistory = [];

        data = reconcileStreakLastClaim(nk, logger, userId, gameId, data);

        return data;
    }

    /**
     * Save streak data
     * @param {object} nk - Nakama runtime
     * @param {object} logger - Logger instance
     * @param {string} userId - User ID
     * @param {string} gameId - Game ID (UUID)
     * @param {object} data - Streak data to save
     * @returns {boolean} Success status
     */
    function saveStreakData(nk, logger, userId, gameId, data) {
        var collection = "daily_streaks";
        var key = utils.makeGameStorageKey("user_daily_streak", userId, gameId);
        return utils.writeStorage(nk, logger, collection, key, userId, data);
    }

    /**
     * OCC support (double-claim fix): raw read that also returns the storage object
     * version, so the claim path can do a CONDITIONAL write. utils.readStorage
     * discards the version, which forced blind writes — two concurrent
     * daily_rewards_claim calls (double-tap, two devices, client retry) both passed
     * canClaimToday and both granted the wallet.
     */
    function readStreakRawWithVersion(nk, userId, gameId) {
        var key = utils.makeGameStorageKey("user_daily_streak", userId, gameId);
        var objects = nk.storageRead([{ collection: "daily_streaks", key: key, userId: userId }]);
        if (objects && objects.length > 0 && objects[0].value) {
            return { value: objects[0].value, version: objects[0].version };
        }
        // "*" = Nakama conditional create: write succeeds only if the key does not exist yet.
        return { value: null, version: "*" };
    }

    /**
     * Conditional write — succeeds only if the record still has the version we read.
     * Returns false on version conflict (a concurrent claim won the race).
     */
    function saveStreakDataVersioned(nk, logger, userId, gameId, data, version) {
        var key = utils.makeGameStorageKey("user_daily_streak", userId, gameId);
        try {
            nk.storageWrite([{
                collection: "daily_streaks",
                key: key,
                userId: userId,
                value: data,
                version: version,
                permissionRead: 1,
                permissionWrite: 0
            }]);
            return true;
        } catch (err) {
            utils.logWarn(logger, "[DailyRewards] Versioned write rejected for " + userId +
                " (concurrent claim?): " + err.message);
            return false;
        }
    }

    /**
     * Check if user can claim reward today
     * @param {object} streakData - Current streak data
     * @returns {object} { canClaim: boolean, reason: string }
     */
    function canClaimToday(streakData) {
        var lastClaim = streakData.lastClaimTimestamp;

        // First claim ever
        if (lastClaim === 0) {
            return { canClaim: true, reason: "first_claim" };
        }

        var lastDate = getUtcDateStringFromUnix(lastClaim);
        var today = getTodayUtcDateString();

        if (lastDate === today) {
            // Incomplete claim (OCC committed, wallet not finalized) — claim RPC resumes it.
            if (hasActivePendingGrant(streakData, today)) {
                return { canClaim: true, reason: "pending_grant_resume" };
            }
            return { canClaim: false, reason: "already_claimed_today" };
        }

        return { canClaim: true, reason: "eligible" };
    }

    /** True when streak has an unfinished wallet grant for the given UTC date. */
    function hasActivePendingGrant(streakData, claimDate) {
        if (!streakData || !streakData.pendingGrant) return false;
        var pg = streakData.pendingGrant;
        if (!claimDate) claimDate = getTodayUtcDateString();
        return pg.claimDate === claimDate && pg.status !== "finalized";
    }

    var DAILY_REWARD_GRANT_LOCKS = "daily_reward_grant_locks";
    var DAILY_REWARD_DEAD_LETTERS = "daily_reward_dead_letters";
    var DAILY_REWARD_SYSTEM_USER = "00000000-0000-0000-0000-000000000000";

    function makeGrantLockKey(userId, gameId, claimDate) {
        return userId + "_" + gameId + "_" + claimDate;
    }

    function readGrantLock(nk, userId, gameId, claimDate) {
        var key = makeGrantLockKey(userId, gameId, claimDate);
        var objects = nk.storageRead([{ collection: DAILY_REWARD_GRANT_LOCKS, key: key, userId: userId }]);
        if (objects && objects.length > 0 && objects[0].value) {
            return { value: objects[0].value, version: objects[0].version, key: key };
        }
        return { value: null, version: "*", key: key };
    }

    function writeGrantLock(nk, logger, userId, gameId, claimDate, value, version) {
        var key = makeGrantLockKey(userId, gameId, claimDate);
        try {
            nk.storageWrite([{
                collection: DAILY_REWARD_GRANT_LOCKS,
                key: key,
                userId: userId,
                value: value,
                version: version,
                permissionRead: 1,
                permissionWrite: 0
            }]);
            return true;
        } catch (err) {
            utils.logWarn(logger, "[DailyRewards] Grant lock write rejected: " + err.message);
            return false;
        }
    }

    /**
     * Credit storage wallets (game+tokens + global XP). Idempotent via grant lock:
     * if lock is already wallet_applied/finalized, skips credit.
     * Transitions pending → applying (OCC) so concurrent resumes cannot double-credit.
     */
    function applyStorageWalletGrant(nk, logger, userId, gameId, grant, xpGrant, claimDate) {
        var lock = readGrantLock(nk, userId, gameId, claimDate);
        if (lock.value && (lock.value.status === "wallet_applied" || lock.value.status === "finalized")) {
            return { ok: true, alreadyApplied: true, walletGranted: { game: grant, xp: xpGrant } };
        }

        var nowTs = utils.getUnixTimestamp();
        var lockValue = lock.value;
        if (!lockValue) {
            lockValue = {
                userId: userId,
                gameId: gameId,
                claimDate: claimDate,
                game: grant,
                xp: xpGrant,
                status: "pending",
                createdAt: utils.getCurrentTimestamp(),
                updatedAt: utils.getCurrentTimestamp()
            };
            if (!writeGrantLock(nk, logger, userId, gameId, claimDate, lockValue, "*")) {
                lock = readGrantLock(nk, userId, gameId, claimDate);
                if (lock.value && (lock.value.status === "wallet_applied" || lock.value.status === "finalized")) {
                    return { ok: true, alreadyApplied: true, walletGranted: { game: grant, xp: xpGrant } };
                }
                if (!lock.value) {
                    throw new Error("Failed to create grant lock");
                }
                lockValue = lock.value;
            } else {
                lock = readGrantLock(nk, userId, gameId, claimDate);
                lockValue = lock.value || lockValue;
            }
        }

        // Another worker mid-apply: if recent, bail so caller retries/resumes later.
        if (lockValue.status === "applying") {
            var started = lockValue.applyingAt || 0;
            if (started > 0 && (nowTs - started) < 30) {
                throw new Error("claim_in_progress");
            }
        }

        if (lockValue.status === "wallet_applied" || lockValue.status === "finalized") {
            return { ok: true, alreadyApplied: true, walletGranted: { game: grant, xp: xpGrant } };
        }

        // OCC claim exclusive apply rights.
        lockValue.status = "applying";
        lockValue.applyingAt = nowTs;
        lockValue.game = grant;
        lockValue.xp = xpGrant;
        lockValue.updatedAt = utils.getCurrentTimestamp();
        lock = readGrantLock(nk, userId, gameId, claimDate);
        if (!writeGrantLock(nk, logger, userId, gameId, claimDate, lockValue, lock.version)) {
            lock = readGrantLock(nk, userId, gameId, claimDate);
            if (lock.value && (lock.value.status === "wallet_applied" || lock.value.status === "finalized")) {
                return { ok: true, alreadyApplied: true, walletGranted: { game: grant, xp: xpGrant } };
            }
            throw new Error("claim_in_progress");
        }

        var gameGrantApplied = false;
        var preGameCurrencies = null;
        try {
            if (grant > 0) {
                var gw = WalletHelpers.getGameWallet(nk, userId, gameId);
                if (!gw.currencies) gw.currencies = { game: 0, tokens: 0, xp: 0 };
                if (gw.currencies.game === undefined) gw.currencies.game = 0;
                if (gw.currencies.tokens === undefined) gw.currencies.tokens = 0;
                preGameCurrencies = { game: gw.currencies.game, tokens: gw.currencies.tokens };
                gw.currencies.game += grant;
                gw.currencies.tokens += grant;
                WalletHelpers.saveGameWallet(nk, gw);
                gameGrantApplied = true;
            }
            if (xpGrant > 0) {
                var globalKey = "global_" + userId;
                var globalReads = nk.storageRead([{ collection: "wallets", key: globalKey, userId: userId }]);
                var globalWallet;
                var globalPermRead = 1;
                var globalPermWrite = 1;
                if (globalReads && globalReads.length > 0 && globalReads[0].value) {
                    globalWallet = globalReads[0].value;
                    if (typeof globalReads[0].permissionRead === "number") globalPermRead = globalReads[0].permissionRead;
                    if (typeof globalReads[0].permissionWrite === "number") globalPermWrite = globalReads[0].permissionWrite;
                } else {
                    globalWallet = { userId: userId, currencies: { global: 0, xut: 0, xp: 0 }, items: {} };
                }
                if (!globalWallet.currencies) globalWallet.currencies = { global: 0, xut: 0, xp: 0 };
                if (globalWallet.currencies.xp === undefined) globalWallet.currencies.xp = 0;
                globalWallet.currencies.xp += xpGrant;
                nk.storageWrite([{
                    collection: "wallets",
                    key: globalKey,
                    userId: userId,
                    value: globalWallet,
                    permissionRead: globalPermRead,
                    permissionWrite: globalPermWrite
                }]);
            }

            lock = readGrantLock(nk, userId, gameId, claimDate);
            lockValue = lock.value || lockValue;
            lockValue.status = "wallet_applied";
            lockValue.updatedAt = utils.getCurrentTimestamp();
            if (!writeGrantLock(nk, logger, userId, gameId, claimDate, lockValue, lock.version)) {
                lock = readGrantLock(nk, userId, gameId, claimDate);
                if (lock.value && (lock.value.status === "wallet_applied" || lock.value.status === "finalized")) {
                    return { ok: true, alreadyApplied: true, walletGranted: { game: grant, xp: xpGrant } };
                }
                throw new Error("Failed to mark grant lock wallet_applied");
            }
            return { ok: true, alreadyApplied: false, walletGranted: { game: grant, xp: xpGrant } };
        } catch (walletErr) {
            if (gameGrantApplied && preGameCurrencies) {
                try {
                    var gwRevert = WalletHelpers.getGameWallet(nk, userId, gameId);
                    if (!gwRevert.currencies) gwRevert.currencies = { game: 0, tokens: 0, xp: 0 };
                    gwRevert.currencies.game = preGameCurrencies.game;
                    gwRevert.currencies.tokens = preGameCurrencies.tokens;
                    WalletHelpers.saveGameWallet(nk, gwRevert);
                } catch (gwRevertErr) {
                    logger.error("[DailyRewards] Failed to revert game wallet: " + ((gwRevertErr && gwRevertErr.message) ? gwRevertErr.message : String(gwRevertErr)));
                }
            }
            // Release applying lock back to pending so resume can retry.
            try {
                lock = readGrantLock(nk, userId, gameId, claimDate);
                if (lock.value && lock.value.status === "applying") {
                    lock.value.status = "pending";
                    lock.value.updatedAt = utils.getCurrentTimestamp();
                    writeGrantLock(nk, logger, userId, gameId, claimDate, lock.value, lock.version);
                }
            } catch (_) {}
            throw walletErr;
        }
    }

    function finalizePendingGrantOnStreak(nk, logger, userId, gameId, streakData, claimDate) {
        if (streakData.pendingGrant) {
            delete streakData.pendingGrant;
        }
        streakData.updatedAt = utils.getCurrentTimestamp();
        saveStreakData(nk, logger, userId, gameId, streakData);

        var lock = readGrantLock(nk, userId, gameId, claimDate);
        if (lock.value) {
            lock.value.status = "finalized";
            lock.value.updatedAt = utils.getCurrentTimestamp();
            writeGrantLock(nk, logger, userId, gameId, claimDate, lock.value, lock.version);
        }
    }

    function writeDailyRewardDeadLetter(nk, logger, entry) {
        var claimDate = entry.claimDate || getTodayUtcDateString();
        var key = entry.userId + "_" + entry.gameId + "_" + claimDate + "_" + utils.getUnixTimestamp();
        var value = {
            userId: entry.userId,
            gameId: entry.gameId,
            claimDate: claimDate,
            reward: entry.reward || null,
            preClaimSnapshot: entry.preClaimSnapshot || null,
            streakSnapshot: entry.streakSnapshot || null,
            grantError: entry.grantError || "",
            revertError: entry.revertError || "",
            reason: entry.reason || "wallet_grant_and_revert_failed",
            status: "open",
            createdAt: utils.getCurrentTimestamp()
        };
        try {
            nk.storageWrite([{
                collection: DAILY_REWARD_DEAD_LETTERS,
                key: key,
                userId: DAILY_REWARD_SYSTEM_USER,
                value: value,
                permissionRead: 0,
                permissionWrite: 0
            }]);
            logger.error("[DailyRewards] Dead letter written: " + key + " reason=" + value.reason);
            return key;
        } catch (dlErr) {
            logger.error("[DailyRewards] CRITICAL: failed to write dead letter: " + ((dlErr && dlErr.message) ? dlErr.message : String(dlErr)));
            return null;
        }
    }

    /**
     * Resume an OCC-committed claim whose wallet grant never finalized.
     * Concurrent callers converge via grant-lock status (no double credit).
     */
    function resumePendingDailyGrant(nk, logger, userId, gameId, streakData) {
        var pg = streakData.pendingGrant;
        var claimDate = pg.claimDate || getTodayUtcDateString();
        var grant = pg.game || 0;
        var xpGrant = pg.xp || 0;
        var reward = pg.reward || getRewardForDay(gameId, streakData.currentStreak);
        var walletGranted = { game: grant, xp: xpGrant };

        var lock = readGrantLock(nk, userId, gameId, claimDate);
        if (lock.value && (lock.value.status === "wallet_applied" || lock.value.status === "finalized")) {
            finalizePendingGrantOnStreak(nk, logger, userId, gameId, streakData, claimDate);
            logger.info("[DailyRewards] Resumed pending grant (already applied) for " + userId);
            return { ok: true, streakData: streakData, reward: reward, walletGranted: walletGranted, resumed: true };
        }

        try {
            if (grant > 0 || xpGrant > 0) {
                var applied = applyStorageWalletGrant(nk, logger, userId, gameId, grant, xpGrant, claimDate);
                walletGranted = applied.walletGranted;
            }
            finalizePendingGrantOnStreak(nk, logger, userId, gameId, streakData, claimDate);
            logger.info("[DailyRewards] Resumed pending grant for " + userId);
            return { ok: true, streakData: streakData, reward: reward, walletGranted: walletGranted, resumed: true };
        } catch (resumeErr) {
            var resumeMsg = (resumeErr && resumeErr.message) ? resumeErr.message : String(resumeErr);
            if (resumeMsg === "claim_in_progress") {
                return { ok: false, error: "Claim wallet grant already in progress", reason: "claim_in_progress" };
            }
            logger.error("[DailyRewards] Resume grant failed for " + userId + ": " + resumeMsg);
            return rollbackFailedGrant(nk, logger, userId, gameId, streakData, pg.preClaimSnapshot || null, reward, resumeMsg);
        }
    }

    /**
     * After wallet failure: restore pre-claim streak. If restore fails, dead-letter.
     */
    function rollbackFailedGrant(nk, logger, userId, gameId, streakData, preClaimSnapshot, reward, grantMsg) {
        var claimDate = (streakData.pendingGrant && streakData.pendingGrant.claimDate) || getTodayUtcDateString();

        if (preClaimSnapshot) {
            try {
                // Ensure rollback clears the in-progress flag.
                if (preClaimSnapshot.pendingGrant) delete preClaimSnapshot.pendingGrant;
                saveStreakData(nk, logger, userId, gameId, preClaimSnapshot);
                var lock = readGrantLock(nk, userId, gameId, claimDate);
                if (lock.value) {
                    lock.value.status = "reverted";
                    lock.value.updatedAt = utils.getCurrentTimestamp();
                    writeGrantLock(nk, logger, userId, gameId, claimDate, lock.value, lock.version);
                }
                logger.info("[DailyRewards] Reverted streak after wallet grant failure for " + userId);
                return { ok: false, error: "Wallet grant failed: " + grantMsg, reason: "wallet_grant_failed" };
            } catch (streakRevertErr) {
                var revertMsg = (streakRevertErr && streakRevertErr.message) ? streakRevertErr.message : String(streakRevertErr);
                logger.error("[DailyRewards] CRITICAL: streak revert failed for " + userId + ": " + revertMsg);
                var dlKey = writeDailyRewardDeadLetter(nk, logger, {
                    userId: userId,
                    gameId: gameId,
                    claimDate: claimDate,
                    reward: reward,
                    preClaimSnapshot: preClaimSnapshot,
                    streakSnapshot: streakData,
                    grantError: grantMsg,
                    revertError: revertMsg,
                    reason: "wallet_grant_and_revert_failed"
                });
                // Keep pendingGrant so claim RPC can resume; stamp deadLetterKey for admins.
                streakData.pendingGrant = streakData.pendingGrant || {};
                streakData.pendingGrant.status = "needs_admin";
                streakData.pendingGrant.deadLetterKey = dlKey;
                streakData.pendingGrant.lastError = grantMsg;
                try {
                    saveStreakData(nk, logger, userId, gameId, streakData);
                } catch (_) {}
                return {
                    ok: false,
                    error: "Wallet grant failed and streak revert failed — queued for admin reconcile",
                    reason: "needs_admin_reconcile",
                    deadLetterKey: dlKey
                };
            }
        }

        var dlKey2 = writeDailyRewardDeadLetter(nk, logger, {
            userId: userId,
            gameId: gameId,
            claimDate: claimDate,
            reward: reward,
            preClaimSnapshot: null,
            streakSnapshot: streakData,
            grantError: grantMsg,
            revertError: "missing_preClaimSnapshot",
            reason: "wallet_grant_failed_no_snapshot"
        });
        return {
            ok: false,
            error: "Wallet grant failed: " + grantMsg,
            reason: "needs_admin_reconcile",
            deadLetterKey: dlKey2
        };
    }

    /**
     * Update streak status based on time elapsed; persist when streak breaks.
     * @param {object} nk - Nakama runtime
     * @param {object} logger - Logger instance
     * @param {string} userId - User ID
     * @param {string} gameId - Game ID (UUID)
     * @param {object} streakData - Current streak data
     * @returns {object} Updated streak data
     */
    function updateStreakStatus(nk, logger, userId, gameId, streakData) {
        var now = utils.getUnixTimestamp();
        var lastClaim = streakData.lastClaimTimestamp;

        // First claim
        if (lastClaim === 0) {
            return streakData;
        }

        // Check if more than 48 hours passed (streak broken)
        if (!utils.isWithinHours(lastClaim, now, 48)) {
            if (streakData.currentStreak !== 0) {
                streakData.currentStreak = 0;
                saveStreakData(nk, logger, userId, gameId, streakData);
            }
        }

        return streakData;
    }

    /**
     * Get reward configuration for current day
     * @param {string} gameId - Game ID
     * @param {number} day - Streak day (1-7)
     * @returns {object} Reward configuration
     */
    function getRewardForDay(gameId, day) {
        var config = REWARD_CONFIGS[gameId] || REWARD_CONFIGS["default"];
        var rewardDay = ((day - 1) % 7) + 1; // Cycle through 1-7
        
        for (var i = 0; i < config.length; i++) {
            if (config[i].day === rewardDay) {
                return config[i];
            }
        }
        
        // Fallback to day 1 if not found
        return config[0];
    }

    /**
     * RPC: Get daily reward status
     * @param {object} ctx - Request context
     * @param {object} logger - Logger instance
     * @param {object} nk - Nakama runtime
     * @param {string} payload - JSON payload with { gameId: "uuid" }
     * @returns {string} JSON response
     */
    function rpcDailyRewardsGetStatus(ctx, logger, nk, payload) {
        utils.logInfo(logger, "RPC daily_rewards_get_status called");
        
        var parsed = utils.safeJsonParse(payload);
        if (!parsed.success) {
            return utils.handleError(ctx, null, "Invalid JSON payload");
        }
        
        var data = parsed.data;
        var validation = utils.validatePayload(data, ['gameId']);
        if (!validation.valid) {
            return utils.handleError(ctx, null, "Missing required fields: " + validation.missing.join(", "));
        }
        
        var gameId = data.gameId;
        if (!utils.isValidUUID(gameId)) {
            return utils.handleError(ctx, null, "Invalid gameId UUID format");
        }
        
        // Session callers (Unity / Bearer): ctx.userId.
        // Server-to-server (http_key): QuizVerse Conversation Hub / personalize
        // pass userId|user_id explicitly. http_key is admin-level and this RPC
        // is READ-ONLY — same pattern as analytics_get_player_profile.
        // X-Nakama-Server-User-Id is NOT a Nakama-native header and does not
        // populate ctx.userId on this cluster.
        var userId = ctx.userId;
        if (!userId) {
            userId = (data && (data.userId || data.user_id)) || "";
        }
        if (!userId) {
            return utils.handleError(ctx, null, "User not authenticated");
        }
        
        // Get current streak data
        var streakData = getStreakData(nk, logger, userId, gameId);
        streakData = updateStreakStatus(nk, logger, userId, gameId, streakData);
        
        // Check if can claim
        var claimCheck = canClaimToday(streakData);
        
        // Get next reward info
        var nextDay = streakData.currentStreak + 1;
        var nextReward = getRewardForDay(gameId, nextDay);
        
        // QVBF_166: field names must match C# DailyRewardStatus [JsonProperty] attributes.
        // C# model maps "streak" → currentStreak, "canClaim" → canClaimToday.
        // Keep legacy aliases alongside for any old clients still in the wild.
        return JSON.stringify({
            success: true,
            userId: userId,
            gameId: gameId,
            streak: streakData.currentStreak,          // canonical — C# [JsonProperty("streak")]
            currentStreak: streakData.currentStreak,   // legacy alias
            bestStreak: streakData.bestStreak || 0,    // QVBF_51: lifetime best for dashboard
            totalClaims: streakData.totalClaims,
            lastClaimTimestamp: streakData.lastClaimTimestamp,
            canClaim: claimCheck.canClaim,             // canonical — C# [JsonProperty("canClaim")]
            canClaimToday: claimCheck.canClaim,        // legacy alias
            claimReason: claimCheck.reason,
            pendingGrant: !!streakData.pendingGrant,
            pendingGrantStatus: streakData.pendingGrant ? streakData.pendingGrant.status : null,
            deadLetterKey: streakData.pendingGrant ? (streakData.pendingGrant.deadLetterKey || null) : null,
            nextReward: nextReward,
            timestamp: utils.getCurrentTimestamp()
        });
    }

    /**
     * DAILY PROGRESSION PLATFORM — single claim core.
     *
     * This is the ONLY implementation of "claim today's daily reward" in the entire
     * backend. Every claim RPC (canonical `daily_rewards_claim`, the consolidated
     * `daily_progress_claim`, and the legacy Arcade `quizverse_claim_daily_reward`)
     * MUST delegate here. Do not fork this logic.
     *
     * Returns:
     *   { ok: true,  streakData, reward, walletGranted }
     *   { ok: false, error, reason, deadLetterKey? }
     */
    function performDailyClaim(nk, logger, userId, gameId) {
        // Get current streak data (runs migration/reconcile side-effects up front so
        // the versioned read below sees a settled record).
        var streakData = getStreakData(nk, logger, userId, gameId);
        streakData = updateStreakStatus(nk, logger, userId, gameId, streakData);

        // Resume incomplete claims BEFORE treating today as a fresh claim.
        // pendingGrant = OCC committed but wallet not finalized (claim-in-progress lock).
        var claimCheck = canClaimToday(streakData);
        if (claimCheck.reason === "pending_grant_resume") {
            return resumePendingDailyGrant(nk, logger, userId, gameId, streakData);
        }
        if (!claimCheck.canClaim) {
            return { ok: false, error: "Cannot claim reward: " + claimCheck.reason, reason: claimCheck.reason };
        }

        // ── ATOMIC CLAIM (OCC + pendingGrant lock) ───────────────────────────────
        // Commit streak WITH pendingGrant so concurrent callers see claim-in-progress
        // and resume (idempotent grant lock) instead of already_claimed_today.
        var reward = null;
        var committed = false;
        var preClaimSnapshot = null;
        var claimDateStr = null;
        for (var attempt = 0; attempt < 2 && !committed; attempt++) {
            var raw = readStreakRawWithVersion(nk, userId, gameId);
            var claimState = raw.value || streakData;
            if (typeof claimState.bestStreak !== "number") claimState.bestStreak = claimState.currentStreak || 0;
            if (!claimState.claimHistory) claimState.claimHistory = [];

            var recheck = canClaimToday(claimState);
            if (recheck.reason === "pending_grant_resume") {
                return resumePendingDailyGrant(nk, logger, userId, gameId, claimState);
            }
            if (!recheck.canClaim) {
                return { ok: false, error: "Cannot claim reward: " + recheck.reason, reason: recheck.reason };
            }

            var snapshotBeforeClaim = JSON.parse(JSON.stringify(claimState));
            if (snapshotBeforeClaim.pendingGrant) delete snapshotBeforeClaim.pendingGrant;

            var lastClaimTs = claimState.lastClaimTimestamp || 0;
            if (lastClaimTs > 0) {
                var lastDate = getUtcDateStringFromUnix(lastClaimTs);
                var today = getTodayUtcDateString();
                var lastDayStart = getUtcDayStartUnixFromDateString(lastDate);
                var todayDayStart = getUtcDayStartUnixFromDateString(today);
                var dayDiff = Math.floor((todayDayStart - lastDayStart) / 86400);
                if (dayDiff > 1 || !utils.isWithinHours(lastClaimTs, utils.getUnixTimestamp(), 48)) {
                    claimState.currentStreak = 0;
                }
            }

            claimState.currentStreak = (claimState.currentStreak || 0) + 1;
            claimState.lastClaimTimestamp = utils.getUnixTimestamp();
            claimState.totalClaims = (claimState.totalClaims || 0) + 1;
            claimState.updatedAt = utils.getCurrentTimestamp();

            if (claimState.currentStreak > (claimState.bestStreak || 0)) {
                claimState.bestStreak = claimState.currentStreak;
            }

            var claimDate = new Date(claimState.lastClaimTimestamp * 1000);
            claimDateStr = claimDate.getUTCFullYear() + "-" +
                (claimDate.getUTCMonth() + 1 < 10 ? "0" : "") + (claimDate.getUTCMonth() + 1) + "-" +
                (claimDate.getUTCDate() < 10 ? "0" : "") + claimDate.getUTCDate();
            if (claimState.claimHistory[claimState.claimHistory.length - 1] !== claimDateStr) {
                claimState.claimHistory.push(claimDateStr);
                while (claimState.claimHistory.length > 90) {
                    claimState.claimHistory.shift();
                }
            }

            reward = getRewardForDay(gameId, claimState.currentStreak);

            // Claim-in-progress lock: concurrent claims resume this instead of rejecting.
            claimState.pendingGrant = {
                status: "pending_wallet",
                game: reward.game || 0,
                xp: reward.xp || 0,
                claimDate: claimDateStr,
                reward: reward,
                preClaimSnapshot: snapshotBeforeClaim,
                startedAt: utils.getUnixTimestamp()
            };

            if (saveStreakDataVersioned(nk, logger, userId, gameId, claimState, raw.version)) {
                committed = true;
                streakData = claimState;
                preClaimSnapshot = snapshotBeforeClaim;
            }
        }

        if (!committed) {
            return { ok: false, error: "Failed to save streak data (concurrent update)", reason: "concurrent_update" };
        }

        utils.logInfo(logger, "User " + userId + " claimed day " + streakData.currentStreak + " reward for game " + gameId);

        // ACTIVE PATH: storage wallets via grant lock (idempotent). Never nk.walletUpdate.
        // Prefer `game` (canonical coin grant). Fall back to `tokens` only for
        // legacy reward rows that omit `game` — never grant 0 when a reward exists.
        var grant = (reward && (reward.game || reward.tokens)) || 0;
        var xpGrant = (reward && reward.xp) || 0;
        var walletGranted = { game: grant, xp: xpGrant };
        try {
            if (grant > 0 || xpGrant > 0) {
                var applied = applyStorageWalletGrant(nk, logger, userId, gameId, grant, xpGrant, claimDateStr);
                walletGranted = applied.walletGranted;
                logger.info("[DailyRewards] Granted storage wallet: " + JSON.stringify(walletGranted) + " to " + userId);
            }
            finalizePendingGrantOnStreak(nk, logger, userId, gameId, streakData, claimDateStr);
        } catch (walletErr) {
            var grantMsg = (walletErr && walletErr.message) ? walletErr.message : String(walletErr);
            if (grantMsg === "claim_in_progress") {
                return { ok: false, error: "Claim wallet grant already in progress", reason: "claim_in_progress" };
            }
            logger.error("[DailyRewards] Wallet grant failed after claim commit: " + grantMsg);
            return rollbackFailedGrant(nk, logger, userId, gameId, streakData, preClaimSnapshot, reward, grantMsg);
        }

        // Transaction log only after successful finalize (avoid false claim history).
        var transactionKey = "transaction_log_" + userId + "_" + utils.getUnixTimestamp();
        utils.writeStorage(nk, logger, "transaction_logs", transactionKey, userId, {
            userId: userId,
            gameId: gameId,
            type: "daily_reward_claim",
            day: streakData.currentStreak,
            reward: reward,
            timestamp: utils.getCurrentTimestamp()
        });

        return { ok: true, streakData: streakData, reward: reward, walletGranted: walletGranted };
    }

    /**
     * Admin / S2S reconcile for dead-lettered daily claims.
     * Payload: { action: "list"|"complete_grant"|"revert_streak"|"dismiss", deadLetterKey?, userId?, gameId?, limit? }
     */
    function rpcDailyRewardsReconcile(ctx, logger, nk, payload) {
        try {
            if (typeof RpcHelpers !== "undefined" && RpcHelpers.requireAdmin) {
                RpcHelpers.requireAdmin(ctx, nk);
            } else if (ctx.userId) {
                throw new Error("Admin access required");
            }
        } catch (adminErr) {
            return utils.handleError(ctx, null, (adminErr && adminErr.message) ? adminErr.message : "Admin access required");
        }

        var parsed = utils.safeJsonParse(payload || "{}");
        if (!parsed.success) {
            return utils.handleError(ctx, null, "Invalid JSON payload");
        }
        var data = parsed.data || {};
        var action = data.action || "list";

        if (action === "list") {
            var limit = data.limit || 50;
            if (limit > 100) limit = 100;
            var listed = nk.storageList(DAILY_REWARD_SYSTEM_USER, DAILY_REWARD_DEAD_LETTERS, limit, data.cursor || "");
            var items = [];
            var objects = (listed && listed.objects) ? listed.objects : [];
            for (var i = 0; i < objects.length; i++) {
                items.push({ key: objects[i].key, value: objects[i].value });
            }
            return JSON.stringify({
                success: true,
                action: "list",
                items: items,
                cursor: (listed && listed.cursor) ? listed.cursor : ""
            });
        }

        if (!data.deadLetterKey) {
            return utils.handleError(ctx, null, "deadLetterKey required for action " + action);
        }

        var dlReads = nk.storageRead([{
            collection: DAILY_REWARD_DEAD_LETTERS,
            key: data.deadLetterKey,
            userId: DAILY_REWARD_SYSTEM_USER
        }]);
        if (!dlReads || dlReads.length === 0 || !dlReads[0].value) {
            return utils.handleError(ctx, null, "Dead letter not found: " + data.deadLetterKey);
        }
        var dl = dlReads[0].value;
        if (dl.status !== "open" && action !== "dismiss") {
            return JSON.stringify({ success: true, action: action, status: dl.status, message: "already resolved" });
        }

        var userId = dl.userId;
        var gameId = dl.gameId;
        var claimDate = dl.claimDate || getTodayUtcDateString();

        if (action === "complete_grant") {
            var streakData = getStreakData(nk, logger, userId, gameId);
            var grant = (dl.reward && dl.reward.game) || (streakData.pendingGrant && streakData.pendingGrant.game) || 0;
            var xpGrant = (dl.reward && dl.reward.xp) || (streakData.pendingGrant && streakData.pendingGrant.xp) || 0;
            try {
                if (grant > 0 || xpGrant > 0) {
                    applyStorageWalletGrant(nk, logger, userId, gameId, grant, xpGrant, claimDate);
                }
                finalizePendingGrantOnStreak(nk, logger, userId, gameId, streakData, claimDate);
                dl.status = "resolved_complete_grant";
                dl.resolvedAt = utils.getCurrentTimestamp();
                dl.resolvedBy = ctx.userId || "http_key";
                nk.storageWrite([{
                    collection: DAILY_REWARD_DEAD_LETTERS,
                    key: data.deadLetterKey,
                    userId: DAILY_REWARD_SYSTEM_USER,
                    value: dl,
                    permissionRead: 0,
                    permissionWrite: 0
                }]);
                return JSON.stringify({ success: true, action: action, userId: userId, gameId: gameId });
            } catch (completeErr) {
                return utils.handleError(ctx, null, "complete_grant failed: " + ((completeErr && completeErr.message) ? completeErr.message : String(completeErr)));
            }
        }

        if (action === "revert_streak") {
            if (!dl.preClaimSnapshot) {
                return utils.handleError(ctx, null, "Dead letter has no preClaimSnapshot");
            }
            try {
                var snap = dl.preClaimSnapshot;
                if (snap.pendingGrant) delete snap.pendingGrant;
                saveStreakData(nk, logger, userId, gameId, snap);
                var lock = readGrantLock(nk, userId, gameId, claimDate);
                if (lock.value) {
                    lock.value.status = "reverted";
                    lock.value.updatedAt = utils.getCurrentTimestamp();
                    writeGrantLock(nk, logger, userId, gameId, claimDate, lock.value, lock.version);
                }
                dl.status = "resolved_revert_streak";
                dl.resolvedAt = utils.getCurrentTimestamp();
                dl.resolvedBy = ctx.userId || "http_key";
                nk.storageWrite([{
                    collection: DAILY_REWARD_DEAD_LETTERS,
                    key: data.deadLetterKey,
                    userId: DAILY_REWARD_SYSTEM_USER,
                    value: dl,
                    permissionRead: 0,
                    permissionWrite: 0
                }]);
                return JSON.stringify({ success: true, action: action, userId: userId, gameId: gameId });
            } catch (revertErr) {
                return utils.handleError(ctx, null, "revert_streak failed: " + ((revertErr && revertErr.message) ? revertErr.message : String(revertErr)));
            }
        }

        if (action === "dismiss") {
            dl.status = "dismissed";
            dl.resolvedAt = utils.getCurrentTimestamp();
            dl.resolvedBy = ctx.userId || "http_key";
            nk.storageWrite([{
                collection: DAILY_REWARD_DEAD_LETTERS,
                key: data.deadLetterKey,
                userId: DAILY_REWARD_SYSTEM_USER,
                value: dl,
                permissionRead: 0,
                permissionWrite: 0
            }]);
            return JSON.stringify({ success: true, action: action });
        }

        return utils.handleError(ctx, null, "Unknown action: " + action);
    }

    /**
     * RPC: Claim daily reward (LEGACY-COMPATIBLE WRAPPER).
     * Thin shell over performDailyClaim — keeps the response shape shipped clients
     * expect. New clients should use `daily_progress_claim` (daily_progress.js),
     * which returns the full progression state in the same round-trip.
     * @param {string} payload - JSON payload with { gameId: "uuid" }
     */
    function rpcDailyRewardsClaim(ctx, logger, nk, payload) {
        utils.logInfo(logger, "RPC daily_rewards_claim called");

        var parsed = utils.safeJsonParse(payload);
        if (!parsed.success) {
            return utils.handleError(ctx, null, "Invalid JSON payload");
        }

        var data = parsed.data;
        var validation = utils.validatePayload(data, ['gameId']);
        if (!validation.valid) {
            return utils.handleError(ctx, null, "Missing required fields: " + validation.missing.join(", "));
        }

        var gameId = data.gameId;
        if (!utils.isValidUUID(gameId)) {
            return utils.handleError(ctx, null, "Invalid gameId UUID format");
        }

        var userId = ctx.userId;
        if (!userId) {
            return utils.handleError(ctx, null, "User not authenticated");
        }

        var result = performDailyClaim(nk, logger, userId, gameId);
        if (!result.ok) {
            return JSON.stringify({
                success: false,
                error: result.error,
                reason: result.reason || null,
                deadLetterKey: result.deadLetterKey || null,
                canClaimToday: result.reason === "pending_grant_resume" || result.reason === "wallet_grant_failed"
            });
        }

        // QVBF_166: emit both `streak`/`newStreak` so C# DailyRewardClaim
        // [JsonProperty("streak")] → newStreak deserializes the correct value.
        return JSON.stringify({
            success: true,
            userId: userId,
            gameId: gameId,
            streak: result.streakData.currentStreak,        // canonical — C# [JsonProperty("streak")] → newStreak
            newStreak: result.streakData.currentStreak,     // legacy alias
            currentStreak: result.streakData.currentStreak, // extra alias for safety
            bestStreak: result.streakData.bestStreak || 0,  // QVBF_51: lifetime best
            totalClaims: result.streakData.totalClaims,
            reward: result.reward,
            walletGranted: result.walletGranted,
            claimedAt: utils.getCurrentTimestamp()
        });
    }

    /**
     * RPC: Get claim history (QVBF_51 — feeds the Streak Dashboard activity
     * heatmap and Best Streak card).
     * @param {string} payload - JSON payload with { gameId: "uuid" }
     * @returns {string} JSON response with claimHistory (UTC YYYY-MM-DD, max 90)
     */
    function rpcDailyRewardsGetHistory(ctx, logger, nk, payload) {
        utils.logInfo(logger, "RPC daily_rewards_get_history called");

        var parsed = utils.safeJsonParse(payload);
        if (!parsed.success) {
            return utils.handleError(ctx, null, "Invalid JSON payload");
        }

        var data = parsed.data;
        var validation = utils.validatePayload(data, ['gameId']);
        if (!validation.valid) {
            return utils.handleError(ctx, null, "Missing required fields: " + validation.missing.join(", "));
        }

        var gameId = data.gameId;
        if (!utils.isValidUUID(gameId)) {
            return utils.handleError(ctx, null, "Invalid gameId UUID format");
        }

        var userId = ctx.userId;
        if (!userId) {
            return utils.handleError(ctx, null, "User not authenticated");
        }

        var streakData = getStreakData(nk, logger, userId, gameId);
        streakData = updateStreakStatus(nk, logger, userId, gameId, streakData);

        return JSON.stringify({
            success: true,
            userId: userId,
            gameId: gameId,
            currentStreak: streakData.currentStreak,
            bestStreak: streakData.bestStreak || 0,
            totalClaims: streakData.totalClaims,
            claimHistory: streakData.claimHistory || [],
            timestamp: utils.getCurrentTimestamp()
        });
    }

    // ============================================================================
    // Registration (QVBF_51)
    // ============================================================================
    // postbuild.js renames this `InitModule` -> `__ModuleInit_N` so it never
    // executes directly. Its purpose is to expose literal registerRpc calls so
    // postbuild can:
    //   1) detect the RPC ids and create __rpc_* stub variables
    //   2) rewrite each call into a guarded `__rpc_id = __rpc_id || handler`
    //   3) replay those assignments at global scope BEFORE legacy fallbacks
    //      (modules-first ordering), so THESE handlers win the stub race
    //   4) emit `initializer.registerRpc("<id>", __rpc_<id>)` in the master InitModule

    // Before this block existed, daily_rewards_get_status / daily_rewards_claim
    // were silently served by the stale TS LegacyDailyRewards copy (wrong response
    // envelope -> Unity always saw streak 0; root cause of QVBF_51).
    // LegacyDailyRewards.ts was removed, so this module now serves as the canonical
    function InitModule(ctx, logger, nk, initializer) {
        initializer.registerRpc("daily_rewards_get_status", rpcDailyRewardsGetStatus);
        initializer.registerRpc("daily_rewards_claim", rpcDailyRewardsClaim);
        initializer.registerRpc("daily_rewards_get_history", rpcDailyRewardsGetHistory);
        initializer.registerRpc("daily_rewards_reconcile", rpcDailyRewardsReconcile);
        logger.info("[DailyRewards] Module InitModule registered: 4 RPCs");
    }
