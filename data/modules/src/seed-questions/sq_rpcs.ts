// sq_rpcs.ts
// ─────────────────────────────────────────────────────────────────────────────
// Seed Questions ("Staged Questions") — RPC surface.
//
// Public host: https://seedquestions.intelli-verse-x.ai/v2/rpc/<rpc_id>
// (deploy/seedquestions/ ingress → intelliverse-nakama:7350). Same RPCs are
// reachable on the primary nakama-rest host — the subdomain is a dedicated,
// rate-limitable surface for the client + live-ops tooling.
//
// USER RPCs (session auth):
//   quizverse_seedq_get_staged    → 2–3 ready sets for (mode, topic); auto top-up
//   quizverse_seedq_consume_set   → mark set played; merge ids into qv_seen; restage
//   quizverse_seedq_review        → up/down/flag(reason) a question (quality loop)
//   quizverse_seedq_focus_tracks  → Focus/Study Mode ambient tracks (source #11)
//   quizverse_seedq_sources       → connector registry + status (also public info)
//
// ADMIN / SERVICE RPCs (http_key server-to-server OR service_token ==
// ctx.env["SEEDQ_SERVICE_TOKEN"]):
//   quizverse_seedq_ingest        → run one connector into a (mode, topic) pool
//   quizverse_seedq_ingest_tick   → cron rotation across the combo matrix
//   quizverse_seedq_pool_stats    → pool/review/staging observability
//   quizverse_seedq_asset_job     → remove.bg / ASO-mockup / art-cleanup job descriptors
//   quizverse_seedq_provenance    → TinEye/whitelist provenance check for an image URL
//
// Cron wiring (same pattern as kb_enrichment_tick / tournament_cron_tick):
//   curl -sS -X POST "http://nakama:7350/v2/rpc/quizverse_seedq_ingest_tick?http_key=<key>&unwrap" \
//        -H 'Content-Type: application/json' \
//        -d '{"service_token":"<SEEDQ_SERVICE_TOKEN>","batch":3,"count":20}'

namespace SeedQuestions {

  function errPayload(code: number, message: string, retryable?: boolean, errorCode?: string): string {
    return JSON.stringify({
      ok: false,
      code: code,
      error: message,
      error_code: errorCode || (code === 16 ? "UNAUTHENTICATED" : (code === 7 ? "FORBIDDEN" : (code === 5 ? "NOT_FOUND" : "INVALID_ARGUMENT"))),
      retryable: retryable === true
    });
  }

  function parse(payload: string): any {
    if (!payload || payload === "") return {};
    try { return JSON.parse(payload); } catch (e) {
      throw new Error(JSON.stringify({ code: 3, message: "payload must be valid JSON" }));
    }
  }

  function isAdminOrService(ctx: nkruntime.Context, data: any): boolean {
    if (!ctx.userId) return true; // server-to-server via http_key
    var token = data && data.service_token;
    if (!token) return false;
    var expected = "" + ((ctx.env && ctx.env["SEEDQ_SERVICE_TOKEN"]) || "");
    return expected.length > 0 && token === expected;
  }

  // ── quizverse_seedq_get_staged ──────────────────────────────────────────────
  // Request:  { mode, topic, set_size?, want_sets?, country?, locale? }
  // Response: { ok, sets: StagedSet[], adaptive, pool: {...}, module_version }
  export function rpcGetStaged(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = parse(payload);
    if (!ctx.userId) return errPayload(16, "session required");
    var mode = "" + (data.mode || "");
    var topic = "" + (data.topic || "general");
    if (!mode) return errPayload(3, "mode required");
    var modeDef = SeedQ.resolveMode(mode);
    if (!modeDef) return errPayload(3, "unsupported mode; call quizverse_seedq_sources for canonical mode coverage");
    if (!modeDef.seedq_required || modeDef.kind === "non_question") {
      return JSON.stringify({
        ok: false,
        code: 3,
        error: "mode does not consume SeedQ MCQ staging",
        mode: modeDef.mode,
        kind: modeDef.kind,
        delivery_contract: modeDef.delivery_contract,
        seedq_optional: false
      });
    }
    if (data.set_size !== undefined && (typeof data.set_size !== "number" ||
        !isFinite(data.set_size) || Math.floor(data.set_size) !== data.set_size ||
        data.set_size < 4 || data.set_size > SeedQ.MAX_SET_SIZE)) {
      return errPayload(3, "set_size must be an integer between 4 and " + SeedQ.MAX_SET_SIZE, false, "INVALID_SET_SIZE");
    }
    if (data.want_sets !== undefined && (typeof data.want_sets !== "number" ||
        !isFinite(data.want_sets) || Math.floor(data.want_sets) !== data.want_sets ||
        data.want_sets < SeedQ.MIN_READY_SETS || data.want_sets > SeedQ.TARGET_READY_SETS)) {
      return errPayload(3, "want_sets must be an integer between " + SeedQ.MIN_READY_SETS + " and " + SeedQ.TARGET_READY_SETS, false, "INVALID_READY_DEPTH");
    }
    topic = ("" + (data.topic || modeDef.default_topic || "general")).trim().substring(0, 80);
    if (!topic) topic = modeDef.default_topic || "general";
    var geo = SeedQ.resolveGeo(ctx, nk, ctx.userId, data);

    var setSize = SeedQ.clampInt(data.set_size, 4, SeedQ.MAX_SET_SIZE, SeedQ.DEFAULT_SET_SIZE);
    // A client may ask for fewer sets for display, but must not lower the
    // server-side safety depth below two. The default and refill target is 3.
    var wantSets = SeedQ.clampInt(data.want_sets, SeedQ.MIN_READY_SETS, SeedQ.TARGET_READY_SETS, SeedQ.TARGET_READY_SETS);

    var result = SeedQEngine.ensureStaged(ctx, nk, logger, ctx.userId, modeDef.mode, topic, wantSets, setSize, geo);
    var generatedMs = SeedQ.nowMs();
    var expiresMs = generatedMs + SeedQ.READY_SET_TTL_MS;
    for (var si = 0; si < result.ready.length; si++) {
      if (result.ready[si].expires_ms && result.ready[si].expires_ms < expiresMs) {
        expiresMs = result.ready[si].expires_ms;
      }
    }

    // Repetition-fatigue metadata (D1 §6.2): the client renders honest copy
    // ("8 new + 2 Smart Review repeats") and — when pool_exhausted — fires the
    // wow.e.pool_exhausted intercept INSTEAD of the App Store rating prompt.
    var repeatPolicy = {
      fresh_count: result.fresh_count,
      review_count: result.review_count,
      pool_exhausted: result.pool_exhausted,
      content_generation_queued: result.content_generation_queued,
      next_refresh_eta_seconds: result.next_refresh_eta_sec
    };
    var suppressRating = result.pool_exhausted || result.recycled ||
      (result.fresh_count < result.review_count);

    return JSON.stringify({
      ok: true,
      mode: mode,
      canonical_mode: modeDef.mode,
      topic: topic,
      sets: result.ready,
      ready_depth: result.ready.length,
      target_ready_depth: wantSets,
      sets_built_now: result.built,
      recycled: result.recycled,
      adaptive: result.adaptive,
      personalization: { geo: result.geo, behavior: result.behavior },
      pool: { size: result.pool_size, available_unseen: result.pool_available },
      repeat_policy: repeatPolicy,
      cache: {
        schema_version: SeedQ.CACHE_SCHEMA_VERSION,
        cache_key: ctx.userId + "/" + SeedQ.slugify(modeDef.mode) + "/" + SeedQ.slugify(topic) + "/" + (geo.country || "global").toLowerCase(),
        generated_ms: generatedMs,
        generated_at: SeedQ.isoTime(generatedMs),
        expires_ms: expiresMs,
        expires_at: SeedQ.isoTime(expiresMs),
        self_contained: true,
        contains_answer_keys: true,
        ready_depth: result.ready.length,
        target_ready_depth: wantSets
      },
      availability: {
        online_ready: result.ready.length >= SeedQ.MIN_READY_SETS,
        degraded: result.ready.length < wantSets,
        reason: result.pool_size === 0 ? "pool_empty" :
          (result.ready.length < wantSets ? "insufficient_approved_pool_content" :
          (result.recycled ? "smart_review_recycle" : "ready"))
      },
      source_route: result.source_route,
      suppress_rating_prompt: suppressRating,
      module_version: SeedQ.MODULE_VERSION
    });
  }

  // ── quizverse_seedq_consume_set ─────────────────────────────────────────────
  // Request:  { mode, topic, set_id, restage? }
  // Response: { ok, merged_seen, restaged: {...} }
  export function rpcConsumeSet(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = parse(payload);
    if (!ctx.userId) return errPayload(16, "session required");
    var mode = "" + (data.mode || "");
    var topic = "" + (data.topic || "general");
    var setId = "" + (data.set_id || "");
    if (!mode || !setId) return errPayload(3, "mode and set_id required");
    var modeDef = SeedQ.resolveMode(mode);
    if (!modeDef) return errPayload(3, "unsupported mode");
    var geo = SeedQ.resolveGeo(ctx, nk, ctx.userId, data);

    var res = SeedQEngine.consumeSet(ctx, nk, logger, ctx.userId, modeDef.mode, topic, setId, geo.country);
    if (!res.found) return errPayload(5, "set not found: " + setId);

    // Refill is mandatory: an acknowledgement must never silently reduce the
    // server-side ready queue. `restage:false` is retained as an accepted but
    // deprecated input for backward compatibility and is intentionally ignored.
    var replacementSize = SeedQ.clampInt(res.set_size, 4, SeedQ.MAX_SET_SIZE, SeedQ.DEFAULT_SET_SIZE);
    var r = SeedQEngine.ensureStaged(ctx, nk, logger, ctx.userId, modeDef.mode, topic, SeedQ.TARGET_READY_SETS, replacementSize, geo);
    var restaged = {
      ready_sets: r.ready.length, target_ready_sets: SeedQ.TARGET_READY_SETS,
      built_now: r.built, pool_available: r.pool_available,
      pool_exhausted: r.pool_exhausted, recycled: r.recycled,
      content_generation_queued: r.content_generation_queued
    };
    return JSON.stringify({
      ok: true,
      merged_seen: res.merged,
      ready_depth: r.ready.length,
      target_ready_depth: SeedQ.TARGET_READY_SETS,
      restaged: restaged,
      suppress_rating_prompt: r.pool_exhausted
    });
  }

  // ── quizverse_seedq_review ──────────────────────────────────────────────────
  // Request:  { mode, topic, question_id, vote: "up"|"down"|"flag", reason? }
  // Response: { ok, quarantined, duplicate_vote, counts }
  export function rpcReview(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = parse(payload);
    if (!ctx.userId) return errPayload(16, "session required");
    var mode = "" + (data.mode || "");
    var topic = "" + (data.topic || "general");
    var qid = "" + (data.question_id || "");
    var vote = "" + (data.vote || "");
    if (!mode || !qid) return errPayload(3, "mode and question_id required");
    if (vote !== "up" && vote !== "down" && vote !== "flag") return errPayload(3, "vote must be up|down|flag");

    var reviewMode = SeedQ.resolveMode(mode);
    if (!reviewMode) return errPayload(3, "unsupported mode");
    var res = SeedQQuality.applyReview(nk, logger, ctx.userId, reviewMode.mode, topic, qid, vote, "" + (data.reason || "other"));
    return JSON.stringify({
      ok: true,
      quarantined: res.quarantined,
      duplicate_vote: res.duplicate,
      counts: { up: res.entry.up, down: res.entry.down, flags: res.entry.flags }
    });
  }

  // ── quizverse_seedq_focus_tracks ────────────────────────────────────────────
  export function rpcFocusTracks(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var doc = SeedQSources.getFocusTracks(nk, logger);
    return JSON.stringify({ ok: true, tracks: doc.tracks || [], pattern_references: doc.pattern_references || [], fetched_ms: doc.fetched_ms || 0 });
  }

  // ── quizverse_seedq_sources ─────────────────────────────────────────────────
  export function rpcSources(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var regs = SeedQSources.registry();
    // Annotate env-key presence so live-ops can see what's unlocked.
    for (var i = 0; i < regs.length; i++) {
      var present: string[] = [];
      for (var k = 0; k < regs[i].env_keys.length; k++) {
        var key = regs[i].env_keys[k];
        if (ctx.env && ctx.env[key]) present.push(key);
      }
      (regs[i] as any).env_keys_present = present;
    }
    return JSON.stringify({ ok: true, sources: regs, modes: SeedQ.modeRegistry(), module_version: SeedQ.MODULE_VERSION });
  }

  // ── quizverse_seedq_ingest (admin/service) ──────────────────────────────────
  // Request: { service_token?, source, mode, topic, count?, params?, questions? }
  // `questions` allows direct authored/CMS ingest through the same QA gate.
  export function rpcIngest(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = parse(payload);
    if (!isAdminOrService(ctx, data)) return errPayload(7, "admin or service_token required");
    var mode = "" + (data.mode || "");
    var topic = "" + (data.topic || "general");
    if (!mode) return errPayload(3, "mode required");
    var modeDef = SeedQ.resolveMode(mode);
    if (!modeDef) return errPayload(3, "unsupported mode");
    if (!modeDef.seedq_required || modeDef.kind === "non_question") {
      return errPayload(3, "mode does not consume SeedQ MCQ inventory; use its documented delivery contract");
    }
    mode = modeDef.mode;

    var candidates: SeedQ.SeedQuestion[] = [];
    var source = "" + (data.source || "");
    if (data.questions && data.questions.length > 0) {
      for (var i = 0; i < data.questions.length; i++) {
        var raw = data.questions[i];
        if (!raw || !raw.question || !raw.options) continue;
        var q: SeedQ.SeedQuestion = {
          id: "", question: "" + raw.question, options: raw.options,
          correct_index: (typeof raw.correct_index === "number" && isFinite(raw.correct_index) &&
            Math.floor(raw.correct_index) === raw.correct_index) ? raw.correct_index : -1,
          explanation: "" + (raw.explanation || ""), category: "" + (raw.category || topic),
          topic: topic, mode: mode, difficulty: SeedQ.clampInt(raw.difficulty, 1, 5, 3),
          question_type: "" + (raw.question_type || "Text"),
          media_url: "" + (raw.media_url || ""), media_provenance: null,
          source: source || "manual", citation: "" + (raw.citation || ""), lang: "" + (raw.lang || "en"),
          created_ms: SeedQ.nowMs(), quality: { score: 0, status: "pending", checks: [] },
          country_codes: [], locale: "" + (raw.locale || data.locale || ""),
          geo_relevance: SeedQ.clampInt(raw.geo_relevance, 0, 100, 100),
          geo_reason: "" + (raw.geo_reason || "")
        };
        q.media_alt = "" + (raw.media_alt || "");
        q.media_mime = "" + (raw.media_mime || "");
        q.behavior_tags = raw.behavior_tags && raw.behavior_tags.length ? raw.behavior_tags : [SeedQ.slugify(topic)];
        var rawCountries: any = raw.country_codes || (raw.country_code ? [raw.country_code] : (data.country ? [data.country] : []));
        if (typeof rawCountries === "string") rawCountries = [rawCountries];
        for (var cc = 0; cc < rawCountries.length; cc++) {
          var validCc = SeedQ.validCountry(rawCountries[cc]);
          if (validCc && (q.country_codes as string[]).indexOf(validCc) < 0) (q.country_codes as string[]).push(validCc);
        }
        q.id = SeedQ.questionId(nk, q.source, q.question, q.options);
        candidates.push(q);
      }
    } else {
      if (!source) return errPayload(3, "source required (or inline questions[])");
      if (SeedQSources.QUESTION_SOURCES.indexOf(source) < 0) {
        return errPayload(3, "unknown question source '" + source + "'. Available: " + SeedQSources.QUESTION_SOURCES.join(", "));
      }
      var count = SeedQ.clampInt(data.count, 1, 100, 20);
      try {
        candidates = SeedQSources.fetchQuestions(ctx, nk, logger, source, mode, topic, count, data.params || {});
      } catch (sourceError: any) {
        var safeSourceError = "source connector failed";
        SeedQ.writeSystem(nk, SeedQ.COLL_SOURCE_STATUS, SeedQ.poolKey(mode, topic), {
          source: source, mode: mode, topic: topic, ok: false,
          last_error: safeSourceError, retryable: true, updated_ms: SeedQ.nowMs()
        });
        logger.warn("[SeedQ] source connector failed source=" + source + " mode=" + mode);
        return errPayload(14, safeSourceError, true, "SOURCE_UNAVAILABLE");
      }
      var sourceCountry = SeedQ.validCountry(data.country || data.country_code || (data.params && data.params.country));
      if (sourceCountry) {
        for (var sc = 0; sc < candidates.length; sc++) {
          candidates[sc].country_codes = [sourceCountry];
          candidates[sc].geo_relevance = 100;
          candidates[sc].geo_reason = "country-targeted source ingest";
        }
      }
    }

    var res = SeedQEngine.ingestIntoPool(ctx, nk, logger, mode, topic, candidates);
    var lastError = candidates.length === 0 ? "source returned zero candidates" : "";
    SeedQ.writeSystem(nk, SeedQ.COLL_SOURCE_STATUS, SeedQ.poolKey(mode, topic), {
      source: source, mode: mode, topic: topic,
      ok: candidates.length > 0, fetched: candidates.length,
      accepted: res.accepted, rejected: res.rejected, duplicates: res.duplicates,
      last_error: lastError, retryable: candidates.length === 0,
      updated_ms: SeedQ.nowMs()
    });
    logger.info("[SeedQ] ingest source=" + source + " mode=" + mode + " topic=" + topic +
      " fetched=" + candidates.length + " accepted=" + res.accepted + " rejected=" + res.rejected);
    if (candidates.length === 0) {
      return errPayload(14, lastError, true, "SOURCE_EMPTY");
    }
    return JSON.stringify({ ok: true, source: source, mode: mode, topic: topic, fetched: candidates.length, result: res, retryable: false });
  }

  // ── quizverse_seedq_ingest_tick (cron) ──────────────────────────────────────
  // Request: { service_token?, batch?, count? }
  export function rpcIngestTick(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = parse(payload);
    if (!isAdminOrService(ctx, data)) return errPayload(7, "admin or service_token required");
    var batch = SeedQ.clampInt(data.batch, 1, 8, 3);
    var count = SeedQ.clampInt(data.count, 5, 60, 20);
    var res = SeedQEngine.ingestTick(ctx, nk, logger, batch, count);
    return JSON.stringify({ ok: true, tick: res });
  }

  // ── quizverse_seedq_pool_stats (admin/service) ──────────────────────────────
  export function rpcPoolStats(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = parse(payload);
    if (!isAdminOrService(ctx, data)) return errPayload(7, "admin or service_token required");

    var idx = SeedQ.readSystem(nk, SeedQ.COLL_POOL_INDEX, "index") || { keys: {} };
    var keys = Object.keys(idx.keys || {});
    var pools: any[] = [];
    for (var i = 0; i < keys.length; i++) {
      var meta = idx.keys[keys[i]];
      var pool = SeedQ.readSystem(nk, SeedQ.COLL_POOL, keys[i]) || { questions: [] };
      var review = SeedQ.readSystem(nk, SeedQ.COLL_REVIEW, keys[i]);
      var quarantined = 0;
      if (review && review.entries) {
        var rk = Object.keys(review.entries);
        for (var r = 0; r < rk.length; r++) if (review.entries[rk[r]].status === "quarantined") quarantined++;
      }
      var bySource: { [s: string]: number } = {};
      var byDifficulty: { [d: string]: number } = {};
      var byCountry: { [c: string]: number } = {};
      var approved = 0, reviewed = 0, uxApproved = 0, mediaHealthy = 0, behaviorTagged = 0;
      var crawlSourced = 0, crawlImages = 0, crawlVideos = 0, rightsApproved = 0;
      for (var qi = 0; qi < pool.questions.length; qi++) {
        var q = pool.questions[qi];
        bySource[q.source] = (bySource[q.source] || 0) + 1;
        byDifficulty["d" + (q.difficulty || 3)] = (byDifficulty["d" + (q.difficulty || 3)] || 0) + 1;
        var reviewEntry = review && review.entries ? review.entries[q.id] : null;
        var currentlyApproved = !reviewEntry || reviewEntry.status !== "quarantined";
        if (currentlyApproved) currentlyApproved = SeedQQuality.ensureReviewed(q, meta.mode);
        if (currentlyApproved) {
          approved++;
          reviewed++;
          uxApproved++;
          mediaHealthy++;
        }
        if (q.behavior_tags && q.behavior_tags.length > 0) behaviorTagged++;
        if (q.crawl_provenance) {
          crawlSourced++;
          if (q.question_type === "Image") crawlImages++;
          if (q.question_type === "Video") crawlVideos++;
        }
        if (q.media_provenance && q.media_provenance.checked &&
            q.media_provenance.license !== "unknown") rightsApproved++;
        if (!q.country_codes || q.country_codes.length === 0) byCountry["global"] = (byCountry["global"] || 0) + 1;
        else for (var ci = 0; ci < q.country_codes.length; ci++) byCountry[q.country_codes[ci]] = (byCountry[q.country_codes[ci]] || 0) + 1;
      }
      pools.push({
        key: keys[i], mode: meta.mode, topic: meta.topic,
        size: pool.questions.length, quarantined: quarantined,
        approved: approved, reviewed: reviewed, semantic_approved: approved,
        ux_approved: uxApproved, media_healthy: mediaHealthy, behavior_tagged: behaviorTagged,
        crawl_sourced: crawlSourced, crawl_images: crawlImages, crawl_videos: crawlVideos,
        rights_approved: rightsApproved,
        production_minimum: SeedQ.MODE_PRODUCTION_MIN,
        ready_for_staging: approved >= SeedQ.MODE_PRODUCTION_MIN,
        by_source: bySource, by_difficulty: byDifficulty, by_country: byCountry,
        updated_ms: pool.updated_ms || 0
      });
    }

    var state = SeedQ.readSystem(nk, SeedQ.COLL_INGEST_STATE, "state") || {};
    var modes = SeedQ.modeRegistry();
    var coverage: any[] = [];
    var taxonomy = { question: 0, experience: 0, non_question: 0, denominator: 0 };
    for (var mi = 0; mi < modes.length; mi++) {
      var directKey = SeedQ.poolKey(modes[mi].mode, modes[mi].default_topic);
      var directSize = 0, directApproved = 0, directUx = 0, directMedia = 0, directBehavior = 0, directCountries: any = {};
      var directCrawl = 0, directCrawlImages = 0, directCrawlVideos = 0, directRights = 0;
      for (var pi = 0; pi < pools.length; pi++) {
        if (pools[pi].key === directKey) {
          directSize = pools[pi].size; directApproved = pools[pi].approved;
          directUx = pools[pi].ux_approved; directMedia = pools[pi].media_healthy;
          directBehavior = pools[pi].behavior_tagged; directCountries = pools[pi].by_country;
          directCrawl = pools[pi].crawl_sourced; directCrawlImages = pools[pi].crawl_images;
          directCrawlVideos = pools[pi].crawl_videos; directRights = pools[pi].rights_approved;
          break;
        }
      }
      if (modes[mi].kind === "question") taxonomy.question++;
      else if (modes[mi].kind === "experience") taxonomy.experience++;
      else taxonomy.non_question++;

      var denominator = modes[mi].seedq_required && modes[mi].kind !== "non_question";
      if (denominator) taxonomy.denominator++;
      var effectiveMode = modes[mi].kind === "experience" && modes[mi].inventory_mode ?
        modes[mi].inventory_mode : modes[mi].mode;
      var effectiveDef = SeedQ.resolveMode(effectiveMode);
      var effectiveTopic = effectiveDef ? effectiveDef.default_topic : modes[mi].default_topic;
      var effectiveKey = SeedQ.poolKey(effectiveMode, effectiveTopic);
            var sourceStatus = SeedQ.readSystem(nk, SeedQ.COLL_SOURCE_STATUS, effectiveKey) || {};
      var effectiveSize = directSize, effectiveApproved = directApproved, effectiveUx = directUx,
        effectiveMedia = directMedia, effectiveBehavior = directBehavior, effectiveCountries = directCountries;
      if (effectiveKey !== directKey) {
        effectiveSize = 0; effectiveApproved = 0; effectiveUx = 0; effectiveMedia = 0;
        effectiveBehavior = 0; effectiveCountries = {};
        for (var epi = 0; epi < pools.length; epi++) {
          if (pools[epi].key === effectiveKey) {
            effectiveSize = pools[epi].size; effectiveApproved = pools[epi].approved;
            effectiveUx = pools[epi].ux_approved; effectiveMedia = pools[epi].media_healthy;
            effectiveBehavior = pools[epi].behavior_tagged; effectiveCountries = pools[epi].by_country;
            break;
          }
        }
      }
      var usable = denominator ? Math.min(effectiveApproved, effectiveUx, effectiveMedia) : 0;
      var deficit = Math.max(0, SeedQ.MODE_PRODUCTION_MIN - usable);
      var status = !denominator ? "NOT_APPLICABLE" :
        (deficit === 0 ? "PASS" : (modes[mi].support === "fallback" ? "WARN" : "BLOCKED"));
      coverage.push({
        mode: modes[mi].mode, aliases: modes[mi].aliases, kind: modes[mi].kind,
        denominator: denominator, seedq_required: modes[mi].seedq_required,
        delivery_contract: modes[mi].delivery_contract,
        support: modes[mi].support, source: modes[mi].source,
        default_topic: modes[mi].default_topic, direct_size: directSize,
        semantic_approved: directApproved, ux_approved: directUx, media_healthy: directMedia,
        behavior_tagged: directBehavior, geo_counts: directCountries,
        crawl_sourced: directCrawl, crawl_images: directCrawlImages,
        crawl_videos: directCrawlVideos, rights_approved: directRights,
        inventory_mode: effectiveMode, effective_topic: effectiveTopic, effective_size: effectiveSize,
        effective_semantic_approved: effectiveApproved, effective_ux_approved: effectiveUx,
        effective_media_healthy: effectiveMedia, effective_behavior_tagged: effectiveBehavior,
        effective_geo_counts: effectiveCountries,
        production_minimum: SeedQ.MODE_PRODUCTION_MIN,
        fresh_sets_possible: Math.floor(usable / SeedQ.DEFAULT_SET_SIZE),
        ready_for_staging: denominator && deficit === 0, deficit: denominator ? deficit : 0,
        status: status,
                last_error: "" + (sourceStatus.last_error || ""),
                last_ingest_ms: sourceStatus.updated_ms || 0,
                source_retryable: sourceStatus.retryable === true,
        fallback_mode: modes[mi].fallback_mode, reason: modes[mi].reason
      });
    }
    return JSON.stringify({ ok: true, taxonomy: taxonomy, pools: pools, mode_coverage: coverage, ingest_state: { cursor: state.cursor || 0, runs: state.runs || 0, last_run_ms: state.last_run_ms || 0 }, module_version: SeedQ.MODULE_VERSION });
  }

  // ── quizverse_seedq_asset_job (admin/service) ───────────────────────────────
  // Request: { service_token?, kind: "removebg"|"aso_mockups"|"art_cleanup", params? }
  export function rpcAssetJob(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = parse(payload);
    if (!isAdminOrService(ctx, data)) return errPayload(7, "admin or service_token required");
    var res = SeedQSources.buildAssetJob(ctx, "" + (data.kind || ""), data.params || {});
    return JSON.stringify(res);
  }

  // ── quizverse_seedq_provenance (admin/service) ──────────────────────────────
  // Request: { service_token?, image_url }
  export function rpcProvenance(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = parse(payload);
    if (!isAdminOrService(ctx, data)) return errPayload(7, "admin or service_token required");
    var url = "" + (data.image_url || "");
    if (!url) return errPayload(3, "image_url required");
    var prov = SeedQQuality.checkProvenance(ctx, nk, logger, url);
    return JSON.stringify({ ok: true, provenance: prov, safe: prov.license !== "unknown" });
  }

  // ── Registration ────────────────────────────────────────────────────────────
  // Single-arg register() with string-literal rpc ids: postbuild.js rewrites
  // each call to a __rpc_ stub assignment and auto-invokes register() on every
  // pooled Goja VM (see nakama-rpc skill / postbuild.js autoInvokeRegister).
  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("quizverse_seedq_get_staged", rpcSeedqGetStaged);
    initializer.registerRpc("quizverse_seedq_consume_set", rpcSeedqConsumeSet);
    initializer.registerRpc("quizverse_seedq_review", rpcSeedqReview);
    initializer.registerRpc("quizverse_seedq_focus_tracks", rpcSeedqFocusTracks);
    initializer.registerRpc("quizverse_seedq_sources", rpcSeedqSources);
    initializer.registerRpc("quizverse_seedq_ingest", rpcSeedqIngest);
    initializer.registerRpc("quizverse_seedq_ingest_tick", rpcSeedqIngestTick);
    initializer.registerRpc("quizverse_seedq_pool_stats", rpcSeedqPoolStats);
    initializer.registerRpc("quizverse_seedq_asset_job", rpcSeedqAssetJob);
    initializer.registerRpc("quizverse_seedq_provenance", rpcSeedqProvenance);
  }

  // Safe module-evaluation call. The real initializer is supplied by main.ts;
  // this no-op preserves the single-argument register shape without
  // dereferencing null before Nakama reaches InitModule.
  var _NOOP: any = { registerRpc: function() {} };
  register(_NOOP);
}

// Nakama's JavaScript AST scanner only accepts globally declared RPC handler
// identifiers. Keep these wrappers at file scope and delegate into the
// namespace implementation so registration works in every pooled Goja VM.
function seedqSafeInvoke(handler: any, ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  try {
    return handler(ctx, logger, nk, payload);
  } catch (error: any) {
    var message = "" + (error && error.message ? error.message : "");
    if (message.indexOf("payload must be valid JSON") >= 0) {
      return JSON.stringify({ ok: false, code: 3, error: "payload must be valid JSON", error_code: "MALFORMED_JSON", retryable: false });
    }
    logger.warn("[SeedQ] RPC failed safely error_code=INTERNAL");
    return JSON.stringify({ ok: false, code: 13, error: "SeedQ request failed", error_code: "INTERNAL", retryable: true });
  }
}

function rpcSeedqGetStaged(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  return seedqSafeInvoke(SeedQuestions.rpcGetStaged, ctx, logger, nk, payload);
}
function rpcSeedqConsumeSet(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  return seedqSafeInvoke(SeedQuestions.rpcConsumeSet, ctx, logger, nk, payload);
}
function rpcSeedqReview(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  return seedqSafeInvoke(SeedQuestions.rpcReview, ctx, logger, nk, payload);
}
function rpcSeedqFocusTracks(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  return seedqSafeInvoke(SeedQuestions.rpcFocusTracks, ctx, logger, nk, payload);
}
function rpcSeedqSources(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  return seedqSafeInvoke(SeedQuestions.rpcSources, ctx, logger, nk, payload);
}
function rpcSeedqIngest(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  return seedqSafeInvoke(SeedQuestions.rpcIngest, ctx, logger, nk, payload);
}
function rpcSeedqIngestTick(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  return seedqSafeInvoke(SeedQuestions.rpcIngestTick, ctx, logger, nk, payload);
}
function rpcSeedqPoolStats(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  return seedqSafeInvoke(SeedQuestions.rpcPoolStats, ctx, logger, nk, payload);
}
function rpcSeedqAssetJob(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  return seedqSafeInvoke(SeedQuestions.rpcAssetJob, ctx, logger, nk, payload);
}
function rpcSeedqProvenance(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
  return seedqSafeInvoke(SeedQuestions.rpcProvenance, ctx, logger, nk, payload);
}
