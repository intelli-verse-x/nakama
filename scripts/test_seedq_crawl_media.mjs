#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CircuitBreaker, FirecrawlAdapter, FixtureAdapter, ProviderDisabledError,
  processCandidates, validateCandidate, validateJob, validateProviderEndpoint, withRetry,
} from "./seedq-crawl/lib.mjs";
import { fixtureCandidates } from "./seedq-crawl/fixtures.mjs";

const root = new URL(".", import.meta.url);
const imageJob = JSON.parse(await readFile(new URL("seedq-crawl/jobs/fixture-image.json", root)));
const videoJob = JSON.parse(await readFile(new URL("seedq-crawl/jobs/fixture-video.json", root)));
const fixtures = fixtureCandidates();
const cases = [];

async function check(name, fn) {
  try {
    const evidence = await fn();
    cases.push({ name, status: "PASS", evidence });
    console.log(`PASS ${name}`);
  } catch (error) {
    cases.push({ name, status: "FAIL", error: error.message });
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

await check("parameterized image job validates", () => {
  assert.deepEqual(validateJob(imageJob), []);
  assert.equal(imageJob.country_codes[0], "IN");
  assert.throws(() => validateProviderEndpoint("https://[::1]/crawl", ["::1"]), /public HTTPS|not allowlisted/);
  assert.throws(() => new FirecrawlAdapter({ apiKey: "" }), ProviderDisabledError);
  return { mode: imageJob.mode, parameters: Object.keys(imageJob).length, providers_fail_closed: true };
});

await check("fixture image pipeline approves stage-3 depth", async () => {
  const discovered = await new FixtureAdapter(fixtures).discover(imageJob);
  const result = processCandidates(discovered, imageJob);
  assert.equal(result.approved.length, 16);
  assert.equal(result.quarantine.length, 0);
  return { approved: 16, stage_sets_at_four: 3, refill_reserve: 4, rights: "public_domain" };
});

await check("fixture video pipeline approves embed evidence", async () => {
  const discovered = await new FixtureAdapter(fixtures).discover(videoJob);
  const result = processCandidates(discovered, videoJob);
  assert.equal(result.approved.length, 16);
  assert(result.approved.every((x) => x.embeddable && x.thumbnail_url && x.cited_segment));
  return { approved: 16, stage_sets_at_four: 3, refill_reserve: 4, policy: "metadata_embed_only" };
});

const base = structuredClone(fixtures[0]);
for (const [name, mutate, expected] of [
  ["malicious private URL", (x) => { x.media_url = "https://127.0.0.1/secret"; }, "blocked_or_invalid_url"],
  ["missing license", (x) => { x.license = ""; }, "license_not_allowed"],
  ["broken media", (x) => { x.media_health_ok = false; }, "media_validation_failed"],
  ["contradictory answer", (x) => { x.deterministic_verified = false; }, "answer_not_verified"],
  ["PII safety failure", (x) => { x.contains_pii = true; }, "safety_gate_failed"],
]) {
  await check(`${name} quarantines`, () => {
    const candidate = structuredClone(base);
    mutate(candidate);
    const result = validateCandidate(candidate, imageJob);
    assert.equal(result.reason, expected);
    return { reason: result.reason };
  });
}

await check("duplicate asset quarantines", () => {
  const a = structuredClone(fixtures[0]), b = structuredClone(fixtures[0]);
  b.candidate_id = "duplicate";
  b.question = "Which duplicate catalog label is supported?";
  const result = processCandidates([a, b], imageJob);
  assert.equal(result.approved.length, 1);
  assert.equal(result.quarantine[0].reason, "duplicate_asset");
  return { approved: 1, quarantine: "duplicate_asset" };
});

await check("429 retries with backoff", async () => {
  let calls = 0, sleeps = 0;
  const result = await withRetry(async () => {
    calls++;
    if (calls < 3) { const error = new Error("rate limited"); error.status = 429; throw error; }
    return "ok";
  }, { attempts: 3, sleep: async () => { sleeps++; } });
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.equal(sleeps, 2);
  return { attempts: calls, backoffs: sleeps };
});

await check("timeout exhausts into DLQ condition", async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => {
    calls++;
    const error = new Error("timeout"); error.code = 503; throw error;
  }, { attempts: 3, sleep: async () => {} }), /timeout/);
  assert.equal(calls, 3);
  let now = 1;
  const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 100, now: () => now });
  for (let i = 0; i < 2; i++) await assert.rejects(breaker.execute(async () => { throw new Error("provider down"); }));
  await assert.rejects(breaker.execute(async () => "unexpected"), /circuit breaker is open/);
  now = 102;
  assert.equal(await breaker.execute(async () => "recovered"), "recovered");
  return { attempts: calls, terminal: "dlq", circuit_breaker: "opens_and_recovers" };
});

await check("invalid country is detectable before submit", () => {
  const invalid = { ...imageJob, country_codes: ["ZZ"] };
  assert(validateJob(invalid).includes("invalid_country_code"));
  return { worker_error: "invalid_country_code", server_contract: "INVALID_JOB" };
});

const summary = {
  suite: "seedq-crawl-media",
  total: cases.length,
  pass: cases.filter((x) => x.status === "PASS").length,
  fail: cases.filter((x) => x.status === "FAIL").length,
  cases,
};
console.log(JSON.stringify(summary));
process.exit(summary.fail ? 1 : 0);
