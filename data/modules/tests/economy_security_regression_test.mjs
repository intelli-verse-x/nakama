// ============================================================================
// Economy & quest security regression suite (Lane B fixes, 2026-08-07)
// ----------------------------------------------------------------------------
// Guards the money-path fixes:
//   F1   wallet_update_global       — admin gate + amount validation + currency allowlist
//   F2   global_wallet_earn / quests_wallet_earn — admin/server-only (both impls)
//   F11  get_user_wallet / create_player_wallet  — no payload userId fallback
//   F13  wallet_convert_to_global   — upstream credit FIRST, debit after, refund on failure
//   A-04 global_to_game_convert     — per-request idempotency key + pending record
//   F6   ivx_quest _writeUserState  — permissionWrite 0; progress clamped to step size
//   Z-08 ivx_quest_claim            — actually pays out, exactly once
//   F14  quest_engine_claim_reward  — claimedAt persisted FIRST under OCC CAS
//
// Part 1 is BEHAVIORAL: it vm-loads the real ivx_quest/ivx_quest.js against an
// in-memory Nakama mock. Part 2 does source-level assertions on the TS/JS edits
// (order of operations, presence of gates, absence of fallbacks).
//
//   node tests/economy_security_regression_test.mjs
// ============================================================================

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';

const base = join(dirname(fileURLToPath(import.meta.url)), '..');

// ────────────────────────────────────────────────────────────────────────────
// Part 1 — behavioral: ivx_quest.js under an in-memory Nakama mock
// ────────────────────────────────────────────────────────────────────────────

const driver = `
var __store = {};
var __versions = {};
var __walletCalls = [];
var __walletShouldThrow = false;
var __writes = [];

function __k(c, k, u) { return c + "|" + k + "|" + u; }

var nk = {
  storageRead: function (reqs) {
    var out = [];
    for (var i = 0; i < reqs.length; i++) {
      var r = reqs[i];
      var key = __k(r.collection, r.key, r.userId);
      if (__store[key] !== undefined) {
        out.push({ value: JSON.parse(JSON.stringify(__store[key])), version: __versions[key] });
      }
    }
    return out;
  },
  storageWrite: function (reqs) {
    for (var i = 0; i < reqs.length; i++) {
      var r = reqs[i];
      var key = __k(r.collection, r.key, r.userId);
      __writes.push({ collection: r.collection, key: r.key, userId: r.userId,
        permissionRead: r.permissionRead, permissionWrite: r.permissionWrite });
      __store[key] = JSON.parse(JSON.stringify(r.value));
      __versions[key] = String((parseInt(__versions[key] || "0", 10) + 1));
    }
  },
  walletUpdate: function (userId, changeset, metadata, updateLedger) {
    if (__walletShouldThrow) throw new Error("wallet backend down");
    __walletCalls.push({ userId: userId, changeset: changeset, metadata: metadata, updateLedger: updateLedger });
    return { updated: {} };
  },
  accountsGetId: function () { return []; },
  uuidv4: function () { return "uuid-" + Math.random().toString(36).slice(2, 10); }
};
var logger = { info: function(){}, warn: function(){}, error: function(){}, debug: function(){} };

var failures = [];
function check(name, cond) {
  if (cond) { console.log("PASS  " + name); } else { console.log("FAIL  " + name); failures.push(name); }
}

var SYSTEM = "00000000-0000-0000-0000-000000000000";

// Seed a custom catalog quest with an explicit stepSize (clamp test).
__store[__k("ivx_quests_catalog", "active", SYSTEM)] = {
  quests: [
    { id: "t_stepped", name: "Stepped", type: "score_total", target: 1000,
      stepSize: 100, rewards: { coins: 5, xp: 1 }, durationDays: 1, gameId: "*" }
  ]
};
// Note: the custom catalog REPLACES the default one in _readCatalog, so the
// default quests are tested against a store-seeded copy of the defaults.
__store[__k("ivx_quests_catalog", "active", SYSTEM)].quests.push(
  { id: "ivx_play_3_games", name: "Triple Play", type: "session_count", target: 3,
    rewards: { coins: 100, xp: 50 }, durationDays: 1, gameId: "*" }
);

// ── T1: F6 — quest state writes are server-only (permissionWrite 0) ────────
var u1 = "user-t1";
var ctx1 = { userId: u1 };
var r = JSON.parse(rpcIvxQuestProgress(ctx1, logger, nk, JSON.stringify({ questId: "ivx_play_3_games", amount: 1 })));
check("T1 progress RPC succeeds", r.success === true);
var questWrites = __writes.filter(function (w) { return w.collection === "ivx_quests"; });
check("T1 _writeUserState used permissionWrite:0 (F6)",
  questWrites.length > 0 && questWrites.every(function (w) { return w.permissionWrite === 0; }));

// ── T2: F6 — client amount clamped to step size (count quest) ──────────────
var u2 = "user-t2";
var ctx2 = { userId: u2 };
var r2 = JSON.parse(rpcIvxQuestProgress(ctx2, logger, nk, JSON.stringify({ questId: "ivx_play_3_games", amount: 999 })));
check("T2 session_count quest clamped to 1 unit/call (was 999)",
  r2.success === true && r2.data.progress === 1);

// ── T3: F6 — explicit stepSize honored on accumulation quest ───────────────
var r3 = JSON.parse(rpcIvxQuestProgress(ctx2, logger, nk, JSON.stringify({ questId: "t_stepped", amount: 500 })));
check("T3 stepSize:100 quest clamps 500 → 100",
  r3.success === true && r3.data.progress === 100);

// ── T4: Z-08 — claim pays the wallet exactly once (updateLedger=true) ──────
var u4 = "user-t4";
var ctx4 = { userId: u4 };
for (var i = 0; i < 3; i++) {
  JSON.parse(rpcIvxQuestProgress(ctx4, logger, nk, JSON.stringify({ questId: "ivx_play_3_games", amount: 1 })));
}
var beforeCalls = __walletCalls.length;
var c1 = JSON.parse(rpcIvxQuestClaim(ctx4, logger, nk, JSON.stringify({ questId: "ivx_play_3_games" })));
check("T4 claim succeeds", c1.success === true && c1.data.claimed === true);
check("T4 wallet paid once with {coins:100, xp:50}, updateLedger=true",
  __walletCalls.length === beforeCalls + 1 &&
  __walletCalls[__walletCalls.length - 1].changeset.coins === 100 &&
  __walletCalls[__walletCalls.length - 1].changeset.xp === 50 &&
  __walletCalls[__walletCalls.length - 1].updateLedger === true);
check("T4 totalEarned reflects reward",
  c1.data.totalEarned.coins === 100 && c1.data.totalEarned.xp === 50);

// ── T5: Z-08 — second claim is a no-op (idempotency) ───────────────────────
var c2 = JSON.parse(rpcIvxQuestClaim(ctx4, logger, nk, JSON.stringify({ questId: "ivx_play_3_games" })));
check("T5 second claim returns alreadyClaimed",
  c2.success === true && c2.data.alreadyClaimed === true);
check("T5 wallet NOT paid twice", __walletCalls.length === beforeCalls + 1);

// ── T6: Z-08 — payout failure rolls the claim marker back (retryable) ──────
var u6 = "user-t6";
var ctx6 = { userId: u6 };
for (var j = 0; j < 3; j++) {
  JSON.parse(rpcIvxQuestProgress(ctx6, logger, nk, JSON.stringify({ questId: "ivx_play_3_games", amount: 1 })));
}
__walletShouldThrow = true;
var c3 = JSON.parse(rpcIvxQuestClaim(ctx6, logger, nk, JSON.stringify({ questId: "ivx_play_3_games" })));
check("T6 payout failure returns explicit error",
  c3.success === false && c3.error === "reward_payout_failed");
__walletShouldThrow = false;
var c4 = JSON.parse(rpcIvxQuestClaim(ctx6, logger, nk, JSON.stringify({ questId: "ivx_play_3_games" })));
check("T6 claim retryable after payout failure (marker rolled back)",
  c4.success === true && c4.data.claimed === true);
var u6Calls = __walletCalls.filter(function (w) { return w.userId === u6; });
check("T6 wallet paid exactly once for retried claim", u6Calls.length === 1);

// ── T7: claim on incomplete quest still rejected ───────────────────────────
var u7 = "user-t7";
var c5 = JSON.parse(rpcIvxQuestClaim({ userId: u7 }, logger, nk, JSON.stringify({ questId: "ivx_play_3_games" })));
check("T7 incomplete quest claim rejected",
  c5.success === false && (c5.error === "quest_not_complete" || c5.error === "quest_not_active"));

console.log(failures.length === 0
  ? "\\nBEHAVIORAL: ALL PASSED"
  : "\\nBEHAVIORAL: " + failures.length + " FAILURES: " + failures.join(" | "));
if (failures.length > 0) throw new Error("behavioral suite failed");
`;

let ivxSource = readFileSync(join(base, 'ivx_quest/ivx_quest.js'), 'utf-8');

try {
  vm.runInThisContext(ivxSource + '\n' + driver, { filename: 'ivx_quest_bundle.js' });
  console.log('PART 1 (behavioral, ivx_quest.js): PASS');
} catch (e) {
  console.error('PART 1 (behavioral, ivx_quest.js): FAIL — ' + e.message);
  process.exit(1);
}

// ────────────────────────────────────────────────────────────────────────────
// Part 2 — source-level assertions on the TS/JS edits
// ────────────────────────────────────────────────────────────────────────────

const walletTs = readFileSync(join(base, 'src/legacy/wallet.ts'), 'utf-8');
const questEngineTs = readFileSync(join(base, 'src/quests/quest_engine.ts'), 'utf-8');
const bridgeJs = readFileSync(join(base, 'quests_economy_bridge.js'), 'utf-8');
const ivxJs = readFileSync(join(base, 'ivx_quest/ivx_quest.js'), 'utf-8');

// Extract a top-level/namespace function body by name via brace matching.
function fnBody(src, name) {
  const sig = src.indexOf('function ' + name + '(');
  if (sig < 0) return null;
  const open = src.indexOf('{', sig);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(sig, i + 1);
    }
  }
  return null;
}

const sfailures = [];
function scheck(name, cond) {
  if (cond) { console.log('PASS  ' + name); } else { console.log('FAIL  ' + name); sfailures.push(name); }
}

// S1 — F1: wallet_update_global admin gate + validation + allowlist
const f1 = fnBody(walletTs, 'rpcWalletUpdateGlobal');
scheck('S1 F1 rpcWalletUpdateGlobal found', !!f1);
scheck('S1 F1 admin gate present', f1 && f1.indexOf('RpcHelpers.requireAdmin(ctx, nk)') >= 0);
scheck('S1 F1 admin gate BEFORE wallet mutation',
  f1 && f1.indexOf('requireAdmin') < f1.indexOf('saveGlobalWallet'));
scheck('S1 F1 currency allowlist', f1 && f1.indexOf('GLOBAL_WALLET_CURRENCIES') >= 0);
scheck('S1 F1 non-finite/negative amount rejected',
  f1 && f1.indexOf('!isFinite(amt) || amt < 0') >= 0);

// S2 — F2: rpcGlobalWalletEarn admin gate before any proxy call
const f2a = fnBody(walletTs, 'rpcGlobalWalletEarn');
scheck('S2 F2 rpcGlobalWalletEarn found', !!f2a);
scheck('S2 F2 admin gate before proxyGlobalApi',
  f2a && f2a.indexOf('requireAdmin') >= 0 && f2a.indexOf('requireAdmin') < f2a.indexOf('proxyGlobalApi'));

// S2b — F2: bridge rpcQuestsWalletEarn gated; internal fn preserved
const f2b = fnBody(bridgeJs, 'rpcQuestsWalletEarn');
const f2int = fnBody(bridgeJs, '_questsWalletEarnInternal');
scheck('S2b F2 rpcQuestsWalletEarn found', !!f2b);
scheck('S2b F2 bridge admin gate before wallet work',
  f2b && f2b.indexOf('_isAdminOrServerCaller') >= 0 &&
  f2b.indexOf('_isAdminOrServerCaller') < f2b.indexOf('_questsWalletEarnInternal'));
scheck('S2b F2 internal earn function preserved for server flows',
  !!f2int && f2int.indexOf('nk.walletUpdate') >= 0);

// S3 — F11: rpcGetUserWallet has no payload userId fallback
const f11a = fnBody(walletTs, 'rpcGetUserWallet');
scheck('S3 F11 rpcGetUserWallet found', !!f11a);
scheck('S3 F11 no "ctx.userId || data.userId" fallback in get_user_wallet',
  f11a && f11a.indexOf('ctx.userId || data.userId') < 0);
scheck('S3 F11 payload userId only inside admin/S2S branch',
  f11a && f11a.indexOf('requireAdmin') >= 0);

// S4 — F11: rpcCreatePlayerWallet has no deviceId fallback
const f11b = fnBody(walletTs, 'rpcCreatePlayerWallet');
scheck('S4 F11 rpcCreatePlayerWallet found', !!f11b);
scheck('S4 F11 no "ctx.userId || deviceId" fallback in create_player_wallet',
  f11b && f11b.indexOf('ctx.userId || deviceId') < 0);
scheck('S4 F11 deviceId only inside admin/S2S branch',
  f11b && f11b.indexOf('requireAdmin') >= 0);

// S5 — F13: convert_to_global credits upstream BEFORE local debit
const f13 = fnBody(walletTs, 'rpcWalletConvertToGlobal');
scheck('S5 F13 rpcWalletConvertToGlobal found', !!f13);
scheck('S5 F13 upstream earn call before saveGameWallet (debit)',
  f13 && f13.indexOf('"earn"') >= 0 && f13.indexOf('"earn"') < f13.indexOf('WalletHelpers.saveGameWallet'));
scheck('S5 F13 "non-critical" swallow removed',
  f13 && f13.indexOf('non-critical') < 0);
scheck('S5 F13 upstream failure returns explicit error before debit',
  f13 && f13.indexOf('Global wallet credit failed') >= 0 &&
  f13.indexOf('Global wallet credit failed') < f13.indexOf('WalletHelpers.saveGameWallet'));
scheck('S5 F13 compensating refund on debit failure',
  f13 && f13.indexOf('game_to_global_conversion_reversal') >= 0);

// S6 — A-04: global_to_game_convert per-request idempotency + pending record
const a04 = fnBody(walletTs, 'rpcGlobalToGameConvert');
scheck('S6 A-04 rpcGlobalToGameConvert found', !!a04);
scheck('S6 A-04 per-request uuid generated', a04 && a04.indexOf('nk.uuidv4()') >= 0);
scheck('S6 A-04 idempotencyKey passed in proxy body', a04 && a04.indexOf('idempotencyKey: conversionId') >= 0);
scheck('S6 A-04 constant sourceId gone', a04 && a04.indexOf('"game:" + gameId') < 0);
scheck('S6 A-04 pending_credit record written before local credit',
  a04 && a04.indexOf('pending_credit') >= 0 &&
  a04.indexOf('pending_credit') < a04.indexOf('WalletHelpers.saveGameWallet'));

// S7 — F14: claim persists marker (OCC) BEFORE granting
const f14 = fnBody(questEngineTs, 'rpcQuestEngineClaimReward');
scheck('S7 F14 rpcQuestEngineClaimReward found', !!f14);
scheck('S7 F14 OCC mark before grantReward',
  f14 && f14.indexOf('markQuestClaimedOcc') >= 0 &&
  f14.indexOf('markQuestClaimedOcc') < f14.indexOf('RewardEngine.grantReward'));
scheck('S7 F14 old unconditional saveUserState-after-grant removed from claim path',
  f14 && f14.indexOf('saveUserState') < 0);
const f14occ = fnBody(questEngineTs, 'markQuestClaimedOcc');
scheck('S7 F14 OCC helper does version CAS',
  !!f14occ && f14occ.indexOf('.version = ver') >= 0);
scheck('S7 F14 OCC helper has bounded retry',
  !!f14occ && f14occ.indexOf('CLAIM_OCC_MAX_RETRIES') >= 0);
scheck('S7 F14 claim conflict maps to already-claimed',
  f14 && f14.indexOf('mark === "already" || mark === "conflict"') >= 0);

// S8 — F6: ivx_quest source-level (behavioral covered above; belt & braces)
scheck('S8 F6 ivx _writeUserState permissionWrite:0',
  /permissionWrite:\s*0/.test(fnBody(ivxJs, '_writeUserState') || ''));
scheck('S8 F6 ivx progress clamp present',
  ivxJs.indexOf('quest.stepSize') >= 0 && ivxJs.indexOf('maxStep') >= 0);
const z08 = fnBody(ivxJs, 'rpcIvxQuestClaim');
scheck('S8 Z-08 ivx claim pays via walletUpdate with updateLedger=true',
  !!z08 && z08.indexOf('nk.walletUpdate') >= 0 && /,\s*true\)/.test(z08));
scheck('S8 Z-08 claim marker persisted before payout',
  !!z08 && z08.indexOf('_writeUserState') >= 0 && z08.indexOf('_writeUserState') < z08.indexOf('nk.walletUpdate'));

console.log(sfailures.length === 0
  ? '\nSOURCE ASSERTIONS: ALL PASSED'
  : '\nSOURCE ASSERTIONS: ' + sfailures.length + ' FAILURES: ' + sfailures.join(' | '));

if (sfailures.length > 0) {
  console.error('REGRESSION SUITE: FAIL');
  process.exit(1);
}
console.log('\nREGRESSION SUITE: PASS');
