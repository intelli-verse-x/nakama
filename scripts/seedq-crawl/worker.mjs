#!/usr/bin/env node
import { createHmac, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  FixtureAdapter, FirecrawlAdapter, HermesAdapter, ProviderDisabledError,
  processCandidates, validateJob, withRetry,
} from "./lib.mjs";
import { fixtureCandidates } from "./fixtures.mjs";

const argv = process.argv.slice(2);
function flag(name, envName, fallback = "") {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : (process.env[envName] || fallback);
}

const host = flag("--host", "NAKAMA_HOST", "http://localhost:7350").replace(/\/+$/, "");
const httpKey = flag("--http-key", "HTTP_KEY", "defaulthttpkey");
const serviceToken = flag("--service-token", "SEEDQ_SERVICE_TOKEN");
const jobFile = flag("--job", "SEEDQ_CRAWL_JOB");
const dryRun = argv.includes("--dry-run");
if (!jobFile) throw new Error("--job is required");
const jobInput = JSON.parse(await readFile(jobFile, "utf8"));
const errors = validateJob(jobInput);
if (errors.length) throw new Error(`invalid job: ${errors.join(",")}`);

async function rpc(id, body) {
  if (serviceToken.length < 32) throw new Error("SEEDQ_SERVICE_TOKEN must be at least 32 characters");
  const timestamp = Date.now();
  const nonce = randomBytes(18).toString("base64url");
  const unsigned = JSON.stringify(body);
  const signature = createHmac("sha256", serviceToken)
    .update(`${id}.${timestamp}.${nonce}.${unsigned}`)
    .digest("hex");
  const response = await fetch(`${host}/v2/rpc/${id}?http_key=${encodeURIComponent(httpKey)}&unwrap`, {
    method: "POST",
    headers: { "content-type": "application/json", connection: "close" },
    body: JSON.stringify({ ...body, auth: { timestamp_ms: timestamp, nonce, signature } }),
    signal: AbortSignal.timeout(jobInput.timeout_ms || 30_000),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { ok: false, error: "invalid server response" }; }
  if (!response.ok || data.ok === false) {
    const error = new Error(`${id} failed: ${data.error || response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function adapterFor(strategy) {
  if (strategy === "fixture") return new FixtureAdapter(fixtureCandidates());
  if (strategy === "firecrawl") return new FirecrawlAdapter({
    apiKey: process.env.FIRECRAWL_API_KEY,
    baseUrl: process.env.FIRECRAWL_BASE_URL,
    endpointAllowlist: (process.env.FIRECRAWL_ALLOWED_DOMAINS || "firecrawl.dev").split(","),
  });
  if (strategy === "hermes") return new HermesAdapter({
    endpoint: process.env.HERMES_ENDPOINT,
    token: process.env.HERMES_TOKEN,
    providerMode: process.env.HERMES_PROVIDER_MODE,
    endpointAllowlist: (process.env.HERMES_ALLOWED_DOMAINS || "").split(",").filter(Boolean),
  });
  throw new Error("hybrid strategy requires an explicitly configured orchestrator");
}

let serverJob = jobInput;
let adapter;
try {
  adapter = adapterFor(jobInput.source_strategy);
} catch (error) {
  if (error instanceof ProviderDisabledError) {
    console.error(JSON.stringify({
      ok: false, status: "provider_disabled", error_code: error.code,
      provider: error.provider, missing_config: error.missing,
    }));
    process.exit(3);
  }
  throw error;
}
if (!dryRun) {
  if (!serviceToken) throw new Error("SEEDQ_SERVICE_TOKEN is required");
  const submitted = await rpc("quizverse_seedq_crawl_job_submit", jobInput);
  serverJob = submitted.job;
}

let discovered;
try {
  discovered = await withRetry(() => adapter.discover(serverJob), { attempts: serverJob.max_attempts || 3 });
} catch (error) {
  // Do not print request bodies, headers, or credentials.
  console.error(JSON.stringify({ ok: false, job_id: serverJob.job_id, status: "dlq", error: String(error.message).slice(0, 200) }));
  process.exit(2);
}

const pipeline = processCandidates(discovered, serverJob);
if (serverJob.source_strategy !== "fixture" && discovered.length > 0 && pipeline.approved.length === 0) {
  console.error(JSON.stringify({
    ok: false, job_id: serverJob.job_id, status: "transform_required",
    error_code: "PROVIDER_TRANSFORM_REQUIRED",
    error: "provider discovery records require the approved candidate transformer before ingest",
    discovered: discovered.length, quarantined: pipeline.quarantine.length,
  }));
  process.exit(3);
}
const summary = {
  ok: true,
  provider: serverJob.source_strategy,
  job_id: serverJob.job_id || null,
  discovered: discovered.length,
  approved: pipeline.approved.length,
  quarantined: pipeline.quarantine.length,
  quarantine_reasons: Object.fromEntries(
    [...new Set(pipeline.quarantine.map((x) => x.reason))].map((reason) =>
      [reason, pipeline.quarantine.filter((x) => x.reason === reason).length])),
};

if (dryRun) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  const ingested = await rpc("quizverse_seedq_crawl_candidate_ingest", {
    job_id: serverJob.job_id, candidates: pipeline.approved, final: true,
  });
  console.log(JSON.stringify({ ...summary, ingest: ingested.ingest, server_quarantine: ingested.quarantine }, null, 2));
}
