import { createHash } from "node:crypto";

export const ALLOWED_MEDIA = new Set(["image", "video", "audio"]);
export const ALLOWED_LICENSES = new Set([
  "public_domain", "cc0", "cc_by", "cc_by_sa", "explicit_permission", "api_tos_embed",
]);

export function hash(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

export function hostOf(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return "";
    const host = url.hostname.toLowerCase();
    if (host === "localhost" || host === "::1" || /^127\.|^10\.|^192\.168\.|^169\.254\./.test(host) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return "";
    return host;
  } catch {
    return "";
  }
}

export function domainMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

export function validateProviderEndpoint(value, allowedDomains) {
  const host = hostOf(value);
  if (!host) throw new Error("provider endpoint must be a public HTTPS URL");
  const allowed = (allowedDomains || []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  if (!allowed.length || !allowed.some((domain) => domainMatches(host, domain))) {
    throw new Error(`provider endpoint host is not allowlisted: ${host}`);
  }
  return String(value).replace(/\/+$/, "");
}

export function validateJob(job) {
  const errors = [];
  if (!job.mode) errors.push("mode_required");
  if (!job.topic) errors.push("topic_required");
  if (!ALLOWED_MEDIA.has(job.media_type)) errors.push("invalid_media_type");
  if (!job.idempotency_key) errors.push("idempotency_key_required");
  if ((job.country_codes || []).some((x) => !/^[A-Z]{2}$/.test(x) || x === "XX" || x === "ZZ")) {
    errors.push("invalid_country_code");
  }
  if (!Array.isArray(job.allowed_domains) || !job.allowed_domains.length) errors.push("allowed_domains_required");
  if ((job.max_pages || 0) < 1 || (job.max_pages || 0) > 100) errors.push("invalid_max_pages");
  if ((job.max_assets || 0) < 1 || (job.max_assets || 0) > 200) errors.push("invalid_max_assets");
  return errors;
}

export function validateCandidate(candidate, job, seenAssets = new Set(), seenStems = new Set()) {
  const fail = (reason) => ({ ok: false, reason, candidate_id: candidate?.candidate_id || "" });
  if (!candidate || typeof candidate !== "object") return fail("invalid_candidate");
  const sourceHost = hostOf(candidate.canonical_url || candidate.source_url);
  const mediaHost = hostOf(candidate.media_url || candidate.embed_url);
  if (!sourceHost || !mediaHost) return fail("blocked_or_invalid_url");
  const allowed = job.allowed_domains || [];
  const denied = job.denied_domains || [];
  if (denied.some((d) => domainMatches(sourceHost, d) || domainMatches(mediaHost, d))) return fail("denied_domain");
  if (!allowed.some((d) => domainMatches(sourceHost, d)) ||
      !allowed.some((d) => domainMatches(mediaHost, d))) return fail("domain_not_allowed");
  if (!ALLOWED_LICENSES.has(candidate.license) || !(job.allowed_licenses || []).includes(candidate.license)) {
    return fail("license_not_allowed");
  }
  if (!candidate.robots_allowed || candidate.auth_gated || candidate.paywalled || candidate.private_content) {
    return fail("crawl_policy_failed");
  }
  if (!candidate.rights_ok || !candidate.mime_valid || !candidate.size_valid ||
      !candidate.redirect_valid || !candidate.media_health_ok) return fail("media_validation_failed");
  if (!candidate.content_safety_ok || !candidate.age_gate_ok || candidate.contains_pii) return fail("safety_gate_failed");
  if (!candidate.deterministic_verified || !candidate.answer_supported_by_citation) return fail("answer_not_verified");
  if (!candidate.experience_approved) return fail("experience_qa_failed");
  if (!Array.isArray(candidate.options) || candidate.options.length !== 4 ||
      new Set(candidate.options.map((x) => String(x).trim().toLowerCase())).size !== 4) return fail("question_shape_invalid");
  const correct = String(candidate.options[candidate.correct_index] || "").toLowerCase();
  if (correct.length >= 4 && String(candidate.question || "").toLowerCase().includes(correct)) return fail("answer_leak");
  if (job.media_type === "image" && (!candidate.alt_text || !candidate.creator || !candidate.license_url)) {
    return fail("image_attribution_incomplete");
  }
  if (job.media_type === "video" &&
      (!candidate.embeddable || !candidate.thumbnail_url || !(candidate.cited_segment || candidate.transcript_url))) {
    return fail("video_evidence_incomplete");
  }
  candidate.asset_hash ||= hash(candidate.media_url || candidate.embed_url);
  const stemHash = hash(String(candidate.question || "").trim().toLowerCase());
  if (seenAssets.has(candidate.asset_hash)) return fail("duplicate_asset");
  if (seenStems.has(stemHash)) return fail("duplicate_stem");
  seenAssets.add(candidate.asset_hash);
  seenStems.add(stemHash);
  candidate.stem_hash = stemHash;
  return { ok: true, candidate };
}

export function processCandidates(candidates, job) {
  const approved = [], quarantine = [];
  const seenAssets = new Set(), seenStems = new Set();
  for (const candidate of candidates.slice(0, job.max_assets)) {
    const result = validateCandidate(candidate, job, seenAssets, seenStems);
    if (result.ok) approved.push(result.candidate);
    else quarantine.push({ candidate_id: result.candidate_id, reason: result.reason });
  }
  return { approved, quarantine };
}

export async function withRetry(fn, { attempts = 3, baseMs = 25, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      last = error;
      const code = error?.status || error?.code;
      if (attempt === attempts || (code && code !== 429 && code < 500)) break;
      await sleep(baseMs * 2 ** (attempt - 1));
    }
  }
  throw last;
}

export class ProviderDisabledError extends Error {
  constructor(provider, missing) {
    super(`${provider} provider is disabled; configure ${missing.join(", ")}`);
    this.name = "ProviderDisabledError";
    this.code = "PROVIDER_DISABLED";
    this.provider = provider;
    this.missing = missing;
  }
}

export class CircuitBreaker {
  constructor({ failureThreshold = 3, cooldownMs = 60_000, now = () => Date.now() } = {}) {
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.failures = 0;
    this.openedAt = 0;
  }
  async execute(fn) {
    if (this.openedAt && this.now() - this.openedAt < this.cooldownMs) {
      const error = new Error("provider circuit breaker is open");
      error.code = "CIRCUIT_OPEN";
      throw error;
    }
    if (this.openedAt) {
      this.openedAt = 0;
      this.failures = 0;
    }
    try {
      const result = await fn();
      this.failures = 0;
      return result;
    } catch (error) {
      this.failures++;
      if (this.failures >= this.failureThreshold) this.openedAt = this.now();
      throw error;
    }
  }
}

export class FixtureAdapter {
  constructor(candidates) { this.candidates = candidates; }
  async discover(job) { return this.candidates.filter((c) => c.media_type === job.media_type); }
}

export class FirecrawlAdapter {
  constructor({
    apiKey,
    baseUrl = "https://api.firecrawl.dev",
    endpointAllowlist = ["firecrawl.dev"],
    fetchImpl = fetch,
    breaker = new CircuitBreaker(),
  }) {
    if (!apiKey) throw new ProviderDisabledError("firecrawl", ["FIRECRAWL_API_KEY"]);
    this.apiKey = apiKey;
    this.baseUrl = validateProviderEndpoint(baseUrl, endpointAllowlist);
    this.fetch = fetchImpl;
    this.breaker = breaker;
  }
  async discover(job) {
    const query = [job.topic, ...(job.query_hints || []), `${job.media_type} Creative Commons`].join(" ");
    return this.breaker.execute(async () => {
      const response = await this.fetch(`${this.baseUrl}/v1/search`, {
        method: "POST",
        redirect: "error",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          query, limit: Math.min(job.max_pages, job.crawl_budget),
          scrapeOptions: { formats: ["markdown", "links"], onlyMainContent: true },
        }),
        signal: AbortSignal.timeout(job.timeout_ms),
      });
      if (!response.ok) {
        const error = new Error(`Firecrawl request failed (${response.status})`);
        error.status = response.status;
        throw error;
      }
      // Search results are discovery records, not approved questions. Only an
      // explicitly configured transformer may turn these into candidates.
      return (await response.json())?.data || [];
    });
  }
}

export class HermesAdapter {
  constructor({
    endpoint,
    token,
    providerMode,
    endpointAllowlist = [],
    fetchImpl = fetch,
    breaker = new CircuitBreaker(),
  } = {}) {
    const missing = [];
    if (!endpoint) missing.push("HERMES_ENDPOINT");
    if (!token) missing.push("HERMES_TOKEN");
    if (!providerMode) missing.push("HERMES_PROVIDER_MODE");
    if (missing.length) throw new ProviderDisabledError("hermes", missing);
    if (providerMode !== "candidate_api_v1") {
      throw new ProviderDisabledError("hermes", ["HERMES_PROVIDER_MODE=candidate_api_v1"]);
    }
    this.endpoint = validateProviderEndpoint(endpoint, endpointAllowlist);
    this.token = token;
    this.fetch = fetchImpl;
    this.breaker = breaker;
  }
  async discover(job) {
    return this.breaker.execute(async () => {
      const response = await this.fetch(this.endpoint, {
        method: "POST",
        redirect: "error",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify({ schema_version: 1, job }),
        signal: AbortSignal.timeout(job.timeout_ms),
      });
      if (!response.ok) {
        const error = new Error(`Hermes request failed (${response.status})`);
        error.status = response.status;
        throw error;
      }
      const body = await response.json();
      if (!body || !Array.isArray(body.candidates)) throw new Error("Hermes response omitted candidates");
      return body.candidates;
    });
  }
}
