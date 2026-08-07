// ============================================================================
// Badge & Character regression suite (BUG FIX 2026-08-06 — "nothing unlocks")
// ----------------------------------------------------------------------------
// Guards the 4 root causes fixed on 2026-08-06:
//   1. game_id mismatch — definitions seeded under "quizverse" but clients
//      send the QuizVerse UUID; all definition reads silently missed.
//   2. Badge→character chain lived in the Unity client — now server-side.
//   3. 9 character unlockConditions referenced badge ids that don't exist.
//   4. ~150 badges listened for events no client ever sent — server fan-out
//      now derives them inside quizverse_submit_result.
//
// Runs the REAL module sources (badge_definitions.js, badges.js,
// characters.js) against an in-memory Nakama mock. No server needed.
//
//   node tests/badge_character_regression_test.mjs
// ============================================================================

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const base = join(dirname(fileURLToPath(import.meta.url)), '..');

const driver = `
var __store = {};
function __k(c, k, u) { return c + "|" + k + "|" + u; }
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
  notificationsSend: function () {},
  notificationSend: function () {},
  walletUpdate: function () {},
  accountGetId: function () { return { user: { metadata: "{}" } }; },
  accountUpdateId: function () {},
  accountsGetId: function (ids) {
    // Admin identity for the authz-gated RPCs (SECURITY FIX 2026-08-07):
    // only "admin-user-1" carries metadata.admin === true.
    if (ids && ids[0] === "admin-user-1") return [{ user: { metadata: { admin: true } } }];
    return [{ user: { metadata: {} } }];
  }
};
var logger = { info: function(){}, warn: function(){}, error: function(){}, debug: function(){} };
var ctx = { userId: "user-test-1" };
var adminCtx = { userId: "admin-user-1" };
var UUID = "126bf539-dae2-4bcf-964d-316c0fa1f92b";
var failures = [];
function check(name, cond) {
  if (cond) { console.log("PASS  " + name); } else { console.log("FAIL  " + name); failures.push(name); }
}

seedBadgesOnStartup(nk, logger);

// 1. UUID clients must see the full catalog (was: empty — the killer bug)
var res = JSON.parse(rpcBadgesGetAll(ctx, logger, nk, JSON.stringify({ game_id: UUID })));
check("T1 badges_get_all(UUID) returns 216 badges", res.success && res.badges.length === 216);

// 2. One quiz fans out into every derived badge family
var fan = quizverseBadgesFanout(ctx, logger, nk, {
  game_id: UUID, event_type: "quiz_complete",
  event_data: { topic: "geography", correct: 8, total: 10 }
});
var unlockedIds = fan.badges_unlocked.map(function(b){ return b.badge_id; });
check("T2 fanout unlocks dashing_debut on first quiz", unlockedIds.indexOf("dashing_debut") >= 0);
check("T2 derived topic event progresses geography_novice",
  fan.badges_updated.some(function(b){ return b.badge_id === "geography_novice"; }));
check("T2 derived correct_answer progresses sharp_shooter",
  fan.badges_updated.some(function(b){ return b.badge_id === "sharp_shooter"; }));
check("T2 derived accuracy_quiz (80%) progresses accuracy_engine",
  fan.badges_updated.some(function(b){ return b.badge_id === "accuracy_engine"; }));

// 3. Server-side badge → character chain
check("T3 Dog auto-unlocked by dashing_debut badge",
  fan.characters_unlocked.some(function(c){ return c.characterId === "Dog"; }));

// 4. Topic isolation — a geography quiz must never progress anime badges
check("T4 anime_novice NOT progressed by geography quiz",
  !fan.badges_updated.some(function(b){ return b.badge_id === "anime_novice"; }));

// 5. Canonical keying — character state visible regardless of id spelling
var state = JSON.parse(rpcCharacterGetState(ctx, logger, nk, JSON.stringify({ gameId: UUID })));
var dog = state.characters.filter(function(c){ return c.id === "Dog"; })[0];
check("T5 character_get_state(UUID) shows Dog unlocked", dog && dog.unlocked === true);

// 6. Server authority — unearned character unlock is rejected
var rej = JSON.parse(rpcCharacterUnlock(ctx, logger, nk, JSON.stringify({ gameId: UUID, characterId: "Atlas" })));
check("T6 character_unlock(Atlas) rejected: condition_not_met",
  rej.success === false && rej.error === "condition_not_met" && rej.requiredBadge === "geography_master");

// 7. Defaults stay free
var okDefault = JSON.parse(rpcCharacterUnlock(ctx, logger, nk, JSON.stringify({ gameId: UUID, characterId: "Quizzy_v1" })));
check("T7 default character reports already_unlocked",
  okDefault.success === false && okDefault.error === "already_unlocked");

// 8. The public RPC path works with the UUID too.
//    (SECURITY FIX 2026-08-07, F5: badges_check_event is now admin/server-only
//    — the player path is quizverseBadgesFanout → badgesCheckEventCore, covered
//    by T2/T9. This check drives the RPC as an admin caller; non-admin
//    rejection is covered by tests/authz_security_regression_test.mjs.)
var res2 = JSON.parse(rpcBadgesCheckEvent(adminCtx, logger, nk,
  JSON.stringify({ game_id: UUID, event_type: "quiz_complete", event_data: { count: 1 } })));
check("T8 badges_check_event(UUID) progresses quiz_warrior",
  res2.badges_updated.some(function(b){ return b.badge_id === "quiz_warrior"; }));

// 9. Perfect quiz → perfect_round + high-accuracy family
var fan2 = quizverseBadgesFanout(ctx, logger, nk, {
  game_id: UUID, event_type: "quiz_complete",
  event_data: { topic: "science", correct: 10, total: 10, is_perfect: true }
});
check("T9 perfect quiz unlocks perfect_round",
  fan2.badges_unlocked.some(function(b){ return b.badge_id === "perfect_round"; }));
check("T9 95%+ accuracy family progresses omniscient",
  fan2.badges_updated.some(function(b){ return b.badge_id === "omniscient"; }));

// 10. Every character unlockCondition must reference a REAL badge id
var seededDefs = __store["badges|definitions_quizverse|00000000-0000-0000-0000-000000000000"].badges;
var realIds = {};
for (var di = 0; di < seededDefs.length; di++) realIds[seededDefs[di].badge_id] = true;
var ghostIds = [];
for (var charId in CHARACTER_DEFS) {
  if (!CHARACTER_DEFS.hasOwnProperty(charId)) continue;
  var cond = CHARACTER_DEFS[charId].unlockCondition;
  if (cond && cond !== "default" && !realIds[cond]) ghostIds.push(charId + "→" + cond);
}
check("T10 all character conditions reference real badge ids" +
  (ghostIds.length ? " (ghosts: " + ghostIds.join(", ") + ")" : ""),
  ghostIds.length === 0);

console.log(failures.length === 0 ? "\\nALL TESTS PASSED (" + 14 + " checks)"
  : "\\n" + failures.length + " FAILURES: " + failures.join(" | "));
if (failures.length > 0) throw new Error("regression suite failed");
`;

let combined = '';
for (const f of ['badges/badge_definitions.js', 'badges/badges.js', 'characters/characters.js']) {
  combined += readFileSync(join(base, f), 'utf-8') + '\n';
}
// Neutralize the node-only exports block so top-level names stay in scope
combined = combined.replace("if (typeof module !== 'undefined') {", 'if (false) {');
combined += driver;

try {
  vm.runInThisContext(combined, { filename: 'badge_char_bundle.js' });
  console.log('REGRESSION SUITE: PASS');
} catch (e) {
  console.error('REGRESSION SUITE: FAIL — ' + e.message);
  process.exit(1);
}
