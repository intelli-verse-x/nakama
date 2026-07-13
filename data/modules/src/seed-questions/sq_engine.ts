// sq_engine.ts
// ─────────────────────────────────────────────────────────────────────────────
// Seed Questions — pool management + per-user staging engine.
//
// Pool:    ingestIntoPool() QA-gates connector output and merges it (by stable
//          content-hash id) into the system pool for (mode, topic).
//
// Staging: ensureStaged() guarantees a user always has TARGET_READY_SETS
//          (2–3) ready sets for (mode, topic):
//            unseen-only  → excludes qv_seen ledger ids + already-staged ids
//            quality-only → excludes quarantined ids (user-review ledger)
//            adaptive     → 60% at the user's target difficulty, 20% one
//                           easier, 20% one harder (from quiz history)
//            recycle      → when the unseen pool runs dry, oldest-seen
//                           questions are recycled (flagged) instead of
//                           starving the client — mirrors quizverse_quiz_generate.

namespace SeedQEngine {

  // ── Pool ────────────────────────────────────────────────────────────────────
  export function readPool(nk: nkruntime.Nakama, mode: string, topic: string): any {
    return SeedQ.readSystem(nk, SeedQ.COLL_POOL, SeedQ.poolKey(mode, topic)) || { questions: [], updated_ms: 0 };
  }

  function indexPoolKey(nk: nkruntime.Nakama, mode: string, topic: string): void {
    var idx = SeedQ.readSystem(nk, SeedQ.COLL_POOL_INDEX, "index") || { keys: {} };
    if (!idx.keys) idx.keys = {};
    var key = SeedQ.poolKey(mode, topic);
    if (!idx.keys[key]) {
      idx.keys[key] = { mode: mode, topic: topic, added_ms: SeedQ.nowMs() };
      SeedQ.writeSystem(nk, SeedQ.COLL_POOL_INDEX, "index", idx);
    }
  }

  export function ingestIntoPool(
    ctx: nkruntime.Context,
    nk: nkruntime.Nakama,
    logger: nkruntime.Logger,
    mode: string,
    topic: string,
    candidates: SeedQ.SeedQuestion[]
  ): { accepted: number; rejected: number; duplicates: number; pool_size: number } {
    var pool = readPool(nk, mode, topic);
    var existing: { [id: string]: boolean } = {};
    for (var i = 0; i < pool.questions.length; i++) existing[pool.questions[i].id] = true;

    var accepted = 0, rejected = 0, duplicates = 0;
    for (var c = 0; c < candidates.length; c++) {
      var q = candidates[c];
      if (!q || !q.id) { rejected++; continue; }
      if (existing[q.id]) { duplicates++; continue; }

      // Provenance for media questions that arrived unchecked.
      if (q.media_url && (!q.media_provenance || !q.media_provenance.checked)) {
        q.media_provenance = SeedQQuality.checkProvenance(ctx, nk, logger, q.media_url);
      }

      if (!SeedQQuality.ensureReviewed(q)) { rejected++; continue; }

      existing[q.id] = true;
      pool.questions.push(q);
      accepted++;
    }

    // Rolling cap: keep the newest POOL_MAX_QUESTIONS.
    if (pool.questions.length > SeedQ.POOL_MAX_QUESTIONS) {
      pool.questions = pool.questions.slice(pool.questions.length - SeedQ.POOL_MAX_QUESTIONS);
    }
    pool.updated_ms = SeedQ.nowMs();
    SeedQ.writeSystem(nk, SeedQ.COLL_POOL, SeedQ.poolKey(mode, topic), pool);
    indexPoolKey(nk, mode, topic);

    return { accepted: accepted, rejected: rejected, duplicates: duplicates, pool_size: pool.questions.length };
  }

  // ── Adaptive selection ──────────────────────────────────────────────────────
  // Buckets candidates by |difficulty - target| and drains them in the
  // 60/20/20 mix so the set is challenging-but-winnable for THIS user.
  function selectAdaptive(candidates: SeedQ.SeedQuestion[], target: number, n: number): SeedQ.SeedQuestion[] {
    var atTarget: SeedQ.SeedQuestion[] = [];
    var easier: SeedQ.SeedQuestion[] = [];
    var harder: SeedQ.SeedQuestion[] = [];
    var rest: SeedQ.SeedQuestion[] = [];

    for (var i = 0; i < candidates.length; i++) {
      var d = candidates[i].difficulty || 3;
      if (d === target) atTarget.push(candidates[i]);
      else if (d === target - 1) easier.push(candidates[i]);
      else if (d === target + 1) harder.push(candidates[i]);
      else rest.push(candidates[i]);
    }
    SeedQ.shuffle(atTarget); SeedQ.shuffle(easier); SeedQ.shuffle(harder); SeedQ.shuffle(rest);

    var wantTarget = Math.ceil(n * 0.6);
    var wantEasier = Math.ceil(n * 0.2);
    var out: SeedQ.SeedQuestion[] = [];
    out = out.concat(atTarget.slice(0, wantTarget));
    out = out.concat(easier.slice(0, wantEasier));
    out = out.concat(harder.slice(0, n - out.length));
    // Backfill from whatever remains, nearest first.
    if (out.length < n) out = out.concat(atTarget.slice(wantTarget));
    if (out.length < n) out = out.concat(easier.slice(wantEasier));
    if (out.length < n) out = out.concat(rest);
    out = out.slice(0, n);
    return SeedQ.shuffle(out);
  }

  function isGlobalQuestion(q: SeedQ.SeedQuestion): boolean {
    return !q.country_codes || q.country_codes.length === 0;
  }

  function questionMatchesCountry(q: SeedQ.SeedQuestion, country: string): boolean {
    if (!country || !q.country_codes) return false;
    for (var i = 0; i < q.country_codes.length; i++) {
      if (SeedQ.validCountry(q.country_codes[i]) === country) return true;
    }
    return false;
  }

  // Blend country-relevant content with global curriculum before applying the
  // existing adaptive difficulty selector. Other-country-only content is not
  // used as a fallback; global content is always safe.
  function behaviorMatch(q: SeedQ.SeedQuestion, behavior: SeedQ.BehaviorProfile): boolean {
    if (!behavior || behavior.basis !== "quiz_history") return false;
    var tags = (q.behavior_tags || []).slice(0);
    tags.push(SeedQ.slugify(q.topic || q.category || ""));
    for (var i = 0; i < tags.length; i++) {
      var tag = SeedQ.slugify(tags[i]);
      if (behavior.weakest_topics.indexOf(tag) >= 0 || behavior.recent_miss_topics.indexOf(tag) >= 0) return true;
    }
    return false;
  }

  function selectBehaviorAdaptive(candidates: SeedQ.SeedQuestion[], target: number, n: number, behavior: SeedQ.BehaviorProfile): SeedQ.SeedQuestion[] {
    var matched: SeedQ.SeedQuestion[] = [], rest: SeedQ.SeedQuestion[] = [];
    for (var i = 0; i < candidates.length; i++) {
      (behaviorMatch(candidates[i], behavior) ? matched : rest).push(candidates[i]);
    }
    var out = selectAdaptive(matched, target, Math.ceil(n * 0.3));
    out = out.concat(selectAdaptive(rest, target, n - out.length));
    if (out.length < n) out = out.concat(selectAdaptive(matched.slice(out.length), target, n - out.length));
    return out.slice(0, n);
  }

  function selectGeoAdaptive(candidates: SeedQ.SeedQuestion[], target: number, n: number, country: string, behavior: SeedQ.BehaviorProfile): SeedQ.SeedQuestion[] {
    if (!country) return selectBehaviorAdaptive(candidates, target, n, behavior);
    var relevant: SeedQ.SeedQuestion[] = [];
    var global: SeedQ.SeedQuestion[] = [];
    for (var i = 0; i < candidates.length; i++) {
      if (questionMatchesCountry(candidates[i], country)) relevant.push(candidates[i]);
      else if (isGlobalQuestion(candidates[i])) global.push(candidates[i]);
    }
    var wantRelevant = Math.round(n * SeedQ.GEO_RELEVANT_PERCENT / 100);
    var out = selectBehaviorAdaptive(relevant, target, wantRelevant, behavior);
    out = out.concat(selectBehaviorAdaptive(global, target, n - out.length, behavior));
    if (out.length < n) {
      var selected: { [id: string]: boolean } = {};
      for (var s = 0; s < out.length; s++) selected[out[s].id] = true;
      var remaining: SeedQ.SeedQuestion[] = [];
      var allowed = relevant.concat(global);
      for (var a = 0; a < allowed.length; a++) if (!selected[allowed[a].id]) remaining.push(allowed[a]);
      out = out.concat(selectBehaviorAdaptive(remaining, target, n - out.length, behavior));
    }
    return SeedQ.shuffle(out.slice(0, n));
  }

  // ── Staging ─────────────────────────────────────────────────────────────────
  // Low-watermark for Dynamic Replenishment (Deliverable 1 §3.1): when a user's
  // unseen pool drops below this, we queue a priority ingest combo so the next
  // cron tick replenishes THIS (mode, topic) first.
  var LOW_WATERMARK = 20;
  var NEXT_REFRESH_ETA_SEC = 900; // seedq ingest cron cadence (15 min)

  export interface StageResult {
    doc: any;
    ready: SeedQ.StagedSet[];
    built: number;
    pool_size: number;
    pool_available: number;
    recycled: boolean;
    pool_exhausted: boolean;
    content_generation_queued: boolean;
    next_refresh_eta_sec: number;
    fresh_count: number;
    review_count: number;
    adaptive: SeedQ.AdaptiveProfile;
    geo: any;
    source_route: any;
    behavior: SeedQ.BehaviorProfile;
  }

  function readRoutedPool(nk: nkruntime.Nakama, mode: string, topic: string): any {
    var def = SeedQ.resolveMode(mode);
    var canonical = def ? def.mode : mode;
    var candidates = [
      { mode: canonical, topic: topic, route: "direct" },
      { mode: canonical, topic: def ? def.default_topic : topic, route: "mode_default" }
    ];
    if (def && def.fallback_mode) {
      var fallbackDef = SeedQ.resolveMode(def.fallback_mode);
      candidates.push({
        mode: def.fallback_mode,
        topic: fallbackDef ? fallbackDef.default_topic : topic,
        route: "mode_fallback"
      });
    }
    candidates.push({ mode: "CustomTopic", topic: "math", route: "global_fallback" });
    var seenKeys: { [k: string]: boolean } = {};
    var partial: any = null;
    for (var i = 0; i < candidates.length; i++) {
      var key = SeedQ.poolKey(candidates[i].mode, candidates[i].topic);
      if (seenKeys[key]) continue;
      seenKeys[key] = true;
      var pool = readPool(nk, candidates[i].mode, candidates[i].topic);
      if (pool.questions && pool.questions.length >= SeedQ.MIN_READY_SETS * 4) {
        return { pool: pool, route: candidates[i], requested_mode: mode, canonical_mode: canonical };
      }
      if (!partial && pool.questions && pool.questions.length > 0) partial = { pool: pool, route: candidates[i] };
    }
    if (partial) return { pool: partial.pool, route: partial.route, requested_mode: mode, canonical_mode: canonical };
    return {
      pool: { questions: [], updated_ms: 0 },
      route: { mode: canonical, topic: topic, route: "empty" },
      requested_mode: mode,
      canonical_mode: canonical
    };
  }

  // Queues a (mode, topic) combo at the FRONT of the ingest rotation. The next
  // ingestTick drains priority entries before resuming the round-robin cursor —
  // this is the Nakama-side equivalent of the `topic_exhaustion_warning` →
  // ContentX flow from the Repetition Fatigue plan.
  export function queuePriorityCombo(nk: nkruntime.Nakama, logger: nkruntime.Logger, mode: string, topic: string): void {
    try {
      var state = SeedQ.readSystem(nk, SeedQ.COLL_INGEST_STATE, "state") || { cursor: 0, runs: 0, last_run_ms: 0, combos: null };
      if (!state.priority) state.priority = [];
      for (var i = 0; i < state.priority.length; i++) {
        if (state.priority[i].mode === mode && state.priority[i].topic === topic) return; // already queued
      }
      // Pick the best-matching source from the combo matrix (same mode wins,
      // then same topic); archive_org is the broadest fallback connector.
      var combos = (state.combos && state.combos.length > 0) ? state.combos : defaultCombos();
      var source = "archive_org";
      for (var c = 0; c < combos.length; c++) {
        if (combos[c].mode === mode) { source = combos[c].source; break; }
        if (SeedQ.slugify(combos[c].topic) === SeedQ.slugify(topic)) source = combos[c].source;
      }
      state.priority.push({ source: source, mode: mode, topic: topic, queued_ms: SeedQ.nowMs() });
      if (state.priority.length > 20) state.priority = state.priority.slice(state.priority.length - 20);
      SeedQ.writeSystem(nk, SeedQ.COLL_INGEST_STATE, "state", state);
      logger.info("[SeedQ] priority replenishment queued: " + source + " → " + mode + "/" + topic);
    } catch (e: any) {
      logger.warn("[SeedQ] queuePriorityCombo failed: " + (e && e.message ? e.message : String(e)));
    }
  }

  export function ensureStaged(
    ctx: nkruntime.Context,
    nk: nkruntime.Nakama,
    logger: nkruntime.Logger,
    userId: string,
    mode: string,
    topic: string,
    wantSets: number,
    setSize: number,
    geo: SeedQ.GeoProfile
  ): StageResult {
    var key = SeedQ.stagedKey(mode, topic, geo.country);
    var routed = readRoutedPool(nk, mode, topic);
    var quarantined = SeedQQuality.getQuarantineSet(nk, routed.route.mode, routed.route.topic);
    var doc = SeedQ.readUser(nk, SeedQ.COLL_STAGED, key, userId) || { sets: [], updated_ms: 0 };
    if (!doc.sets) doc.sets = [];

    // Drop expired ready sets and consumed sets past their TTL so stale cache
    // payloads are replaced on the next sync and the storage doc never balloons.
    var now = SeedQ.nowMs();
    var originalSetCount = doc.sets.length;
    var metadataDirty = false;
    var kept: SeedQ.StagedSet[] = [];
    for (var i = 0; i < doc.sets.length; i++) {
      var s = doc.sets[i];
      if (s.status === "consumed" && (now - (s.consumed_ms || 0)) > SeedQ.CONSUMED_SET_TTL_MS) continue;
      // Backfill cache metadata for sets created by v1.0.0.
      if (!s.schema_version) { s.schema_version = SeedQ.CACHE_SCHEMA_VERSION; metadataDirty = true; }
      if (!s.expires_ms) { s.expires_ms = (s.created_ms || now) + SeedQ.READY_SET_TTL_MS; metadataDirty = true; }
      if (!s.generated_at) { s.generated_at = SeedQ.isoTime(s.created_ms || now); metadataDirty = true; }
      if (!s.expires_at) { s.expires_at = SeedQ.isoTime(s.expires_ms); metadataDirty = true; }
      if (s.status === "ready" && s.expires_ms <= now) continue;
      kept.push(s);
    }
    doc.sets = kept;

    // Exclude only questions sitting in READY sets. Consumed questions live in
    // the qv_seen ledger already — they must stay eligible for the recycle path
    // (D1: "recycle oldest-seen rather than starve"), otherwise an exhausted
    // user gets zero sets until the consumed-set TTL expires.
    var ready: SeedQ.StagedSet[] = [];
    var stagedIds: { [id: string]: boolean } = {};
    for (var r = 0; r < doc.sets.length; r++) {
      var st = doc.sets[r];
      if (st.status !== "ready") continue;
      var setApproved = true;
      for (var gq = 0; gq < st.questions.length; gq++) {
        var existingQ = st.questions[gq];
        if (quarantined[existingQ.id] || !SeedQQuality.ensureReviewed(existingQ, mode) ||
            (!isGlobalQuestion(existingQ) && !questionMatchesCountry(existingQ, geo.country))) {
          setApproved = false;
          break;
        }
      }
      if (!setApproved || st.questions.length !== st.question_ids.length) {
        st.status = "invalidated";
        metadataDirty = true;
        continue;
      }
      for (var qi = 0; qi < st.question_ids.length; qi++) stagedIds[st.question_ids[qi]] = true;
      ready.push(st);
    }

    var adaptive = SeedQ.computeAdaptiveProfile(nk, userId, topic);
    var behavior = SeedQ.computeBehaviorProfile(nk, userId);
    var pool = routed.pool;
    var built = 0;
    var recycled = false;
    var poolAvailable = 0;
    var seenIds = SeedQ.getSeenIdSet(nk, userId, mode, topic);
    var reviewBackfilled = false;

    // Always compute the per-user unseen supply — repeat_policy metadata (D1
    // §6.2) needs it even when no new sets are built this call.
    var unseen: SeedQ.SeedQuestion[] = [];
    var seenPool: SeedQ.SeedQuestion[] = [];
    for (var p = 0; p < pool.questions.length; p++) {
      var q = pool.questions[p];
      if (!q || quarantined[q.id] || stagedIds[q.id]) continue;
      var hadReview = !!(q.review && q.review.reviewed);
      if (!SeedQQuality.ensureReviewed(q, mode)) continue;
      if (!hadReview) reviewBackfilled = true;
      // Country-specific questions for another country are never served.
      if (!isGlobalQuestion(q) && !questionMatchesCountry(q, geo.country)) continue;
      if (seenIds[q.id]) seenPool.push(q);
      else unseen.push(q);
    }
    poolAvailable = unseen.length;
    // qv_seen stores first/last-seen timestamps; oldest items are the least
    // surprising Smart Review fallback when fresh supply is exhausted.
    seenPool.sort(function (a: SeedQ.SeedQuestion, b: SeedQ.SeedQuestion): number {
      return Number(seenIds[a.id] || 0) - Number(seenIds[b.id] || 0);
    });

    if (ready.length < wantSets && pool.questions.length > 0) {
      while (ready.length < wantSets) {
        var candidates = unseen;
        if (candidates.length < Math.min(setSize, 4) && seenPool.length > 0) {
          // Fewer than the minimum playable fresh questions remain: include
          // disclosed Smart Review items rather than starve. If 4+ fresh
          // questions remain, serve a short all-fresh set before any repeat.
          candidates = unseen.concat(seenPool);
          recycled = true;
        }
        if (candidates.length < Math.min(setSize, 4)) break; // not enough content, even recycled

        var chosen = selectGeoAdaptive(candidates, adaptive.target_difficulty, setSize, geo.country, behavior);
        if (chosen.length === 0) break;

        // Remove chosen from future candidate lists.
        var chosenIds: { [id: string]: boolean } = {};
        var ids: string[] = [];
        var served: SeedQ.SeedQuestion[] = [];
        var setFresh = 0, setReview = 0;
        for (var ci = 0; ci < chosen.length; ci++) {
          chosenIds[chosen[ci].id] = true;
          ids.push(chosen[ci].id);
          // Serve a copy with the media URL optimized (squoosh-equivalent).
          var copy = JSON.parse(JSON.stringify(chosen[ci]));
          copy.media_url = SeedQ.optimizeMediaUrl(copy.media_url);
          if (!copy.review || copy.review.reviewed !== true || copy.quality.status !== "approved") continue;
          copy.selection_reasons = ["quality_approved", "ux_approved", "no_repeat",
            seenIds[copy.id] ? "smart_review" : "fresh",
            questionMatchesCountry(copy, geo.country) ? "geo_relevant" : "global_curriculum",
            behaviorMatch(copy, behavior) ? "behavior_weakness_or_recent_miss" : "adaptive_difficulty"];
          // Honest-repeat disclosure (D1 §6.2): mark recycled questions so the
          // client renders "N new + M Smart Review repeats", never a silent repeat.
          if (seenIds[copy.id]) { copy.recycled = true; setReview++; }
          else setFresh++;
          served.push(copy);
        }
        var nextUnseen: SeedQ.SeedQuestion[] = [];
        for (var ui = 0; ui < unseen.length; ui++) if (!chosenIds[unseen[ui].id]) nextUnseen.push(unseen[ui]);
        unseen = nextUnseen;
        var nextSeenPool: SeedQ.SeedQuestion[] = [];
        for (var si = 0; si < seenPool.length; si++) if (!chosenIds[seenPool[si].id]) nextSeenPool.push(seenPool[si]);
        seenPool = nextSeenPool;

        var newSet: SeedQ.StagedSet = {
          schema_version: SeedQ.CACHE_SCHEMA_VERSION,
          set_id: "set_" + now.toString(36) + "_" + SeedQ.randSuffix(),
          mode: mode,
          topic: topic,
          status: "ready",
          difficulty_target: adaptive.target_difficulty,
          question_ids: ids,
          questions: served,
          fresh_count: setFresh,
          review_count: setReview,
          created_ms: now,
          expires_ms: now + SeedQ.READY_SET_TTL_MS,
          generated_at: SeedQ.isoTime(now),
          expires_at: SeedQ.isoTime(now + SeedQ.READY_SET_TTL_MS),
          consumed_ms: 0
          ,country_code: geo.country || ""
        };
        // A serve-time gate may remove a malformed copy. Keep IDs exactly in
        // sync with the self-contained payload and never stage an empty set.
        ids = [];
        for (var ri = 0; ri < served.length; ri++) ids.push(served[ri].id);
        newSet.question_ids = ids;
        if (served.length < Math.min(setSize, 4)) break;
        doc.sets.push(newSet);
        ready.push(newSet);
        for (var ni = 0; ni < ids.length; ni++) stagedIds[ids[ni]] = true;
        built++;
      }
    }
    if (reviewBackfilled) {
      pool.updated_ms = SeedQ.nowMs();
      SeedQ.writeSystem(nk, SeedQ.COLL_POOL, SeedQ.poolKey(routed.route.mode, routed.route.topic), pool);
    }
    // Report unseen supply remaining after this call's newly staged sets.
    poolAvailable = unseen.length;

    if (built > 0 || originalSetCount !== doc.sets.length || metadataDirty) {
      doc.updated_ms = now;
      SeedQ.writeUser(nk, SeedQ.COLL_STAGED, key, userId, doc);
    }

    // Aggregate honest-repeat counts over the ready sets (repeat_policy §6.2).
    var freshTotal = 0, reviewTotal = 0;
    for (var rc2 = 0; rc2 < ready.length; rc2++) {
      var rs: any = ready[rc2];
      if (rs.fresh_count !== undefined) { freshTotal += rs.fresh_count; reviewTotal += rs.review_count || 0; }
      else freshTotal += rs.question_ids.length; // pre-metadata sets: assume fresh
    }

    // Deliverable 1 — Dynamic Replenishment + the "Wow" Intercept.
    // Exhausted for this user = the pool has content but nothing unseen is
    // left (we're recycling or couldn't build at all).
    var exhausted = pool.questions.length > 0 && poolAvailable === 0 && (recycled || ready.length === 0);
    var generationQueued = false;
    if (poolAvailable < LOW_WATERMARK) {
      queuePriorityCombo(nk, logger, mode, topic);
      generationQueued = true;
    }
    if (exhausted) {
      // "You beat the game" — queue the wow.e.pool_exhausted Aahaa moment and
      // suppress the App Store rating prompt (never ask while exhausted).
      AahaaEngine.notePoolExhausted(nk, logger, userId, mode, topic);
    }

    return {
      doc: doc,
      ready: ready,
      built: built,
      pool_size: pool.questions.length,
      pool_available: poolAvailable,
      recycled: recycled,
      pool_exhausted: exhausted,
      content_generation_queued: generationQueued,
      next_refresh_eta_sec: generationQueued ? NEXT_REFRESH_ETA_SEC : 0,
      fresh_count: freshTotal,
      review_count: reviewTotal,
      adaptive: adaptive,
      geo: {
        country: geo.country || "GLOBAL",
        basis: geo.basis,
        locale: geo.locale || "",
        relevance_target_pct: SeedQ.GEO_RELEVANT_PERCENT,
        relevant_count: countGeoQuestions(ready, geo.country, true),
        global_count: countGeoQuestions(ready, geo.country, false),
        fallback_reason: geo.country ?
          (countGeoQuestions(ready, geo.country, true) > 0 ? "" : "no_geo_tagged_content_global_used") :
          "no_valid_country_global_used"
      },
      source_route: routed.route,
      behavior: behavior
    };
  }

  function countGeoQuestions(sets: SeedQ.StagedSet[], country: string, relevant: boolean): number {
    var count = 0;
    for (var i = 0; i < sets.length; i++) {
      for (var q = 0; q < sets[i].questions.length; q++) {
        if (relevant ? questionMatchesCountry(sets[i].questions[q], country) : isGlobalQuestion(sets[i].questions[q])) count++;
      }
    }
    return count;
  }

  // Marks a set consumed and merges its ids into the qv_seen ledger — this is
  // what enforces "never the same question for the same user-id" across ALL
  // QuizVerse delivery paths that share the seedq scope.
  export function consumeSet(
    ctx: nkruntime.Context,
    nk: nkruntime.Nakama,
    logger: nkruntime.Logger,
    userId: string,
    mode: string,
    topic: string,
    setId: string,
    country: string
  ): { found: boolean; merged: number; set_size: number } {
    var key = SeedQ.stagedKey(mode, topic, country);
    var doc = SeedQ.readUser(nk, SeedQ.COLL_STAGED, key, userId);
    // Backward compatibility for v1 cache documents.
    if (!doc) {
      key = SeedQ.poolKey(mode, topic);
      doc = SeedQ.readUser(nk, SeedQ.COLL_STAGED, key, userId);
    }
    if (!doc || !doc.sets) return { found: false, merged: 0, set_size: 0 };

    for (var i = 0; i < doc.sets.length; i++) {
      var s = doc.sets[i];
      if (s.set_id !== setId) continue;
      if (s.status === "consumed") return { found: true, merged: 0, set_size: s.question_ids.length };
      s.status = "consumed";
      s.consumed_ms = SeedQ.nowMs();
      // Consumed sets keep ids (dedup) but drop full question bodies (size).
      s.questions = [];
      doc.updated_ms = SeedQ.nowMs();
      SeedQ.writeUser(nk, SeedQ.COLL_STAGED, key, userId, doc);
      SeedQ.mergeSeenIds(nk, userId, mode, topic, s.question_ids);
      return { found: true, merged: s.question_ids.length, set_size: s.question_ids.length };
    }
    return { found: false, merged: 0, set_size: 0 };
  }

  // ── Cron ingest rotation ────────────────────────────────────────────────────
  // Default matrix of (source, mode, topic) combos the tick rotates through.
  // Live-ops can extend it by writing sq_ingest_state.combos.
  export function defaultCombos(): any[] {
    var defs = SeedQ.modeRegistry();
    var out: any[] = [];
    for (var i = 0; i < defs.length; i++) {
      out.push({ source: defs[i].source, mode: defs[i].mode, topic: defs[i].default_topic });
    }
    // CustomTopic has multiple direct subject sources.
    out.push({ source: "gutenberg", mode: "CustomTopic", topic: "literature" });
    out.push({ source: "scholar", mode: "CustomTopic", topic: "science" });
    out.push({ source: "music_tv", mode: "MediaQuiz", topic: "music" });
    return out;
  }

  export function ingestTick(ctx: nkruntime.Context, nk: nkruntime.Nakama, logger: nkruntime.Logger, batchCombos: number, perComboCount: number): any {
    var state = SeedQ.readSystem(nk, SeedQ.COLL_INGEST_STATE, "state") || { cursor: 0, runs: 0, last_run_ms: 0, combos: null };
    var combos = (state.combos && state.combos.length > 0) ? state.combos : defaultCombos();

    var results: any[] = [];
    var rotationSlots = batchCombos;

    // Drain user-triggered priority replenishment (low-watermark / exhaustion)
    // BEFORE the round-robin rotation — exhausted pools refill first.
    if (state.priority && state.priority.length > 0) {
      var stillQueued: any[] = [];
      for (var pq = 0; pq < state.priority.length; pq++) {
        var pcombo = state.priority[pq];
        if (rotationSlots <= 0) { stillQueued.push(pcombo); continue; }
        rotationSlots--;
        try {
          var pFetched = SeedQSources.fetchQuestions(ctx, nk, logger, pcombo.source, pcombo.mode, pcombo.topic, perComboCount, pcombo.params || {});
          var pRes = ingestIntoPool(ctx, nk, logger, pcombo.mode, pcombo.topic, pFetched);
          results.push({ combo: pcombo, priority: true, fetched: pFetched.length, accepted: pRes.accepted, rejected: pRes.rejected, duplicates: pRes.duplicates, pool_size: pRes.pool_size });
        } catch (perr: any) {
          results.push({ combo: pcombo, priority: true, error: (perr && perr.message) ? perr.message : String(perr) });
        }
      }
      state.priority = stillQueued;
    }

    for (var b = 0; b < rotationSlots; b++) {
      var combo = combos[(state.cursor + b) % combos.length];
      try {
        var fetched = SeedQSources.fetchQuestions(ctx, nk, logger, combo.source, combo.mode, combo.topic, perComboCount, combo.params || {});
        var res = ingestIntoPool(ctx, nk, logger, combo.mode, combo.topic, fetched);
        results.push({ combo: combo, fetched: fetched.length, accepted: res.accepted, rejected: res.rejected, duplicates: res.duplicates, pool_size: res.pool_size });
      } catch (err: any) {
        results.push({ combo: combo, error: (err && err.message) ? err.message : String(err) });
      }
    }

    state.cursor = (state.cursor + rotationSlots) % combos.length;
    state.runs = (state.runs || 0) + 1;
    state.last_run_ms = SeedQ.nowMs();
    SeedQ.writeSystem(nk, SeedQ.COLL_INGEST_STATE, "state", state);

    return { cursor: state.cursor, runs: state.runs, combo_count: combos.length, results: results };
  }
}
