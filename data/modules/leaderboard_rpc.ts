// Copyright 2025 The Nakama Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

interface LeaderboardRecord {
    leaderboardId: string;
    gameId?: string;
    scope: string;
    createdAt: string;
}

function createAllLeaderboardsPersistent(ctx: nkruntime.Context, payload: string): string {
    const tokenUrl = "https://api.intelli-verse-x.ai/api/admin/oauth/token";
    const gamesUrl = "https://api.intelli-verse-x.ai/api/games/all";

    const client_id = "54clc0uaqvr1944qvkas63o0rb";
    const client_secret = "1eb7ooua6ft832nh8dpmi37mos4juqq27svaqvmkt5grc3b7e377";

    const sort = "desc";
    const operator = "best";
    const resetSchedule = "0 0 * * 0"; // Weekly reset
    const collection = "leaderboards_registry";

    // Fetch existing records to skip duplicates
    let existingRecords: LeaderboardRecord[] = [];
    try {
        const records = nk.storageRead([{ collection, key: "all_created", userId: ctx.userId || "system" }]);
        if (records && records.length > 0 && records[0].value) {
            existingRecords = records[0].value as LeaderboardRecord[];
        }
    } catch (err) {
        nk.loggerWarn(`Failed to read existing leaderboard records: ${err}`);
    }

    const existingIds = new Set(existingRecords.map(r => r.leaderboardId));
    const created: string[] = [];
    const skipped: string[] = [];

    // Step 1: Request token
    nk.loggerInfo("Requesting IntelliVerse OAuth token...");
    let tokenResponse;
    try {
        tokenResponse = nk.httpRequest(tokenUrl, "post", {
            "accept": "application/json",
            "Content-Type": "application/json"
        }, JSON.stringify({
            client_id,
            client_secret
        }));
    } catch (err) {
        return JSON.stringify({ success: false, error: `Token request failed: ${err.message}` });
    }

    if (tokenResponse.code !== 200) {
        return JSON.stringify({ success: false, error: `Token request failed with code ${tokenResponse.code}` });
    }

    let tokenData;
    try {
        tokenData = JSON.parse(tokenResponse.body);
    } catch (err) {
        return JSON.stringify({ success: false, error: "Invalid token response JSON." });
    }

    const accessToken = tokenData.access_token;
    if (!accessToken) {
        return JSON.stringify({ success: false, error: "No access_token in response." });
    }

    // Step 2: Fetch game list
    nk.loggerInfo("Fetching onboarded game list...");
    let gameResponse;
    try {
        gameResponse = nk.httpRequest(gamesUrl, "get", {
            "accept": "application/json",
            "Authorization": `Bearer ${accessToken}`
        });
    } catch (err) {
        return JSON.stringify({ success: false, error: `Game fetch failed: ${err.message}` });
    }

    if (gameResponse.code !== 200) {
        return JSON.stringify({ success: false, error: `Game API responded with ${gameResponse.code}` });
    }

    let games;
    try {
        const parsed = JSON.parse(gameResponse.body);
        games = parsed.data || [];
    } catch (err) {
        return JSON.stringify({ success: false, error: "Invalid games JSON format." });
    }

    // Step 3: Create global leaderboard if missing
    const globalId = "leaderboard_global";
    if (!existingIds.has(globalId)) {
        try {
            nk.leaderboardCreate(globalId, true, sort, operator, resetSchedule, { scope: "global", desc: "Global Ecosystem Leaderboard" });
            created.push(globalId);
            existingRecords.push({ leaderboardId: globalId, scope: "global", createdAt: new Date().toISOString() });
        } catch (err) {
            skipped.push(globalId);
        }
    } else {
        skipped.push(globalId);
    }

    // Step 4: Create per-game leaderboards
    nk.loggerInfo(`Processing ${games.length} games for leaderboard creation...`);
    for (const game of games) {
        if (!game.id) continue;
        const leaderboardId = `leaderboard_${game.id}`;
        if (existingIds.has(leaderboardId)) {
            skipped.push(leaderboardId);
            continue;
        }
        try {
            nk.leaderboardCreate(leaderboardId, true, sort, operator, resetSchedule, {
                desc: `Leaderboard for ${game.gameTitle || "Untitled Game"}`,
                gameId: game.id,
                scope: "game"
            });
            created.push(leaderboardId);
            existingRecords.push({
                leaderboardId,
                gameId: game.id,
                scope: "game",
                createdAt: new Date().toISOString()
            });
        } catch (err) {
            skipped.push(leaderboardId);
        }
    }

    // Step 5: Persist record of created leaderboards
    try {
        nk.storageWrite([{
            collection,
            key: "all_created",
            userId: ctx.userId || "system",
            value: existingRecords,
            permissionRead: 1,
            permissionWrite: 0
        }]);
    } catch (err) {
        nk.loggerError(`Failed to write leaderboard records: ${err.message}`);
    }

    return JSON.stringify({
        success: true,
        created,
        skipped,
        totalProcessed: games.length,
        storedRecords: existingRecords.length
    });
}

nk.registerRpc(createAllLeaderboardsPersistent, "create_all_leaderboards_persistent");

// Score payload interface
interface ScorePayload {
    gameId: string;
    score: number;
    metadata?: Record<string, any>;
}

// Submit score sync: writes to both game and global leaderboards
function submitScoreSync(ctx: nkruntime.Context, payload: string): string {
    if (!payload) return JSON.stringify({ success: false, error: "Missing payload." });

    let data: ScorePayload;
    try {
        data = JSON.parse(payload);
    } catch {
        return JSON.stringify({ success: false, error: "Invalid JSON payload." });
    }

    if (!data.gameId || data.score === undefined) {
        return JSON.stringify({ success: false, error: "Missing gameId or score." });
    }

    const userId = ctx.userId || "anonymous";
    const username = ctx.username || "Guest";

    // Step 1: Read known leaderboards from registry
    const collection = "leaderboards_registry";
    let registered: LeaderboardRecord[] = [];
    try {
        const results = nk.storageRead([{ collection, key: "all_created", userId: ctx.userId || "system" }]);
        if (results && results.length && results[0].value) {
            registered = results[0].value as LeaderboardRecord[];
        }
    } catch (err) {
        nk.loggerWarn(`Could not read leaderboard registry: ${err.message}`);
    }

    const globalId = "leaderboard_global";
    const gameLeaderboardId = `leaderboard_${data.gameId}`;

    // Step 2: Verify existence or log warning
    const existingIds = new Set(registered.map(r => r.leaderboardId));
    if (!existingIds.has(globalId)) nk.loggerWarn(`Global leaderboard missing.`);
    if (!existingIds.has(gameLeaderboardId)) nk.loggerWarn(`Per-game leaderboard missing for ${data.gameId}.`);

    // Step 3: Write score to per-game leaderboard
    try {
        nk.leaderboardRecordWrite(gameLeaderboardId, userId, username, data.score, data.metadata || {
            source: "game",
            gameId: data.gameId,
            submittedAt: new Date().toISOString()
        });
    } catch (err) {
        nk.loggerError(`Failed writing score to ${gameLeaderboardId}: ${err.message}`);
    }

    // Step 4: Write score also to global leaderboard
    try {
        nk.leaderboardRecordWrite(globalId, userId, username, data.score, data.metadata || {
            source: "global",
            gameId: data.gameId,
            submittedAt: new Date().toISOString()
        });
    } catch (err) {
        nk.loggerError(`Failed writing score to ${globalId}: ${err.message}`);
    }

    return JSON.stringify({
        success: true,
        message: `Score successfully synced across game and global leaderboards.`,
        gameId: data.gameId,
        userId,
        score: data.score
    });
}

nk.registerRpc(submitScoreSync, "submit_score_sync");

// Submit score with aggregate: writes individual scores and aggregates across all games
function submitScoreWithAggregate(ctx: nkruntime.Context, payload: string): string {
    if (!payload) return JSON.stringify({ success: false, error: "Missing payload." });

    let data: ScorePayload;
    try {
        data = JSON.parse(payload);
    } catch {
        return JSON.stringify({ success: false, error: "Invalid JSON payload." });
    }

    if (!data.gameId || data.score === undefined) {
        return JSON.stringify({ success: false, error: "Missing gameId or score." });
    }

    const userId = ctx.userId || "anonymous";
    const username = ctx.username || "Guest";

    const collection = "leaderboards_registry";
    const globalId = "leaderboard_global";
    const gameLeaderboardId = `leaderboard_${data.gameId}`;

    // Step 1: Read existing leaderboard registry
    let registered: LeaderboardRecord[] = [];
    try {
        const results = nk.storageRead([{ collection, key: "all_created", userId: ctx.userId || "system" }]);
        if (results && results.length && results[0].value) {
            registered = results[0].value as LeaderboardRecord[];
        }
    } catch (err) {
        nk.loggerWarn(`Cannot read leaderboard registry: ${err.message}`);
    }

    const existingIds = new Set(registered.map(r => r.leaderboardId));
    if (!existingIds.has(globalId)) nk.loggerWarn(`Global leaderboard missing.`);

    // Step 2: Write user score on game leaderboard
    try {
        nk.leaderboardRecordWrite(gameLeaderboardId, userId, username, data.score, data.metadata || {
            source: "game",
            gameId: data.gameId,
            submittedAt: new Date().toISOString()
        });
    } catch (err) {
        nk.loggerError(`Failed writing score to ${gameLeaderboardId}: ${err.message}`);
        return JSON.stringify({ success: false, error: `Failed writing game leaderboard score.` });
    }

    // Step 3: Write to global leaderboard as well (individual score)
    try {
        nk.leaderboardRecordWrite(globalId, userId, username, data.score, data.metadata || {
            source: "global_individual",
            gameId: data.gameId,
            submittedAt: new Date().toISOString()
        });
    } catch (err) {
        nk.loggerError(`Failed writing score to ${globalId}: ${err.message}`);
    }

    // Step 4: Aggregate total score across all per-game leaderboards for user
    let totalAggregate = 0;
    for (const record of registered) {
        if (record.scope !== "game") continue;
        try {
            const userRanks = nk.leaderboardRecordsHaystack(record.leaderboardId, userId, 1, 0);
            if (userRanks && userRanks.records && userRanks.records.length > 0) {
                const userScore = userRanks.records[0].score;
                totalAggregate += userScore;
            }
        } catch (err) {
            nk.loggerWarn(`Could not read leaderboard ${record.leaderboardId} for user ${userId}: ${err.message}`);
        }
    }

    // Step 5: Update user global power rank in global leaderboard with aggregate score
    try {
        nk.leaderboardRecordWrite(globalId, userId, username, totalAggregate, {
            source: "global_aggregate",
            submittedAt: new Date().toISOString(),
            aggregateScore: totalAggregate
        });
    } catch (err) {
        nk.loggerError(`Failed writing aggregate score to ${globalId}: ${err.message}`);
    }

    return JSON.stringify({
        success: true,
        message: "Score and aggregate updated successfully",
        gameId: data.gameId,
        userId,
        individualScore: data.score,
        aggregateScore: totalAggregate
    });
}

nk.registerRpc(submitScoreWithAggregate, "submit_score_with_aggregate");

// Create all leaderboards including friend leaderboards
function createAllLeaderboardsWithFriends(ctx: nkruntime.Context, payload: string): string {
    const tokenUrl = "https://api.intelli-verse-x.ai/api/admin/oauth/token";
    const gamesUrl = "https://api.intelli-verse-x.ai/api/games/all";

    const client_id = "54clc0uaqvr1944qvkas63o0rb";
    const client_secret = "1eb7ooua6ft832nh8dpmi37mos4juqq27svaqvmkt5grc3b7e377";

    const sort = "desc";
    const operator = "best";
    const resetSchedule = "0 0 * * 0"; // Weekly reset
    const collection = "leaderboards_registry";

    // Fetch existing records to skip duplicates
    let existingRecords: LeaderboardRecord[] = [];
    try {
        const records = nk.storageRead([{ collection, key: "all_created", userId: ctx.userId || "system" }]);
        if (records && records.length > 0 && records[0].value) {
            existingRecords = records[0].value as LeaderboardRecord[];
        }
    } catch (err) {
        nk.loggerWarn(`Failed to read existing leaderboard records: ${err}`);
    }

    const existingIds = new Set(existingRecords.map(r => r.leaderboardId));
    const created: string[] = [];
    const skipped: string[] = [];

    // Step 1: Request token
    nk.loggerInfo("Requesting IntelliVerse OAuth token...");
    let tokenResponse;
    try {
        tokenResponse = nk.httpRequest(tokenUrl, "post", {
            "accept": "application/json",
            "Content-Type": "application/json"
        }, JSON.stringify({
            client_id,
            client_secret
        }));
    } catch (err) {
        return JSON.stringify({ success: false, error: `Token request failed: ${err.message}` });
    }

    if (tokenResponse.code !== 200) {
        return JSON.stringify({ success: false, error: `Token request failed with code ${tokenResponse.code}` });
    }

    let tokenData;
    try {
        tokenData = JSON.parse(tokenResponse.body);
    } catch (err) {
        return JSON.stringify({ success: false, error: "Invalid token response JSON." });
    }

    const accessToken = tokenData.access_token;
    if (!accessToken) {
        return JSON.stringify({ success: false, error: "No access_token in response." });
    }

    // Step 2: Fetch game list
    nk.loggerInfo("Fetching onboarded game list...");
    let gameResponse;
    try {
        gameResponse = nk.httpRequest(gamesUrl, "get", {
            "accept": "application/json",
            "Authorization": `Bearer ${accessToken}`
        });
    } catch (err) {
        return JSON.stringify({ success: false, error: `Game fetch failed: ${err.message}` });
    }

    if (gameResponse.code !== 200) {
        return JSON.stringify({ success: false, error: `Game API responded with ${gameResponse.code}` });
    }

    let games;
    try {
        const parsed = JSON.parse(gameResponse.body);
        games = parsed.data || [];
    } catch (err) {
        return JSON.stringify({ success: false, error: "Invalid games JSON format." });
    }

    // Step 3: Create global leaderboards (normal and friend)
    const globalId = "leaderboard_global";
    const globalFriendId = "leaderboard_friends_global";

    if (!existingIds.has(globalId)) {
        try {
            nk.leaderboardCreate(globalId, true, sort, operator, resetSchedule, { scope: "global", desc: "Global Ecosystem Leaderboard" });
            created.push(globalId);
            existingRecords.push({ leaderboardId: globalId, scope: "global", createdAt: new Date().toISOString() });
        } catch (err) {
            skipped.push(globalId);
        }
    } else {
        skipped.push(globalId);
    }

    if (!existingIds.has(globalFriendId)) {
        try {
            nk.leaderboardCreate(globalFriendId, true, sort, operator, resetSchedule, { scope: "global_friends", desc: "Global Friends Leaderboard" });
            created.push(globalFriendId);
            existingRecords.push({ leaderboardId: globalFriendId, scope: "global_friends", createdAt: new Date().toISOString() });
        } catch (err) {
            skipped.push(globalFriendId);
        }
    } else {
        skipped.push(globalFriendId);
    }

    // Step 4: Create per-game leaderboards (normal and friend)
    nk.loggerInfo(`Processing ${games.length} games for leaderboard creation...`);
    for (const game of games) {
        if (!game.id) continue;

        const normalLb = `leaderboard_${game.id}`;
        const friendLb = `leaderboard_friends_${game.id}`;

        // Create normal leaderboard
        if (!existingIds.has(normalLb)) {
            try {
                nk.leaderboardCreate(normalLb, true, sort, operator, resetSchedule, {
                    desc: `Leaderboard for ${game.gameTitle || "Untitled Game"}`,
                    gameId: game.id,
                    scope: "game"
                });
                created.push(normalLb);
                existingRecords.push({
                    leaderboardId: normalLb,
                    gameId: game.id,
                    scope: "game",
                    createdAt: new Date().toISOString()
                });
            } catch (err) {
                skipped.push(normalLb);
            }
        } else {
            skipped.push(normalLb);
        }

        // Create friend leaderboard
        if (!existingIds.has(friendLb)) {
            try {
                nk.leaderboardCreate(friendLb, true, sort, operator, resetSchedule, {
                    desc: `Friends Leaderboard for ${game.gameTitle || "Untitled Game"}`,
                    gameId: game.id,
                    scope: "game_friends"
                });
                created.push(friendLb);
                existingRecords.push({
                    leaderboardId: friendLb,
                    gameId: game.id,
                    scope: "game_friends",
                    createdAt: new Date().toISOString()
                });
            } catch (err) {
                skipped.push(friendLb);
            }
        } else {
            skipped.push(friendLb);
        }
    }

    // Step 5: Persist record of created leaderboards
    try {
        nk.storageWrite([{
            collection,
            key: "all_created",
            userId: ctx.userId || "system",
            value: existingRecords,
            permissionRead: 1,
            permissionWrite: 0
        }]);
    } catch (err) {
        nk.loggerError(`Failed to write leaderboard records: ${err.message}`);
    }

    return JSON.stringify({
        success: true,
        created,
        skipped,
        totalProcessed: games.length,
        storedRecords: existingRecords.length
    });
}

nk.registerRpc(createAllLeaderboardsWithFriends, "create_all_leaderboards_with_friends");

// Submit score with friends sync: writes to normal and friend leaderboards
function submitScoreWithFriendsSync(ctx: nkruntime.Context, payload: string): string {
    if (!payload) return JSON.stringify({ success: false, error: "Missing payload." });

    let data: ScorePayload;
    try {
        data = JSON.parse(payload);
    } catch {
        return JSON.stringify({ success: false, error: "Invalid JSON payload." });
    }

    if (!data.gameId || data.score === undefined) {
        return JSON.stringify({ success: false, error: "Missing gameId or score." });
    }

    const userId = ctx.userId || "anonymous";
    const username = ctx.username || "Guest";

    const collection = "leaderboards_registry";
    const globalId = "leaderboard_global";
    const globalFriendId = "leaderboard_friends_global";
    const gameLeaderboardId = `leaderboard_${data.gameId}`;
    const gameFriendLeaderboardId = `leaderboard_friends_${data.gameId}`;

    // Read registered leaderboards
    let registered: LeaderboardRecord[] = [];
    try {
        const results = nk.storageRead([{ collection, key: "all_created", userId: ctx.userId || "system" }]);
        if (results && results.length && results[0].value) {
            registered = results[0].value as LeaderboardRecord[];
        }
    } catch {}

    const existingIds = new Set(registered.map(r => r.leaderboardId));

    // Write score to normal leaderboards
    try {
        if (existingIds.has(gameLeaderboardId)) {
            nk.leaderboardRecordWrite(gameLeaderboardId, userId, username, data.score, data.metadata || {
                source: "game",
                gameId: data.gameId,
                submittedAt: new Date().toISOString()
            });
        }
        if (existingIds.has(globalId)) {
            nk.leaderboardRecordWrite(globalId, userId, username, data.score, data.metadata || {
                source: "global_individual",
                gameId: data.gameId,
                submittedAt: new Date().toISOString()
            });
        }
    } catch {}

    // Write score to friend leaderboards
    try {
        if (existingIds.has(gameFriendLeaderboardId)) {
            nk.leaderboardRecordWrite(gameFriendLeaderboardId, userId, username, data.score, data.metadata || {
                source: "friends_game",
                gameId: data.gameId,
                submittedAt: new Date().toISOString()
            });
        }
        if (existingIds.has(globalFriendId)) {
            nk.leaderboardRecordWrite(globalFriendId, userId, username, data.score, data.metadata || {
                source: "friends_global",
                gameId: data.gameId,
                submittedAt: new Date().toISOString()
            });
        }
    } catch {}

    return JSON.stringify({ success: true, message: "Scores synced to normal and friend leaderboards." });
}

nk.registerRpc(submitScoreWithFriendsSync, "submit_score_with_friends_sync");

// Get friend leaderboard for game or global
function getFriendLeaderboard(ctx: nkruntime.Context, payload: string): string {
    if (!ctx.userId) return JSON.stringify({ success: false, error: "User must be authenticated." });

    // Payload: { gameId?: string, limit?: number }
    let params: { gameId?: string; limit?: number } = {};
    try {
        params = JSON.parse(payload || "{}");
    } catch {
        return JSON.stringify({ success: false, error: "Invalid JSON payload." });
    }

    const limit = params.limit || 20;
    const collection = "leaderboards_registry";

    let registered: LeaderboardRecord[] = [];
    try {
        const results = nk.storageRead([{ collection, key: "all_created", userId: ctx.userId || "system" }]);
        if (results && results.length && results[0].value) {
            registered = results[0].value as LeaderboardRecord[];
        }
    } catch {}

    const globalFriendId = "leaderboard_friends_global";
    let friendLeaderboardId = globalFriendId;
    if (params.gameId) {
        friendLeaderboardId = `leaderboard_friends_${params.gameId}`;
    }

    // Validate leaderboard existence
    const existingIds = new Set(registered.map(r => r.leaderboardId));
    if (!existingIds.has(friendLeaderboardId)) {
        return JSON.stringify({ success: false, error: "Friend leaderboard does not exist." });
    }

    // Get friend user ids
    let friends: string[] = [];
    try {
        const friendsRes = nk.friendsList(ctx.userId, limit, null, null);
        friends = friendsRes.friends.map(f => f.user.id);
        friends.push(ctx.userId); // Include self for own score
    } catch {
        return JSON.stringify({ success: false, error: "Failed to retrieve friends." });
    }

    // Fetch friend leaderboard records for this leaderboard
    let records;
    try {
        records = nk.leaderboardRecordsList(friendLeaderboardId, friends, limit, null, 0);
    } catch {
        return JSON.stringify({ success: false, error: "Failed to retrieve friend leaderboard records." });
    }

    return JSON.stringify({ success: true, leaderboard: records.records || [] });
}

nk.registerRpc(getFriendLeaderboard, "get_friend_leaderboard");

// Send friend invite
function sendFriendInvite(ctx: nkruntime.Context, payload: string): string {
    if (!ctx.userId) return JSON.stringify({ success: false, error: "Auth required." });
    let targetUserId: string;
    try {
        const data = JSON.parse(payload);
        targetUserId = data.targetUserId;
    } catch {
        return JSON.stringify({ success: false, error: "Invalid payload." });
    }
    if (!targetUserId) return JSON.stringify({ success: false, error: "targetUserId missing." });
    try {
        nk.friendAdd(ctx.userId, targetUserId, ctx.username || "");
        return JSON.stringify({ success: true, message: "Friend invite sent." });
    } catch (err) {
        return JSON.stringify({ success: false, error: `Failed to send friend invite: ${err.message}` });
    }
}

nk.registerRpc(sendFriendInvite, "send_friend_invite");

// Accept friend invite
function acceptFriendInvite(ctx: nkruntime.Context, payload: string): string {
    if (!ctx.userId) return JSON.stringify({ success: false, error: "Auth required." });
    let requesterUserId: string;
    try {
        const data = JSON.parse(payload);
        requesterUserId = data.requesterUserId;
    } catch {
        return JSON.stringify({ success: false, error: "Invalid payload." });
    }
    if (!requesterUserId) return JSON.stringify({ success: false, error: "requesterUserId missing." });
    try {
        nk.friendAdd(ctx.userId, requesterUserId, ctx.username || "");
        return JSON.stringify({ success: true, message: "Friend invite accepted." });
    } catch (err) {
        return JSON.stringify({ success: false, error: `Failed to accept friend invite: ${err.message}` });
    }
}

nk.registerRpc(acceptFriendInvite, "accept_friend_invite");

// Decline friend invite
function declineFriendInvite(ctx: nkruntime.Context, payload: string): string {
    if (!ctx.userId) return JSON.stringify({ success: false, error: "Auth required." });
    let requesterUserId: string;
    try {
        const data = JSON.parse(payload);
        requesterUserId = data.requesterUserId;
    } catch {
        return JSON.stringify({ success: false, error: "Invalid payload." });
    }
    if (!requesterUserId) return JSON.stringify({ success: false, error: "requesterUserId missing." });
    try {
        nk.friendBlock(ctx.userId, requesterUserId, ctx.username || "");
        return JSON.stringify({ success: true, message: "Friend invite declined." });
    } catch (err) {
        return JSON.stringify({ success: false, error: `Failed to decline friend invite: ${err.message}` });
    }
}

nk.registerRpc(declineFriendInvite, "decline_friend_invite");

// Get notifications for user
function getNotifications(ctx: nkruntime.Context, payload: string): string {
    if (!ctx.userId) return JSON.stringify({ success: false, error: "Auth required." });

    const limit = 30;
    try {
        const notifs = nk.notificationsList(ctx.userId, limit, null);
        return JSON.stringify({ success: true, notifications: notifs.notifications });
    } catch (err) {
        return JSON.stringify({ success: false, error: `Failed to retrieve notifications: ${err.message}` });
    }
}

nk.registerRpc(getNotifications, "get_notifications");

// Helper function: send notification to a user
function sendNotificationToUser(userId: string, content: Record<string, any>, subject: string) {
    try {
        nk.notificationSend(userId, subject, content, 1, "", true);
    } catch (err) {
        nk.loggerWarn(`Failed to send notification to user ${userId}: ${err.message}`);
    }
}

// Notify friends on score submission
function notifyFriendsOnScore(ctx: nkruntime.Context, userId: string, gameId: string, score: number) {
    try {
        const friends = nk.friendsList(userId, 100, null, null);
        for (const friend of friends.friends) {
            sendNotificationToUser(
                friend.user.id,
                { message: `${ctx.username} scored ${score} in ${gameId}!` },
                "Friend Score Update"
            );
        }
    } catch (err) {
        nk.loggerWarn(`Failed to notify friends: ${err.message}`);
    }
}
