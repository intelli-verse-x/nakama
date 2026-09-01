// ============================================================================
// QuizVerse guest→registered merge regression suite (W2-5 Phase 2, 2026-08-07)
// ----------------------------------------------------------------------------
// Guards src/identity/quizverse_merge.ts (RPC quizverse_merge_guest_to_account):
//   A1  anonymous caller → 401
//   A2  caller ≠ ghost → 403 (never merge someone else's ghost)
//   A3  ghost === destination → 400
//   A4  missing ids → 400
//   B1  happy path: wallets sum-merge, ghost zeroed, collections ported,
//       audit row written, ghost sentinel set
//   B2  idempotency: second call returns cached result, no double-credit
//   B3  fraud cap: currency amounts clamp to MAX_MERGE_PER_CURRENCY
//   B4  already-merged ghost sentinel → 409
//   B5  destination keeps its own state (copy-if-absent never overwrites)
//
// Transpiles the REAL TS source (repo's own typescript dep) and runs it
// against an in-memory Nakama mock — same pattern as
// authz_security_regression_test.mjs.
//
//   node tests/quizverse_merge_regression_test.mjs
// ============================================================================

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';
import ts from 'typescript';

const base = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function check(name, cond) {
  if (cond) console.log('PASS  ' + name);
  else { console.log('FAIL  ' + name); failures++; }
}

// ── Transpile the real module source ────────────────────────────────────────
const source = readFileSync(join(base, 'src/identity/quizverse_merge.ts'), 'utf8');
const js = ts.transpileModule(source, {
  compilerOptions: { target: 'es2019', module: 'none' },
}).outputText;

// ── In-memory Nakama mock ───────────────────────────────────────────────────
function makeCtx() {
  const store = {};
  const k = (c, key, u) => c + '|' + key + '|' + u;
  const accounts = {}; // userId → { user: { metadata } }
  const nk = {
    storageRead: (reqs) => {
      const out = [];
      for (const r of reqs) {
        const v = store[k(r.collection, r.key, r.userId)];
        if (v !== undefined) out.push({ value: JSON.parse(JSON.stringify(v)) });
      }
      return out;
    },
    storageWrite: (reqs) => {
      for (const r of reqs) {
        store[k(r.collection, r.key, r.userId)] = JSON.parse(JSON.stringify(r.value));
      }
    },
    storageList: (userId, collection, limit, cursor) => {
      const prefix = collection + '|';
      const suffix = '|' + userId;
      const objects = Object.keys(store)
        .filter((key) => key.startsWith(prefix) && key.endsWith(suffix))
        .map((key) => ({ key: key.slice(prefix.length, -suffix.length), value: store[key] }));
      return { objects, cursor: '' };
    },
    accountGetId: (userId) => {
      if (!accounts[userId]) throw new Error('account not found: ' + userId);
      return accounts[userId];
    },
    accountUpdateId: (userId, _a, _b, _c, _d, _e, _f, metadata) => {
      accounts[userId] = accounts[userId] || { user: {} };
      accounts[userId].user.metadata = metadata;
      return {};
    },
  };
  const sandbox = {
    nk,
    logger: { info() {}, warn() {}, error() {} },
    Constants: {
      SYSTEM_USER_ID: 'SYSTEM',
      WALLETS_COLLECTION: 'wallets',
      HIRO_PROGRESSION_COLLECTION: 'hiro_progression',
      HIRO_STREAKS_COLLECTION: 'hiro_streaks',
      HIRO_STATS_COLLECTION: 'hiro_stats',
      HIRO_INVENTORY_COLLECTION: 'hiro_inventory',
      HIRO_ACHIEVEMENTS_COLLECTION: 'hiro_achievements',
      DAILY_REWARDS_COLLECTION: 'daily_rewards',
      SATORI_ASSIGNMENTS_COLLECTION: 'satori_assignments',
    },
    RpcHelpers: {
      parseRpcPayload: (p) => (typeof p === 'string' ? JSON.parse(p || '{}') : p || {}),
      successResponse: (d) => JSON.stringify({ success: true, data: d }),
      errorResponse: (message, code) => JSON.stringify({ success: false, error: message, code }),
      logRpcError() {},
    },
    QuizverseMerge: undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(js + '\nthis.QuizverseMerge = QuizverseMerge;', sandbox);
  return { sandbox, store, accounts, nk };
}

function callRpc(sandbox, ctxUserId, payload) {
  const ctx = { userId: ctxUserId, env: {} };
  const logger = { info() {}, warn() {}, error() {} };
  // register() captures the handler — invoke through a fake initializer.
  let handler = null;
  sandbox.QuizverseMerge.register({
    registerRpc: (id, fn) => {
      if (id === 'quizverse_merge_guest_to_account') handler = fn;
    },
  });
  if (!handler) throw new Error('RPC not registered');
  return JSON.parse(handler(ctx, logger, sandbox.nk, JSON.stringify(payload)));
}

// ── Fixtures ────────────────────────────────────────────────────────────────
const GHOST = 'ghost-user-1';
const DEST = 'cognito-user-1';

function seed(ctx) {
  ctx.accounts[GHOST] = { user: { metadata: {} } };
  ctx.accounts[DEST] = { user: { metadata: {} } };
  // Ghost wallet: 500 coins + 5 gems; destination already has 100 coins.
  ctx.store['wallets|global_' + GHOST + '|' + GHOST] = {
    userId: GHOST, currencies: { coins: 500, gems: 5 }, items: { hint: 2 },
  };
  ctx.store['wallets|global_' + DEST + '|' + DEST] = {
    userId: DEST, currencies: { coins: 100 }, items: {},
  };
  // Game state on both sides (destination state must win).
  ctx.store['hiro_streaks|quizverse:state|' + GHOST] = { current: 7 };
  ctx.store['hiro_streaks|quizverse:state|' + DEST] = { current: 30 };
  ctx.store['qv_seen|solo_cricket|' + GHOST] = { seen: ['q1', 'q2'] };
  ctx.store['satori_assignments|126bf539-dae2-4bcf-964d-316c0fa1f92b:assignments|' + GHOST] = {
    assignments: { quest_reward_ab: { variantId: 'treatment', assignedAt: 1 } },
  };
}

// ── A: authorization ────────────────────────────────────────────────────────
{
  const ctx = makeCtx(); seed(ctx);
  const anon = callRpc(ctx.sandbox, null, { ghost_user_id: GHOST, cognito_user_id: DEST });
  check('A1 anonymous caller → 401', anon.success === false && anon.code === 401);

  const thief = callRpc(ctx.sandbox, 'someone-else', { ghost_user_id: GHOST, cognito_user_id: DEST });
  check('A2 caller ≠ ghost → 403', thief.success === false && thief.code === 403);

  const same = callRpc(ctx.sandbox, GHOST, { ghost_user_id: GHOST, cognito_user_id: GHOST });
  check('A3 ghost === destination → 400', same.success === false && same.code === 400);

  const missing = callRpc(ctx.sandbox, GHOST, {});
  check('A4 missing ids → 400', missing.success === false && missing.code === 400);

  const noDest = callRpc(ctx.sandbox, GHOST, { ghost_user_id: GHOST, cognito_user_id: 'nope' });
  check('A5 unknown destination → 404', noDest.success === false && noDest.code === 404);
}

// ── B1: happy path ──────────────────────────────────────────────────────────
{
  const ctx = makeCtx(); seed(ctx);
  const res = callRpc(ctx.sandbox, GHOST, { ghost_user_id: GHOST, cognito_user_id: DEST });
  check('B1 merge succeeds', res.success === true && res.data.ok === true);

  const destWallet = ctx.store['wallets|global_' + DEST + '|' + DEST];
  check('B1 wallet sum-merged (100+500 coins, +5 gems)',
    destWallet.currencies.coins === 600 && destWallet.currencies.gems === 5);
  check('B1 wallet items merged (hint ×2)', destWallet.items.hint === 2);

  const ghostWallet = ctx.store['wallets|global_' + GHOST + '|' + GHOST];
  check('B1 ghost wallet zeroed',
    !ghostWallet.currencies.coins && !ghostWallet.currencies.gems);

  check('B1 destination streak untouched (copy-if-absent)',
    ctx.store['hiro_streaks|quizverse:state|' + DEST].current === 30);
  check('B1 ghost-only qv_seen doc ported',
    ctx.store['qv_seen|solo_cricket|' + DEST] !== undefined);
  check('B1 ghost A/B assignment ported copy-if-absent',
    ctx.store['satori_assignments|126bf539-dae2-4bcf-964d-316c0fa1f92b:assignments|' + DEST]
      .assignments.quest_reward_ab.variantId === 'treatment');

  const auditKey = 'account_merge_log|merge_idem_' + GHOST + '_' + DEST + '|SYSTEM';
  check('B1 audit row written', ctx.store[auditKey] !== undefined);
  check('B1 ghost sentinel set',
    ctx.accounts[GHOST].user.metadata.merged_to === DEST);
}

// ── B2: idempotency — no double-credit on retry ─────────────────────────────
{
  const ctx = makeCtx(); seed(ctx);
  callRpc(ctx.sandbox, GHOST, { ghost_user_id: GHOST, cognito_user_id: DEST });
  const again = callRpc(ctx.sandbox, GHOST, { ghost_user_id: GHOST, cognito_user_id: DEST });
  check('B2 second call → idempotent cached result',
    again.success === true && again.data.idempotent === true);
  const destWallet = ctx.store['wallets|global_' + DEST + '|' + DEST];
  check('B2 no double-credit (still 600 coins)', destWallet.currencies.coins === 600);
}

// ── B3: fraud cap ───────────────────────────────────────────────────────────
{
  const ctx = makeCtx(); seed(ctx);
  ctx.store['wallets|global_' + GHOST + '|' + GHOST].currencies.coins = 999999999;
  callRpc(ctx.sandbox, GHOST, { ghost_user_id: GHOST, cognito_user_id: DEST });
  const destWallet = ctx.store['wallets|global_' + DEST + '|' + DEST];
  check('B3 currency clamped to 100k cap (100 + 100000)',
    destWallet.currencies.coins === 100100);
}

// ── B4: already-merged ghost refuses a second merge elsewhere ───────────────
{
  const ctx = makeCtx(); seed(ctx);
  ctx.accounts['cognito-user-2'] = { user: { metadata: {} } };
  callRpc(ctx.sandbox, GHOST, { ghost_user_id: GHOST, cognito_user_id: DEST });
  const second = callRpc(ctx.sandbox, GHOST, { ghost_user_id: GHOST, cognito_user_id: 'cognito-user-2' });
  // Idem key differs, so this reaches the sentinel check.
  check('B4 merged ghost → 409 on second target',
    second.success === false && second.code === 409);
}

// ── B5: destination assignment wins; guest bucket does not flip dest ────────
{
  const ctx = makeCtx(); seed(ctx);
  ctx.store['satori_assignments|126bf539-dae2-4bcf-964d-316c0fa1f92b:assignments|' + DEST] = {
    assignments: { quest_reward_ab: { variantId: 'control', assignedAt: 9 } },
  };
  callRpc(ctx.sandbox, GHOST, { ghost_user_id: GHOST, cognito_user_id: DEST });
  check('B5 destination A/B bucket kept (copy-if-absent)',
    ctx.store['satori_assignments|126bf539-dae2-4bcf-964d-316c0fa1f92b:assignments|' + DEST]
      .assignments.quest_reward_ab.variantId === 'control');
}

// ── Done ────────────────────────────────────────────────────────────────────
console.log(failures === 0 ? '\nALL CHECKS PASS' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
