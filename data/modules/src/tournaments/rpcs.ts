// =============================================================================
// rpcs.ts — All 23 tournament RPCs per §1I signature catalog
//
// Plan ref: §1I End-to-End Wire Spec
//
// User-callable (must be authenticated; rate-limited):
//   tournament_list
//   tournament_get
//   tournament_pre_enroll
//   tournament_enter
//   tournament_submit_pack_result
//   tournament_submit_picks                 (pick_n format only)
//   tournament_status_get
//   tournament_leaderboard_top
//   tournament_leaderboard_around_me
//   tournament_leaderboard_friends
//   tournament_leaderboard_country
//   tournament_leaderboard_tier_league
//   tournament_leaderboard_activity_feed
//   tournament_claim_cert
//   tournament_content_get_pack
//   tournament_video_get_url
//   tournament_learning_check_submit
//   tournament_referral_get_mine
//
// Service-callable (require service_token):
//   tournament_admin_create
//   tournament_content_request_generation
//   tournament_settle                       (manual trigger; cron calls same impl)
//   tournament_eliminate_round              (manual trigger; cron calls same impl)
//   tournament_referral_settle_topN         (manual trigger)
// =============================================================================

namespace TournamentRpcs {

  function nowSec(): number { return Math.floor(Date.now() / 1000); }
  function isoToUnix(iso: string): number { return Math.floor(new Date(iso).getTime() / 1000); }

  function isServiceCaller(ctx: nkruntime.Context, payload: any): boolean {
    var token = payload && payload.service_token;
    if (!token) return false;
    var expected = "" + ((ctx.env && ctx.env["TOURNAMENT_SERVICE_TOKEN"]) || (ctx.env && ctx.env["BRAIN_COINS_SERVICE_TOKEN"]) || "");
    return expected.length > 0 && token === expected;
  }

  function readUserCountry(nk: nkruntime.Nakama, userId: string): string {
    try {
      var acc = nk.accountsGetId([userId]);
      if (acc && acc.length > 0) {
        var md: any = acc[0].user.metadata;
        if (md && md.country) return "" + md.country;
      }
    } catch (_) { }
    return "";
  }

  function readUserState(nk: nkruntime.Nakama, userId: string): string {
    try {
      var acc = nk.accountsGetId([userId]);
      if (acc && acc.length > 0) {
        var md: any = acc[0].user.metadata;
        if (md && md.us_state) return "" + md.us_state;
      }
    } catch (_) { }
    return "";
  }

  function readUserDob(nk: nkruntime.Nakama, userId: string): { age: number; dob_iso: string } {
    try {
      var acc = nk.accountsGetId([userId]);
      if (acc && acc.length > 0) {
        var md: any = acc[0].user.metadata;
        if (md && md.dob_iso) {
          var dob = new Date(md.dob_iso);
          var now = new Date();
          var age = now.getFullYear() - dob.getFullYear();
          var m = now.getMonth() - dob.getMonth();
          if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
          return { age: age, dob_iso: md.dob_iso };
        }
      }
    } catch (_) { }
    return { age: 0, dob_iso: "" };
  }

  function readBcBalance(nk: nkruntime.Nakama, userId: string): { balance: number; lifetime_earned: number } {
    try {
      var rows = nk.storageRead([{ collection: "brain_coins", key: "wallet", userId: userId }]);
      if (rows && rows.length > 0) {
        var v = rows[0].value as any;
        return { balance: v.balance | 0, lifetime_earned: v.lifetime_earned | 0 };
      }
    } catch (_) { }
    return { balance: 0, lifetime_earned: 0 };
  }

  function debitBc(nk: nkruntime.Nakama, userId: string, amount: number, reason: string): boolean {
    try {
      var rows = nk.storageRead([{ collection: "brain_coins", key: "wallet", userId: userId }]);
      var wallet: any = (rows && rows.length > 0) ? rows[0].value : { balance: 0, lifetime_earned: 0, lifetime_redeemed: 0 };
      if ((wallet.balance | 0) < amount) return false;
      wallet.balance = (wallet.balance | 0) - amount;
      wallet.updated_at = nowSec();
      nk.storageWrite([{
        collection: "brain_coins",
        key: "wallet",
        userId: userId,
        value: wallet,
        permissionRead: 1,
        permissionWrite: 0,
      }]);
      nk.storageWrite([{
        collection: "brain_coins",
        key: "earn_log_debit_" + nowSec() + "_" + Math.random().toString(36).slice(2, 8),
        userId: userId,
        value: {
          code: "tournament_entry_debit",
          coins: -amount,
          unix_ts: nowSec(),
          date: new Date().toISOString().slice(0, 10),
          source: reason,
        },
        permissionRead: 1,
        permissionWrite: 0,
      }]);
      return true;
    } catch (_) {
      return false;
    }
  }

  // ── RPC: tournament_list ────────────────────────────────────────────────────
  // Public/anonymous-friendly. Returns all visible tournaments + caller-specific
  // enriched fields (entered? founder? bc_balance) when authenticated.
  function rpcList(ctx: nkruntime.Context, _logger: nkruntime.Logger, nk: nkruntime.Nakama, _payload: string): string {
    var slate = TournamentEconomy.listAll();
    var out: any[] = [];
    var userId = ctx.userId || "";
    var userCountry = userId ? readUserCountry(nk, userId) : "";
    var userState = userId ? readUserState(nk, userId) : "";

    for (var i = 0; i < slate.length; i++) {
      var cfg = slate[i];
      var meta = TournamentsStorage.readMeta(nk, cfg.slug);
      if (!meta) {
        // Seed if missing (idempotent — first-touch creates the row)
        meta = TournamentsStorage.seedFromConfig(nk, cfg);
      }
      var entry = userId ? TournamentsStorage.readEntry(nk, cfg.slug, userId) : null;
      var preEnroll = userId ? TournamentsStorage.readPreEnroll(nk, cfg.slug, userId) : null;
      var countryAllowed = TournamentEconomy.isCountryAllowed(cfg, userCountry);
      var stateBlocked = userCountry === "US" && userState && TournamentEconomy.isUsStateEntryBlocked(userState);

      out.push({
        slug: cfg.slug,
        name: cfg.name,
        description: cfg.description,
        format: cfg.format,
        format_ui_variant: cfg.format_ui_variant,
        topic_tag: cfg.topic_tag,
        status: meta.status,
        pot_bc: meta.pot_bc,
        entries_count: meta.entries_count,
        pre_enroll_count: meta.pre_enroll_count,
        entry_fee_bc: cfg.entry_fee_bc,
        rake_pct: cfg.rake_pct,
        pre_enroll_start_iso: cfg.pre_enroll_start_iso,
        open_start_iso: cfg.open_start_iso,
        end_iso: cfg.end_iso,
        badge_emoji: cfg.badge_emoji,
        caller: {
          authenticated: !!userId,
          country: userCountry || null,
          state: userState || null,
          eligible: countryAllowed && !stateBlocked,
          ineligibility_reason: !countryAllowed ? "country_not_allowed" : (stateBlocked ? "us_state_blocked" : null),
          entered: !!entry,
          pre_enrolled: !!preEnroll,
          founder_rank: preEnroll && preEnroll.founder_rank ? preEnroll.founder_rank : null,
        },
      });
    }
    return RpcHelpers.successResponse({ tournaments: out, served_at: nowSec() });
  }

  // ── RPC: tournament_get ────────────────────────────────────────────────────
  function rpcGet(ctx: nkruntime.Context, _logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = RpcHelpers.parseRpcPayload(payload);
    var slug = "" + (data.slug || "");
    if (!slug) return RpcHelpers.errorResponse("slug required", 400);
    var cfg = TournamentEconomy.getBySlug(slug);
    if (!cfg) return RpcHelpers.errorResponse("tournament not found", 404);
    var meta = TournamentsStorage.readMeta(nk, slug) || TournamentsStorage.seedFromConfig(nk, cfg);
    var userId = ctx.userId || "";
    var entry = userId ? TournamentsStorage.readEntry(nk, slug, userId) : null;
    var preEnroll = userId ? TournamentsStorage.readPreEnroll(nk, slug, userId) : null;
    return RpcHelpers.successResponse({
      config: cfg,
      meta: meta,
      caller_entry: entry,
      caller_pre_enroll: preEnroll,
      served_at: nowSec(),
    });
  }

  // ── RPC: tournament_pre_enroll ─────────────────────────────────────────────
  // Frees a Founder slot if available. No BC charged.
  function rpcPreEnroll(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var rl = SharedRateLimit.enforce(ctx, nk, "tournament_pre_enroll", { perUserPerMin: 20 });
    if (rl) return rl;
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload);
    var slug = "" + (data.slug || "");
    var referredBy = "" + (data.referred_by || "");
    if (!slug) return RpcHelpers.errorResponse("slug required", 400);
    var cfg = TournamentEconomy.getBySlug(slug);
    if (!cfg) return RpcHelpers.errorResponse("tournament not found", 404);

    var meta = TournamentsStorage.readMeta(nk, slug) || TournamentsStorage.seedFromConfig(nk, cfg);
    if (meta.status !== "PRE_ENROLL" && meta.status !== "OPEN") {
      return RpcHelpers.errorResponse("tournament not accepting pre-enrollment", 400);
    }

    var existing = TournamentsStorage.readPreEnroll(nk, slug, userId);
    if (existing) {
      return RpcHelpers.successResponse({ pre_enroll: existing, idempotent: true });
    }

    // Determine Founder rank (1..PRE_ENROLL_FOUNDER_CAP)
    var founderRank: number | undefined = undefined;
    if (meta.pre_enroll_count < TournamentEconomy.PRE_ENROLL_FOUNDER_CAP) {
      founderRank = meta.pre_enroll_count + 1;
    }

    var row: TournamentsStorage.PreEnrollRow = {
      tournament_slug: slug,
      user_id: userId,
      enrolled_at: nowSec(),
      founder_rank: founderRank,
      referred_by: referredBy || undefined,
    };
    TournamentsStorage.writePreEnroll(nk, slug, userId, row);
    var newCount = TournamentsStorage.incrementPreEnrollCount(nk, slug);

    // Referral attribution
    if (referredBy) {
      try {
        Referrals.recordReferral(nk, referredBy, userId, slug);
      } catch (_) { /* best-effort */ }
    }

    // Notify scarcity if under threshold (broadcast to recent subscribers list).
    // MVP: skip subscriber-list maintenance and use empty list (web fetches every poll).
    var founderLeft = TournamentEconomy.PRE_ENROLL_FOUNDER_CAP - newCount;
    if (founderLeft <= 100 && founderLeft > 0) {
      TournamentRealtime.notifyPreEnrollScarcity(nk, slug, founderLeft, []);
    }

    logger.info("[Tournaments] pre-enroll " + userId + " → " + slug + " (founder_rank=" + (founderRank || "-") + ", pre_enroll_count=" + newCount + ")");
    return RpcHelpers.successResponse({ pre_enroll: row, founder_spots_left: founderLeft, total_pre_enroll: newCount });
  }

  // ── RPC: tournament_enter ──────────────────────────────────────────────────
  // Charges BC; opens the entry row. Honors AMOE if user completed Learning
  // Series (6/6 videos) — paid_via="amoe" with bc_charged=0.
  function rpcEnter(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var rl = SharedRateLimit.enforce(ctx, nk, "tournament_enter", { perUserPerMin: 10 });
    if (rl) return rl;
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload);
    var slug = "" + (data.slug || "");
    var paidVia = "" + (data.paid_via || "balance"); // balance | amoe
    var idempotencyKey = "" + (data.idempotency_key || "");
    if (!slug) return RpcHelpers.errorResponse("slug required", 400);
    if (!idempotencyKey) return RpcHelpers.errorResponse("idempotency_key required", 400);

    var cfg = TournamentEconomy.getBySlug(slug);
    if (!cfg) return RpcHelpers.errorResponse("tournament not found", 404);
    var meta = TournamentsStorage.readMeta(nk, slug);
    if (!meta) return RpcHelpers.errorResponse("tournament meta missing — call tournament_list first", 404);
    if (meta.status !== "OPEN" && meta.status !== "ACTIVE") {
      return RpcHelpers.errorResponse("tournament not open for entry (status=" + meta.status + ")", 400);
    }

    // Eligibility
    var ageInfo = readUserDob(nk, userId);
    if (ageInfo.age < cfg.min_age) {
      return RpcHelpers.errorResponse("min age " + cfg.min_age + " required", 403);
    }
    var country = readUserCountry(nk, userId);
    if (!TournamentEconomy.isCountryAllowed(cfg, country)) {
      return RpcHelpers.errorResponse("country not allowed for this tournament", 403);
    }
    if (country === "US") {
      var state = readUserState(nk, userId);
      if (state && TournamentEconomy.isUsStateEntryBlocked(state)) {
        return RpcHelpers.errorResponse("entry blocked in US state " + state, 403);
      }
    }

    // Idempotency: if entry row exists, return it.
    var existing = TournamentsStorage.readEntry(nk, slug, userId);
    if (existing) {
      return RpcHelpers.successResponse({ entry: existing, idempotent: true });
    }

    // Pay path
    var bcCharged = 0;
    if (paidVia === "amoe") {
      // Verify AMOE eligibility (caller has watched 6/6 Learning Series videos).
      var amoeOk = LearningSeries.hasUnlockedAmoe(nk, userId, cfg.topic_tag, cfg.amoe.learning_series_required_videos);
      if (!amoeOk) return RpcHelpers.errorResponse("AMOE not unlocked — complete 6/6 Learning Series videos first", 403);
      // Verify under per-tournament free-entry cap
      if (existing) return RpcHelpers.successResponse({ entry: existing, idempotent: true });
    } else {
      var bal = readBcBalance(nk, userId);
      if (bal.balance < cfg.entry_fee_bc) {
        return RpcHelpers.errorResponse("insufficient BC (balance=" + bal.balance + ", entry_fee=" + cfg.entry_fee_bc + ")", 402);
      }
      var debited = debitBc(nk, userId, cfg.entry_fee_bc, "tournament_enter:" + slug);
      if (!debited) return RpcHelpers.errorResponse("debit failed", 500);
      bcCharged = cfg.entry_fee_bc;
    }

    // Founder check
    var preEnroll = TournamentsStorage.readPreEnroll(nk, slug, userId);
    var isFounder = !!(preEnroll && preEnroll.founder_rank);

    var entry: TournamentsStorage.EntryRow = {
      entry_id: "ent_" + nowSec() + "_" + Math.random().toString(36).slice(2, 10),
      tournament_slug: slug,
      user_id: userId,
      paid_via: paidVia as any,
      bc_charged: bcCharged,
      founder_member: isFounder,
      enrolled_at: nowSec(),
      score: 0,
    };
    TournamentsStorage.writeEntry(nk, slug, userId, entry);

    // Pot increment (paid entries only; AMOE doesn't add to pot)
    if (bcCharged > 0) {
      var newPot = TournamentsStorage.incrementPot(nk, slug, bcCharged);
      TournamentRealtime.notifyPotUpdate(nk, slug, newPot, bcCharged, []);
    } else {
      TournamentsStorage.incrementPot(nk, slug, 0);  // bumps entries_count
    }

    // Ensure leaderboard
    TournamentLeaderboard.ensureLeaderboard(nk, slug, null, 0);

    logger.info("[Tournaments] enter user=" + userId + " slug=" + slug + " paid=" + paidVia + " bc=" + bcCharged + " founder=" + isFounder);
    return RpcHelpers.successResponse({ entry: entry, founder_member: isFounder, idempotent: false });
  }

  // ── RPC: tournament_submit_pack_result ─────────────────────────────────────
  function rpcSubmitPackResult(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var rl = SharedRateLimit.enforce(ctx, nk, "tournament_submit_pack_result", { perUserPerSec: 2, perUserPerMin: 60 });
    if (rl) return rl;
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload);
    var slug = "" + (data.slug || "");
    var packId = "" + (data.pack_id || "");
    var idempotencyKey = "" + (data.idempotency_key || "");
    var correct = parseInt("" + (data.correct || 0), 10);
    var total = parseInt("" + (data.total || 0), 10);
    var durationMs = parseInt("" + (data.duration_ms || 0), 10);
    var latencyMs = parseInt("" + (data.latency_ms || 0), 10);
    var honeypotCorrect = parseInt("" + (data.honeypot_correct || 0), 10);
    var honeypotTotal = parseInt("" + (data.honeypot_total || 0), 10);

    if (!slug || !packId || !idempotencyKey) {
      return RpcHelpers.errorResponse("slug + pack_id + idempotency_key required", 400);
    }

    // Idempotency check
    var prior = TournamentsStorage.readSubmitIdem(nk, userId, idempotencyKey);
    if (prior) return RpcHelpers.successResponse({ submit: prior, idempotent: true });

    var cfg = TournamentEconomy.getBySlug(slug);
    if (!cfg) return RpcHelpers.errorResponse("tournament not found", 404);

    var entry = TournamentsStorage.readEntry(nk, slug, userId);
    if (!entry) return RpcHelpers.errorResponse("not entered — call tournament_enter first", 403);
    if (entry.eliminated_at) return RpcHelpers.errorResponse("eliminated", 403);

    // Anti-cheat
    var ac = TournamentAntiCheat.check(nk, {
      user_id: userId,
      answers_count: total,
      duration_ms: durationMs,
      latency_ms: latencyMs,
      correct: correct,
      total: total,
      honeypot_correct: honeypotCorrect,
      honeypot_total: honeypotTotal,
    });

    var status: "counted" | "soft_dq" | "throttled" = ac.pass ? "counted" : "soft_dq";
    var effectiveScore = ac.pass ? correct : 0;

    // Update entry
    entry.score = (entry.score | 0) + effectiveScore;
    TournamentsStorage.writeEntry(nk, slug, userId, entry);

    // Record submit row
    var submitRow: TournamentsStorage.SubmitRow = {
      idempotency_key: idempotencyKey,
      tournament_slug: slug,
      pack_id: packId,
      user_id: userId,
      answers_count: total,
      score: effectiveScore,
      correct: correct,
      total: total,
      latency_ms: latencyMs,
      duration_ms: durationMs,
      submitted_at: nowSec(),
      status: status,
      soft_dq_reasons: ac.pass ? undefined : ac.reasons,
    };
    TournamentsStorage.writeSubmit(nk, userId, idempotencyKey, submitRow);

    // Push score to leaderboard (only if counted)
    if (ac.pass) {
      var username = "";
      try {
        var acc = nk.accountsGetId([userId]);
        if (acc && acc.length > 0) username = "" + (acc[0].user.username || "");
      } catch (_) { }
      TournamentLeaderboard.recordSubmit(nk, slug, userId, username, entry.score);

      // Tier-league bookkeeping
      var bal = readBcBalance(nk, userId);
      var tier = TournamentLeaderboard.tierForBalance(bal.lifetime_earned);
      TournamentLeaderboard.recordTierSubmit(nk, slug, tier, userId, username, entry.score);
    }

    logger.info("[Tournaments] submit user=" + userId + " slug=" + slug + " pack=" + packId + " score=" + effectiveScore + " status=" + status);
    return RpcHelpers.successResponse({
      submit: submitRow,
      total_score: entry.score,
      idempotent: false,
    });
  }

  // ── RPC: tournament_submit_picks (pick_n format) ───────────────────────────
  function rpcSubmitPicks(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var rl = SharedRateLimit.enforce(ctx, nk, "tournament_submit_picks", { perUserPerMin: 5 });
    if (rl) return rl;
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload);
    var slug = "" + (data.slug || "");
    var idempotencyKey = "" + (data.idempotency_key || "");
    var picks: any[] = data.picks || [];

    if (!slug || !idempotencyKey) return RpcHelpers.errorResponse("slug + idempotency_key required", 400);
    if (!picks || picks.length === 0) return RpcHelpers.errorResponse("picks array required", 400);

    var cfg = TournamentEconomy.getBySlug(slug);
    if (!cfg) return RpcHelpers.errorResponse("tournament not found", 404);
    if (cfg.format !== "pick_n") return RpcHelpers.errorResponse("submit_picks only valid for pick_n format", 400);
    if (!cfg.pick_n_config) return RpcHelpers.errorResponse("tournament misconfigured: pick_n_config missing", 500);
    if (picks.length !== cfg.pick_n_config.n) {
      return RpcHelpers.errorResponse("picks count must be " + cfg.pick_n_config.n, 400);
    }

    var entry = TournamentsStorage.readEntry(nk, slug, userId);
    if (!entry) return RpcHelpers.errorResponse("not entered", 403);

    // Lock window
    var now = nowSec();
    var lockTime = isoToUnix(cfg.end_iso) - (cfg.pick_n_config.max_pick_window_hours * 3600);
    if (now > lockTime) return RpcHelpers.errorResponse("pick window closed", 403);

    // Idempotency
    var prior = nk.storageRead([{ collection: TournamentsStorage.COL_PICKS, key: idempotencyKey, userId: userId }]);
    if (prior && prior.length > 0) {
      return RpcHelpers.successResponse({ picks: (prior[0].value as any), idempotent: true });
    }

    // Persist picks (grading happens at settle time when answer key is revealed)
    nk.storageWrite([{
      collection: TournamentsStorage.COL_PICKS,
      key: idempotencyKey,
      userId: userId,
      value: {
        tournament_slug: slug,
        idempotency_key: idempotencyKey,
        picks: picks,
        submitted_at: now,
      },
      permissionRead: 1,
      permissionWrite: 0,
    }]);

    logger.info("[Tournaments] picks user=" + userId + " slug=" + slug + " n=" + picks.length);
    return RpcHelpers.successResponse({ submitted: true, locks_at: lockTime });
  }

  // ── RPC: tournament_status_get ─────────────────────────────────────────────
  function rpcStatusGet(ctx: nkruntime.Context, _logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload);
    var slug = "" + (data.slug || "");
    if (!slug) return RpcHelpers.errorResponse("slug required", 400);
    var entry = TournamentsStorage.readEntry(nk, slug, userId);
    var meta = TournamentsStorage.readMeta(nk, slug);
    var lbRank = -1;
    try {
      var rec = nk.leaderboardRecordsList(TournamentLeaderboard.lbId(slug), [userId], 1, undefined);
      if (rec.records && rec.records.length > 0) lbRank = rec.records[0].rank as any;
    } catch (_) { }
    return RpcHelpers.successResponse({
      entry: entry,
      meta: meta,
      caller_rank: lbRank,
      served_at: nowSec(),
    });
  }

  // ── Leaderboard variant RPCs ───────────────────────────────────────────────
  function rpcLbTop(ctx: nkruntime.Context, _l: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = RpcHelpers.parseRpcPayload(payload);
    var slug = "" + (data.slug || "");
    var limit = parseInt("" + (data.limit || 50), 10);
    var cursor = data.cursor || null;
    if (!slug) return RpcHelpers.errorResponse("slug required", 400);
    var res = TournamentLeaderboard.listTop(nk, slug, limit, cursor);
    return RpcHelpers.successResponse(res);
  }

  function rpcLbAroundMe(ctx: nkruntime.Context, _l: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload);
    var slug = "" + (data.slug || "");
    var limit = parseInt("" + (data.limit || 25), 10);
    if (!slug) return RpcHelpers.errorResponse("slug required", 400);
    var res = TournamentLeaderboard.listAroundMe(nk, slug, userId, limit);
    return RpcHelpers.successResponse(res);
  }

  function rpcLbFriends(ctx: nkruntime.Context, _l: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload);
    var slug = "" + (data.slug || "");
    var limit = parseInt("" + (data.limit || 50), 10);
    if (!slug) return RpcHelpers.errorResponse("slug required", 400);
    var res = TournamentLeaderboard.listFriends(nk, slug, userId, limit);
    return RpcHelpers.successResponse(res);
  }

  function rpcLbCountry(ctx: nkruntime.Context, _l: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var userId = ctx.userId || "";
    var data = RpcHelpers.parseRpcPayload(payload);
    var slug = "" + (data.slug || "");
    var country = "" + (data.country || (userId ? readUserCountry(nk, userId) : "US"));
    var limit = parseInt("" + (data.limit || 50), 10);
    if (!slug) return RpcHelpers.errorResponse("slug required", 400);
    var res = TournamentLeaderboard.listCountry(nk, slug, country, limit);
    return RpcHelpers.successResponse(res);
  }

  function rpcLbTierLeague(ctx: nkruntime.Context, _l: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload);
    var slug = "" + (data.slug || "");
    var tier = "" + (data.tier || "");
    var limit = parseInt("" + (data.limit || 50), 10);
    if (!slug) return RpcHelpers.errorResponse("slug required", 400);
    if (!tier) {
      var bal = readBcBalance(nk, userId);
      tier = TournamentLeaderboard.tierForBalance(bal.lifetime_earned);
    }
    var res = TournamentLeaderboard.listTierLeague(nk, slug, tier, limit);
    return RpcHelpers.successResponse(res);
  }

  // Activity feed: recent N submits across all users for this tournament.
  // MVP impl: tail the user's own log + intersperse "Player X scored Y" rows
  // from the leaderboard top.
  function rpcLbActivityFeed(ctx: nkruntime.Context, _l: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = RpcHelpers.parseRpcPayload(payload);
    var slug = "" + (data.slug || "");
    var limit = parseInt("" + (data.limit || 20), 10);
    if (!slug) return RpcHelpers.errorResponse("slug required", 400);
    // Pull recent top-20 from leaderboard as a proxy for "recent activity"
    var top = TournamentLeaderboard.listTop(nk, slug, limit, null);
    var feed: any[] = [];
    if (top.records) {
      for (var i = 0; i < top.records.length; i++) {
        var r = top.records[i];
        feed.push({
          username: r.username || "Player",
          score: r.score,
          rank: r.rank,
          updated_at: r.updateTime || null,
        });
      }
    }
    return RpcHelpers.successResponse({ activity: feed, served_at: nowSec() });
  }

  // ── RPC: tournament_claim_cert ─────────────────────────────────────────────
  function rpcClaimCert(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var rl = SharedRateLimit.enforce(ctx, nk, "tournament_claim_cert", { perUserPerMin: 10 });
    if (rl) return rl;
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload);
    var slug = "" + (data.slug || "");
    if (!slug) return RpcHelpers.errorResponse("slug required", 400);

    var entry = TournamentsStorage.readEntry(nk, slug, userId);
    if (!entry) return RpcHelpers.errorResponse("not entered", 403);
    if (entry.claimed_cert) return RpcHelpers.successResponse({ cert_id: entry.cert_id, idempotent: true });

    var meta = TournamentsStorage.readMeta(nk, slug);
    if (!meta || (meta.status !== "SETTLED")) {
      return RpcHelpers.errorResponse("tournament not settled yet", 400);
    }

    // Determine tier: top-1 = gold, top-3 = silver, top-10 = bronze, else participation
    var tier = "participation";
    if (entry.rank === 1) tier = "gold";
    else if (entry.rank && entry.rank <= 3) tier = "silver";
    else if (entry.rank && entry.rank <= 10) tier = "bronze";

    var certId = "cert_" + slug + "_" + userId + "_" + nowSec();
    // Persist cert row (Lambda generates PDF lazily on first /certificate/[id] hit)
    nk.storageWrite([{
      collection: TournamentsStorage.COL_CERTS,
      key: certId,
      userId: userId,
      value: {
        cert_id: certId,
        tournament_slug: slug,
        user_id: userId,
        tier: tier,
        rank: entry.rank || 0,
        score: entry.score,
        claimed_at: nowSec(),
        pdf_status: "pending",  // Lambda flips to "ready" + sets s3_url
        s3_url: null,
      },
      permissionRead: 2,  // public read so OG image generation works
      permissionWrite: 0,
    }]);

    entry.claimed_cert = true;
    entry.cert_id = certId;
    TournamentsStorage.writeEntry(nk, slug, userId, entry);

    logger.info("[Tournaments] claim_cert user=" + userId + " slug=" + slug + " tier=" + tier);
    return RpcHelpers.successResponse({ cert_id: certId, tier: tier });
  }

  // ── RPC: tournament_content_get_pack ───────────────────────────────────────
  // Catalog read; on miss requests CF generation and returns task_id.
  function rpcContentGetPack(ctx: nkruntime.Context, _l: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = RpcHelpers.parseRpcPayload(payload);
    var slug = "" + (data.slug || "");
    var language = "" + (data.language || "en");
    var weekNum = parseInt("" + (data.week_num || 0), 10);
    if (!slug) return RpcHelpers.errorResponse("slug required", 400);

    var entry = ContentFactoryClient.readPackCatalog(nk, slug, language, weekNum);
    if (entry) {
      return RpcHelpers.successResponse({ pack: entry, source: "cache" });
    }

    var cfg = TournamentEconomy.getBySlug(slug);
    if (!cfg) return RpcHelpers.errorResponse("tournament not found", 404);
    var topic = TournamentTopicCatalog.getEntry(cfg.topic_tag);
    if (!topic) return RpcHelpers.errorResponse("topic catalog missing for " + cfg.topic_tag, 500);

    var rotatedTag = TournamentTopicCatalog.getRotatedTag(cfg.topic_tag, weekNum);
    var rotatedTopic = TournamentTopicCatalog.getEntry(rotatedTag) || topic;

    var enq = ContentFactoryClient.enqueuePackGeneration(ctx, nk, {
      concept: rotatedTopic.concept,
      exam_board: rotatedTopic.exam_board,
      language: language,
      num_cards: 30,
      tags: [slug, rotatedTag, "w" + weekNum],
    });
    if (!enq.ok) return RpcHelpers.errorResponse("CF enqueue failed: " + enq.error, 502);
    return RpcHelpers.successResponse({ pack: null, source: "generating", task_id: enq.task_id });
  }

  // ── RPC: tournament_video_get_url ──────────────────────────────────────────
  function rpcVideoGetUrl(ctx: nkruntime.Context, _l: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = RpcHelpers.parseRpcPayload(payload);
    var slug = "" + (data.slug || "");
    var videoIndex = parseInt("" + (data.video_index || 0), 10);
    var language = "" + (data.language || "en");
    if (!slug) return RpcHelpers.errorResponse("slug required", 400);

    var entry = ContentFactoryClient.readVideoCatalog(nk, slug, videoIndex, language);
    if (entry) return RpcHelpers.successResponse({ video: entry, source: "cache" });
    return RpcHelpers.successResponse({ video: null, source: "not_yet_generated" });
  }

  // ── RPC: tournament_learning_check_submit ──────────────────────────────────
  function rpcLearningCheckSubmit(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload);
    var topicTag = "" + (data.topic_tag || "");
    var videoIndex = parseInt("" + (data.video_index || -1), 10);
    var correct = parseInt("" + (data.correct || 0), 10);
    var total = parseInt("" + (data.total || 5), 10);
    if (!topicTag || videoIndex < 0) return RpcHelpers.errorResponse("topic_tag + video_index required", 400);

    LearningSeries.recordVideoCheck(nk, userId, topicTag, videoIndex, correct, total);
    var progress = LearningSeries.getProgress(nk, userId, topicTag);
    return RpcHelpers.successResponse({ progress: progress });
  }

  // ── RPC: tournament_referral_get_mine ──────────────────────────────────────
  function rpcReferralGetMine(ctx: nkruntime.Context, _l: nkruntime.Logger, nk: nkruntime.Nakama, _payload: string): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var summary = Referrals.getMySummary(nk, userId);
    return RpcHelpers.successResponse(summary);
  }

  // ── RPC: tournament_admin_create (service-only) ────────────────────────────
  function rpcAdminCreate(ctx: nkruntime.Context, _l: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!isServiceCaller(ctx, data)) return RpcHelpers.errorResponse("service-only", 401);
    var slug = "" + (data.slug || "");
    if (!slug) return RpcHelpers.errorResponse("slug required", 400);
    var cfg = TournamentEconomy.getBySlug(slug);
    if (!cfg) return RpcHelpers.errorResponse("slug not in LAUNCH_SLATE", 404);
    var meta = TournamentsStorage.seedFromConfig(nk, cfg);
    return RpcHelpers.successResponse({ meta: meta, idempotent: !!meta });
  }

  // ── RPC: tournament_content_request_generation (service-only) ──────────────
  function rpcContentRequestGeneration(ctx: nkruntime.Context, _l: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!isServiceCaller(ctx, data)) return RpcHelpers.errorResponse("service-only", 401);
    var slug = "" + (data.slug || "");
    var language = "" + (data.language || "en");
    var weekNum = parseInt("" + (data.week_num || 0), 10);
    var numCards = parseInt("" + (data.num_cards || 30), 10);
    if (!slug) return RpcHelpers.errorResponse("slug required", 400);
    var cfg = TournamentEconomy.getBySlug(slug);
    if (!cfg) return RpcHelpers.errorResponse("slug not found", 404);
    var topic = TournamentTopicCatalog.getEntry(cfg.topic_tag);
    if (!topic) return RpcHelpers.errorResponse("topic missing", 500);
    var rotated = TournamentTopicCatalog.getRotatedTag(cfg.topic_tag, weekNum);
    var rt = TournamentTopicCatalog.getEntry(rotated) || topic;
    var enq = ContentFactoryClient.enqueuePackGeneration(ctx, nk, {
      concept: rt.concept,
      exam_board: rt.exam_board,
      language: language,
      num_cards: numCards,
      tags: [slug, rotated, "w" + weekNum],
    });
    return RpcHelpers.successResponse({ enqueued: enq.ok, task_id: enq.task_id || null, error: enq.error || null });
  }

  // ── RPC: tournament_settle (service-only) ──────────────────────────────────
  function rpcSettle(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!isServiceCaller(ctx, data)) return RpcHelpers.errorResponse("service-only", 401);
    var slug = "" + (data.slug || "");
    if (!slug) return RpcHelpers.errorResponse("slug required", 400);
    var result = TournamentSettlement.settle(ctx, logger, nk, slug);
    return RpcHelpers.successResponse(result);
  }

  // ── RPC: tournament_eliminate_round (service-only) ─────────────────────────
  function rpcEliminateRound(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!isServiceCaller(ctx, data)) return RpcHelpers.errorResponse("service-only", 401);
    var slug = "" + (data.slug || "");
    var round = parseInt("" + (data.round || 1), 10);
    if (!slug) return RpcHelpers.errorResponse("slug required", 400);
    var result = TournamentSettlement.eliminateRound(ctx, logger, nk, slug, round);
    return RpcHelpers.successResponse(result);
  }

  // ── RPC: tournament_referral_settle_topN (service-only) ────────────────────
  function rpcReferralSettleTopN(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!isServiceCaller(ctx, data)) return RpcHelpers.errorResponse("service-only", 401);
    var result = Referrals.settleTopN(ctx, logger, nk);
    return RpcHelpers.successResponse(result);
  }

  // ── Registration ───────────────────────────────────────────────────────────
  export function register(initializer: nkruntime.Initializer): void {
    // User-callable
    initializer.registerRpc("tournament_list", rpcList);
    initializer.registerRpc("tournament_get", rpcGet);
    initializer.registerRpc("tournament_pre_enroll", rpcPreEnroll);
    initializer.registerRpc("tournament_enter", rpcEnter);
    initializer.registerRpc("tournament_submit_pack_result", rpcSubmitPackResult);
    initializer.registerRpc("tournament_submit_picks", rpcSubmitPicks);
    initializer.registerRpc("tournament_status_get", rpcStatusGet);
    initializer.registerRpc("tournament_leaderboard_top", rpcLbTop);
    initializer.registerRpc("tournament_leaderboard_around_me", rpcLbAroundMe);
    initializer.registerRpc("tournament_leaderboard_friends", rpcLbFriends);
    initializer.registerRpc("tournament_leaderboard_country", rpcLbCountry);
    initializer.registerRpc("tournament_leaderboard_tier_league", rpcLbTierLeague);
    initializer.registerRpc("tournament_leaderboard_activity_feed", rpcLbActivityFeed);
    initializer.registerRpc("tournament_claim_cert", rpcClaimCert);
    initializer.registerRpc("tournament_content_get_pack", rpcContentGetPack);
    initializer.registerRpc("tournament_video_get_url", rpcVideoGetUrl);
    initializer.registerRpc("tournament_learning_check_submit", rpcLearningCheckSubmit);
    initializer.registerRpc("tournament_referral_get_mine", rpcReferralGetMine);

    // Service-only
    initializer.registerRpc("tournament_admin_create", rpcAdminCreate);
    initializer.registerRpc("tournament_content_request_generation", rpcContentRequestGeneration);
    initializer.registerRpc("tournament_settle", rpcSettle);
    initializer.registerRpc("tournament_eliminate_round", rpcEliminateRound);
    initializer.registerRpc("tournament_referral_settle_topN", rpcReferralSettleTopN);
  }
}
