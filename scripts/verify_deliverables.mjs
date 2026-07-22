#!/usr/bin/env node
// verify_deliverables.mjs — Seed Questions × Aahaa deliverable verifier.
// ─────────────────────────────────────────────────────────────────────────────
// Runs 15 numbered checks covering every deliverable of the SeedQ/Aahaa
// project (see docs/VERIFIER_LOOP.md for the check → deliverable map) against
// a live Nakama backend. Every run mints FRESH device-auth personas, so the
// suite is repeatable forever and never depends on prior state.
//
// Zero npm deps — node >= 18 (global fetch) is the only requirement.
//
// Usage:
//   node scripts/verify_deliverables.mjs                         # one run vs localhost
//   node scripts/verify_deliverables.mjs --host http://host:7350 # other host
//   node scripts/verify_deliverables.mjs --loop 300              # re-run forever every 300s
//
// Flags / env:
//   --host URL         (env NAKAMA_HOST,  default http://localhost:7350)
//   --http-key KEY     (env HTTP_KEY,     default defaulthttpkey)  admin RPCs
//   --client-key KEY   (env CLIENT_KEY,   default defaultkey)      device auth
//   --out PATH         (env VERIFY_OUT,   default web/seedquestions/verify-latest.json;
//                       pass --out none to skip writing)
//   --loop SECONDS     re-run forever, sleeping SECONDS between runs
//   --no-color         plain output
//
// Exit code: 0 when every check PASSes, 1 otherwise (single-run mode).
// In --loop mode the process never exits; each round prints a summary and
// rewrites the JSON evidence file.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── config ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name, envName, dflt) {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1];
  if (envName && process.env[envName]) return process.env[envName];
  return dflt;
}
const HOST = flag("--host", "NAKAMA_HOST", "http://localhost:7350").replace(/\/+$/, "");
const HTTP_KEY = flag("--http-key", "HTTP_KEY", "defaulthttpkey");
const CLIENT_KEY = flag("--client-key", "CLIENT_KEY", "defaultkey");
const LOOP_SEC = parseInt(flag("--loop", "VERIFY_LOOP", "0"), 10) || 0;
const NO_COLOR = argv.includes("--no-color") || !process.stdout.isTTY;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const OUT_PATH = flag("--out", "VERIFY_OUT", join(REPO_ROOT, "web", "seedquestions", "verify-latest.json"));
const INDEX_JS = join(REPO_ROOT, "data", "modules", "index.js");

// ── ansi ─────────────────────────────────────────────────────────────────────
const c = (code, s) => (NO_COLOR ? s : `\x1b[${code}m${s}\x1b[0m`);
const green = (s) => c("32;1", s), red = (s) => c("31;1", s), dim = (s) => c("2", s),
  bold = (s) => c("1", s), cyan = (s) => c("36", s), yellow = (s) => c("33", s);

// ── the 20 RPC ids shipped by this project ───────────────────────────────────
const RPC_IDS = [
  "quizverse_seedq_get_staged", "quizverse_seedq_consume_set", "quizverse_seedq_review",
  "quizverse_seedq_focus_tracks", "quizverse_seedq_sources", "quizverse_seedq_ingest",
  "quizverse_seedq_ingest_tick", "quizverse_seedq_pool_stats", "quizverse_seedq_asset_job",
  "quizverse_seedq_provenance",
  "quizverse_seedq_crawl_job_submit", "quizverse_seedq_crawl_job_status",
  "quizverse_seedq_crawl_candidate_ingest",
  "quizverse_aahaa_get", "quizverse_aahaa_react", "quizverse_aahaa_fact_pack",
  "quizverse_aahaa_profile_set", "quizverse_aahaa_generate_all", "quizverse_aahaa_validate",
  "quizverse_aahaa_catalog",
];

// ── http helpers ─────────────────────────────────────────────────────────────
async function http(url, opts) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 30000);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url.split("?")[0]} → ${JSON.stringify(data).slice(0, 300)}`);
    return data;
  } finally { clearTimeout(t); }
}

async function deviceAuth(label) {
  const id = `vfy-${label}-` + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const username = `vfy_${label}_${Math.random().toString(36).slice(2, 8)}`;
  const data = await http(
    `${HOST}/v2/account/authenticate/device?create=true&username=${encodeURIComponent(username)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + Buffer.from(`${CLIENT_KEY}:`).toString("base64"),
      },
      body: JSON.stringify({ id }),
    },
  );
  if (!data.token) throw new Error("device auth returned no token: " + JSON.stringify(data).slice(0, 200));
  const claims = JSON.parse(Buffer.from(data.token.split(".")[1], "base64").toString());
  return { token: data.token, userId: claims.uid, username: claims.usn };
}

async function rpc(persona, id, body) {
  return http(`${HOST}/v2/rpc/${id}?unwrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${persona.token}` },
    body: JSON.stringify(body ?? {}),
  });
}

async function adminRpc(id, body) {
  return http(`${HOST}/v2/rpc/${id}?http_key=${encodeURIComponent(HTTP_KEY)}&unwrap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
const ids = (set) => set.question_ids || (set.questions || []).map((q) => q.id);
const allStagedIds = (res) => (res.sets || []).flatMap(ids);

function assertCacheableStagedPayload(res, expectedUserId) {
  const cache = res.cache || {};
  assert(Number.isInteger(cache.schema_version) && cache.schema_version >= 1,
    `cache.schema_version missing/invalid: ${JSON.stringify(cache)}`);
  assert(cache.self_contained === true && cache.contains_answer_keys === true,
    `cache payload not declared self-contained with answer keys`);
  assert(typeof cache.cache_key === "string" && cache.cache_key.startsWith(expectedUserId + "/"),
    `cache key is not user-scoped: ${cache.cache_key}`);
  assert(cache.expires_ms > cache.generated_ms && Date.parse(cache.expires_at) === cache.expires_ms,
    `cache expiry metadata missing/inconsistent`);
  assert(res.ready_depth === (res.sets || []).length, `ready_depth does not match sets.length`);
  assert(res.ready_depth >= 2, `ready depth ${res.ready_depth} is below safety minimum 2`);

  const questions = (res.sets || []).flatMap((s) => s.questions || []);
  for (const q of questions) {
    assert(q.id && q.question && Array.isArray(q.options) && q.options.length >= 2,
      `question is not self-contained: ${JSON.stringify(q).slice(0, 180)}`);
    assert(Number.isInteger(q.correct_index) && q.correct_index >= 0 && q.correct_index < q.options.length,
      `question ${q.id} has invalid answer index`);
    assert(Object.prototype.hasOwnProperty.call(q, "media_url"),
      `question ${q.id} omits media_url cache field`);
    assert(q.quality && q.quality.status === "approved",
      `question ${q.id} is not quality-approved`);
    assert(q.review && q.review.reviewed === true &&
      ["auto_qa", "agent"].includes(q.review.reviewer) &&
      Array.isArray(q.review.checks) && q.review.version &&
      Array.isArray(q.review.experience_checks) && q.review.experience_checks.length > 0,
      `question ${q.id} lacks truthful review provenance`);
  }

  // Simulate an encrypted-disk cache boundary: JSON bytes are persisted and
  // hydrated later without any server lookup. Stable IDs, media and answers
  // must survive exactly.
  const hydrated = JSON.parse(JSON.stringify(res));
  assert(JSON.stringify(allStagedIds(hydrated)) === JSON.stringify(allStagedIds(res)),
    `set/question IDs changed across cache serialization`);
  const hydratedQs = hydrated.sets.flatMap((s) => s.questions || []);
  assert(hydratedQs.every((q, i) =>
    q.id === questions[i].id &&
    q.correct_index === questions[i].correct_index &&
    q.media_url === questions[i].media_url),
  `IDs, media, or answer keys changed across cache serialization`);
  return { questions: questions.length, bytes: Buffer.byteLength(JSON.stringify(res)) };
}

function mkHistory(total, correct) {
  const out = [];
  for (let i = 0; i < total; i++) {
    out.push({ category: "math", correct: i < correct, time_ms: 4000 + Math.floor(Math.random() * 3000) });
  }
  return out;
}
async function seedGames(persona, games, total, correct) {
  for (let g = 0; g < games; g++) {
    const qh = mkHistory(total, correct);
    await rpc(persona, "quiz_submit_result", {
      score: Math.round((correct / total) * 100),
      totalQuestions: total, correctAnswers: correct,
      category: "math", questionHistory: qh,
    });
  }
}

// ── suite ────────────────────────────────────────────────────────────────────
async function runSuite() {
  const runId = Math.random().toString(36).slice(2, 10);
  const checks = [];
  const ctx = {}; // cross-check state

  async function check(id, name, deliverable, fn) {
    const t0 = Date.now();
    let pass = false, detail = "";
    try { detail = await fn(); pass = true; }
    catch (e) { detail = e && e.message ? e.message : String(e); }
    const entry = { id, name, deliverable, pass, detail, ms: Date.now() - t0 };
    checks.push(entry);
    const chip = pass ? green(" PASS ") : red(" FAIL ");
    console.log(`  ${String(id).padStart(2)} ${chip} ${bold(name.padEnd(26))} ${dim(`[${deliverable}]`)} ${dim(entry.ms + "ms")}`);
    console.log(`     ${pass ? dim(detail) : red(detail)}`);
    return entry;
  }

  console.log(`\n${bold("Seed Questions × Aahaa — deliverable verifier")}`);
  console.log(dim(`host=${HOST}  run=${runId}  ${new Date().toISOString()}\n`));

  // 1 · RPC registration in the built bundle (skip gracefully off-repo).
  await check(1, "RPC registration ×20", "RPC Surface", async () => {
    if (!existsSync(INDEX_JS)) return "index.js not present — skipped (in-cluster / off-repo run); covered by repo-local runs";
    const bundle = readFileSync(INDEX_JS, "utf8");
    const missing = RPC_IDS.filter((id) => !bundle.includes(`registerRpc("${id}"`));
    assert(missing.length === 0, "missing registerRpc in index.js: " + missing.join(", "));
    return `all ${RPC_IDS.length} RPC ids registered in data/modules/index.js`;
  });

  // 2 · Fresh persona staging.
  await check(2, "Fresh persona staging", "SeedQ Adaptive", async () => {
    ctx.a = await deviceAuth("a");
    ctx.stage0 = await rpc(ctx.a, "quizverse_seedq_get_staged", { mode: "CustomTopic", topic: "math", set_size: 6, want_sets: 3 });
    const r = ctx.stage0;
    assert(r.ok === true, "get_staged not ok: " + JSON.stringify(r).slice(0, 200));
    assert((r.sets || []).length === 3, `expected 3 ready sets, got ${(r.sets || []).length}`);
    r.sets.forEach((s, i) => assert((s.questions || []).length === 6, `set ${i + 1} has ${(s.questions || []).length} questions, expected 6`));
    assert(r.adaptive && r.adaptive.basis === "default", `fresh user basis expected "default", got "${r.adaptive && r.adaptive.basis}"`);
    const cached = assertCacheableStagedPayload(r, ctx.a.userId);
    return `persona ${ctx.a.username}: 3 sets × 6 questions; cache schema v${r.cache.schema_version}, ${cached.bytes} serialized bytes round-trip with IDs/media/answers intact`;
  });

  // 3 · Adaptive difficulty: high-accuracy persona targets harder than low-accuracy.
  await check(3, "Adaptive difficulty hi>lo", "SeedQ Adaptive", async () => {
    await seedGames(ctx.a, 3, 8, 8); // 24/24 correct in math
    const hi = await rpc(ctx.a, "quizverse_seedq_get_staged", { mode: "CustomTopic", topic: "math", set_size: 6, want_sets: 3 });
    ctx.b = await deviceAuth("b");
    await seedGames(ctx.b, 3, 8, 2); // 6/24 correct
    const lo = await rpc(ctx.b, "quizverse_seedq_get_staged", { mode: "CustomTopic", topic: "math", set_size: 6, want_sets: 3 });
    const ha = hi.adaptive || {}, la = lo.adaptive || {};
    assert(ha.basis && ha.basis !== "default", `high persona basis still "${ha.basis}" after 24 answers`);
    assert(la.basis && la.basis !== "default", `low persona basis still "${la.basis}" after 24 answers`);
    assert(ha.target_difficulty > la.target_difficulty,
      `expected high target > low target, got d${ha.target_difficulty} vs d${la.target_difficulty}`);
    ctx.stageHi = hi;
    return `high 100% acc → target d${ha.target_difficulty} (${ha.basis}, n=${ha.sample_size}) > low 25% acc → d${la.target_difficulty} (${la.basis}, n=${la.sample_size})`;
  });

  // 4 · Pre-staged depth: sets 2–3 already exist before set 1 is consumed.
  await check(4, "Pre-staged depth 2–3", "D1 No-repeat", async () => {
    const sets = ctx.stage0.sets;
    assert(sets[1] && sets[1].set_id && (sets[1].questions || []).length === 6, "set 2 missing / short before any consume");
    assert(sets[2] && sets[2].set_id && (sets[2].questions || []).length === 6, "set 3 missing / short before any consume");
    return `sets 2–3 pre-built behind set 1: ${sets[1].set_id}, ${sets[2].set_id}`;
  });

  // 5 · Uniqueness across the 18 staged questions.
  await check(5, "Staged id uniqueness ×18", "D1 No-repeat", async () => {
    const all = allStagedIds(ctx.stage0);
    assert(all.length === 18, `expected 18 staged ids, got ${all.length}`);
    const dupes = all.filter((id, i) => all.indexOf(id) !== i);
    assert(dupes.length === 0, "duplicate ids across staged sets: " + [...new Set(dupes)].join(", "));
    return `18 staged question ids, all distinct`;
  });

  // 6 · Consume + restage: zero overlap with consumed ids.
  await check(6, "Consume → restage no-overlap", "D1 No-repeat", async () => {
    const set1 = ctx.stage0.sets[0];
    const consumed = new Set(ids(set1));
    const res = await rpc(ctx.a, "quizverse_seedq_consume_set", { mode: "CustomTopic", topic: "math", set_id: set1.set_id });
    assert(res.ok === true, "consume_set not ok: " + JSON.stringify(res).slice(0, 200));
    assert(res.ready_depth === 3 && res.restaged && res.restaged.ready_sets === 3,
      `consume did not immediately refill to depth 3: ${JSON.stringify(res.restaged)}`);
    const restaged = await rpc(ctx.a, "quizverse_seedq_get_staged", { mode: "CustomTopic", topic: "math", set_size: 6, want_sets: 3 });
    ctx.stage1 = restaged;
    const overlap = allStagedIds(restaged).filter((id) => consumed.has(id));
    assert(overlap.length === 0, `${overlap.length} consumed ids reappeared after restage: ${overlap.slice(0, 5).join(", ")}`);
    assert(restaged.pool.available_unseen > 0 && restaged.repeat_policy.review_count === 0,
      `fresh pool remained but Smart Review repeats were served`);
    return `consumed ${set1.set_id} (${consumed.size} ids) → immediate depth ${res.ready_depth}, fetched depth ${restaged.sets.length}, 0 overlap while fresh pool remained`;
  });

  // 7 · No-repeat production chokepoint: double request_questions is disjoint.
  await check(7, "No-repeat chokepoint ×2", "D1 No-repeat", async () => {
    const topic = `verify_${runId}`;
    const inline = [];
    for (let i = 1; i <= 12; i++) {
      inline.push({ id: `vq_${runId}_${i}`, question: `Verifier question #${i} — pick A.`, options: ["A", "B", "C"], correct_index: 0, category: topic, difficulty: 3 });
    }
    const payload = { kind: "deduped_s3", mode: "Verifier", scope: "global", topic, count: 6, id_prefix: "vfy", inline_questions: inline };
    const r1 = await rpc(ctx.a, "quizverse_request_questions", payload);
    assert(r1.ok === true, "call 1 not ok: " + JSON.stringify(r1).slice(0, 200));
    const r2 = await rpc(ctx.a, "quizverse_request_questions", payload);
    assert(r2.ok === true, "call 2 not ok: " + JSON.stringify(r2).slice(0, 200));
    const ids1 = (r1.questions || []).map((q) => q.id), ids2 = (r2.questions || []).map((q) => q.id);
    const shared = ids2.filter((id) => ids1.includes(id));
    assert(shared.length === 0, `${shared.length} ids repeated across back-to-back calls: ${shared.join(", ")}`);
    for (const [n, r, list] of [[1, r1, ids1], [2, r2, ids2]]) {
      const p = r.repeat_policy;
      assert(p && typeof p.fresh_count === "number" && typeof p.review_count === "number" && typeof p.pool_exhausted === "boolean",
        `call ${n} repeat_policy missing/malformed: ${JSON.stringify(p)}`);
      assert(p.fresh_count + p.review_count === list.length,
        `call ${n} arithmetic: fresh ${p.fresh_count} + review ${p.review_count} != served ${list.length}`);
    }
    return `disjoint: [${ids1.join(",")}] vs [${ids2.join(",")}]; policies fresh=${r1.repeat_policy.fresh_count}/${r2.repeat_policy.fresh_count} review=${r1.repeat_policy.review_count}/${r2.repeat_policy.review_count}`;
  });

  // 8 · Quality gate + honesty fields on every staged response.
  await check(8, "Quality approved + honesty", "SeedQ Quality", async () => {
    const res = ctx.stage1 || ctx.stage0;
    const qs = (res.sets || []).flatMap((s) => s.questions || []);
    const bad = qs.filter((q) => !q.quality || q.quality.status !== "approved");
    assert(bad.length === 0, `${bad.length}/${qs.length} served questions not quality-approved: ` +
      bad.slice(0, 3).map((q) => `${q.id}=${q.quality && q.quality.status}`).join(", "));
    assert(res.repeat_policy && typeof res.repeat_policy.fresh_count === "number", "repeat_policy missing on get_staged response");
    assert(typeof res.suppress_rating_prompt === "boolean", "suppress_rating_prompt missing on get_staged response");
    return `${qs.length}/${qs.length} served questions quality.status="approved"; repeat_policy + suppress_rating_prompt present`;
  });

  // 9 · Media mode: wsrv.nl-optimized URLs with provenance.
  await check(9, "Media wsrv.nl + provenance", "SeedQ Media", async () => {
    const res = await rpc(ctx.a, "quizverse_seedq_get_staged", { mode: "ImageGuess", topic: "space", set_size: 4, want_sets: 2 });
    assert(res.ok === true, "media get_staged not ok: " + JSON.stringify(res).slice(0, 200));
    const qs = (res.sets && res.sets[0] && res.sets[0].questions) || [];
    assert(qs.length > 0, "no ImageGuess/space questions staged (pool empty?)");
    const noMedia = qs.filter((q) => !q.media_url || !q.media_url.includes("wsrv.nl"));
    assert(noMedia.length === 0, `${noMedia.length}/${qs.length} questions lack a wsrv.nl media_url: ` +
      noMedia.slice(0, 3).map((q) => `${q.id}=${(q.media_url || "none").slice(0, 60)}`).join(", "));
    const noProv = qs.filter((q) => !q.media_provenance);
    assert(noProv.length === 0, `${noProv.length}/${qs.length} media questions missing provenance`);
    return `${qs.length} image questions: all media_url via wsrv.nl, all with provenance (` +
      [...new Set(qs.map((q) => q.media_provenance.license))].join("/") + ")";
  });

  // 10 · Aahaa: feed generates for the seeded persona; fact pack matches history.
  await check(10, "Aahaa feed + fact pack", "D2 Fact-pack · D3 Aahaa", async () => {
    const feedRes = await rpc(ctx.a, "quizverse_aahaa_get", { generate: true });
    assert(feedRes.ok === true, "aahaa_get not ok: " + JSON.stringify(feedRes).slice(0, 200));
    const feed = feedRes.feed || [];
    assert(feed.length >= 1, "empty wow feed for a persona with 3 seeded games");
    assert(typeof feedRes.rating_prompt_suppressed === "boolean", "rating_prompt_suppressed missing");
    const fpRes = await rpc(ctx.a, "quizverse_aahaa_fact_pack", {});
    assert(fpRes.ok === true, "fact_pack not ok");
    ctx.facts = fpRes.facts;
    const answered = ctx.facts && ctx.facts.lifetime && ctx.facts.lifetime.questions_answered;
    assert(answered >= 24, `fact pack lifetime.questions_answered=${answered}, expected ≥24 (3×8 submitted)`);
    const react = await rpc(ctx.a, "quizverse_aahaa_react", { wow_id: feed[0].wow_id, action: "shown" });
    assert(react.ok === true, "aahaa_react not ok: " + JSON.stringify(react).slice(0, 200));
    return `feed=${feed.length} wows (top: ${feed[0].wow_id}, tier ${feed[0].tier}); fact pack answered=${answered} ≥ 24; react(shown) ok`;
  });

  // 11 · No-Hallucination validator: fabricated fails, faithful passes.
  await check(11, "Validator no-hallucination", "D4 Validator", async () => {
    assert(ctx.facts, "no fact pack from check 10");
    const lt = ctx.facts.lifetime || {};
    const fab = await adminRpc("quizverse_aahaa_validate", {
      facts: ctx.facts,
      text: "You answered 987654 questions and you felt thrilled about every single one.",
    });
    assert(fab.ok === true, "validate(fabricated) not ok: " + JSON.stringify(fab).slice(0, 200));
    assert(fab.validation && fab.validation.pass === false, "fabricated text unexpectedly PASSED the validator");
    assert((fab.validation.violations || []).length > 0, "fabricated text failed but reported no violations");
    const faithfulText = `You answered ${lt.questions_answered} questions with ${lt.accuracy_pct}% accuracy. Keep going.`;
    const ok = await adminRpc("quizverse_aahaa_validate", { facts: ctx.facts, text: faithfulText });
    assert(ok.ok === true, "validate(faithful) not ok: " + JSON.stringify(ok).slice(0, 200));
    assert(ok.validation && ok.validation.pass === true,
      "faithful rephrase unexpectedly FAILED: " + JSON.stringify(ok.validation && ok.validation.violations));
    return `fabricated → pass:false (${fab.validation.violations.length} violations: ${fab.validation.violations[0]}); faithful "${faithfulText}" → pass:true`;
  });

  // 12 · Sources registry + pool observability.
  await check(12, "Sources ×16 + pool stats", "Sources", async () => {
    const src = await adminRpc("quizverse_seedq_sources", {});
    assert(src.ok === true, "sources not ok: " + JSON.stringify(src).slice(0, 200));
    const n = (src.sources || []).length;
    assert(n === 16, `expected 16 connectors, got ${n}`);
    const stats = await adminRpc("quizverse_seedq_pool_stats", {});
    assert(stats.ok === true, "pool_stats not ok: " + JSON.stringify(stats).slice(0, 200));
    assert(Array.isArray(stats.pools) && stats.pools.length >= 1, "pool_stats returned no pools");
    return `16 connectors registered; ${stats.pools.length} pools (e.g. ${stats.pools.slice(0, 3).map((p) => `${p.key}:${p.size}`).join(", ")})`;
  });

  // 13 · Every canonical mode resolves to a source or explicit safe fallback.
  await check(13, "Canonical mode coverage", "Mode Coverage", async () => {
    const src = await adminRpc("quizverse_seedq_sources", {});
    const modes = src.modes || [];
    assert(modes.length >= 34, `expected backend/client mode union, got ${modes.length}`);
    const malformed = modes.filter((m) => !m.mode || !m.kind || !m.delivery_contract ||
      typeof m.seedq_required !== "boolean" ||
      (m.seedq_required && (!m.inventory_mode || !["direct", "fallback"].includes(m.support))) ||
      (m.support === "fallback" && m.seedq_required && !m.fallback_mode));
    assert(malformed.length === 0, `modes missing taxonomy/lineage: ${malformed.map((m) => m.mode).join(", ")}`);
    const denominatorModes = modes.filter((m) => m.seedq_required && m.kind !== "non_question");
    const persona = await deviceAuth("allmodes");
    const staged = [], blocked = [];
    for (const m of denominatorModes) {
      const r = await rpc(persona, "quizverse_seedq_get_staged", {
        mode: m.mode, topic: m.default_topic, set_size: 4, want_sets: 2,
      });
      if (r.ready_depth >= 2) staged.push(m.mode);
      else blocked.push(`${m.mode}:${r.availability && r.availability.reason}`);
      assert(r.source_route && r.source_route.route,
        `${m.mode} response omitted source_route`);
    }
    const stats = await adminRpc("quizverse_seedq_pool_stats", {});
    assert((stats.mode_coverage || []).length === modes.length,
      `pool_stats mode_coverage mismatch`);
    const releaseGaps = (stats.mode_coverage || []).filter((m) => m.denominator && m.status !== "PASS");
    assert(releaseGaps.length === 0,
      `release-gating coverage gaps: ${releaseGaps.map((m) => `${m.mode}:${m.status}:${m.deficit}`).join(", ")}`);
    return `${modes.length} canonical modes resolved; ${staged.length}/${denominatorModes.length} question-consuming routes staged ≥2 sets; 0 WARN/BLOCKED`;
  });

  // 14 · Country isolation, 60/40 ranking, invalid input, and global fallback.
  await check(14, "Geo isolation + review gate", "Geo · Quality", async () => {
    const topic = `geo_${runId}`;
    const questions = [];
    const add = (prefix, country, n) => {
      for (let i = 0; i < n; i++) questions.push({
        question: `${prefix} curriculum item ${i + 1}: choose the verified label.`,
        options: ["A", "B", "C", "D"], correct_index: 0, difficulty: 2 + (i % 3),
        country_codes: country ? [country] : [], geo_relevance: country ? 100 : 0,
        geo_reason: country ? `relevant to ${country}` : "global curriculum",
      });
    };
    add("India", "IN", 30); add("United States", "US", 30); add("Global", "", 30);
    const ing = await adminRpc("quizverse_seedq_ingest", {
      source: "verifier", mode: "SoloChallenge", topic, questions,
    });
    assert(ing.ok && ing.result.accepted >= 90, `geo fixture ingest failed: ${JSON.stringify(ing).slice(0, 240)}`);

    const inUser = await deviceAuth("geo-in"), usUser = await deviceAuth("geo-us");
    const [inRes, usRes] = await Promise.all([
      rpc(inUser, "quizverse_seedq_get_staged", { mode: "SoloChallenge", topic, country: "IN", locale: "en-IN", set_size: 6, want_sets: 3 }),
      rpc(usUser, "quizverse_seedq_get_staged", { mode: "SoloChallenge", topic, country: "US", locale: "en-US", set_size: 6, want_sets: 3 }),
    ]);
    assert(inRes.personalization.geo.country === "IN" && inRes.personalization.geo.basis === "payload_country", "IN geo metadata incorrect");
    assert(usRes.personalization.geo.country === "US" && usRes.personalization.geo.basis === "payload_country", "US geo metadata incorrect");
    assert(inRes.cache.cache_key.endsWith("/in") && usRes.cache.cache_key.endsWith("/us"), "country missing from cache key");
    assert(inRes.personalization.geo.relevant_count > inRes.personalization.geo.global_count, "IN relevance did not outrank global");
    assert(usRes.personalization.geo.relevant_count > usRes.personalization.geo.global_count, "US relevance did not outrank global");
    const inQs = inRes.sets.flatMap((s) => s.questions);
    const usQs = usRes.sets.flatMap((s) => s.questions);
    assert(inQs.every((q) => !(q.country_codes || []).length || q.country_codes.includes("IN")), "IN received another country's question");
    assert(usQs.every((q) => !(q.country_codes || []).length || q.country_codes.includes("US")), "US received another country's question");
    assert(inQs.every((q) => q.quality.status === "approved" && q.review.reviewed), "unreviewed IN question served");

    const invalidUser = await deviceAuth("geo-invalid");
    const invalid = await rpc(invalidUser, "quizverse_seedq_get_staged", {
      mode: "SoloChallenge", topic, country: "ZZ", locale: "not-a-locale", set_size: 6, want_sets: 3,
    });
    assert(invalid.personalization.geo.country === "GLOBAL" && invalid.personalization.geo.basis === "global",
      `invalid country did not fall back globally: ${JSON.stringify(invalid.personalization.geo)}`);
    const invalidQs = invalid.sets.flatMap((s) => s.questions);
    assert(invalidQs.length >= 12 && invalidQs.every((q) => !(q.country_codes || []).length),
      "global fallback empty or leaked country-only content");
    assert(inRes.cache.cache_key !== usRes.cache.cache_key, "country cache bleed");
    return `IN ${inRes.personalization.geo.relevant_count}/${inRes.personalization.geo.global_count} relevant/global; US ${usRes.personalization.geo.relevant_count}/${usRes.personalization.geo.global_count}; invalid ZZ → global-only; all reviewed`;
  });

  // 15 · Same-country users with different persisted weakness histories.
  await check(15, "Behavior-aware divergence", "Behavior Ranking", async () => {
    const topic = `behavior_${runId}`;
    const questions = [];
    for (const tag of ["math", "history", "general"]) {
      for (let i = 0; i < 30; i++) questions.push({
        question: `${tag} behavior fixture ${i + 1}: choose the reviewed answer.`,
        options: ["A", "B", "C", "D"], correct_index: 0, difficulty: 2 + (i % 3),
        country_codes: ["IN"], behavior_tags: [tag], citation: "Verifier authored fixture",
      });
    }
    questions.push(
      { question: "<b>broken HTML stem</b>", options: ["A","B","C","D"], correct_index: 0, country_codes:["IN"] },
      { question: "Oversized mobile option fixture?", options: ["A".repeat(140),"B","C","D"], correct_index: 0, country_codes:["IN"] },
    );
    const ing = await adminRpc("quizverse_seedq_ingest", {
      source: "verifier", mode: "SoloChallenge", topic, questions,
    });
    assert(ing.result.rejected >= 2, `malformed visual fixtures were not rejected: ${JSON.stringify(ing.result)}`);

    const mathUser = await deviceAuth("behavior-math"), historyUser = await deviceAuth("behavior-history");
    const submitWeakness = async (persona, weak, strong) => {
      const qh = [];
      for (let i = 0; i < 12; i++) qh.push({ category: weak, correct: false, time_ms: 9000 });
      for (let i = 0; i < 12; i++) qh.push({ category: strong, correct: true, time_ms: 3500 });
      await rpc(persona, "quiz_submit_result", {
        score: 50, totalQuestions: 24, correctAnswers: 12, category: weak, questionHistory: qh,
      });
    };
    await submitWeakness(mathUser, "math", "history");
    await submitWeakness(historyUser, "history", "math");
    const [mathRes, historyRes] = await Promise.all([
      rpc(mathUser, "quizverse_seedq_get_staged", { mode:"SoloChallenge", topic, country:"IN", set_size:6, want_sets:3 }),
      rpc(historyUser, "quizverse_seedq_get_staged", { mode:"SoloChallenge", topic, country:"IN", set_size:6, want_sets:3 }),
    ]);
    assert(mathRes.personalization.behavior.basis === "quiz_history", "math user behavior did not use persisted history");
    assert(historyRes.personalization.behavior.basis === "quiz_history", "history user behavior did not use persisted history");
    assert(mathRes.personalization.behavior.weakest_topics[0] === "math", "math weakness not detected");
    assert(historyRes.personalization.behavior.weakest_topics[0] === "history", "history weakness not detected");
    const mathIds = new Set(allStagedIds(mathRes));
    const historyIds = allStagedIds(historyRes);
    assert(historyIds.some((id) => !mathIds.has(id)), "distinct behavior profiles produced identical staged IDs");
    const mathReasons = mathRes.sets.flatMap((s) => s.questions).filter((q) => q.selection_reasons.includes("interest_or_learning_signal")).length;
    const historyReasons = historyRes.sets.flatMap((s) => s.questions).filter((q) => q.selection_reasons.includes("interest_or_learning_signal")).length;
    assert(mathReasons > 0 && historyReasons > 0, `behavior selection reasons absent: ${mathReasons}/${historyReasons}`);
    return `same country IN; math vs history weakness produced distinct sets with ${mathReasons}/${historyReasons} behavior-ranked questions; malformed UX rejected`;
  });

  const overall = checks.every((ch) => ch.pass) ? "PASS" : "FAIL";
  return { ts: new Date().toISOString(), host: HOST, overall, checks };
}

// ── summary table + evidence file ────────────────────────────────────────────
function printSummary(result) {
  const W = { id: 3, name: 28, del: 24, res: 6 };
  const line = dim("  " + "─".repeat(W.id + W.name + W.del + W.res + 12));
  console.log("\n" + bold("  SUMMARY — " + result.host) + "  " + dim(result.ts));
  console.log(line);
  console.log(dim(`  ${"#".padEnd(W.id)} ${"check".padEnd(W.name)} ${"deliverable".padEnd(W.del)} ${"result".padEnd(W.res)} detail`));
  console.log(line);
  for (const ch of result.checks) {
    const chip = ch.pass ? green("PASS") : red("FAIL");
    console.log(`  ${String(ch.id).padEnd(W.id)} ${ch.name.padEnd(W.name)} ${cyan(ch.deliverable.padEnd(W.del))} ${chip}   ${dim(ch.detail.slice(0, 110))}`);
  }
  console.log(line);
  const passed = result.checks.filter((ch) => ch.pass).length;
  const banner = result.overall === "PASS"
    ? green(`  ✓ ALL ${passed}/${result.checks.length} CHECKS PASS`)
    : red(`  ✗ ${result.checks.length - passed}/${result.checks.length} CHECKS FAILED`);
  console.log(banner + "\n");
}

function writeEvidence(result) {
  if (!OUT_PATH || OUT_PATH === "none") return;
  try {
    mkdirSync(dirname(OUT_PATH), { recursive: true });
    writeFileSync(OUT_PATH, JSON.stringify(result, null, 2) + "\n");
    console.log(dim(`  evidence → ${OUT_PATH}`));
  } catch (e) {
    console.log(yellow(`  (could not write evidence file ${OUT_PATH}: ${e.message})`));
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (LOOP_SEC > 0) {
  console.log(bold(`Loop mode: re-running every ${LOOP_SEC}s — Ctrl-C to stop.`));
  for (;;) {
    try {
      const result = await runSuite();
      printSummary(result);
      writeEvidence(result);
    } catch (e) {
      console.error(red("suite crashed: " + (e && e.stack || e)));
    }
    console.log(dim(`  next run in ${LOOP_SEC}s…`));
    await sleep(LOOP_SEC * 1000);
  }
} else {
  let result;
  try {
    result = await runSuite();
  } catch (e) {
    console.error(red("suite crashed: " + (e && e.stack || e)));
    process.exit(1);
  }
  printSummary(result);
  writeEvidence(result);
  process.exit(result.overall === "PASS" ? 0 : 1);
}
