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
//   quizverse_seedq_sources       → 13-connector registry + status (also public info)
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

  function errPayload(code: number, message: string): string {
    return JSON.stringify({ ok: false, code: code, error: message });
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
  function rpcGetStaged(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = parse(payload);
    if (!ctx.userId) return errPayload(16, "session required");
    var mode = "" + (data.mode || "");
    var topic = "" + (data.topic || "general");
    if (!mode) return errPayload(3, "mode required");
    var modeDef = SeedQ.resolveMode(mode);
    if (!modeDef) return errPayload(3, "unsupported mode; call quizverse_seedq_sources for canonical mode coverage");
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
  function rpcConsumeSet(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
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
  function rpcReview(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
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
  function rpcFocusTracks(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var doc = SeedQSources.getFocusTracks(nk, logger);
    return JSON.stringify({ ok: true, tracks: doc.tracks || [], pattern_references: doc.pattern_references || [], fetched_ms: doc.fetched_ms || 0 });
  }

  // ── quizverse_seedq_sources ─────────────────────────────────────────────────
  function rpcSources(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
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
  function rpcIngest(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = parse(payload);
    if (!isAdminOrService(ctx, data)) return errPayload(7, "admin or service_token required");
    var mode = "" + (data.mode || "");
    var topic = "" + (data.topic || "general");
    if (!mode) return errPayload(3, "mode required");
    var modeDef = SeedQ.resolveMode(mode);
    if (!modeDef) return errPayload(3, "unsupported mode");
    mode = modeDef.mode;

    var candidates: SeedQ.SeedQuestion[] = [];
    var source = "" + (data.source || "");
    if (data.questions && data.questions.length > 0) {
      for (var i = 0; i < data.questions.length; i++) {
        var raw = data.questions[i];
        if (!raw || !raw.question || !raw.options) continue;
        var q: SeedQ.SeedQuestion = {
          id: "", question: "" + raw.question, options: raw.options,
          correct_index: SeedQ.clampInt(raw.correct_index, 0, 7, 0),
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
      candidates = SeedQSources.fetchQuestions(ctx, nk, logger, source, mode, topic, count, data.params || {});
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
    logger.info("[SeedQ] ingest source=" + source + " mode=" + mode + " topic=" + topic +
      " fetched=" + candidates.length + " accepted=" + res.accepted + " rejected=" + res.rejected);
    return JSON.stringify({ ok: true, source: source, mode: mode, topic: topic, fetched: candidates.length, result: res });
  }

  // ── quizverse_seedq_ingest_tick (cron) ──────────────────────────────────────
  // Request: { service_token?, batch?, count? }
  function rpcIngestTick(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = parse(payload);
    if (!isAdminOrService(ctx, data)) return errPayload(7, "admin or service_token required");
    var batch = SeedQ.clampInt(data.batch, 1, 8, 3);
    var count = SeedQ.clampInt(data.count, 5, 60, 20);
    var res = SeedQEngine.ingestTick(ctx, nk, logger, batch, count);
    return JSON.stringify({ ok: true, tick: res });
  }

  // ── quizverse_seedq_pool_stats (admin/service) ──────────────────────────────
  function rpcPoolStats(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
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
      for (var qi = 0; qi < pool.questions.length; qi++) {
        var q = pool.questions[qi];
        bySource[q.source] = (bySource[q.source] || 0) + 1;
        byDifficulty["d" + (q.difficulty || 3)] = (byDifficulty["d" + (q.difficulty || 3)] || 0) + 1;
        if (q.quality && q.quality.status === "approved") approved++;
        if (q.review && q.review.reviewed === true) reviewed++;
        if (q.review && q.review.experience_checks && q.review.experience_checks.length > 0) uxApproved++;
        if (!q.media_url || (q.media_provenance && q.media_provenance.checked && q.media_alt)) mediaHealthy++;
        if (q.behavior_tags && q.behavior_tags.length > 0) behaviorTagged++;
        if (!q.country_codes || q.country_codes.length === 0) byCountry["global"] = (byCountry["global"] || 0) + 1;
        else for (var ci = 0; ci < q.country_codes.length; ci++) byCountry[q.country_codes[ci]] = (byCountry[q.country_codes[ci]] || 0) + 1;
      }
      pools.push({
        key: keys[i], mode: meta.mode, topic: meta.topic,
        size: pool.questions.length, quarantined: quarantined,
        approved: approved, reviewed: reviewed, semantic_approved: approved,
        ux_approved: uxApproved, media_healthy: mediaHealthy, behavior_tagged: behaviorTagged,
        production_minimum: SeedQ.MODE_PRODUCTION_MIN,
        ready_for_staging: approved - quarantined >= SeedQ.MODE_PRODUCTION_MIN,
        by_source: bySource, by_difficulty: byDifficulty, by_country: byCountry,
        updated_ms: pool.updated_ms || 0
      });
    }

    var state = SeedQ.readSystem(nk, SeedQ.COLL_INGEST_STATE, "state") || {};
    var modes = SeedQ.modeRegistry();
    var coverage: any[] = [];
    for (var mi = 0; mi < modes.length; mi++) {
      var directKey = SeedQ.poolKey(modes[mi].mode, modes[mi].default_topic);
      var directSize = 0, directApproved = 0, directUx = 0, directMedia = 0, directBehavior = 0, directCountries: any = {};
      for (var pi = 0; pi < pools.length; pi++) {
        if (pools[pi].key === directKey) {
          directSize = pools[pi].size; directApproved = pools[pi].approved;
          directUx = pools[pi].ux_approved; directMedia = pools[pi].media_healthy;
          directBehavior = pools[pi].behavior_tagged; directCountries = pools[pi].by_country;
          break;
        }
      }
      var usable = Math.min(directApproved, directUx, directMedia);
      var deficit = Math.max(0, SeedQ.MODE_PRODUCTION_MIN - usable);
      coverage.push({
        mode: modes[mi].mode, aliases: modes[mi].aliases, support: modes[mi].support, source: modes[mi].source,
        default_topic: modes[mi].default_topic, direct_size: directSize,
        semantic_approved: directApproved, ux_approved: directUx, media_healthy: directMedia,
        behavior_tagged: directBehavior, geo_counts: directCountries,
        production_minimum: SeedQ.MODE_PRODUCTION_MIN,
        fresh_sets_possible: Math.floor(usable / SeedQ.DEFAULT_SET_SIZE),
        ready_for_staging: deficit === 0, deficit: deficit,
        status: deficit === 0 ? "PASS" : (modes[mi].support === "fallback" ? "WARN" : "BLOCKED"),
        fallback_mode: modes[mi].fallback_mode, reason: modes[mi].reason
      });
    }
    return JSON.stringify({ ok: true, pools: pools, mode_coverage: coverage, ingest_state: { cursor: state.cursor || 0, runs: state.runs || 0, last_run_ms: state.last_run_ms || 0 }, module_version: SeedQ.MODULE_VERSION });
  }

  // ── quizverse_seedq_asset_job (admin/service) ───────────────────────────────
  // Request: { service_token?, kind: "removebg"|"aso_mockups"|"art_cleanup", params? }
  function rpcAssetJob(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = parse(payload);
    if (!isAdminOrService(ctx, data)) return errPayload(7, "admin or service_token required");
    var res = SeedQSources.buildAssetJob(ctx, "" + (data.kind || ""), data.params || {});
    return JSON.stringify(res);
  }

  // ── quizverse_seedq_provenance (admin/service) ──────────────────────────────
  // Request: { service_token?, image_url }
  function rpcProvenance(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
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
    initializer.registerRpc("quizverse_seedq_get_staged", rpcGetStaged);
    initializer.registerRpc("quizverse_seedq_consume_set", rpcConsumeSet);
    initializer.registerRpc("quizverse_seedq_review", rpcReview);
    initializer.registerRpc("quizverse_seedq_focus_tracks", rpcFocusTracks);
    initializer.registerRpc("quizverse_seedq_sources", rpcSources);
    initializer.registerRpc("quizverse_seedq_ingest", rpcIngest);
    initializer.registerRpc("quizverse_seedq_ingest_tick", rpcIngestTick);
    initializer.registerRpc("quizverse_seedq_pool_stats", rpcPoolStats);
    initializer.registerRpc("quizverse_seedq_asset_job", rpcAssetJob);
    initializer.registerRpc("quizverse_seedq_provenance", rpcProvenance);
  }

  // Explicit per-VM stub population. postbuild rewrites the registerRpc calls
  // above into __rpc_* assignments before this bundle is loaded, so the
  // argument is never dereferenced. This avoids pooled Goja VMs inheriting
  // undefined handlers if autoInvokeRegister misses this large namespace.
  register(null as any);
}
