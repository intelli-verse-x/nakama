// ============================================================================
// Authz security regression suite (SECURITY FIXES 2026-08-07 — F3/F4/F5/F10/F11)
// ----------------------------------------------------------------------------
// Guards the badge/admin/social authorization fixes:
//   F3  badges_update_progress  — admin/server-only (was: any user could set
//       arbitrary progress and harvest wallet rewards).
//   F4  badges_bulk_create      — admin-gated (was: any user could write badge
//       definitions with arbitrary rewards into the system-owned doc).
//   F5  badges_check_event      — admin/server-only (was: forged event_type +
//       count storms unlocked reward badges without gameplay). The LAP bridge
//       (quizverse_lap_badge_event) now calls badgesCheckEventCore directly
//       with a lap_* whitelist + count clamp.
//   F10 analytics_admin.js      — hardcoded fallback admin credentials deleted;
//       env-absent must fail closed.
//   F11 legacy_runtime.js       — asyncChallengeValidateUser must not fall back
//       to payload userId.
//
// Runs the REAL module sources (badge_definitions.js, badges.js,
// characters.js, lap-badges.js) against an in-memory Nakama mock.
//
//   node tests/authz_security_regression_test.mjs
// ============================================================================

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const base = join(dirname(fileURLToPath(import.meta.url)), '..');
let sourceFailures = 0;

function srcCheck(name, cond) {
  if (cond) { console.log('PASS  ' + name); }
  else { console.log('FAIL  ' + name); sourceFailures++; }
}

// ─── Part 1: behavioral suite (vm-loaded real sources + mock nk) ──────────

const driver = `
var __store = {};
var __walletCalls = [];
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
  walletUpdate: function (userId, changeset) { __walletCalls.push({ userId: userId, changeset: changeset }); },
  accountGetId: function () { return { user: { metadata: "{}" } }; },
  accountUpdateId: function () {},
  accountsGetId: function (ids) {
    // Admin identity for the authz-gated RPCs: only "admin-user-1" is admin.
    if (ids && ids[0] === "admin-user-1") return [{ user: { metadata: { admin: true } } }];
    return [{ user: { metadata: {} } }];
  }
};
var logger = { info: function(){}, warn: function(){}, error: function(){}, debug: function(){} };
var playerCtx = { userId: "player-0001" };
var adminCtx  = { userId: "admin-user-1" };
var serverCtx = {}; // no userId — http_key server-to-server, trusted by design
var UUID = "126bf539-dae2-4bcf-964d-316c0fa1f92b";
var failures = [];
function check(name, cond) {
  if (cond) { console.log("PASS  " + name); } else { console.log("FAIL  " + name); failures.push(name); }
}
function isAdminRejection(res) {
  return res && res.success === false && /Admin access required/.test(res.error || "");
}
function playerHasNoProgress() {
  for (var k in __store) { if (k.indexOf("player-0001") >= 0) return false; }
  return true;
}
function playerWalletUntouched() {
  return !__walletCalls.some(function (w) { return w.userId === "player-0001"; });
}

seedBadgesOnStartup(nk, logger);

// ── F3: badges_update_progress ────────────────────────────────────────────
var r1 = JSON.parse(rpcBadgesUpdateProgress(playerCtx, logger, nk, JSON.stringify({
  game_id: UUID, badge_id: "dashing_debut", progress: 999
})));
check("F3 badges_update_progress rejects non-admin", isAdminRejection(r1));
check("F3 rejection granted no wallet rewards", playerWalletUntouched());
check("F3 rejection wrote no progress doc", playerHasNoProgress());

var r2 = JSON.parse(rpcBadgesUpdateProgress(adminCtx, logger, nk, JSON.stringify({
  game_id: UUID, badge_id: "dashing_debut", progress: 1
})));
check("F3 badges_update_progress still works for admin", r2.success === true);

var r3 = JSON.parse(rpcBadgesUpdateProgress(serverCtx, logger, nk, JSON.stringify({
  game_id: UUID, badge_id: "dashing_debut", progress: 1
})));
check("F3 badges_update_progress allows server-to-server (no userId)", r3.success === true);

// ── F4: badges_bulk_create ────────────────────────────────────────────────
var defsKey = "badges|definitions_quizverse|00000000-0000-0000-0000-000000000000";
var defsBefore = JSON.stringify(__store[defsKey]);
var r4 = JSON.parse(rpcBadgesBulkCreate(playerCtx, logger, nk, JSON.stringify({
  game_id: "quizverse",
  badges: [{ badge_id: "evil_badge", title: "Evil", target: 1, rewards: { coins: 1000000 } }]
})));
check("F4 badges_bulk_create rejects non-admin", isAdminRejection(r4));
check("F4 rejection left definitions doc untouched", JSON.stringify(__store[defsKey]) === defsBefore);

var r5 = JSON.parse(rpcBadgesBulkCreate(adminCtx, logger, nk, JSON.stringify({
  game_id: "quizverse",
  badges: [{ badge_id: "admin_test_badge", title: "Admin Test", target: 1 }]
})));
check("F4 badges_bulk_create still works for admin",
  r5.success === true && r5.created.indexOf("admin_test_badge") >= 0);

// ── F5: badges_check_event + internal core + LAP bridge ──────────────────
var r6 = JSON.parse(rpcBadgesCheckEvent(playerCtx, logger, nk, JSON.stringify({
  game_id: UUID, event_type: "correct_answer", event_data: { count: 1000000 }
})));
check("F5 badges_check_event rejects forged event storm (non-admin)", isAdminRejection(r6));
check("F5 forged storm granted no wallet rewards", playerWalletUntouched());
check("F5 forged storm wrote no progress doc", playerHasNoProgress());

// The legit player path: server fanout calls the CORE directly — no admin gate.
var coreRes = badgesCheckEventCore(playerCtx, logger, nk, UUID, "quiz_complete", { count: 1 });
check("F5 internal badgesCheckEventCore path still works for players",
  coreRes.badges_updated.some(function (b) { return b.badge_id === "quiz_warrior"; }));

var r7 = JSON.parse(rpcBadgesCheckEvent(adminCtx, logger, nk, JSON.stringify({
  game_id: UUID, event_type: "quiz_complete", event_data: { count: 1 }
})));
check("F5 badges_check_event still works for admin", r7.success === true);

// LAP bridge: player-facing, rerouted to the core with whitelist + clamp.
var r8 = JSON.parse(rpcQuizverseLapBadgeEvent(playerCtx, logger, nk, JSON.stringify({
  event_type: "lap_quiz_played", event_data: { count: 99999 }
})));
check("F5 LAP bridge still serves players (lap_quiz_played)", r8.success === true);
var lapMaster = (r8.badges_updated || []).filter(function (b) { return b.badge_id === "lap_quiz_master"; })[0];
check("F5 LAP bridge clamps forged count 99999 → 1", lapMaster && lapMaster.progress === 1);

var r9 = JSON.parse(rpcQuizverseLapBadgeEvent(playerCtx, logger, nk, JSON.stringify({
  event_type: "correct_answer", event_data: { count: 1000000 }
})));
check("F5 LAP bridge rejects non-lap event types",
  r9.success === false && /unsupported event_type/.test(r9.error || ""));

var r10 = JSON.parse(rpcQuizverseLapBadgeEvent(playerCtx, logger, nk, JSON.stringify({
  event_type: "lap_quiz_completed" // legacy alias → lap_quiz_played
})));
check("F5 LAP bridge alias mapping still works",
  r10.success === true && (r10.badges_updated || []).some(function (b) { return b.badge_id === "lap_quiz_master"; }));

console.log(failures.length === 0 ? "\\nALL BEHAVIORAL CHECKS PASSED"
  : "\\n" + failures.length + " FAILURES: " + failures.join(" | "));
if (failures.length > 0) throw new Error("authz behavioral suite failed");
`;

let combined = '';
for (const f of ['badges/badge_definitions.js', 'badges/badges.js', 'characters/characters.js', 'lap-badges/lap-badges.js']) {
  combined += readFileSync(join(base, f), 'utf-8') + '\n';
}
// Neutralize node-only exports blocks so top-level names stay in scope
combined = combined.split("if (typeof module !== 'undefined') {").join('if (false) {');
combined += driver;

try {
  vm.runInThisContext(combined, { filename: 'authz_bundle.js' });
  console.log('BEHAVIORAL SUITE: PASS');
} catch (e) {
  console.error('BEHAVIORAL SUITE: FAIL — ' + e.message);
  process.exit(1);
}

// ─── Part 2: source-level assertions ──────────────────────────────────────

// F10: no hardcoded fallback admin credentials remain anywhere in sources.
const aaSrc = readFileSync(join(base, 'analytics/admin/analytics_admin.js'), 'utf-8');
srcCheck('F10 analytics_admin.js contains no AA_FALLBACK string', aaSrc.indexOf('AA_FALLBACK') === -1);

const analyticsDirs = [
  'analytics/backfill/analytics_backfill.js',
  'analytics/firecrawl/analytics_firecrawl.js',
  'analytics/hardening/analytics_hardening.js',
  'analytics/player_profile/analytics_player_profile.js',
  'analytics/read_models/analytics_read_models.js',
  'analytics/retention_curves/analytics_retention_curves.js',
  'analytics/rollup/analytics_rollup.js',
  'analytics/satori_identity/analytics_satori_identity.js',
  'offer_engine/offer_engine.js',
];
let dangling = [];
for (const rel of analyticsDirs) {
  const src = readFileSync(join(base, rel), 'utf-8');
  if (src.indexOf('AA_FALLBACK') !== -1) dangling.push(rel);
}
srcCheck('F10 no dangling AA_FALLBACK consumers remain' +
  (dangling.length ? ' (found: ' + dangling.join(', ') + ')' : ''), dangling.length === 0);

// F10: env-absent admin_login fails closed (503 path still present + env read).
srcCheck('F10 admin_login keeps the fail-closed 503 path',
  aaSrc.indexOf('Admin login not configured on server') !== -1 &&
  aaSrc.indexOf('ctx.env[key]') !== -1);

// F11: asyncChallengeValidateUser must not trust payload userId.
const legacySrc = readFileSync(join(base, 'legacy_runtime.js'), 'utf-8');
const fnStart = legacySrc.indexOf('function asyncChallengeValidateUser');
srcCheck('F11 asyncChallengeValidateUser exists in legacy_runtime.js', fnStart !== -1);
if (fnStart !== -1) {
  const fnEnd = legacySrc.indexOf('\nfunction ', fnStart + 10);
  const fnBody = legacySrc.slice(fnStart, fnEnd === -1 ? fnStart + 2000 : fnEnd);
  srcCheck('F11 asyncChallengeValidateUser has no payload userId fallback',
    fnBody.indexOf('request.userId') === -1);
  srcCheck('F11 asyncChallengeValidateUser reads identity from ctx',
    fnBody.indexOf('ctx.userId') !== -1 || fnBody.indexOf('ctx && ctx.userId') !== -1);
}

// F3/F4/F5: gates present in the live badges.js handlers.
const badgesSrc = readFileSync(join(base, 'badges/badges.js'), 'utf-8');
srcCheck('F3/F4/F5 badgeRequireAdmin gate defined in badges.js',
  badgesSrc.indexOf('function badgeRequireAdmin(ctx, nk)') !== -1);
const gateCount = (badgesSrc.match(/badgeRequireAdmin\(ctx, nk\);/g) || []).length;
srcCheck('F3/F4/F5 all three badge RPCs gated (3 call sites, got ' + gateCount + ')',
  gateCount === 3);

if (sourceFailures > 0) {
  console.error('SOURCE ASSERTIONS: FAIL — ' + sourceFailures + ' failure(s)');
  process.exit(1);
}
console.log('SOURCE ASSERTIONS: PASS');
console.log('AUTHZ SECURITY REGRESSION SUITE: PASS');
