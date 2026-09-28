/**
 * QuizVerse Arcade — server-authoritative run completion.
 *
 * quizverse_arcade_complete {gameId, score, subscore?, runId}
 *   → {ok:true, coins, xp, duplicate, capped}
 *   → {ok:false, error: invalid_game|invalid_score|invalid_run_id|busy|internal}
 *
 * The client only reports the score; rewards are computed here
 * (coins = floor(score/1000)×5, xp = floor(score/1000)×10), scores above the
 * per-game ceiling are rejected, each runId pays out once, and payouts are
 * capped per game per UTC day.
 */
namespace QuizVerseArcade {

  var COLLECTION = "quizverse_arcade";

  var DAILY_COIN_CAP = 500;
  var DAILY_XP_CAP = 1000;
  var MAX_RUNS_TRACKED = 200;

  /** Highest score a legitimate run can reach, per arcade game UUID. */
  var MAX_SCORE: { [gameId: string]: number } = {
    // 2048 Crystal: run ends at the first 2048 tile (≈37k theoretical max).
    "650636ba-7fa7-4441-9223-08ecd79677ae": 40000,
    // Sudoku: 10000 start + 50 per correct non-given cell.
    "4d1b82a7-9f6e-4c3a-b812-7e01a6fbc902": 15000,
    // Hex 2248: score accrues until the 2248 win or a locked board.
    "02290eb7-bdd5-4dc2-b5d3-619127eeaa99": 250000
  };

  var RUN_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

  interface DailyLedger {
    coins: number;
    xp: number;
    runs: string[];
  }

  function fail(error: string): string {
    return JSON.stringify({ ok: false, error: error });
  }

  function utcDayKey(): string {
    return new Date().toISOString().slice(0, 10).replace(/-/g, "");
  }

  function displayName(nk: nkruntime.Nakama, ctx: nkruntime.Context, userId: string): string {
    try {
      var users = nk.usersGetId([userId]);
      if (users && users.length > 0) {
        return (users[0] as any).displayName || users[0].username || ctx.username || userId;
      }
    } catch (_) { }
    return ctx.username || userId;
  }

  export function rewardsForScore(score: number): { coins: number; xp: number } {
    var thousands = Math.floor(score / 1000);
    return { coins: thousands * 5, xp: thousands * 10 };
  }

  /**
   * Records the run in today's ledger with optimistic concurrency.
   * Returns null when the runId was already paid out.
   */
  function claimRun(nk: nkruntime.Nakama, userId: string, gameId: string, runId: string, score: number): { coins: number; xp: number; capped: boolean } | null {
    var key = "ledger_" + gameId + "_" + utcDayKey();
    for (var attempt = 0; attempt < 3; attempt++) {
      var objects = nk.storageRead([{ collection: COLLECTION, key: key, userId: userId }]);
      var ledger: DailyLedger = { coins: 0, xp: 0, runs: [] };
      var version = "*";
      if (objects && objects.length > 0) {
        ledger = objects[0].value as any;
        if (!ledger.runs) ledger.runs = [];
        version = objects[0].version;
      }
      if (ledger.runs.indexOf(runId) !== -1) return null;

      var earned = rewardsForScore(score);
      var coins = Math.max(0, Math.min(earned.coins, DAILY_COIN_CAP - (ledger.coins || 0)));
      var xp = Math.max(0, Math.min(earned.xp, DAILY_XP_CAP - (ledger.xp || 0)));

      ledger.coins = (ledger.coins || 0) + coins;
      ledger.xp = (ledger.xp || 0) + xp;
      ledger.runs.push(runId);
      if (ledger.runs.length > MAX_RUNS_TRACKED) {
        ledger.runs = ledger.runs.slice(ledger.runs.length - MAX_RUNS_TRACKED);
      }

      try {
        nk.storageWrite([{
          collection: COLLECTION,
          key: key,
          userId: userId,
          value: ledger as any,
          version: version,
          permissionRead: 1,
          permissionWrite: 0
        }]);
        return { coins: coins, xp: xp, capped: coins < earned.coins || xp < earned.xp };
      } catch (_) {
        // Version conflict: a concurrent completion won the write — re-read.
      }
    }
    throw new Error("busy");
  }

  function rpcArcadeComplete(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var data: any;
    try {
      data = RpcHelpers.parseRpcPayload(payload);
    } catch (_) {
      return fail("invalid_score");
    }

    var gameId = String(data.gameId || "");
    var maxScore = MAX_SCORE[gameId];
    if (maxScore === undefined) return fail("invalid_game");

    var score = Number(data.score);
    if (!isFinite(score) || score < 0 || score > maxScore || Math.floor(score) !== score) {
      logger.warn("[Arcade] rejected score user=" + userId + " game=" + gameId + " score=" + String(data.score));
      return fail("invalid_score");
    }
    var subscore = Math.max(0, Math.floor(Number(data.subscore) || 0));

    var runId = String(data.runId || "");
    if (!RUN_ID_PATTERN.test(runId)) return fail("invalid_run_id");

    var claim: { coins: number; xp: number; capped: boolean } | null;
    try {
      claim = claimRun(nk, userId, gameId, runId, score);
    } catch (e: any) {
      logger.warn("[Arcade] ledger write failed user=" + userId + " err=" + (e && e.message));
      return fail("busy");
    }
    if (claim === null) {
      return JSON.stringify({ ok: true, duplicate: true, coins: 0, xp: 0, capped: false });
    }

    try {
      if (claim.coins > 0) {
        WalletHelpers.addCurrency(nk, logger, ctx, userId, gameId, "game", claim.coins);
      }
      if (claim.xp > 0) {
        LegacyWallet.addGlobalXp(nk, userId, claim.xp);
      }
      LegacyLeaderboards.writeGameTimePeriodScores(nk, logger, gameId, userId, displayName(nk, ctx, userId), score, subscore, {
        source: "quizverse_arcade_complete",
        gameId: gameId,
        submittedAt: new Date().toISOString()
      });
    } catch (e: any) {
      logger.error("[Arcade] grant failed user=" + userId + " game=" + gameId + " err=" + (e && e.message));
      return fail("internal");
    }

    return JSON.stringify({ ok: true, duplicate: false, coins: claim.coins, xp: claim.xp, capped: claim.capped });
  }

  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("quizverse_arcade_complete", rpcArcadeComplete);
  }
}
