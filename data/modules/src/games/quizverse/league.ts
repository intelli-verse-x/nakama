// league.ts — Weekly competitive leagues for QuizVerse (Phase 3).
//
// WHY THIS EXISTS
// ---------------
// quiz-verse-prod already ships LeagueManager.cs + LeagueScreen.cs which call
//   league_get_state / league_submit_points / league_get_leaderboard
// on Nakama — but those RPCs were never implemented (verified absent from the
// bundle), so the whole league UI sat dead (RefreshLeagueStateAsync returned
// null). This module implements the three RPCs against the EXACT response shapes
// the Unity DTOs deserialize (LeagueStateData / SubmitPointsResponse /
// LeagueLeaderboardData), so the existing UI lights up with no client changes.
//
// MODEL (mirrors the Unity client)
//   6 tiers: bronze < silver < gold < platinum < diamond < elite.
//   Weekly seasons (ISO year-week). At each rollover we promote/demote based on
//   last week's points + quiz count, then reset the weekly counters.
//   Per-tier XP multiplier rewards higher tiers.
//
// STORAGE
//   collection "league_state", key "quizverse", per-user:
//     { season, tierIndex, points, quizzesThisWeek, perfectRounds, accuracySum,
//       recentSubmissions[] }
//   Leaderboard per tier+season: id "league_{tier}_{season}", authoritative,
//   DESCENDING/BEST, with per-record metadata {quizzesThisWeek, perfectRounds,
//   averageAccuracy, avatarUrl} so the board is self-sufficient for the UI.
namespace QuizVerseLeague {

  const COLLECTION = "league_state";
  const STATE_KEY = "quizverse";
  const MIN_QUIZZES_TO_RANK = 3;
  const MAX_RECENT_SUBMISSIONS = 30;

  const TIER_NAMES = ["bronze", "silver", "gold", "platinum", "diamond", "elite"];
  // Points needed (within a week) to promote out of tier i. Top tier never promotes.
  const PROMOTION_THRESHOLD = [1000, 2000, 3500, 5000, 7000, 0];
  // Below this at week end ⇒ demote (bronze never demotes).
  const DEMOTION_THRESHOLD = [0, 500, 900, 1500, 2200, 3000];
  const XP_MULTIPLIER = [1.0, 1.05, 1.1, 1.2, 1.35, 1.5];

  interface LeagueState {
    season: string;
    tierIndex: number;
    points: number;
    quizzesThisWeek: number;
    perfectRounds: number;
    accuracySum: number;   // sum of per-quiz accuracy (0..100) → average on read
    recentSubmissions: string[];
  }

  // ─── Season helpers (ISO year-week, UTC) ─────────────────────────────
  function isoWeek(d: Date): { year: number; week: number } {
    // Copy, shift to nearest Thursday (ISO weeks belong to the year of their Thu)
    var date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    var day = (date.getUTCDay() + 6) % 7; // Mon=0..Sun=6
    date.setUTCDate(date.getUTCDate() - day + 3);
    var firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
    var firstDay = (firstThursday.getUTCDay() + 6) % 7;
    firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
    var week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
    return { year: date.getUTCFullYear(), week: week };
  }

  function currentSeason(): string {
    var w = isoWeek(new Date());
    var ww = w.week < 10 ? "0" + w.week : "" + w.week;
    return w.year + "-W" + ww;
  }

  // Next Monday 00:00 UTC — when the current weekly season ends.
  function seasonEndsAt(): string {
    var now = new Date();
    var day = (now.getUTCDay() + 6) % 7; // Mon=0..Sun=6
    var daysUntilNextMon = 7 - day;
    var end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilNextMon));
    return end.toISOString();
  }

  function clampTier(i: number): number {
    if (i < 0) return 0;
    if (i > TIER_NAMES.length - 1) return TIER_NAMES.length - 1;
    return i;
  }

  function lbId(tierIndex: number, season: string): string {
    return "league_" + TIER_NAMES[clampTier(tierIndex)] + "_" + season;
  }

  function ensureLeaderboard(nk: nkruntime.Nakama, id: string): void {
    try {
      nk.leaderboardCreate(id, true, nkruntime.SortOrder.DESCENDING, nkruntime.Operator.BEST, "", {});
    } catch (_) {
      // Already exists — leaderboardCreate throws on duplicate; safe to ignore.
    }
  }

  function defaultState(): LeagueState {
    return {
      season: currentSeason(),
      tierIndex: 0,
      points: 0,
      quizzesThisWeek: 0,
      perfectRounds: 0,
      accuracySum: 0,
      recentSubmissions: [],
    };
  }

  function load(nk: nkruntime.Nakama, userId: string): { state: LeagueState; version: string | undefined } {
    try {
      var recs = nk.storageRead([{ collection: COLLECTION, key: STATE_KEY, userId: userId }]);
      if (recs && recs.length > 0 && recs[0].value) {
        var v = recs[0].value as Partial<LeagueState>;
        var s = defaultState();
        if (typeof v.season === "string") s.season = v.season;
        if (typeof v.tierIndex === "number") s.tierIndex = clampTier(v.tierIndex);
        if (typeof v.points === "number") s.points = v.points;
        if (typeof v.quizzesThisWeek === "number") s.quizzesThisWeek = v.quizzesThisWeek;
        if (typeof v.perfectRounds === "number") s.perfectRounds = v.perfectRounds;
        if (typeof v.accuracySum === "number") s.accuracySum = v.accuracySum;
        if (v.recentSubmissions && v.recentSubmissions.length) s.recentSubmissions = v.recentSubmissions;
        return { state: s, version: recs[0].version };
      }
    } catch (_) { /* fall through */ }
    return { state: defaultState(), version: undefined };
  }

  function save(nk: nkruntime.Nakama, userId: string, s: LeagueState, version: string | undefined): void {
    var write: nkruntime.StorageWriteRequest = {
      collection: COLLECTION,
      key: STATE_KEY,
      userId: userId,
      value: s as any,
      permissionRead: 1,
      permissionWrite: 0, // server-only; points are authoritative
    };
    if (version) (write as any).version = version;
    nk.storageWrite([write]);
  }

  // Apply weekly rollover (promote/demote + reset) when the stored season is
  // stale. Returns true if the state changed (caller should persist).
  function applyRollover(s: LeagueState): boolean {
    var season = currentSeason();
    if (s.season === season) return false;

    var promoteAt = PROMOTION_THRESHOLD[s.tierIndex];
    var demoteAt = DEMOTION_THRESHOLD[s.tierIndex];
    if (promoteAt > 0 && s.points >= promoteAt && s.quizzesThisWeek >= MIN_QUIZZES_TO_RANK) {
      s.tierIndex = clampTier(s.tierIndex + 1);
    } else if (s.tierIndex > 0 && s.points < demoteAt) {
      s.tierIndex = clampTier(s.tierIndex - 1);
    }

    s.season = season;
    s.points = 0;
    s.quizzesThisWeek = 0;
    s.perfectRounds = 0;
    s.accuracySum = 0;
    s.recentSubmissions = [];
    return true;
  }

  function avgAccuracy(s: LeagueState): number {
    if (s.quizzesThisWeek <= 0) return 0;
    return Math.round(s.accuracySum / s.quizzesThisWeek);
  }

  function qualifies(s: LeagueState): boolean {
    var t = PROMOTION_THRESHOLD[s.tierIndex];
    return t > 0 && s.points >= t && s.quizzesThisWeek >= MIN_QUIZZES_TO_RANK;
  }

  // ─── RPC: league_get_state ───────────────────────────────────────────
  function rpcGetState(ctx: nkruntime.Context, _logger: nkruntime.Logger, nk: nkruntime.Nakama, _payload: string): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var loaded = load(nk, userId);
    var s = loaded.state;
    var changed = applyRollover(s);
    var isNew = loaded.version === undefined;
    if (changed || isNew) save(nk, userId, s, loaded.version);

    var promoteAt = PROMOTION_THRESHOLD[s.tierIndex];
    var demoteAt = DEMOTION_THRESHOLD[s.tierIndex];

    return JSON.stringify({
      success: true,
      isNew: isNew,
      userId: userId,
      gameId: "quizverse",
      tier: TIER_NAMES[s.tierIndex],
      tierIndex: s.tierIndex,
      points: s.points,
      quizzesThisWeek: s.quizzesThisWeek,
      perfectRounds: s.perfectRounds,
      averageAccuracy: avgAccuracy(s),
      season: s.season,
      seasonEndsAt: seasonEndsAt(),
      minQuizzesRequired: MIN_QUIZZES_TO_RANK,
      qualifiesForPromotion: qualifies(s),
      promotionThreshold: promoteAt,
      demotionThreshold: demoteAt,
      xpMultiplier: XP_MULTIPLIER[s.tierIndex],
      canPromote: promoteAt > 0,
      canDemote: s.tierIndex > 0,
      timestamp: new Date().toISOString(),
    });
  }

  // ─── RPC: league_submit_points ───────────────────────────────────────
  function rpcSubmitPoints(ctx: nkruntime.Context, _logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload);

    var rawPoints = (typeof data.points === "number") ? Math.floor(data.points) : 0;
    if (rawPoints <= 0 || rawPoints > 10000) {
      return JSON.stringify({ success: false, error: "invalid_points" });
    }
    var accuracy = (typeof data.accuracy === "number") ? data.accuracy : 0; // 0..1
    var isPerfect = data.isPerfect === true;
    var submissionId = "" + (data.submissionId || "");

    var loaded = load(nk, userId);
    var s = loaded.state;
    applyRollover(s);

    // Idempotency — server-side guard against double submits / retries.
    if (submissionId) {
      for (var i = 0; i < s.recentSubmissions.length; i++) {
        if (s.recentSubmissions[i] === submissionId) {
          return JSON.stringify({
            success: true, duplicate: true, pointsAwarded: 0, pointsRaw: rawPoints,
            totalPoints: s.points, tier: TIER_NAMES[s.tierIndex], quizzesThisWeek: s.quizzesThisWeek,
            qualifiesForPromotion: qualifies(s), nearPromotion: false, nearDemotion: false,
            xpMultiplier: XP_MULTIPLIER[s.tierIndex], error: "",
          });
        }
      }
    }

    var mult = XP_MULTIPLIER[s.tierIndex];
    var awarded = Math.round(rawPoints * mult);
    s.points += awarded;
    s.quizzesThisWeek += 1;
    if (isPerfect) s.perfectRounds += 1;
    s.accuracySum += Math.round((accuracy <= 1 ? accuracy * 100 : accuracy));
    if (submissionId) {
      s.recentSubmissions.push(submissionId);
      if (s.recentSubmissions.length > MAX_RECENT_SUBMISSIONS) {
        s.recentSubmissions = s.recentSubmissions.slice(s.recentSubmissions.length - MAX_RECENT_SUBMISSIONS);
      }
    }
    save(nk, userId, s, loaded.version);

    // Mirror to the tier+season leaderboard for ranking.
    var id = lbId(s.tierIndex, s.season);
    ensureLeaderboard(nk, id);
    var username = "";
    var avatarUrl = "";
    try {
      var accts = nk.usersGetId([userId]);
      if (accts && accts.length > 0) {
        username = accts[0].username || "";
        avatarUrl = (accts[0] as any).avatarUrl || "";
      }
    } catch (_) { /* non-fatal */ }
    try {
      nk.leaderboardRecordWrite(id, userId, username, s.points, 0, {
        quizzesThisWeek: s.quizzesThisWeek,
        perfectRounds: s.perfectRounds,
        averageAccuracy: avgAccuracy(s),
        avatarUrl: avatarUrl,
      });
    } catch (_) { /* leaderboard write is best-effort */ }

    var promoteAt = PROMOTION_THRESHOLD[s.tierIndex];
    var demoteAt = DEMOTION_THRESHOLD[s.tierIndex];
    return JSON.stringify({
      success: true,
      duplicate: false,
      pointsAwarded: awarded,
      pointsRaw: rawPoints,
      totalPoints: s.points,
      tier: TIER_NAMES[s.tierIndex],
      quizzesThisWeek: s.quizzesThisWeek,
      qualifiesForPromotion: qualifies(s),
      nearPromotion: promoteAt > 0 && s.points >= Math.round(promoteAt * 0.8),
      nearDemotion: s.tierIndex > 0 && s.points < demoteAt,
      xpMultiplier: mult,
      error: "",
    });
  }

  // ─── RPC: league_get_leaderboard ─────────────────────────────────────
  function rpcGetLeaderboard(ctx: nkruntime.Context, _logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload);
    var limit = (typeof data.limit === "number") ? data.limit : 50;
    if (limit < 1) limit = 1;
    if (limit > 100) limit = 100;

    var loaded = load(nk, userId);
    var s = loaded.state;
    if (applyRollover(s)) save(nk, userId, s, loaded.version);

    var id = lbId(s.tierIndex, s.season);
    ensureLeaderboard(nk, id);

    var records: any[] = [];
    var userRecord: any = null;
    try {
      var list = nk.leaderboardRecordsList(id, [], limit, undefined, 0);
      var rows = (list && list.records) ? list.records : [];

      // Batch-resolve usernames for any record missing one.
      var missingIds: string[] = [];
      for (var i = 0; i < rows.length; i++) {
        if (!rows[i].username) missingIds.push(rows[i].ownerId);
      }
      var nameById: { [k: string]: { username: string; avatarUrl: string } } = {};
      if (missingIds.length > 0) {
        try {
          var users = nk.usersGetId(missingIds);
          for (var u = 0; u < users.length; u++) {
            nameById[users[u].userId] = { username: users[u].username || "", avatarUrl: (users[u] as any).avatarUrl || "" };
          }
        } catch (_) { /* non-fatal */ }
      }

      for (var r = 0; r < rows.length; r++) {
        var row = rows[r];
        var meta: any = row.metadata || {};
        var resolved = nameById[row.ownerId] || { username: "", avatarUrl: "" };
        records.push({
          rank: row.rank,
          userId: row.ownerId,
          username: row.username || resolved.username,
          avatarUrl: meta.avatarUrl || resolved.avatarUrl || "",
          points: row.score,
          perfectRounds: meta.perfectRounds || 0,
          quizzesThisWeek: meta.quizzesThisWeek || 0,
          averageAccuracy: meta.averageAccuracy || 0,
        });
      }

      // Caller's own record + percentile.
      var mine = nk.leaderboardRecordsList(id, [userId], 1, undefined, 0);
      var myRows = (mine && mine.records) ? mine.records : [];
      if (myRows.length > 0) {
        var total = records.length;
        var myRank = myRows[0].rank;
        var percentile = total > 0 ? Math.round((myRank / total) * 100) : 0;
        var mmeta: any = myRows[0].metadata || {};
        userRecord = {
          rank: myRank,
          points: myRows[0].score,
          perfectRounds: mmeta.perfectRounds || s.perfectRounds,
          quizzesThisWeek: mmeta.quizzesThisWeek || s.quizzesThisWeek,
          averageAccuracy: mmeta.averageAccuracy || avgAccuracy(s),
          percentile: percentile,
        };
      }
    } catch (_) { /* return whatever we have */ }

    return JSON.stringify({
      success: true,
      tier: TIER_NAMES[s.tierIndex],
      season: s.season,
      seasonEndsAt: seasonEndsAt(),
      totalPlayers: records.length,
      records: records,
      userRecord: userRecord,
    });
  }

  // ─── Registration ────────────────────────────────────────────────────
  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("league_get_state", RpcHelpers.withCleanAuthError(rpcGetState));
    initializer.registerRpc("league_submit_points", RpcHelpers.withCleanAuthError(rpcSubmitPoints));
    initializer.registerRpc("league_get_leaderboard", RpcHelpers.withCleanAuthError(rpcGetLeaderboard));
  }
}
