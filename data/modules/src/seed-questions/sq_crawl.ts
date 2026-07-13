// SeedQ asynchronous crawl contract.
// Crawling and media probing happen in an external worker. Goja only stores
// bounded jobs and ingests sanitized, pre-validated candidates.
declare var __rpc_quizverse_seedq_crawl_job_submit: any;
declare var __rpc_quizverse_seedq_crawl_job_status: any;
declare var __rpc_quizverse_seedq_crawl_candidate_ingest: any;

namespace SeedQCrawl {
  var MEDIA_TYPES: any = { image: true, video: true, audio: true };
  var STRATEGIES: any = { fixture: true, firecrawl: true, hermes: true, hybrid: true };
  var LICENSES: any = {
    public_domain: true, cc0: true, cc_by: true, cc_by_sa: true,
    explicit_permission: true, api_tos_embed: true
  };
  var MAX_CANDIDATES_PER_BATCH = 100;
  var AUTH_MAX_SKEW_MS = 5 * 60 * 1000;

  function response(ok: boolean, code: number, errorCode: string, message: string, data?: any): string {
    var out: any = { ok: ok, code: code, error_code: errorCode, error: message, retryable: code === 14 };
    if (data) for (var k in data) if (Object.prototype.hasOwnProperty.call(data, k)) out[k] = data[k];
    return JSON.stringify(out);
  }

  function parse(payload: string): any {
    if (!payload) return {};
    try { return JSON.parse(payload); } catch (e) { return null; }
  }

  function hex(buffer: ArrayBuffer): string {
    var bytes = new Uint8Array(buffer);
    var out = "";
    for (var i = 0; i < bytes.length; i++) {
      var part = bytes[i].toString(16);
      out += part.length === 1 ? "0" + part : part;
    }
    return out;
  }

  function equalFixed(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    var different = 0;
    for (var i = 0; i < a.length; i++) different |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return different === 0;
  }

  function serviceAuthorized(
    ctx: nkruntime.Context,
    nk: nkruntime.Nakama,
    rpcId: string,
    data: any
  ): boolean {
    var secret = "" + ((ctx.env && ctx.env["SEEDQ_SERVICE_TOKEN"]) || "");
    var auth = data && data.auth;
    if (secret.length < 32 || !auth || typeof auth !== "object") return false;
    var timestamp = parseInt(auth.timestamp_ms, 10);
    var nonce = "" + (auth.nonce || "");
    var supplied = ("" + (auth.signature || "")).toLowerCase();
    if (!timestamp || Math.abs(SeedQ.nowMs() - timestamp) > AUTH_MAX_SKEW_MS ||
        !/^[A-Za-z0-9_-]{16,96}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(supplied)) return false;

    delete data.auth;
    delete data.service_token;
    var signed = rpcId + "." + timestamp + "." + nonce + "." + JSON.stringify(data);
    var expected = hex(nk.hmacSha256Hash(signed, secret));
    if (!equalFixed(supplied, expected)) return false;

    // A five-minute CAS bucket makes signatures single-use without creating an
    // unbounded row per request. Contended writers fail closed and may retry
    // with a new nonce; each bucket accepts at most 500 signed operations.
    try {
      var bucket = Math.floor(timestamp / AUTH_MAX_SKEW_MS);
      var bucketKey = "b_" + bucket;
      var rows = nk.storageRead([{
        collection: SeedQ.COLL_CRAWL_AUTH_NONCES,
        key: bucketKey,
        userId: "00000000-0000-0000-0000-000000000000"
      }]);
      var row: any = rows && rows.length ? rows[0] : null;
      var hashes: string[] = row && row.value && row.value.hashes instanceof Array ?
        row.value.hashes.slice(0) : [];
      var nonceHash = nk.sha256Hash(nonce).substring(0, 32);
      if (hashes.indexOf(nonceHash) >= 0 || hashes.length >= 500) return false;
      hashes.push(nonceHash);
      nk.storageWrite([{
        collection: SeedQ.COLL_CRAWL_AUTH_NONCES,
        key: bucketKey,
        userId: "00000000-0000-0000-0000-000000000000",
        value: { hashes: hashes, updated_ms: SeedQ.nowMs() },
        version: row ? row.version : "*",
        permissionRead: 0,
        permissionWrite: 0
      }]);
      try {
        nk.storageDelete([{
          collection: SeedQ.COLL_CRAWL_AUTH_NONCES,
          key: "b_" + (bucket - 2),
          userId: "00000000-0000-0000-0000-000000000000"
        }]);
      } catch (_) { /* already absent */ }
    } catch (_) {
      return false;
    }
    return true;
  }

  function cleanList(raw: any, max: number, countryOnly?: boolean): string[] {
    var input: any[] = raw instanceof Array ? raw : (raw ? [raw] : []);
    var out: string[] = [];
    for (var i = 0; i < input.length && out.length < max; i++) {
      var value = countryOnly ? SeedQ.validCountry(input[i]) :
        ("" + (input[i] || "")).trim().toLowerCase().substring(0, 80);
      if (value && out.indexOf(value) < 0) out.push(value);
    }
    return out;
  }

  function hostOf(url: string): string {
    var m = /^https:\/\/([^\/\?#]+)(?:[\/\?#]|$)/i.exec(url || "");
    if (!m) return "";
    var host = m[1].toLowerCase().replace(/:\d+$/, "");
    if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) return "";
    if (host === "localhost" || host === "::1" || host.indexOf("127.") === 0 ||
        host.indexOf("10.") === 0 || host.indexOf("192.168.") === 0 ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host)) return "";
    return host;
  }

  function cleanDomains(raw: any, max: number): string[] {
    var input: any[] = raw instanceof Array ? raw : (raw ? [raw] : []);
    var out: string[] = [];
    for (var i = 0; i < input.length && out.length < max; i++) {
      var value = ("" + (input[i] || "")).trim().toLowerCase().replace(/\.$/, "");
      if (/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value) &&
          out.indexOf(value) < 0) out.push(value);
    }
    return out;
  }

  function domainAllowed(host: string, allowed: string[], denied: string[]): boolean {
    function matches(domain: string): boolean {
      return host === domain || (host.length > domain.length &&
        host.indexOf("." + domain) === host.length - domain.length - 1);
    }
    for (var d = 0; d < denied.length; d++) if (matches(denied[d])) return false;
    if (allowed.length === 0) return false; // fail closed: no unrestricted crawl/ingest
    for (var a = 0; a < allowed.length; a++) if (matches(allowed[a])) return true;
    return false;
  }

  function normalizeJob(nk: nkruntime.Nakama, data: any): any {
    var def = SeedQ.resolveMode("" + (data.mode || ""));
    if (!def || !def.seedq_required) return { error: "unsupported SeedQ mode" };
    var mediaType = ("" + (data.media_type || def.media || "")).toLowerCase();
    if (!MEDIA_TYPES[mediaType]) return { error: "media_type must be image|video|audio" };
    var strategy = ("" + (data.source_strategy || "fixture")).toLowerCase();
    if (!STRATEGIES[strategy]) return { error: "source_strategy must be fixture|firecrawl|hermes|hybrid" };
    var countries = cleanList(data.country_codes, 20, true);
    var rawCountries: any[] = data.country_codes instanceof Array ? data.country_codes : (data.country_codes ? [data.country_codes] : []);
    if (countries.length !== rawCountries.length) return { error: "country_codes must contain valid ISO-3166 alpha-2 codes" };
    var rawAllowed: any[] = data.allowed_domains instanceof Array ? data.allowed_domains : [];
    var allowed = cleanDomains(rawAllowed, 30);
    if (allowed.length === 0 || allowed.length !== rawAllowed.length) {
      return { error: "allowed_domains is required and must contain only public DNS suffixes" };
    }
    var rawDenied: any[] = data.denied_domains instanceof Array ? data.denied_domains : [];
    var denied = cleanDomains(rawDenied, 30);
    if (denied.length !== rawDenied.length) return { error: "denied_domains contains an invalid DNS suffix" };
    var topic = ("" + (data.topic || def.default_topic || "general")).trim().substring(0, 80);
    var idem = ("" + (data.idempotency_key || "")).trim().substring(0, 120);
    if (!idem) return { error: "idempotency_key is required" };
    var now = SeedQ.nowMs();
    var jobId = "sqcj_" + nk.sha256Hash(idem).substring(0, 20);
    return {
      job_id: jobId, idempotency_key: idem, status: "queued",
      mode: def.mode, topic: topic, country_codes: countries,
      locales: cleanList(data.locales, 10, false),
      interest_tags: cleanList(data.interest_tags, 20, false),
      target_difficulty: SeedQ.clampInt(data.target_difficulty, 1, 5, 3),
      age_band: ("" + (data.age_band || "general")).substring(0, 24),
      media_type: mediaType, count: SeedQ.clampInt(data.count, 1, 100, 20),
      freshness_window_days: SeedQ.clampInt(data.freshness_window_days, 1, 3650, 90),
      allowed_domains: allowed, denied_domains: denied,
      allowed_licenses: cleanList(data.allowed_licenses || ["public_domain", "cc0", "cc_by"], 10, false),
      query_hints: cleanList(data.query_hints, 20, false),
      source_strategy: strategy,
      crawl_budget: SeedQ.clampInt(data.crawl_budget, 1, 1000, 50),
      max_pages: SeedQ.clampInt(data.max_pages, 1, 100, 10),
      max_assets: SeedQ.clampInt(data.max_assets, 1, 200, 30),
      timeout_ms: SeedQ.clampInt(data.timeout_ms, 1000, 120000, 30000),
      attempts: 0, max_attempts: SeedQ.clampInt(data.max_attempts, 1, 8, 3),
      accepted: 0, rejected: 0, duplicates: 0, quarantined: 0,
      created_ms: now, updated_ms: now, completed_ms: 0,
      policy: { robots_required: true, private_content_forbidden: true, pii_forbidden: true }
    };
  }

  export function rpcSubmit(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = parse(payload);
    if (!data) return response(false, 3, "MALFORMED_JSON", "payload must be valid JSON");
    if (!serviceAuthorized(ctx, nk, "quizverse_seedq_crawl_job_submit", data)) {
      return response(false, 7, "FORBIDDEN", "valid non-replayed service signature required");
    }
    var job = normalizeJob(nk, data);
    if (job.error) return response(false, 3, "INVALID_JOB", job.error);
    var existingId = SeedQ.readSystem(nk, SeedQ.COLL_CRAWL_IDEMPOTENCY, job.idempotency_key);
    if (existingId && existingId.job_id) {
      var existing = SeedQ.readSystem(nk, SeedQ.COLL_CRAWL_JOBS, existingId.job_id);
      return response(true, 0, "", "", { job: existing, idempotent_replay: true });
    }
    SeedQ.writeSystem(nk, SeedQ.COLL_CRAWL_JOBS, job.job_id, job);
    SeedQ.writeSystem(nk, SeedQ.COLL_CRAWL_IDEMPOTENCY, job.idempotency_key, { job_id: job.job_id });
    logger.info("[SeedQ crawl] queued job=" + job.job_id + " strategy=" + job.source_strategy);
    return response(true, 0, "", "", { job: job, idempotent_replay: false });
  }

  export function rpcStatus(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = parse(payload);
    if (!data) return response(false, 3, "MALFORMED_JSON", "payload must be valid JSON");
    if (!serviceAuthorized(ctx, nk, "quizverse_seedq_crawl_job_status", data)) {
      return response(false, 7, "FORBIDDEN", "valid non-replayed service signature required");
    }
    var jobId = ("" + (data.job_id || "")).substring(0, 64);
    var job = SeedQ.readSystem(nk, SeedQ.COLL_CRAWL_JOBS, jobId);
    if (!job) return response(false, 5, "NOT_FOUND", "crawl job not found");
    return response(true, 0, "", "", { job: job });
  }

  function rejectReason(candidate: any, job: any): string {
    if (!candidate || typeof candidate !== "object") return "invalid_candidate";
    var sourceHost = hostOf("" + (candidate.canonical_url || candidate.source_url || ""));
    var mediaHost = hostOf("" + (candidate.media_url || candidate.embed_url || ""));
    if (!sourceHost || !mediaHost) return "blocked_or_invalid_url";
    if (!domainAllowed(sourceHost, job.allowed_domains, job.denied_domains) ||
        !domainAllowed(mediaHost, job.allowed_domains, job.denied_domains)) return "domain_not_allowed";
    var license = ("" + (candidate.license || "")).toLowerCase();
    if (!LICENSES[license] || job.allowed_licenses.indexOf(license) < 0) return "license_not_allowed";
    if (!candidate.robots_allowed || candidate.auth_gated || candidate.paywalled || candidate.private_content) {
      return "crawl_policy_failed";
    }
    if (!candidate.rights_ok || !candidate.mime_valid || !candidate.size_valid ||
        !candidate.redirect_valid || !candidate.media_health_ok) return "media_validation_failed";
    if (!candidate.content_safety_ok || !candidate.age_gate_ok || candidate.contains_pii) return "safety_gate_failed";
    if (!candidate.deterministic_verified || !candidate.answer_supported_by_citation) return "answer_not_verified";
    if (!candidate.experience_approved) return "experience_qa_failed";
    if (("" + (candidate.media_type || "")).toLowerCase() !== job.media_type) return "media_type_mismatch";
    if (!candidate.citation || !/^[a-f0-9]{64}$/i.test("" + (candidate.asset_hash || ""))) {
      return "provenance_incomplete";
    }
    if (job.media_type === "video" && (!candidate.embeddable || !candidate.thumbnail_url ||
        !hostOf("" + candidate.thumbnail_url) ||
        !domainAllowed(hostOf("" + candidate.thumbnail_url), job.allowed_domains, job.denied_domains) ||
        !(candidate.cited_segment || (candidate.transcript_url && hostOf("" + candidate.transcript_url))))) {
      return "video_evidence_incomplete";
    }
    if (job.media_type === "image" && (!candidate.alt_text || !candidate.creator ||
        !candidate.license_url || !hostOf("" + candidate.license_url))) {
      return "image_attribution_incomplete";
    }
    if (!candidate.question || !(candidate.options instanceof Array) || candidate.options.length !== 4) {
      return "question_shape_invalid";
    }
    return "";
  }

  function toQuestion(nk: nkruntime.Nakama, candidate: any, job: any): SeedQ.SeedQuestion {
    var source = "crawl_" + SeedQ.slugify(candidate.provider || job.source_strategy).substring(0, 12);
    var q: SeedQ.SeedQuestion = {
      id: "", question: ("" + candidate.question).substring(0, 320), options: [],
      correct_index: SeedQ.clampInt(candidate.correct_index, 0, 3, 0),
      explanation: ("" + (candidate.explanation || "")).substring(0, 500),
      category: job.topic, topic: job.topic, mode: job.mode,
      difficulty: SeedQ.clampInt(candidate.difficulty || job.target_difficulty, 1, 5, 3),
      question_type: job.media_type.charAt(0).toUpperCase() + job.media_type.substring(1),
      media_url: "" + (candidate.media_url || candidate.embed_url || ""),
      media_provenance: {
        source_domain: hostOf("" + (candidate.canonical_url || candidate.source_url)),
        license: "" + candidate.license, checked: true, method: "crawl_worker_rights_gate"
      },
      source: source, citation: ("" + candidate.citation).substring(0, 500),
      lang: (job.locales[0] || "en").substring(0, 20), created_ms: SeedQ.nowMs(),
      quality: { score: 0, status: "pending", checks: ["crawl_worker_validated", "deterministic_verified"] },
      country_codes: job.country_codes.slice(0), locale: job.locales[0] || "",
      geo_relevance: job.country_codes.length ? 100 : 0,
      geo_reason: job.country_codes.length ? "country-tagged crawl source" : "global crawl source",
      media_alt: ("" + (candidate.alt_text || candidate.caption || candidate.title || "")).substring(0, 200),
      media_mime: ("" + candidate.media_mime).toLowerCase(),
      behavior_tags: job.interest_tags.concat([SeedQ.slugify(job.topic)]),
      media_embed_url: "" + (candidate.embed_url || ""),
      media_thumbnail_url: "" + (candidate.thumbnail_url || ""),
      media_timecode_seconds: SeedQ.clampInt(candidate.timecode_seconds, 0, 86400, 0),
      media_fallback: candidate.thumbnail_url ? "thumbnail" : "hide_media",
      crawl_provenance: {
        job_id: job.job_id, provider: "" + (candidate.provider || job.source_strategy),
        canonical_url: "" + candidate.canonical_url, source_url: "" + (candidate.source_url || candidate.canonical_url),
        creator: "" + (candidate.creator || ""), license_url: "" + (candidate.license_url || ""),
        published_at: "" + (candidate.published_at || ""),
        transcript_url: "" + (candidate.transcript_url || ""),
        cited_segment: "" + (candidate.cited_segment || ""),
        asset_hash: "" + (candidate.asset_hash || ""),
        stem_hash: nk.sha256Hash(SeedQ.slugify(candidate.question)),
        review_kind: candidate.agent_reviewed ? "agent_supplemental" : "deterministic_auto"
      }
    };
    for (var i = 0; i < candidate.options.length; i++) q.options.push(("" + candidate.options[i]).substring(0, 120));
    q.id = SeedQ.questionId(nk, source, q.question, q.options);
    return q;
  }

  export function rpcIngestCandidates(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = parse(payload);
    if (!data) return response(false, 3, "MALFORMED_JSON", "payload must be valid JSON");
    if (!serviceAuthorized(ctx, nk, "quizverse_seedq_crawl_candidate_ingest", data)) {
      return response(false, 7, "FORBIDDEN", "valid non-replayed service signature required");
    }
    var jobId = ("" + (data.job_id || "")).substring(0, 64);
    var job = SeedQ.readSystem(nk, SeedQ.COLL_CRAWL_JOBS, jobId);
    if (!job) return response(false, 5, "NOT_FOUND", "crawl job not found");
    if (job.status === "completed") return response(true, 0, "", "", { job: job, idempotent_replay: true });
    var raw: any[] = data.candidates instanceof Array ? data.candidates.slice(0, MAX_CANDIDATES_PER_BATCH) : [];
    var acceptedCandidates: SeedQ.SeedQuestion[] = [];
    var rejected: any[] = [];
    for (var i = 0; i < raw.length; i++) {
      var reason = rejectReason(raw[i], job);
      if (reason) {
        rejected.push({ candidate_id: ("" + (raw[i] && raw[i].candidate_id || i)).substring(0, 80), reason: reason });
      } else {
        acceptedCandidates.push(toQuestion(nk, raw[i], job));
      }
    }
    var result = SeedQEngine.ingestIntoPool(ctx, nk, logger, job.mode, job.topic, acceptedCandidates);
    job.attempts = (job.attempts || 0) + 1;
    job.accepted = (job.accepted || 0) + result.accepted;
    job.rejected = (job.rejected || 0) + result.rejected;
    job.duplicates = (job.duplicates || 0) + result.duplicates;
    job.quarantined = (job.quarantined || 0) + rejected.length;
    job.status = data.final === false ? "processing" : "completed";
    job.updated_ms = SeedQ.nowMs();
    if (job.status === "completed") job.completed_ms = job.updated_ms;
    SeedQ.writeSystem(nk, SeedQ.COLL_CRAWL_JOBS, job.job_id, job);
    if (rejected.length) {
      SeedQ.writeSystem(nk, SeedQ.COLL_CRAWL_QUARANTINE,
        job.job_id + "_" + job.attempts, { job_id: job.job_id, created_ms: SeedQ.nowMs(), reasons: rejected });
    }
    return response(true, 0, "", "", {
      job: job, received: raw.length, validated: acceptedCandidates.length,
      quarantine: rejected, ingest: result, idempotent_replay: false
    });
  }
}

function seedqCrawlSafeInvoke(handler: any, ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  try {
    return handler(ctx, logger, nk, payload);
  } catch (error: any) {
    logger.warn("[SeedQ crawl] request failed safely");
    return JSON.stringify({ ok: false, code: 13, error_code: "INTERNAL", error: "crawl request failed", retryable: true });
  }
}
function rpcSeedqCrawlJobSubmit(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  return seedqCrawlSafeInvoke(SeedQCrawl.rpcSubmit, ctx, logger, nk, payload);
}
function rpcSeedqCrawlJobStatus(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  return seedqCrawlSafeInvoke(SeedQCrawl.rpcStatus, ctx, logger, nk, payload);
}
function rpcSeedqCrawlCandidateIngest(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  return seedqCrawlSafeInvoke(SeedQCrawl.rpcIngestCandidates, ctx, logger, nk, payload);
}

// Nakama resolves callback identifiers independently in every Goja VM. Keep
// these generated-name aliases initialized at global scope; assigning them only
// inside InitModule leaves non-initializer VMs with an undefined callback.
__rpc_quizverse_seedq_crawl_job_submit = rpcSeedqCrawlJobSubmit;
__rpc_quizverse_seedq_crawl_job_status = rpcSeedqCrawlJobStatus;
__rpc_quizverse_seedq_crawl_candidate_ingest = rpcSeedqCrawlCandidateIngest;
