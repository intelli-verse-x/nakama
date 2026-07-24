// __tests__/streak-entry.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Self-contained micro test runner for the streak-gated tournament entry rule
// (PR: feat/tournament-streak-entry). Mirrors the runner style of
// learner-toolbelt/__tests__/skeleton.test.ts so it compiles cleanly against
// the production tsconfig and needs no test-runner dependency.
//
// These functions ARE the server-side entry gate enforced in
// TournamentRpcs.rpcEnter, so this suite is the authoritative
// "ineligible blocked / eligible enters" coverage for the backend:
//   1. requiredStreakForEntry — fee → required-streak tier mapping.
//   2. effectiveStreakDays    — live streak read that zeroes out a lapsed
//      streak the ledger has not yet reset (anti-replay).
//
// It mirrors the client rule in web/lib/tournaments/entry-rule.ts (28 vitest
// cases) — keep both in sync.

namespace TournamentStreakEntryTests {

  interface TestCase { suite: string; name: string; fn: () => void; }
  var allTests: TestCase[] = [];
  var currentSuite: string = "(root)";

  function describe(suite: string, fn: () => void): void {
    var prev = currentSuite; currentSuite = suite;
    try { fn(); } finally { currentSuite = prev; }
  }
  function it(name: string, fn: () => void): void {
    allTests.push({ suite: currentSuite, name: name, fn: fn });
  }
  function fmt(v: any): string { try { return JSON.stringify(v); } catch (_e: any) { return String(v); } }
  function expectEq(actual: any, expected: any, msg?: string): void {
    if (actual !== expected) {
      throw new Error((msg ? msg + " — " : "") + "expected " + fmt(expected) + " got " + fmt(actual));
    }
  }

  // ── Mock Nakama runtime (storageRead only) ────────────────────────────────
  function makeMockNk(streakRow: any | null): any {
    return {
      storageRead: function(reqs: any[]): any[] {
        var out: any[] = [];
        for (var i = 0; i < reqs.length; i++) {
          var r = reqs[i];
          if (r.collection === TournamentLevers.COL_STREAKS && r.key === "row" && streakRow) {
            out.push({ collection: r.collection, key: r.key, userId: r.userId, value: streakRow });
          } else {
            out.push({ value: null });
          }
        }
        return out;
      },
    };
  }

  // Build a YYYY-MM-DD key `daysAgo` days before "today" (UTC / tz 0), matching
  // TournamentLevers.todayKey math so effectiveStreakDays sees the offset we mean.
  function dayKeyAgo(daysAgo: number): string {
    var d = new Date(Date.now() - daysAgo * 86400000);
    var yyyy = d.getUTCFullYear();
    var mm = ("0" + (d.getUTCMonth() + 1)).slice(-2);
    var dd = ("0" + d.getUTCDate()).slice(-2);
    return yyyy + "-" + mm + "-" + dd;
  }

  // ── requiredStreakForEntry — fee → required-days tiers ────────────────────
  describe("requiredStreakForEntry — fee tiers", function(): void {
    it("free tournament (fee 0) requires no streak", function(): void {
      expectEq(TournamentLevers.requiredStreakForEntry(0), 0);
    });
    it("low fee (<=50) requires a 3-day streak", function(): void {
      expectEq(TournamentLevers.requiredStreakForEntry(25), 3);
      expectEq(TournamentLevers.requiredStreakForEntry(50), 3);
    });
    it("mid fee (<=75) requires a 5-day streak", function(): void {
      expectEq(TournamentLevers.requiredStreakForEntry(60), 5);
      expectEq(TournamentLevers.requiredStreakForEntry(75), 5);
    });
    it("high fee (>75) requires a 7-day streak (capped)", function(): void {
      expectEq(TournamentLevers.requiredStreakForEntry(100), 7);
      expectEq(TournamentLevers.requiredStreakForEntry(100000), 7);
    });
    it("never exceeds MAX_REQUIRED_STREAK_DAYS", function(): void {
      expectEq(TournamentLevers.requiredStreakForEntry(1e9) <= TournamentLevers.MAX_REQUIRED_STREAK_DAYS, true);
    });
    it("negative / NaN fee floors to the free tier", function(): void {
      expectEq(TournamentLevers.requiredStreakForEntry(-10), 0);
      expectEq(TournamentLevers.requiredStreakForEntry(NaN as any), 0);
    });
  });

  // ── effectiveStreakDays — live streak read (anti-replay) ──────────────────
  describe("effectiveStreakDays — liveness gate", function(): void {
    it("no streak row → 0 (ineligible)", function(): void {
      expectEq(TournamentLevers.effectiveStreakDays(makeMockNk(null), "u", 0), 0);
    });
    it("checked in today → returns current_days (eligible)", function(): void {
      var row = { current_days: 5, last_calendar_day: dayKeyAgo(0), grace_days_used: 0, history: [], longest_ever: 5 };
      expectEq(TournamentLevers.effectiveStreakDays(makeMockNk(row), "u", 0), 5);
    });
    it("checked in yesterday (diff 1) → streak still alive", function(): void {
      var row = { current_days: 4, last_calendar_day: dayKeyAgo(1), grace_days_used: 0, history: [], longest_ever: 4 };
      expectEq(TournamentLevers.effectiveStreakDays(makeMockNk(row), "u", 0), 4);
    });
    it("diff 2 with grace available → streak preserved", function(): void {
      var row = { current_days: 6, last_calendar_day: dayKeyAgo(2), grace_days_used: 0, history: [], longest_ever: 6 };
      expectEq(TournamentLevers.effectiveStreakDays(makeMockNk(row), "u", 0), 6);
    });
    it("diff 2 with grace exhausted → lapsed streak reads 0", function(): void {
      var row = { current_days: 6, last_calendar_day: dayKeyAgo(2), grace_days_used: 99, history: [], longest_ever: 6 };
      expectEq(TournamentLevers.effectiveStreakDays(makeMockNk(row), "u", 0), 0);
    });
    it("stale streak (diff 5) cannot be replayed → 0", function(): void {
      var row = { current_days: 30, last_calendar_day: dayKeyAgo(5), grace_days_used: 0, history: [], longest_ever: 30 };
      expectEq(TournamentLevers.effectiveStreakDays(makeMockNk(row), "u", 0), 0);
    });
  });

  // ── Combined gate — eligible enters vs ineligible blocked ─────────────────
  describe("entry gate — eligible vs ineligible", function(): void {
    function eligible(feeBc: number, row: any): boolean {
      var required = TournamentLevers.requiredStreakForEntry(feeBc);
      var current = TournamentLevers.effectiveStreakDays(makeMockNk(row), "u", 0);
      return current >= required;
    }
    it("free tournament: anyone (even no streak) can enter", function(): void {
      expectEq(eligible(0, null), true);
    });
    it("fee 50 (needs 3): a live 3-day streak enters", function(): void {
      var row = { current_days: 3, last_calendar_day: dayKeyAgo(0), grace_days_used: 0, history: [], longest_ever: 3 };
      expectEq(eligible(50, row), true);
    });
    it("fee 50 (needs 3): a 2-day streak is blocked", function(): void {
      var row = { current_days: 2, last_calendar_day: dayKeyAgo(0), grace_days_used: 0, history: [], longest_ever: 2 };
      expectEq(eligible(50, row), false);
    });
    it("fee 100 (needs 7): a long-but-lapsed streak is blocked (anti-replay)", function(): void {
      var row = { current_days: 30, last_calendar_day: dayKeyAgo(9), grace_days_used: 0, history: [], longest_ever: 30 };
      expectEq(eligible(100, row), false);
    });
  });

  export function runAll(): { passed: number; failed: number; errors: string[]; total: number } {
    var passed = 0; var errors: string[] = [];
    for (var i = 0; i < allTests.length; i++) {
      var t = allTests[i];
      try { t.fn(); passed++; }
      catch (e: any) { errors.push("[" + t.suite + "] " + t.name + " — " + (e && e.message ? e.message : String(e))); }
    }
    return { passed: passed, failed: errors.length, errors: errors, total: allTests.length };
  }
}
