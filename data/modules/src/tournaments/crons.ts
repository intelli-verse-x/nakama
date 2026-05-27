// =============================================================================
// crons.ts — Tournament background jobs
//
// Plan ref: §1G pre-gen + §2 settlement + §1H eliminate cron
//
// Crons are tick-based (Nakama has no native cron; we use a single-shot
// "scheduler tick" RPC that ops invokes via http_key, OR auto-invoke from
// the existing AnalyticsAlerts opportunistic scheduler).
//
// Jobs:
//   open_pending     — flips PRE_ENROLL → OPEN when public_open_time hits
//   eliminate_round  — runs at each elimination cut time per cfg schedule
//   settle_finished  — runs after cfg.end_iso elapsed → calls settle()
//   pregenerate_content — slow drip of CF pack generation during pre-enrollment
//   referral_settle  — one-shot on Jul 1 to freeze referral leaderboard prizes
// =============================================================================

namespace TournamentCrons {

  function nowSec(): number { return Math.floor(Date.now() / 1000); }
  function isoToUnix(iso: string): number { return Math.floor(new Date(iso).getTime() / 1000); }

  // Single-tick driver: walks every slate config, advances any whose schedule
  // has elapsed.
  export function tick(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama): any {
    var slate = TournamentEconomy.listAll();
    var now = nowSec();
    var actions: any[] = [];

    for (var i = 0; i < slate.length; i++) {
      var cfg = slate[i];
      var meta = TournamentsStorage.readMeta(nk, cfg.slug);
      if (!meta) {
        meta = TournamentsStorage.seedFromConfig(nk, cfg);
        actions.push({ slug: cfg.slug, action: "seeded" });
        continue;
      }

      // PRE_ENROLL → OPEN transition
      if (meta.status === "PRE_ENROLL" && now >= isoToUnix(cfg.open_start_iso)) {
        meta.status = "OPEN";
        TournamentsStorage.writeMeta(nk, cfg.slug, meta);
        TournamentLeaderboard.ensureLeaderboard(nk, cfg.slug, null, 0);
        // Pre-create Bracket shell for top-64 playoff (plan §3 update)
        try {
          var br = BracketClient.createBracketShell(ctx, nk, cfg.slug, cfg.name, 64);
          if (br.ok && br.bracket_id) {
            (meta as any).bracket_id = br.bracket_id;
            TournamentsStorage.writeMeta(nk, cfg.slug, meta);
          }
        } catch (_) { }
        actions.push({ slug: cfg.slug, action: "opened" });
        continue;
      }

      // OPEN → ACTIVE (cosmetic transition once first entry lands; here we
      // just leave OPEN — we don't differentiate today). Skipped.

      // Eliminate-round trigger
      if (cfg.format === "elimination" && cfg.elimination_schedule && meta.status === "OPEN") {
        var cuts = cfg.elimination_schedule.cut_times_utc || [];
        for (var c = 0; c < cuts.length; c++) {
          var cutAt = isoToUnix(cuts[c]);
          if (now < cutAt) continue;
          // Idempotency: skip if we've already processed this round
          var roundKey = "elim_round_done_" + cfg.slug + "_" + c;
          var existing = nk.storageRead([{ collection: TournamentsStorage.COL_ELIMINATIONS, key: roundKey, userId: Constants.SYSTEM_USER_ID }]);
          if (existing && existing.length > 0) continue;
          var elim = TournamentSettlement.eliminateRound(ctx, logger, nk, cfg.slug, c + 1);
          nk.storageWrite([{
            collection: TournamentsStorage.COL_ELIMINATIONS,
            key: roundKey,
            userId: Constants.SYSTEM_USER_ID,
            value: { slug: cfg.slug, round: c + 1, ran_at: now, result: elim },
            permissionRead: 0,
            permissionWrite: 0,
          }]);
          actions.push({ slug: cfg.slug, action: "eliminated_round", round: c + 1, result: elim });
        }
      }

      // End → SETTLING → SETTLED transition
      if ((meta.status === "OPEN" || meta.status === "ACTIVE") && now >= isoToUnix(cfg.end_iso)) {
        var res = TournamentSettlement.settle(ctx, logger, nk, cfg.slug);
        actions.push({ slug: cfg.slug, action: "settled", result: res });
        continue;
      }
    }

    return { ok: true, actions: actions, ran_at: now };
  }

  // Pre-generation drip job. Walks (slug × language × weekNum) combinations
  // and enqueues CF pack generation for the first N missing entries.
  // Called by ops on a slow timer (every 30s = 1 pack/30s); fits 1248-pack
  // budget into the 35-day pre-enrollment window comfortably.
  export function pregenerateTick(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, maxJobs: number): any {
    var slate = TournamentEconomy.listAll();
    var langs = ["en", "es", "hi", "pt", "fr", "de", "ja", "ko", "zh", "ar", "ru", "id"];
    var weeksAhead = 4;
    var enqueued: any[] = [];

    for (var i = 0; i < slate.length && enqueued.length < maxJobs; i++) {
      var cfg = slate[i];
      var topic = TournamentTopicCatalog.getEntry(cfg.topic_tag);
      if (!topic) continue;
      var allowedLangs = topic.languages_supported || ["en"];

      for (var w = 0; w < weeksAhead && enqueued.length < maxJobs; w++) {
        for (var l = 0; l < allowedLangs.length && enqueued.length < maxJobs; l++) {
          var lang = allowedLangs[l];
          if (langs.indexOf(lang) < 0) continue;
          // Skip if catalog already has this entry
          var existing = ContentFactoryClient.readPackCatalog(nk, cfg.slug, lang, w);
          if (existing) continue;
          var rotated = TournamentTopicCatalog.getRotatedTag(cfg.topic_tag, w);
          var rt = TournamentTopicCatalog.getEntry(rotated) || topic;
          var enq = ContentFactoryClient.enqueuePackGeneration(ctx, nk, {
            concept: rt.concept,
            exam_board: rt.exam_board,
            language: lang,
            num_cards: 30,
            tags: [cfg.slug, rotated, "w" + w, lang],
          });
          enqueued.push({ slug: cfg.slug, language: lang, week_num: w, ok: enq.ok, task_id: enq.task_id || null });
        }
      }
    }
    logger.info("[TournamentCron:pregen] enqueued " + enqueued.length + " CF jobs");
    return { ok: true, enqueued: enqueued, ran_at: nowSec() };
  }

  // ── RPC: tournament_cron_tick (service-only) ───────────────────────────────
  function rpcTick(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = RpcHelpers.parseRpcPayload(payload);
    var expected = "" + ((ctx.env && ctx.env["TOURNAMENT_SERVICE_TOKEN"]) || (ctx.env && ctx.env["BRAIN_COINS_SERVICE_TOKEN"]) || "");
    if (!data.service_token || data.service_token !== expected) return RpcHelpers.errorResponse("service-only", 401);
    var res = tick(ctx, logger, nk);
    return RpcHelpers.successResponse(res);
  }

  // ── RPC: tournament_cron_pregen (service-only) ─────────────────────────────
  function rpcPregenTick(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = RpcHelpers.parseRpcPayload(payload);
    var expected = "" + ((ctx.env && ctx.env["TOURNAMENT_SERVICE_TOKEN"]) || (ctx.env && ctx.env["BRAIN_COINS_SERVICE_TOKEN"]) || "");
    if (!data.service_token || data.service_token !== expected) return RpcHelpers.errorResponse("service-only", 401);
    var max = parseInt("" + (data.max_jobs || 1), 10);
    var res = pregenerateTick(ctx, logger, nk, max);
    return RpcHelpers.successResponse(res);
  }

  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("tournament_cron_tick", rpcTick);
    initializer.registerRpc("tournament_cron_pregen", rpcPregenTick);
  }
}
