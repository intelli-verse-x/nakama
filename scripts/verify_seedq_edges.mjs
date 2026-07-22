#!/usr/bin/env node
// Machine-readable SeedQ edge-case release gate.
// Safe against production: creates fresh device personas and uniquely named
// fixture topics; never deletes pools, users, or shared storage.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
function flag(name, envName, fallback) {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1];
  return process.env[envName] || fallback;
}
const HOST = flag("--host", "NAKAMA_HOST", "http://localhost:7350").replace(/\/+$/, "");
const HTTP_KEY = flag("--http-key", "HTTP_KEY", "defaulthttpkey");
const CLIENT_KEY = flag("--client-key", "CLIENT_KEY", "defaultkey");
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = flag("--out", "SEEDQ_EDGE_OUT", resolve(ROOT, "web/seedquestions/edge-latest.json"));
const RUN = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
const results = [];

function assert(value, message) { if (!value) throw new Error(message); }
function uniq(values) { return new Set(values).size === values.length; }
function questionIds(response) {
  return (response.sets || []).flatMap((set) => set.question_ids || (set.questions || []).map((q) => q.id));
}
async function request(url, options = {}, allowHttpError = false) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);
  try {
    const response = await fetch(url, { ...options, signal: ac.signal });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!allowHttpError && !response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(data).slice(0, 220)}`);
    return { status: response.status, data, bytes: Buffer.byteLength(text) };
  } finally {
    clearTimeout(timer);
  }
}
async function adminRpc(id, body, raw) {
  return (await request(`${HOST}/v2/rpc/${id}?http_key=${encodeURIComponent(HTTP_KEY)}&unwrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw !== undefined ? raw : JSON.stringify(body || {}),
  }, true)).data;
}
async function deviceAuth(label) {
  const id = `edge-${label}-${RUN}-${Math.random().toString(36).slice(2)}`;
  const result = await request(`${HOST}/v2/account/authenticate/device?create=true&username=edge_${label}_${RUN}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Basic " + Buffer.from(`${CLIENT_KEY}:`).toString("base64"),
    },
    body: JSON.stringify({ id }),
  });
  const claims = JSON.parse(Buffer.from(result.data.token.split(".")[1], "base64").toString());
  return { token: result.data.token, userId: claims.uid };
}
async function rpc(user, id, body, raw) {
  return (await request(`${HOST}/v2/rpc/${id}?unwrap`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${user.token}` },
    body: raw !== undefined ? raw : JSON.stringify(body || {}),
  }, true)).data;
}
async function check(id, category, name, fn) {
  const started = Date.now();
  try {
    const evidence = await fn();
    results.push({ id, category, name, status: "PASS", duration_ms: Date.now() - started, evidence });
    console.log(`PASS ${id.padEnd(6)} ${name}`);
  } catch (error) {
    results.push({ id, category, name, status: "FAIL", duration_ms: Date.now() - started,
      error: String(error && error.message ? error.message : error).slice(0, 500) });
    console.log(`FAIL ${id.padEnd(6)} ${name}: ${results.at(-1).error}`);
  }
}

const sources = await adminRpc("quizverse_seedq_sources", {});
const coverage = await adminRpc("quizverse_seedq_pool_stats", {});
const modeByName = Object.fromEntries((sources.modes || []).map((m) => [m.mode, m]));
const questionRoutes = (sources.modes || []).filter((m) => m.seedq_required && m.kind !== "non_question");

await check("ID-01", "identity", "Country normalization and global fallback", async () => {
  const user = await deviceAuth("geo");
  const lower = await rpc(user, "quizverse_seedq_get_staged", { mode: "SoloChallenge", topic: "general", country: "in" });
  const locale = await rpc(user, "quizverse_seedq_get_staged", { mode: "SoloChallenge", topic: "general", locale: "en-US" });
  const invalid = await rpc(user, "quizverse_seedq_get_staged", { mode: "SoloChallenge", topic: "general", country: "ZZ" });
  assert(lower.personalization.geo.country === "IN", "lowercase country not normalized");
  assert(locale.personalization.geo.country === "US", "locale country not resolved");
  assert(invalid.personalization.geo.country === "GLOBAL", "unsupported country did not fail safely to global");
  return { lower: lower.personalization.geo, locale: locale.personalization.geo, invalid: invalid.personalization.geo };
});

await check("ID-02", "identity", "Fresh and sparse users are not profiled", async () => {
  const user = await deviceAuth("fresh");
  const res = await rpc(user, "quizverse_seedq_get_staged", { mode: "SoloChallenge", topic: "general" });
  const behavior = res.personalization.behavior;
  assert(behavior.basis === "sparse_history_fallback", "fresh user claimed behavioral profile");
  assert(behavior.samples < behavior.minimum_samples, "fresh user sample accounting invalid");
  assert(behavior.signals_used.length === 0 && behavior.weakest_topics.length === 0, "sparse signals were used");
  return behavior;
});

await check("ID-03", "identity", "User and country cache isolation", async () => {
  const a = await deviceAuth("cachea"), b = await deviceAuth("cacheb");
  const [ain, aus, bin] = await Promise.all([
    rpc(a, "quizverse_seedq_get_staged", { mode: "SoloChallenge", topic: "general", country: "IN" }),
    rpc(a, "quizverse_seedq_get_staged", { mode: "SoloChallenge", topic: "general", country: "US" }),
    rpc(b, "quizverse_seedq_get_staged", { mode: "SoloChallenge", topic: "general", country: "IN" }),
  ]);
  assert(ain.cache.cache_key !== aus.cache.cache_key, "country cache keys collided");
  assert(ain.cache.cache_key !== bin.cache.cache_key, "user cache keys collided");
  assert(ain.cache.cache_key.startsWith(a.userId) && bin.cache.cache_key.startsWith(b.userId), "cache is not user scoped");
  return { isolated_keys: 3 };
});

await check("API-01", "api_security", "Structured malformed JSON and validation errors", async () => {
  const user = await deviceAuth("invalid");
  const malformed = await rpc(user, "quizverse_seedq_get_staged", {}, "{bad");
  assert(malformed.ok === false && malformed.error_code === "MALFORMED_JSON" && malformed.retryable === false,
    "malformed JSON lacks structured envelope");
  const missing = await rpc(user, "quizverse_seedq_get_staged", {});
  const unknown = await rpc(user, "quizverse_seedq_get_staged", { mode: "not-a-mode" });
  assert(missing.ok === false && missing.retryable === false, "missing mode not rejected");
  assert(unknown.ok === false && unknown.retryable === false, "unknown mode not rejected");
  return { malformed: malformed.error_code, missing: missing.error_code, unknown: unknown.error_code };
});

await check("API-02", "api_security", "Numeric bounds reject coercion and extremes", async () => {
  const user = await deviceAuth("bounds");
  const bad = [
    { set_size: 0 }, { set_size: -1 }, { set_size: 999999 }, { set_size: 4.5 }, { set_size: "6" },
    { want_sets: 0 }, { want_sets: 99 }, { want_sets: 2.5 }, { want_sets: "3" },
  ];
  for (const input of bad) {
    const res = await rpc(user, "quizverse_seedq_get_staged", { mode: "SoloChallenge", topic: "general", ...input });
    assert(res.ok === false && /^INVALID_/.test(res.error_code), `unsafe numeric input accepted: ${JSON.stringify(input)}`);
  }
  return { rejected: bad.length };
});

await check("API-03", "api_security", "Aliases normalize; non-question routes fail explicitly", async () => {
  const user = await deviceAuth("alias");
  const alias = await rpc(user, "quizverse_seedq_get_staged", { mode: "  CLASSIC  ", topic: "general" });
  const nonQuestion = await rpc(user, "quizverse_seedq_get_staged", { mode: "SubjectiveQuiz", topic: "science" });
  assert(alias.ok && alias.canonical_mode === "SoloChallenge", "case/whitespace alias failed");
  assert(nonQuestion.ok === false && nonQuestion.delivery_contract, "non-question route was not explicit");
  return { alias: alias.canonical_mode, non_question: nonQuestion.kind };
});

await check("STG-01", "staging", "All denominator modes stage exact ready depth", async () => {
  const user = await deviceAuth("allmodes");
  const failures = [];
  for (const mode of questionRoutes) {
    const res = await rpc(user, "quizverse_seedq_get_staged", {
      mode: mode.mode, topic: mode.default_topic, set_size: 4, want_sets: 3,
    });
    if (!res.ok || res.ready_depth !== 3 || (res.sets || []).some((set) => set.questions.length < 4)) {
      failures.push(`${mode.mode}:${res.availability && res.availability.reason || res.error_code}`);
    }
  }
  assert(failures.length === 0, `availability failures: ${failures.join(", ")}`);
  return { routes: questionRoutes.length, ready_sets_each: 3 };
});

await check("STG-02", "staging", "Concurrent staging converges without duplicate IDs", async () => {
  const user = await deviceAuth("concurrentget");
  const calls = await Promise.all(Array.from({ length: 8 }, () =>
    rpc(user, "quizverse_seedq_get_staged", { mode: "SoloChallenge", topic: "general", set_size: 6, want_sets: 3 })));
  const final = await rpc(user, "quizverse_seedq_get_staged", { mode: "SoloChallenge", topic: "general", set_size: 6, want_sets: 3 });
  const finalIds = questionIds(final);
  assert(final.ready_depth === 3 && finalIds.length === 18 && uniq(finalIds), "concurrent staging left duplicate or partial ready sets");
  assert(calls.every((r) => r.ok && r.ready_depth >= 2), "concurrent staging returned an unexplained short response");
  return { simultaneous_calls: calls.length, final_unique_ids: finalIds.length };
});

await check("STG-03", "staging", "Consume replay is idempotent and unknown IDs fail", async () => {
  const user = await deviceAuth("consume");
  const staged = await rpc(user, "quizverse_seedq_get_staged", { mode: "SoloChallenge", topic: "general" });
  const setId = staged.sets[0].set_id;
  const first = await rpc(user, "quizverse_seedq_consume_set", { mode: "SoloChallenge", topic: "general", set_id: setId });
  const duplicate = await rpc(user, "quizverse_seedq_consume_set", { mode: "SoloChallenge", topic: "general", set_id: setId });
  const unknown = await rpc(user, "quizverse_seedq_consume_set", { mode: "SoloChallenge", topic: "general", set_id: "unknown" });
  assert(first.ok && first.merged_seen > 0 && first.ready_depth === 3, "first consume/refill failed");
  assert(duplicate.ok && duplicate.merged_seen === 0, "duplicate consume was not idempotent");
  assert(unknown.ok === false && unknown.error_code === "NOT_FOUND", "unknown set did not return NOT_FOUND");
  return { first_merged: first.merged_seen, duplicate_merged: duplicate.merged_seen };
});

await check("STG-04", "staging", "Concurrent duplicate consume has one effective merge", async () => {
  const user = await deviceAuth("concurrentconsume");
  const staged = await rpc(user, "quizverse_seedq_get_staged", { mode: "SoloChallenge", topic: "general" });
  const body = { mode: "SoloChallenge", topic: "general", set_id: staged.sets[0].set_id };
  const calls = await Promise.all(Array.from({ length: 6 }, () => rpc(user, "quizverse_seedq_consume_set", body)));
  assert(calls.every((r) => r.ok), "a duplicate consume returned a failure: " +
    JSON.stringify(calls.map((r) => ({ ok: r.ok, code: r.code, error_code: r.error_code, error: r.error }))));
  assert(calls.filter((r) => r.merged_seen > 0).length === 1, "more than one concurrent consume merged the same set");
  return { calls: calls.length, effective_merges: 1 };
});

await check("STG-05", "staging", "Cache contract is self-contained and time bounded", async () => {
  const user = await deviceAuth("offline");
  const res = await rpc(user, "quizverse_seedq_get_staged", { mode: "SoloChallenge", topic: "general" });
  const cache = res.cache;
  assert(cache.schema_version >= 2 && cache.self_contained && cache.contains_answer_keys, "offline cache contract incomplete");
  assert(cache.generated_ms <= Date.now() + 60000 && cache.expires_ms > cache.generated_ms, "cache TTL/clock boundary invalid");
  assert(res.availability && typeof res.availability.degraded === "boolean" && res.availability.reason, "availability reason missing");
  assert(Buffer.byteLength(JSON.stringify(res)) < 1_000_000, "staged response exceeds 1MB");
  return { schema: cache.schema_version, ttl_ms: cache.expires_ms - cache.generated_ms };
});

await check("QLT-01", "quality", "Malformed authored questions fail closed", async () => {
  const topic = `edge_quality_${RUN}`;
  const invalid = [
    { question: "No options are present here", options: [], correct_index: 0 },
    { question: "Duplicate options must be rejected", options: ["A", "A", "B", "C"], correct_index: 0 },
    { question: "Invalid negative answer index", options: ["A", "B", "C", "D"], correct_index: -1 },
    { question: "Invalid huge answer index", options: ["A", "B", "C", "D"], correct_index: 99 },
    { question: "<script>alert(1)</script> unsafe HTML", options: ["A", "B", "C", "D"], correct_index: 0 },
    { question: "Control\u0001 character is unsafe", options: ["A", "B", "C", "D"], correct_index: 0 },
    { question: "The answer Alpha is leaked as Alpha", options: ["Alpha", "Beta", "Gamma", "Delta"], correct_index: 0 },
    { question: "x".repeat(400), options: ["A", "B", "C", "D"], correct_index: 0 },
  ];
  const ingested = await adminRpc("quizverse_seedq_ingest", {
    source: "edge_fixture", mode: "SoloChallenge", topic, questions: invalid,
  });
  assert(ingested.ok && ingested.result.accepted === 0 && ingested.result.rejected === invalid.length,
    `unsafe authored rows passed: ${JSON.stringify(ingested).slice(0, 300)}`);
  return { rejected: ingested.result.rejected };
});

await check("QLT-02", "quality", "Every served item has review and valid answer shape", async () => {
  const user = await deviceAuth("shape");
  for (const modeName of ["SoloChallenge", "ImageQuiz", "AudioQuiz", "VideoQuiz", "NewsQuiz", "HealthQuiz"]) {
    const mode = modeByName[modeName];
    const res = await rpc(user, "quizverse_seedq_get_staged", { mode: modeName, topic: mode.default_topic, set_size: 4 });
    for (const q of (res.sets || []).flatMap((s) => s.questions)) {
      assert(q.quality?.status === "approved" && q.review?.reviewed === true, `${modeName} served unreviewed item`);
      assert([2, 4].includes(q.options?.length) && Number.isInteger(q.correct_index) &&
        q.correct_index >= 0 && q.correct_index < q.options.length && uniq(q.options.map((o) => o.toLowerCase())),
      `${modeName} served malformed answer shape`);
    }
  }
  return { representative_modes: 6 };
});

await check("QLT-03", "quality", "Visual/audio/video mode-specific media gates", async () => {
  const user = await deviceAuth("media");
  const expected = { ImageQuiz: "image", AudioQuiz: "audio", VideoQuiz: "video", NewsQuiz: "image" };
  for (const [modeName, mediaType] of Object.entries(expected)) {
    const mode = modeByName[modeName];
    const res = await rpc(user, "quizverse_seedq_get_staged", { mode: modeName, topic: mode.default_topic, set_size: 4 });
    for (const q of (res.sets || []).flatMap((s) => s.questions)) {
      assert(q.media_url?.startsWith("https://") && q.media_mime?.startsWith(`${mediaType}/`), `${modeName} media type mismatch`);
      assert(q.media_alt && q.media_provenance?.checked && q.citation, `${modeName} media provenance incomplete`);
    }
  }
  return expected;
});

await check("SRC-01", "sources", "Duplicate static ingest is bounded and idempotent", async () => {
  const body = { source: "health_catalog", mode: "HealthQuiz", topic: "health", count: 1000000 };
  const first = await adminRpc("quizverse_seedq_ingest", body);
  const second = await adminRpc("quizverse_seedq_ingest", body);
  assert(first.ok && second.ok && first.fetched <= 100 && second.fetched <= 100, "ingest count was not bounded");
  assert(second.result.accepted === 0 && second.result.duplicates >= 50, "duplicate replay changed the pool");
  return { fetched_cap: second.fetched, duplicates: second.result.duplicates };
});

await check("SRC-02", "sources", "Coverage exposes deficits, errors, and semantic lineage", async () => {
  const latest = await adminRpc("quizverse_seedq_pool_stats", {});
  const rows = latest.mode_coverage || [];
  assert(rows.length === 36, "coverage row count mismatch");
  assert(rows.every((r) => typeof r.deficit === "number" && typeof r.status === "string" &&
    typeof r.last_error === "string" && typeof r.reason === "string"), "coverage observability fields missing");
  const gaps = rows.filter((r) => r.denominator && r.status !== "PASS");
  assert(gaps.length === 0, `WARN/BLOCKED release gates: ${gaps.map((r) => `${r.mode}:${r.status}`).join(", ")}`);
  assert(rows.filter((r) => r.kind === "experience").every((r) => r.inventory_mode), "experience lineage missing");
  return { pass: rows.filter((r) => r.denominator && r.status === "PASS").length, warn: 0, blocked: 0 };
});

await check("SRC-03", "sources", "Cron batch and source registry are bounded", async () => {
  assert((sources.sources || []).length === 16, "source registry count mismatch");
  assert((sources.sources || []).every((s) => s.id && Array.isArray(s.env_keys) && s.implemented), "source status metadata missing");
  const tick = await adminRpc("quizverse_seedq_ingest_tick", { batch: 1, count: 5 });
  assert(tick.ok && (tick.tick.results || []).length <= 1, "bounded cron tick exceeded requested batch");
  return { connectors: sources.sources.length, tick_results: (tick.tick.results || []).length };
});

await check("SRC-04", "sources", "Reviewed Gutenberg outage fallback is mode-correct", async () => {
  const topic = `no_upstream_results_${RUN}`;
  const modes = ["DailyQuiz", "TrueFalseQuiz", "EmojiQuiz"];
  for (const mode of modes) {
    const ingested = await adminRpc("quizverse_seedq_ingest", {
      source: "gutenberg", mode, topic, count: 60,
    });
    assert(ingested.ok && ingested.result.accepted >= 50, `${mode} reviewed fallback did not reach threshold`);
  }
  const user = await deviceAuth("fallback");
  const tf = await rpc(user, "quizverse_seedq_get_staged", { mode: "TrueFalseQuiz", topic, set_size: 4 });
  const emoji = await rpc(user, "quizverse_seedq_get_staged", { mode: "EmojiQuiz", topic, set_size: 4 });
  assert((tf.sets || []).flatMap((s) => s.questions).every((q) => q.options.length === 2 &&
    q.options.includes("True") && q.options.includes("False")), "TrueFalse fallback schema mismatch");
  assert((emoji.sets || []).flatMap((s) => s.questions).every((q) => /emoji clue|emoji/i.test(q.question)),
    "Emoji fallback is not mode-specific");
  return { modes, accepted_minimum: 50 };
});

await check("SEC-01", "api_security", "Admin RPC rejects user session without service token", async () => {
  const user = await deviceAuth("forbidden");
  const res = await rpc(user, "quizverse_seedq_pool_stats", {});
  assert(res.ok === false && res.error_code === "FORBIDDEN" && res.retryable === false, "admin RPC access was not rejected");
  return { error_code: res.error_code };
});

await check("SEC-02", "api_security", "Responses contain no secret-shaped fields", async () => {
  const payloads = [sources, coverage, await adminRpc("quizverse_seedq_pool_stats", {})];
  const serialized = JSON.stringify(payloads);
  assert(!/api[_-]?key["']?\s*:|secret["']?\s*:|authorization["']?\s*:/i.test(serialized), "secret-shaped response field detected");
  return { inspected_bytes: Buffer.byteLength(serialized) };
});

await check("RUN-01", "runtime", "Generated bundle is ES5-compatible and RPCs are direct", async () => {
  const bundle = readFileSync(resolve(ROOT, "data/modules/index.js"), "utf8");
  for (const id of ["get_staged", "consume_set", "pool_stats", "ingest"]) {
    assert(bundle.includes(`registerRpc("quizverse_seedq_${id}"`), `generated RPC missing: ${id}`);
  }
  assert(!bundle.includes("register(null)"), "unsafe module-evaluation registration remains");
  const engine = readFileSync(resolve(ROOT, "data/modules/src/seed-questions/sq_engine.ts"), "utf8");
  const servePath = engine.slice(engine.indexOf("export function ensureStaged"), engine.indexOf("export function consumeSet"));
  assert(!servePath.includes("httpRequest("), "serve-time path performs network I/O");
  return { direct_rpc_registration: true, serve_time_network: false };
});

await check("CLI-01", "client_contract", "Offline/account-switch metadata and honest repeats", async () => {
  const user = await deviceAuth("client");
  const res = await rpc(user, "quizverse_seedq_get_staged", { mode: "SoloChallenge", topic: "general" });
  assert(res.cache?.cache_key.startsWith(`${user.userId}/`) && res.cache?.expires_ms, "account-scoped offline metadata missing");
  assert(res.repeat_policy && Number.isInteger(res.repeat_policy.fresh_count) &&
    Number.isInteger(res.repeat_policy.review_count) && typeof res.suppress_rating_prompt === "boolean",
  "Smart Review/rating suppression contract missing");
  assert(res.availability?.reason && res.source_route?.route, "truthful availability/source route missing");
  return { cache_schema: res.cache.schema_version, availability: res.availability.reason };
});

await check("CLI-02", "client_contract", "Aahaa fresh-user and unknown-action handling", async () => {
  const user = await deviceAuth("aahaa");
  const feed = await rpc(user, "quizverse_aahaa_get", {});
  assert(feed.ok === true && Array.isArray(feed.feed), "Aahaa absent/empty feed was not handled");
  const unknown = await rpc(user, "quizverse_aahaa_react", { wow_id: "missing", action: "unknown_surface_action" });
  assert(unknown.ok === false || unknown.error || unknown.code, "unknown Aahaa action was silently accepted");
  return { fresh_feed_items: feed.feed.length, unknown_action_rejected: true };
});

const summary = {
  schema_version: 1,
  suite: "seedq-edge-matrix",
  run_id: RUN,
  host: HOST,
  generated_at: new Date().toISOString(),
  taxonomy: coverage.taxonomy,
  total: results.length,
  pass: results.filter((r) => r.status === "PASS").length,
  fail: results.filter((r) => r.status === "FAIL").length,
  release_gate: results.every((r) => r.status === "PASS") ? "PASS" : "BLOCKED",
  cases: results,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify({ total: summary.total, pass: summary.pass, fail: summary.fail, release_gate: summary.release_gate, evidence: OUT }));
process.exit(summary.fail === 0 ? 0 : 1);
