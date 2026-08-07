// ============================================================================
// StreakV2 seed regression suite (BUG FIX 2026-08-07 — wager dead on arrival)
// ----------------------------------------------------------------------------
// Guards the root cause fixed on 2026-08-07: nothing in the backend ever
// wrote the V2 `streak_data` store, so streak_wager / streak_repair always
// returned "No streak data found. Play a quiz first." and the wager win
// check could never pass (currentDay stayed 0 forever).
//
// The fix merges live fields on every readStreakData call:
//   currentDay            ← daily_streaks (login streak, daily_progress_check)
//   isBroken / brokenAt   ← derived from last activity gap (>= 2 days)
//   lastQuizCompletedAt   ← daily_play_log/{userId}_{YYYYMMDD} (quiz pipeline)
//
// Runs the REAL module source (retention/retention_v2.js) against an
// in-memory Nakama mock. No server needed.
//
//   node tests/streak_v2_seed_regression_test.mjs
// ============================================================================

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const base = join(dirname(fileURLToPath(import.meta.url)), '..');

const driver = `
var __store = {};
var __wallet = { coins: 1000 };
function __k(c, k, u) { return c + "|" + k + "|" + u; }
function __seed(c, k, u, v) { __store[__k(c, k, u)] = v; }
var nk = {
  storageRead: function (reqs) {
    var out = [];
    for (var i = 0; i < reqs.length; i++) {
      var r = reqs[i];
      var v = __store[__k(r.collection, r.key, r.userId)];
      if (v !== undefined) out.push({ value: JSON.parse(JSON.stringify(v)) });
    }
    return out;
  },
  storageWrite: function (reqs) {
    for (var i = 0; i < reqs.length; i++) {
      var r = reqs[i];
      __store[__k(r.collection, r.key, r.userId)] = JSON.parse(JSON.stringify(r.value));
    }
  },
  walletUpdate: function (userId, delta) {
    var coins = (delta && delta.coins) || 0;
    if (__wallet.coins + coins < 0) throw new Error("insufficient funds");
    __wallet.coins += coins;
    return { balance: __wallet };
  },
  accountGetId: function () { return { wallet: JSON.stringify(__wallet) }; }
};
var logger = { info: function(){}, warn: function(){}, error: function(){}, debug: function(){} };
var ctx = { userId: "user-wager-1" };
var UUID = "126bf539-dae2-4bcf-964d-316c0fa1f92b";
var failures = [];
function check(name, cond) {
  if (cond) { console.log("PASS  " + name); } else { console.log("FAIL  " + name); failures.push(name); }
}
function todayKey() { return new Date().toISOString().slice(0, 10).replace(/-/g, ""); }
function seedDailyStreak(day) {
  __seed("daily_streaks", "user_daily_streak_" + ctx.userId + "_" + UUID, ctx.userId, {
    currentStreak: day, bestStreak: day,
    lastOpenTimestamp: Math.floor(Date.now() / 1000),
    lastClaimTimestamp: Math.floor(Date.now() / 1000)
  });
}
function seedPlayLog() {
  __seed("daily_play_log", ctx.userId + "_" + todayKey(), ctx.userId, { xpToday: 100 });
}

// ── T1: brand-new player (no stores at all) keeps the original error ──────
var r1 = JSON.parse(rpcStreakWager(ctx, logger, nk, JSON.stringify({ action: "place", wagerAmount: 50 })));
check("T1 no stores → 'No streak data found' preserved", r1.success === false && /No streak data/.test(r1.error));

// ── T2: day-12 login streak (UUID key) + play log → place succeeds ────────
seedDailyStreak(12);
seedPlayLog();
var r2 = JSON.parse(rpcStreakWager(ctx, logger, nk, JSON.stringify({ action: "place", wagerAmount: 100 })));
check("T2 place succeeds via live seed (was the dead-store bug)",
  r2.success === true && r2.wagerAmount === 100 && r2.multiplier === 2.0 && r2.potentialWinnings === 200);
check("T2 coins deducted server-side at place", __wallet.coins === 900);

// ── T3: double place is rejected with the active wager echoed ─────────────
var r3 = JSON.parse(rpcStreakWager(ctx, logger, nk, JSON.stringify({ action: "place", wagerAmount: 50 })));
check("T3 wager_already_active", r3.success === false && r3.error === "wager_already_active" && r3.activeWager.amount === 100);

// ── T4: day-5 streak is locked out ────────────────────────────────────────
var ctx4 = { userId: "user-wager-2" };
__seed("daily_streaks", "user_daily_streak_" + ctx4.userId + "_" + UUID, ctx4.userId, {
  currentStreak: 5, lastOpenTimestamp: Math.floor(Date.now() / 1000)
});
var r4 = JSON.parse(rpcStreakWager(ctx4, logger, nk, JSON.stringify({ action: "place", wagerAmount: 50 })));
check("T4 wager_locked_until_day_10", r4.success === false && r4.error === "wager_locked_until_day_10" && r4.currentDay === 5);

// ── T5: resolve without playing today is rejected ─────────────────────────
// ctx has a play log for today; wipe it to simulate "not played".
delete __store[__k("daily_play_log", ctx.userId + "_" + todayKey(), ctx.userId)];
var r5 = JSON.parse(rpcStreakWager(ctx, logger, nk, JSON.stringify({ action: "resolve" })));
check("T5 quiz_not_completed_today", r5.success === false && r5.error === "quiz_not_completed_today");

// ── T6: streak advanced + played today → resolve pays amount × 2 ──────────
seedDailyStreak(13); // login streak advanced since placement (was 12)
seedPlayLog();
var r6 = JSON.parse(rpcStreakWager(ctx, logger, nk, JSON.stringify({ action: "resolve" })));
check("T6 resolve won +200 (100 × 2.0)", r6.success === true && r6.result === "won" && r6.winnings === 200);
check("T6 winnings paid server-side", __wallet.coins === 1100);

// ── T7: wager clears after resolve — a new wager can be placed ────────────
var r7 = JSON.parse(rpcStreakWager(ctx, logger, nk, JSON.stringify({ action: "place", wagerAmount: 50 })));
check("T7 new wager placeable after resolve", r7.success === true && r7.wagerAmount === 50);

// ── T8: canonical game id also finds the UUID-keyed daily streak ──────────
var ctx8 = { userId: "user-wager-3" };
__seed("daily_streaks", "user_daily_streak_" + ctx8.userId + "_" + UUID, ctx8.userId, {
  currentStreak: 15, lastOpenTimestamp: Math.floor(Date.now() / 1000)
});
var r8 = JSON.parse(rpcStreakWager(ctx8, logger, nk, JSON.stringify({ action: "place", wagerAmount: 50, gameId: "quizverse" })));
check("T8 canonical 'quizverse' seeds from UUID-keyed daily streak", r8.success === true);

// ── T9: lapsed streak (48h gap) is broken — repair path unblocks ──────────
// (48h exactly: gapDays=2 → broken; brokenAt=lastActivity+24h → 24h ago,
// still inside the 24h repair window.)
var ctx9 = { userId: "user-wager-4" };
__seed("daily_streaks", "user_daily_streak_" + ctx9.userId + "_" + UUID, ctx9.userId, {
  currentStreak: 12,
  lastOpenTimestamp: Math.floor((Date.now() - 48 * 3600000) / 1000),
  lastClaimTimestamp: Math.floor((Date.now() - 48 * 3600000) / 1000)
});
var r9w = JSON.parse(rpcStreakWager(ctx9, logger, nk, JSON.stringify({ action: "place", wagerAmount: 50 })));
check("T9 broken streak cannot wager", r9w.success === false && /broken/i.test(r9w.error));
var r9 = JSON.parse(rpcStreakRepair(ctx9, logger, nk, JSON.stringify({})));
check("T9 streak_repair works via seed (was dead too)", r9.success === true && r9.repairCost === 200);

console.log(failures.length === 0 ? "\\nALL TESTS PASSED"
  : "\\n" + failures.length + " FAILURES: " + failures.join(" | "));
if (failures.length > 0) throw new Error("streak v2 seed regression suite failed");
`;

let combined = readFileSync(join(base, 'retention/retention_v2.js'), 'utf-8') + '\n';
combined = combined.replace("if (typeof module !== 'undefined') {", 'if (false) {');
combined += driver;

try {
  vm.runInThisContext(combined, { filename: 'streak_v2_bundle.js' });
  console.log('REGRESSION SUITE: PASS');
} catch (e) {
  console.error('REGRESSION SUITE: FAIL — ' + e.message);
  process.exit(1);
}
