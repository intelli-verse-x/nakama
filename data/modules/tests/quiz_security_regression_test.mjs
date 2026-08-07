// ============================================================================
// Quiz core security regression suite (Phase 1 — 2026-08-07)
// ----------------------------------------------------------------------------
// Guards the Lane-A fixes against regression:
//   F7  get_questions ships correct_option_ids ONLY to legacy clients
//       (secure_v2 flag) + new quizverse_answer_reveal RPC with ownership checks
//   F8  answers array capped at 200, duration_ms clamped non-negative finite
//   F9  country_code /^[A-Z]{2}$/, lang BCP-47 format, mode allowlist
//   F12 pack claim = commit point (OCC conflict replays stored result),
//       wallet grant strict + claim rollback on failure
//   M-03 variable-reward bonus grant carries ledger + pack_id
//
// Source-level assertions on the real TS sources (no build needed).
//   node tests/quiz_security_regression_test.mjs
// ============================================================================

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const base = join(dirname(fileURLToPath(import.meta.url)), '..');
const gq = readFileSync(join(base, 'src/games/quizverse/get_questions.ts'), 'utf8');
const sr = readFileSync(join(base, 'src/games/quizverse/submit_result.ts'), 'utf8');

let failures = [];
function check(name, cond) {
  if (cond) { console.log('PASS  ' + name); } else { console.log('FAIL  ' + name); failures.push(name); }
}

// ── F7: answer key guarded behind secure_v2 at BOTH client-payload sites ────
const secureGuardCount = (gq.match(/if \(!secureV2\)/g) || []).length;
check('F7 secureV2 flag parsed from payload', gq.includes('var secureV2 = req.secure_v2 === true;'));
check('F7 both client-question builders guard correct_option_ids (2 sites)', secureGuardCount === 2);
check('F7 guarded form assigns correct_option_ids conditionally',
  gq.includes('rqQ.correct_option_ids = rqq.correct_option_ids') &&
  gq.includes('cq.correct_option_ids = q.correct_option_ids'));
// No unguarded `correct_option_ids:` left inside the two client object literals
const clientLiteralLeak = /rqClientQs\.push\(\{[\s\S]*?correct_option_ids:/.test(gq) ||
  /clientQs\.push\(\{[\s\S]*?correct_option_ids:/.test(gq);
check('F7 no unguarded correct_option_ids in client push literals', !clientLiteralLeak);

// ── F7: answer_reveal RPC exists, is registered, validates ownership ────────
check('F7 quizverse_answer_reveal registered', gq.includes('registerRpc("quizverse_answer_reveal", rpcAnswerReveal)'));
check('F7 reveal requires auth', /function rpcAnswerReveal[\s\S]*?UNAUTHENTICATED/.test(gq));
check('F7 reveal reads pack from user-owned collection', /function rpcAnswerReveal[\s\S]*?COL_PACKS[\s\S]*?userId: userId/.test(gq));
check('F7 reveal validates question membership', gq.includes('question not in pack'));
check('F7 reveal returns grade + key + explanation', gq.includes('is_correct:') && gq.includes('correct_option_ids: correctIds') && gq.includes('explanation:'));

// ── F8: input clamps ────────────────────────────────────────────────────────
check('F8 answers capped at 200', sr.includes('answers.length > 200'));
check('F8 duration_ms clamped non-negative finite', /isFinite\(req\.duration_ms\) && req\.duration_ms >= 0/.test(sr));

// ── F9: request validation ──────────────────────────────────────────────────
check('F9 country_code regex-validated', gq.includes('/^[A-Z]{2}$/.test(reqCC)'));
check('F9 lang format-validated', gq.includes('/^[a-z]{2}(-[a-z0-9]{2,4})?$/.test(lang)'));
check('F9 unknown mode falls back to standard', gq.includes('falling back to standard'));

// ── F12: claim-commit + strict wallet + rollback ────────────────────────────
check('F12 commit-point comment present', sr.includes('CLAIM the pack (COMMIT POINT'));
check('F12 OCC conflict replays stored result', sr.includes('replay:          true'));
check('F12 conflict without winner returns retryable error', sr.includes('"submit_conflict"'));
check('F12 wallet failure returns explicit error', sr.includes('"wallet_grant_failed"'));
check('F12 claim rollback on wallet failure', sr.includes('pack.submitted = false;'));
check('F12 rollback failure logs CRITICAL', sr.includes('[CRITICAL] claim rollback failed'));
check('F12 updateWallet no longer swallows errors', !/function updateWallet[\s\S]*?catch \(e: any\)[\s\S]*?\n  \}/.test(sr.split('// ── Task 2.4 — leaderboard')[0]));
check('F12 updateWallet carries pack_id metadata', sr.includes('pack_id: packId }, true)'));

// Ordering: claim write happens before wallet grant, wallet before response
const iClaim = sr.indexOf('nk.storageWrite([packWrite]);');
const iWallet = sr.indexOf('updateWallet(nk, logger, userId, topic, coinsEarned, xpEarned, packId);');
const iResponse = sr.lastIndexOf('return JSON.stringify({');
check('F12 order: claim < wallet < response', iClaim > -1 && iWallet > iClaim && iResponse > iWallet);

// ── M-03: variable reward ledgered + keyed ──────────────────────────────────
check('M-03 variable reward grant writes ledger with pack_id', sr.includes('{ source: "variable_reward", pack_id: packId }, true)'));

console.log('');
if (failures.length === 0) {
  console.log('ALL CHECKS PASSED');
  console.log('QUIZ SECURITY REGRESSION SUITE: PASS');
} else {
  console.log(failures.length + ' FAILURES: ' + failures.join(' | '));
  console.log('QUIZ SECURITY REGRESSION SUITE: FAIL');
  process.exit(1);
}
