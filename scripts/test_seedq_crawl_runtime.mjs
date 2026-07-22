#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fixtureCandidates } from "./seedq-crawl/fixtures.mjs";

const argv = process.argv.slice(2);
function flag(name, envName, fallback = "") {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : (process.env[envName] || fallback);
}
const HOST = flag("--host", "NAKAMA_HOST", "http://localhost:7350").replace(/\/+$/, "");
const HTTP_KEY = flag("--http-key", "HTTP_KEY", "defaulthttpkey");
const CLIENT_KEY = flag("--client-key", "CLIENT_KEY", "defaultkey");
const SECRET = flag("--service-token", "SEEDQ_SERVICE_TOKEN");
assert(SECRET.length >= 32, "SEEDQ_SERVICE_TOKEN must be at least 32 characters");

async function request(path, options) {
  const response = await fetch(`${HOST}${path}`, {
    ...options,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { response, data };
}

function signedPayload(id, body) {
  const timestamp = Date.now();
  const nonce = randomBytes(18).toString("base64url");
  const unsigned = JSON.stringify(body);
  const signature = createHmac("sha256", SECRET)
    .update(`${id}.${timestamp}.${nonce}.${unsigned}`)
    .digest("hex");
  return { ...body, auth: { timestamp_ms: timestamp, nonce, signature } };
}

async function serviceRpc(id, body, exactPayload) {
  const payload = exactPayload || signedPayload(id, body);
  const { response, data } = await request(`/v2/rpc/${id}?http_key=${encodeURIComponent(HTTP_KEY)}&unwrap`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  assert(response.ok, `${id} HTTP ${response.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return { data, payload };
}

async function deviceAuth(label) {
  const suffix = `${Date.now().toString(36)}${randomBytes(5).toString("hex")}`;
  const { response, data } = await request(
    `/v2/account/authenticate/device?create=true&username=crawl_${label}_${suffix}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${Buffer.from(`${CLIENT_KEY}:`).toString("base64")}`,
      },
      body: JSON.stringify({ id: `crawl-${label}-${suffix}` }),
    },
  );
  assert(response.ok && data.token, `device auth failed: ${JSON.stringify(data).slice(0, 300)}`);
  return data.token;
}

async function userRpc(token, id, body) {
  const { response, data } = await request(`/v2/rpc/${id}?unwrap`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  assert(response.ok, `${id} HTTP ${response.status}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

const run = `${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
const baseJobs = {
  image: JSON.parse(await readFile(new URL("./seedq-crawl/jobs/fixture-image.json", import.meta.url))),
  video: JSON.parse(await readFile(new URL("./seedq-crawl/jobs/fixture-video.json", import.meta.url))),
};
const evidence = [];

for (const mediaType of ["image", "video"]) {
  const job = {
    ...baseJobs[mediaType],
    topic: `crawl_runtime_${mediaType}_${run}`,
    idempotency_key: `crawl-runtime-${mediaType}-${run}`,
  };
  const candidates = fixtureCandidates().filter((candidate) => candidate.media_type === mediaType);
  const submitted = await serviceRpc("quizverse_seedq_crawl_job_submit", job);
  assert.equal(submitted.data.ok, true);
  assert.equal(submitted.data.job.status, "queued");

  const replay = await serviceRpc("quizverse_seedq_crawl_job_submit", {}, submitted.payload);
  assert.equal(replay.data.ok, false);
  assert.equal(replay.data.error_code, "FORBIDDEN");

  const queued = await serviceRpc("quizverse_seedq_crawl_job_status", { job_id: submitted.data.job.job_id });
  assert.equal(queued.data.job.status, "queued");
  const ingested = await serviceRpc("quizverse_seedq_crawl_candidate_ingest", {
    job_id: submitted.data.job.job_id, candidates, final: true,
  });
  assert.equal(ingested.data.validated, 16);
  assert.equal(ingested.data.ingest.accepted, 16);
  assert.equal(ingested.data.quarantine.length, 0);
  const completed = await serviceRpc("quizverse_seedq_crawl_job_status", { job_id: submitted.data.job.job_id });
  assert.equal(completed.data.job.status, "completed");

  const token = await deviceAuth(mediaType);
  const staged = await userRpc(token, "quizverse_seedq_get_staged", {
    mode: job.mode, topic: job.topic, country: job.country_codes[0],
    locale: job.locales[0], set_size: 4, want_sets: 3,
  });
  assert.equal(staged.ready_depth, 3);
  const questions = staged.sets.flatMap((set) => set.questions);
  assert.equal(questions.length, 12);
  assert.equal(new Set(questions.map((question) => question.id)).size, 12);
  for (const question of questions) {
    assert.equal(question.crawl_provenance.job_id, submitted.data.job.job_id);
    assert.equal(question.quality.status, "approved");
    assert.equal(question.review.reviewed, true);
    assert.equal(question.media_provenance.checked, true);
    assert.notEqual(question.media_provenance.license, "unknown");
    assert(question.country_codes.includes(job.country_codes[0]));
    assert(job.interest_tags.some((tag) => question.behavior_tags.includes(tag)));
    assert.equal(question.question_type.toLowerCase(), mediaType);
  }

  const consumed = new Set(staged.sets[0].question_ids);
  const consume = await userRpc(token, "quizverse_seedq_consume_set", {
    mode: job.mode, topic: job.topic, country: job.country_codes[0], set_id: staged.sets[0].set_id,
  });
  assert.equal(consume.ready_depth, 3);
  const refilled = await userRpc(token, "quizverse_seedq_get_staged", {
    mode: job.mode, topic: job.topic, country: job.country_codes[0],
    locale: job.locales[0], set_size: 4, want_sets: 3,
  });
  assert(refilled.sets.flatMap((set) => set.question_ids).every((id) => !consumed.has(id)));

  const stats = await serviceRpc("quizverse_seedq_pool_stats", {});
  const pool = stats.data.pools.find((item) => item.mode === job.mode && item.topic === job.topic);
  assert(pool, `crawl pool missing for ${mediaType}`);
  assert.equal(pool.crawl_sourced, 16);
  assert.equal(pool.rights_approved, 16);
  assert.equal(pool.media_healthy, 16);
  assert.equal(mediaType === "image" ? pool.crawl_images : pool.crawl_videos, 16);
  evidence.push({
    media_type: mediaType, submitted: true, accepted: 16, staged: 12,
    refilled_without_repeat: true, rights_review_media_geo_interest: true,
  });
}

console.log(JSON.stringify({ suite: "seedq-crawl-runtime", pass: 2, total: 2, evidence }, null, 2));
