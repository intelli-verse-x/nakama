// ---------------------------------------------------------------------------
// Satori Experiment Results — conversion counting + statistical significance
// for A/B experiments, plus a declare-winner action. Closes the biggest gap
// vs the hosted Satori console (which reports per-variant results).
//
// Data sources (no schema changes):
//   - Assignments: `satori_assignments` collection, one object per user
//     (key = gameKey(gameId, "assignments")), written by SatoriExperiments
//     on first getVariant() call → gives EXPOSURES per variant.
//   - Goal events: `satori_events` collection under SYSTEM_USER (records
//     keyed ev_*), written by SatoriEventCapture → gives CONVERSIONS
//     (first goal event at/after the user's assignment time).
//
// Significance: two-proportion z-test of each variant against the control
// (variant whose id/name is "control", else the first variant). Two-tailed
// p-value via the Abramowitz–Stegun erf approximation. 95% => significant.
//
// Both scans are page-capped so a huge dataset degrades to a truncated
// (clearly flagged) estimate instead of hanging a VM.
// ---------------------------------------------------------------------------
namespace SatoriExperimentResults {

  var PAGE_SIZE = 100;
  var ASSIGNMENT_MAX_PAGES = 200;  // 20K users
  var EVENTS_DEFAULT_PAGES = 320;  // 32K event records — covers the legacy (oldest-first) key tail
  var EVENTS_MAX_PAGES = 800;

  export interface AssignmentInfo {
    variantKey: string;
    assignedAtMs: number;
    exposedAtMs?: number;
    startedAtMs?: number;
    convertedAtMs?: number;
    claimedAtMs?: number;
  }

  function toMs(ts: number): number {
    if (!ts) return 0;
    return ts < 100000000000 ? ts * 1000 : ts;
  }

  function variantKeyOf(variant: any): string {
    return (variant && (variant.id || variant.name)) || "";
  }

  // ---- Normal CDF via erf (Abramowitz & Stegun 7.1.26) ----

  function erf(x: number): number {
    var sign = x < 0 ? -1 : 1;
    x = Math.abs(x);
    var a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
    var a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    var t = 1 / (1 + p * x);
    var y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
    return sign * y;
  }

  function normalCdf(z: number): number {
    return 0.5 * (1 + erf(z / Math.SQRT2));
  }

  // Two-proportion z-test. Returns null when sample sizes are too small.
  function zTest(c1: number, n1: number, c2: number, n2: number): { z: number; pValue: number } | null {
    if (n1 < 1 || n2 < 1) return null;
    var p1 = c1 / n1;
    var p2 = c2 / n2;
    var pooled = (c1 + c2) / (n1 + n2);
    var se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
    if (se === 0) return null;
    var z = (p2 - p1) / se;
    var pValue = 2 * (1 - normalCdf(Math.abs(z)));
    return { z: z, pValue: pValue };
  }

  var SRM_ALPHA = 0.001;

  // Upper-tail P(χ²_df > x). df=1,2 closed form; else Wilson–Hilferty.
  function chiSquareSurvival(chi2: number, df: number): number {
    if (!(chi2 > 0) || df < 1) return 1;
    if (chi2 === Infinity) return 0;
    if (df === 1) return 2 * (1 - normalCdf(Math.sqrt(chi2)));
    if (df === 2) return Math.exp(-chi2 / 2);
    var cuberoot = Math.pow(chi2 / df, 1 / 3);
    var mu = 1 - 2 / (9 * df);
    var sigma = Math.sqrt(2 / (9 * df));
    if (sigma === 0) return 1;
    return 1 - normalCdf((cuberoot - mu) / sigma);
  }

  // Observed exposure counts vs configured variant weights.
  function computeSrm(variants: any[], exposures: { [k: string]: number }): any {
    var observed: { [k: string]: number } = {};
    var expected: { [k: string]: number } = {};
    var weights: { [k: string]: number } = {};
    var totalN = 0;
    var totalW = 0;
    var keys: string[] = [];
    for (var i = 0; i < variants.length; i++) {
      var k = variantKeyOf(variants[i]);
      if (!k) continue;
      keys.push(k);
      var w = typeof variants[i].weight === "number" ? variants[i].weight : 1;
      if (w < 0) w = 0;
      weights[k] = w;
      observed[k] = exposures[k] || 0;
      totalN += observed[k];
      totalW += w;
    }
    var df = keys.length - 1;
    if (keys.length < 2 || totalN < 1 || totalW <= 0 || df < 1) {
      return {
        chiSquare: 0, degreesOfFreedom: Math.max(df, 0), pValue: 1, alpha: SRM_ALPHA,
        passed: true, skipped: true, observed: observed, expected: expected, weights: weights
      };
    }
    var chi2 = 0;
    var minExpected = Infinity;
    var infinite = false;
    for (var j = 0; j < keys.length; j++) {
      var vk = keys[j];
      var e = totalN * (weights[vk] / totalW);
      expected[vk] = e;
      if (e < minExpected) minExpected = e;
      if (e <= 0) {
        if (observed[vk] > 0) { infinite = true; chi2 = Infinity; }
        continue;
      }
      var diff = observed[vk] - e;
      chi2 += (diff * diff) / e;
    }
    if (minExpected < 5 && !infinite) {
      return {
        chiSquare: chi2, degreesOfFreedom: df, pValue: chiSquareSurvival(chi2, df),
        alpha: SRM_ALPHA, passed: true, skipped: true,
        observed: observed, expected: expected, weights: weights
      };
    }
    var pValue = infinite ? 0 : chiSquareSurvival(chi2, df);
    var passed = pValue >= SRM_ALPHA;
    return {
      chiSquare: infinite ? null : chi2,
      degreesOfFreedom: df,
      pValue: pValue,
      alpha: SRM_ALPHA,
      passed: passed,
      skipped: false,
      observed: observed,
      expected: expected,
      weights: weights
    };
  }

  // ---- Data collection ----

  function loadExperimentDef(nk: nkruntime.Nakama, experimentId: string, gameId?: string): any {
    var experiments = ConfigLoader.loadSatoriConfigForGame<{ [id: string]: any }>(nk, "experiments", gameId, {});
    return experiments[experimentId] || null;
  }

  // Scan all users' assignment objects, collect userId → assignment for this
  // experiment. Assignment objects are stored per-user, so we list across
  // owners with an empty userId. Exported for reuse by funnels/retention
  // variant segmentation.
  export function collectAssignments(nk: nkruntime.Nakama, experimentId: string, gameId?: string): { byUser: { [userId: string]: AssignmentInfo }; truncated: boolean; scanned: number } {
    var expectedKey = Constants.gameKey(gameId, "assignments");
    var byUser: { [userId: string]: AssignmentInfo } = {};
    var cursor = "";
    var truncated = false;
    var scanned = 0;

    for (var p = 0; p < ASSIGNMENT_MAX_PAGES; p++) {
      var page = nk.storageList("", Constants.SATORI_ASSIGNMENTS_COLLECTION, PAGE_SIZE, cursor);
      var objects = (page && page.objects) || [];
      for (var i = 0; i < objects.length; i++) {
        var obj = objects[i];
        if (obj.key !== expectedKey || !obj.value || !obj.userId) continue;
        scanned++;
        var assignments = (obj.value as any).assignments || {};
        var a = assignments[experimentId];
        if (!a || !a.variantId) continue;
        byUser[obj.userId] = {
          variantKey: a.variantId,
          assignedAtMs: toMs(a.assignedAt || 0),
          exposedAtMs: a.exposedAt ? toMs(a.exposedAt) : 0,
          startedAtMs: a.startedAt ? toMs(a.startedAt) : 0,
          convertedAtMs: a.convertedAt ? toMs(a.convertedAt) : 0,
          claimedAtMs: a.claimedAt ? toMs(a.claimedAt) : 0
        };
      }
      cursor = (page && page.cursor) || "";
      if (!cursor) break;
    }
    if (cursor) truncated = true;
    return { byUser: byUser, truncated: truncated, scanned: scanned };
  }

  // Scan goal events; a user converts when their FIRST goal event happens at
  // or after their assignment time. Also tallies total goal-event volume.
  function collectConversions(
    nk: nkruntime.Nakama,
    goalEvent: string,
    byUser: { [userId: string]: AssignmentInfo },
    maxPages: number
  ): { convertedUsers: { [userId: string]: boolean }; totalGoalEvents: number; truncated: boolean; scannedRecords: number } {
    var convertedUsers: { [userId: string]: boolean } = {};
    var totalGoalEvents = 0;
    var scannedRecords = 0;
    var cursor = "";
    var truncated = false;

    for (var p = 0; p < maxPages; p++) {
      var page = nk.storageList(Constants.SYSTEM_USER_ID, Constants.SATORI_EVENTS_COLLECTION, PAGE_SIZE, cursor);
      var objects = (page && page.objects) || [];
      for (var i = 0; i < objects.length; i++) {
        var obj = objects[i];
        if (!obj.key || obj.key.indexOf("ev_") !== 0 || !obj.value) continue;
        scannedRecords++;
        var rec = obj.value as any;
        if (rec.name !== goalEvent) continue;
        var uid = rec.userId || rec.identityId;
        if (!uid) continue;
        var assignment = byUser[uid];
        if (!assignment) continue;
        totalGoalEvents++;
        if (toMs(rec.timestamp) >= assignment.assignedAtMs) {
          convertedUsers[uid] = true;
        }
      }
      cursor = (page && page.cursor) || "";
      if (!cursor) break;
    }
    if (cursor) truncated = true;
    return { convertedUsers: convertedUsers, totalGoalEvents: totalGoalEvents, truncated: truncated, scannedRecords: scannedRecords };
  }

  // Quest A/B: count convertedAt on the assignment. Unattributed quest_completed
  // events must not convert (hidden quest, other game, complete before exposure).
  function collectConvertedAt(
    byUser: { [userId: string]: AssignmentInfo }
  ): { convertedUsers: { [userId: string]: boolean }; totalGoalEvents: number; truncated: boolean; scannedRecords: number } {
    var convertedUsers: { [userId: string]: boolean } = {};
    var total = 0;
    for (var uid in byUser) {
      if (!byUser.hasOwnProperty(uid)) continue;
      if (byUser[uid].convertedAtMs) {
        convertedUsers[uid] = true;
        total++;
      }
    }
    return { convertedUsers: convertedUsers, totalGoalEvents: total, truncated: false, scannedRecords: 0 };
  }

  function incCount(dest: { [k: string]: number }, key: string): void {
    dest[key] = (dest[key] || 0) + 1;
  }

  function unixToUtcDay(unixOrMs: number): string {
    var ms = unixOrMs < 100000000000 ? unixOrMs * 1000 : unixOrMs;
    var d = new Date(ms);
    var m = d.getUTCMonth() + 1;
    var day = d.getUTCDate();
    var mm = m < 10 ? "0" + m : String(m);
    var dd = day < 10 ? "0" + day : String(day);
    return d.getUTCFullYear() + "-" + mm + "-" + dd;
  }

  // Bounded repair: rebuild 32 shard docs from per-user assignment markers.
  function rebuildFunnelShardsFromAssignments(
    nk: nkruntime.Nakama, experimentId: string, gameId: string,
    byUser: { [userId: string]: AssignmentInfo }
  ): void {
    var docs: any[] = [];
    for (var i = 0; i < SatoriExperiments.FUNNEL_SHARD_COUNT; i++) {
      docs.push(SatoriExperiments.emptyFunnelShardDoc());
    }
    for (var uid in byUser) {
      if (!byUser.hasOwnProperty(uid)) continue;
      var info = byUser[uid];
      if (!info || !info.variantKey) continue;
      var shard = SatoriExperiments.funnelShardIndexOf(uid);
      var doc = docs[shard];
      incCount(doc.assigned, info.variantKey);
      if (info.exposedAtMs) incCount(doc.exposed, info.variantKey);
      if (info.startedAtMs) incCount(doc.started, info.variantKey);
      if (info.convertedAtMs) incCount(doc.completed, info.variantKey);
      if (info.claimedAtMs) incCount(doc.claimed, info.variantKey);
      if (info.assignedAtMs) {
        var dayA = unixToUtcDay(info.assignedAtMs);
        if (!doc.byDay[dayA]) doc.byDay[dayA] = { assigned: {}, completed: {} };
        incCount(doc.byDay[dayA].assigned, info.variantKey);
      }
      if (info.convertedAtMs) {
        var dayC = unixToUtcDay(info.convertedAtMs);
        if (!doc.byDay[dayC]) doc.byDay[dayC] = { assigned: {}, completed: {} };
        incCount(doc.byDay[dayC].completed, info.variantKey);
      }
    }
    SatoriExperiments.replaceFunnelShards(nk, gameId, experimentId, docs);
  }

  var MIN_SAMPLE_QA = 30;
  var MIN_SAMPLE_LIVE = 100;

  function isQaExperiment(def: any): boolean {
    var aid = String((def && def.audienceId) || "").toLowerCase();
    if (!aid) return false;
    if (aid === "all" || aid === "quizverse_all_players" || aid.indexOf("all_player") >= 0) return false;
    return true;
  }

  function resolveMinSamplePerArm(def: any, data: any): { perArm: number; mode: string } {
    var raw = (data && (data.minSample || data.min_sample || data.minSamplePerArm)) ||
      (def && (def.minSamplePerArm || def.minSample));
    var parsed = parseInt(String(raw == null ? "" : raw), 10);
    if (parsed > 0) {
      if (parsed > 100000) parsed = 100000;
      return { perArm: parsed, mode: "override" };
    }
    if (isQaExperiment(def)) return { perArm: MIN_SAMPLE_QA, mode: "qa" };
    return { perArm: MIN_SAMPLE_LIVE, mode: "live" };
  }

  function countMapTotal(map: { [k: string]: number }): number {
    var total = 0;
    for (var k in map) {
      if (map.hasOwnProperty(k)) total += map[k] || 0;
    }
    return total;
  }

  // ---- RPCs ----

  // satori_experiments_results — per-variant exposures, conversions, rates,
  // z-test vs control, and a recommendation.
  // Payload: { experimentId, game_id?, goal_event?, max_event_pages? }
  function rpcResults(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.experimentId && !data.experiment_id) return RpcHelpers.errorResponse("experimentId required");
    var experimentId = data.experimentId || data.experiment_id;
    var gameId = RpcHelpers.gameId(data);

    var def = loadExperimentDef(nk, experimentId, gameId);
    if (!def) return RpcHelpers.errorResponse("Experiment '" + experimentId + "' not found");

    var goalEvent = data.goal_event || data.goalEvent || def.goalEvent || def.goalMetric;
    if (!goalEvent) {
      return RpcHelpers.errorResponse("No goal event: pass goal_event or set goalMetric on the experiment definition");
    }

    var variants: any[] = def.variants || [];
    if (variants.length < 2) return RpcHelpers.errorResponse("Experiment needs at least 2 variants for results");

    var maxEventPages = Math.min(Math.max(parseInt(data.max_event_pages, 10) || EVENTS_DEFAULT_PAGES, 1), EVENTS_MAX_PAGES);
    var goalIsQuestCompleted = goalEvent === "quest_completed";

    var shardSums = goalIsQuestCompleted
      ? SatoriExperiments.loadFunnelShardSums(nk, gameId, experimentId)
      : null;
    var assignmentScan: { byUser: { [userId: string]: AssignmentInfo }; truncated: boolean; scanned: number } = null;
    var reconciled = false;
    if (goalIsQuestCompleted && data.reconcile === true) {
      assignmentScan = collectAssignments(nk, experimentId, gameId);
      rebuildFunnelShardsFromAssignments(nk, experimentId, gameId, assignmentScan.byUser);
      shardSums = SatoriExperiments.loadFunnelShardSums(nk, gameId, experimentId);
      reconciled = true;
    }

    var usedShards = !!(shardSums && shardSums.shardsPresent);
    var conversionScan = {
      convertedUsers: {} as { [userId: string]: boolean },
      totalGoalEvents: 0,
      truncated: false,
      scannedRecords: 0
    };

    var exposures: { [variantKey: string]: number } = {};
    var conversions: { [variantKey: string]: number } = {};
    var funnelAssigned: { [variantKey: string]: number } = {};
    var funnelExposed: { [variantKey: string]: number } = {};
    var funnelStarted: { [variantKey: string]: number } = {};
    var funnelCompleted: { [variantKey: string]: number } = {};
    var funnelClaimed: { [variantKey: string]: number } = {};
    var byDay: any = {};

    if (usedShards) {
      funnelAssigned = shardSums.assigned;
      funnelExposed = shardSums.exposed;
      funnelStarted = shardSums.started;
      funnelCompleted = shardSums.completed;
      funnelClaimed = shardSums.claimed;
      byDay = shardSums.byDay || {};
      conversions = shardSums.completed;
      // Exposure is get-time, not assignment. Fall back to assigned only when
      // no exposed ticks exist yet (pre-T9 shards).
      if (goalIsQuestCompleted && countMapTotal(shardSums.exposed) > 0) {
        exposures = shardSums.exposed;
      } else {
        exposures = shardSums.assigned;
      }
      conversionScan.totalGoalEvents = countMapTotal(conversions);
    } else {
      if (!assignmentScan) assignmentScan = collectAssignments(nk, experimentId, gameId);
      conversionScan = goalIsQuestCompleted
        ? collectConvertedAt(assignmentScan.byUser)
        : collectConversions(nk, goalEvent, assignmentScan.byUser, maxEventPages);
      for (var uid in assignmentScan.byUser) {
        var info = assignmentScan.byUser[uid];
        var vk = info.variantKey;
        exposures[vk] = (exposures[vk] || 0) + 1;
        incCount(funnelAssigned, vk);
        if (info.exposedAtMs) incCount(funnelExposed, vk);
        if (info.startedAtMs) incCount(funnelStarted, vk);
        if (info.convertedAtMs) incCount(funnelCompleted, vk);
        if (info.claimedAtMs) incCount(funnelClaimed, vk);
        if (conversionScan.convertedUsers[uid]) {
          conversions[vk] = (conversions[vk] || 0) + 1;
        }
      }
      if (goalIsQuestCompleted && countMapTotal(funnelExposed) > 0) {
        exposures = funnelExposed;
      }
    }

    // Control = variant with id/name "control", else first.
    var controlKey = variantKeyOf(variants[0]);
    for (var c = 0; c < variants.length; c++) {
      var key = variantKeyOf(variants[c]);
      if (key === "control" || (variants[c].name || "").toLowerCase() === "control") {
        controlKey = key;
        break;
      }
    }

    var variantRows: any[] = [];
    for (var v = 0; v < variants.length; v++) {
      var vKey = variantKeyOf(variants[v]);
      var n = exposures[vKey] || 0;
      var conv = conversions[vKey] || 0;
      variantRows.push({
        id: vKey,
        name: variants[v].name || vKey,
        isControl: vKey === controlKey,
        exposures: n,
        conversions: conv,
        rate: n > 0 ? conv / n : 0,
        assigned: funnelAssigned[vKey] || 0,
        exposed: funnelExposed[vKey] || 0,
        started: funnelStarted[vKey] || 0,
        completed: funnelCompleted[vKey] || 0,
        claimed: funnelClaimed[vKey] || 0
      });
    }

    var minCfg = resolveMinSamplePerArm(def, data);
    var shortVariants: string[] = [];
    for (var ms = 0; ms < variantRows.length; ms++) {
      if ((variantRows[ms].exposures || 0) < minCfg.perArm) {
        shortVariants.push(variantRows[ms].id);
      }
    }
    var sampleMet = shortVariants.length === 0 && variantRows.length >= 2;
    var srm = computeSrm(variants, exposures);
    var srmPassed = !!(srm && srm.passed !== false);

    // Compare every non-control variant to control.
    var cN = exposures[controlKey] || 0;
    var cConv = conversions[controlKey] || 0;
    var cRate = cN > 0 ? cConv / cN : 0;
    var comparisons: any[] = [];
    var winner: string | null = null;
    var bestLift = 0;

    for (var w = 0; w < variantRows.length; w++) {
      var row = variantRows[w];
      if (row.isControl) continue;
      var test = zTest(cConv, cN, row.conversions, row.exposures);
      var lift = cRate > 0 ? (row.rate - cRate) / cRate : (row.rate > 0 ? 1 : 0);
      var significant = sampleMet && srmPassed && !!(test && test.pValue < 0.05);
      comparisons.push({
        variantId: row.id,
        controlId: controlKey,
        lift: lift,
        zScore: test ? test.z : null,
        pValue: test ? test.pValue : null,
        significant: significant,
        confidence: test ? (1 - test.pValue) : null
      });
      if (significant && row.rate > cRate && lift > bestLift) {
        winner = row.id;
        bestLift = lift;
      }
    }

    var recommendation: string;
    if (!srmPassed) {
      winner = null;
      recommendation = "Do not promote: sample ratio mismatch — observed traffic does not match the configured split (p=" +
        (typeof srm.pValue === "number" ? srm.pValue.toExponential(2) : "0") +
        "). Fix assignment before trusting a winner.";
      logger.warn("[ExperimentResults] SRM fail experiment=%s chi2=%s p=%s",
        experimentId, String(srm.chiSquare), String(srm.pValue));
    } else if (!sampleMet) {
      winner = null;
      var modeLabel = minCfg.mode === "qa" ? "QA, 30 per arm" : (minCfg.mode === "live" ? "live, 100 per arm" : "custom");
      recommendation = "Need at least " + minCfg.perArm + " players in every variant before picking a winner (" + modeLabel + "). Still short: " + shortVariants.join(", ") + ".";
    } else if (winner) {
      recommendation = "Variant '" + winner + "' beats control with 95% confidence — consider declaring it the winner.";
    } else {
      var anySignificantLoss = false;
      for (var s = 0; s < comparisons.length; s++) {
        if (comparisons[s].significant && comparisons[s].lift < 0) anySignificantLoss = true;
      }
      recommendation = anySignificantLoss
        ? "Control significantly outperforms at least one variant — consider declaring control the winner."
        : "No statistically significant difference yet — keep the experiment running.";
    }

    return RpcHelpers.successResponse({
      experimentId: experimentId,
      name: def.name || experimentId,
      status: def.status || "unknown",
      goalEvent: goalEvent,
      winnerVariantId: def.winnerVariantId || null,
      variants: variantRows,
      comparisons: comparisons,
      suggestedWinner: winner,
      recommendation: recommendation,
      minSample: {
        perArm: minCfg.perArm,
        mode: minCfg.mode,
        met: sampleMet,
        shortVariants: shortVariants
      },
      srm: srm,
      funnel: {
        assigned: funnelAssigned,
        exposed: funnelExposed,
        started: funnelStarted,
        completed: funnelCompleted,
        claimed: funnelClaimed
      },
      byDay: byDay,
      scan: {
        source: usedShards ? "shards" : "assignment_scan",
        shardsRead: shardSums ? shardSums.shardsRead : 0,
        reconciled: reconciled,
        assignmentObjectsScanned: assignmentScan ? assignmentScan.scanned : 0,
        assignmentsTruncated: assignmentScan ? assignmentScan.truncated : false,
        eventRecordsScanned: conversionScan.scannedRecords,
        eventsTruncated: conversionScan.truncated,
        totalGoalEvents: conversionScan.totalGoalEvents
      },
      promotion: def.promotion ? {
        state: def.promotion.state || null,
        auditKey: def.promotion.auditKey || null,
        restored: !!def.promotion.restored,
        restoredAt: def.promotion.restoredAt || null
      } : null
    });
  }

  // satori_experiments_declare_winner — end the experiment and optionally
  // promote the winning quest overlay onto qv_quest_config.
  // Payload: { experimentId, variantId, game_id?, promote? }
  function persistExperimentDef(
    nk: nkruntime.Nakama, configKey: string,
    experiments: { [id: string]: any }, experimentId: string, def: any
  ): void {
    experiments[experimentId] = def;
    Storage.writeSystemJson(nk, Constants.SATORI_CONFIGS_COLLECTION, configKey, experiments);
    ConfigLoader.invalidateCache(configKey);
  }

  function parseVariantOverlay(variant: any): any {
    var raw = variant && (variant.config || variant.data);
    if (typeof raw === "string") {
      try { raw = JSON.parse(raw); } catch (_e) { raw = {}; }
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { quests: {} };
    return raw;
  }

  function findVariantByKey(variants: any[], variantId: string): any {
    for (var i = 0; i < variants.length; i++) {
      if (variantKeyOf(variants[i]) === variantId) return variants[i];
    }
    return null;
  }

  function promoteGateError(nk: nkruntime.Nakama, def: any, gameId: string, experimentId: string, data: any): string {
    var sums = SatoriExperiments.loadFunnelShardSums(nk, gameId, experimentId);
    var exposures: { [k: string]: number } = {};
    if (sums && sums.shardsPresent) {
      exposures = (def.goalMetric === "quest_completed" && countMapTotal(sums.exposed) > 0)
        ? sums.exposed : sums.assigned;
    }
    var srm = computeSrm(def.variants || [], exposures);
    if (srm && srm.passed === false) return "cannot promote: sample ratio mismatch";
    var minCfg = resolveMinSamplePerArm(def, data);
    var variants: any[] = def.variants || [];
    for (var v = 0; v < variants.length; v++) {
      var vk = variantKeyOf(variants[v]);
      if ((exposures[vk] || 0) < minCfg.perArm) {
        return "cannot promote: need at least " + minCfg.perArm + " players per variant";
      }
    }
    return "";
  }

  function rpcDeclareWinner(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    var experimentId = data.experimentId || data.experiment_id;
    var variantId = data.variantId || data.variant_id;
    if (!experimentId || !variantId) return RpcHelpers.errorResponse("experimentId and variantId required");
    var gameId = RpcHelpers.gameId(data);
    var promote = data.promote === true || data.promote === "true";

    var scopedKey = Constants.gameKey(gameId, "experiments");
    var configKey = scopedKey;
    var experiments = Storage.readSystemJson<{ [id: string]: any }>(nk, Constants.SATORI_CONFIGS_COLLECTION, scopedKey);
    if ((!experiments || !experiments[experimentId]) && scopedKey !== "experiments") {
      configKey = "experiments";
      experiments = Storage.readSystemJson<{ [id: string]: any }>(nk, Constants.SATORI_CONFIGS_COLLECTION, configKey);
    }
    if (!experiments || !experiments[experimentId]) {
      return RpcHelpers.errorResponse("Experiment '" + experimentId + "' not found");
    }

    var def = experiments[experimentId];
    var defVariants: any[] = def.variants || [];
    var winnerVariant = findVariantByKey(defVariants, variantId);
    if (!winnerVariant) return RpcHelpers.errorResponse("Variant '" + variantId + "' not found on experiment");

    var now = Math.floor(Date.now() / 1000);
    var isQuestEngine = def.configSystem === "quest_engine";
    var questGameId = def.gameId || gameId;
    if (!questGameId || questGameId === "default" || questGameId === Constants.DEFAULT_GAME_ID) {
      questGameId = Constants.QUIZVERSE_GAME_ID;
    }

    if (promote && isQuestEngine) {
      var promo = def.promotion || {};
      if (promo.state === "finalized" && promo.variantId === variantId) {
        return RpcHelpers.successResponse({
          experimentId: experimentId, winnerVariantId: variantId, status: def.status || "ended",
          promoted: true, auditKey: promo.auditKey || null, promotionState: "finalized"
        });
      }
      if (promo.state === "finalized" && promo.variantId && promo.variantId !== variantId) {
        return RpcHelpers.errorResponse("already promoted variant '" + promo.variantId + "'");
      }
      if (promo.variantId && promo.variantId !== variantId &&
          (promo.state === "prepared" || promo.state === "written" || promo.state === "verified")) {
        return RpcHelpers.errorResponse("promotion already in progress for variant '" + promo.variantId + "'");
      }

      var gateErr = promoteGateError(nk, def, questGameId, experimentId, data);
      if (gateErr) return RpcHelpers.errorResponse(gateErr);

      var overlay = parseVariantOverlay(winnerVariant);
      var stepCtx: any = {
        experimentId: experimentId,
        variantId: variantId,
        auditKey: promo.auditKey,
        desiredHash: promo.desiredHash
      };

      if (promo.state !== "prepared" && promo.state !== "written" && promo.state !== "verified") {
        var prepared = QuestEngine.runPromoteStep(nk, logger, questGameId, overlay, "prepare", stepCtx);
        if (!prepared.ok) return RpcHelpers.errorResponse(prepared.error || "promote prepare failed");
        def.promotion = {
          state: "prepared",
          variantId: variantId,
          auditKey: prepared.auditKey,
          desiredHash: prepared.desiredHash,
          preparedAt: now
        };
        def.updatedAt = now;
        persistExperimentDef(nk, configKey, experiments, experimentId, def);
        promo = def.promotion;
        stepCtx.auditKey = promo.auditKey;
        stepCtx.desiredHash = promo.desiredHash;
      }

      if (promo.state !== "verified") {
        var written = QuestEngine.runPromoteStep(nk, logger, questGameId, overlay, "write", stepCtx);
        if (!written.ok) {
          logger.warn("[ExperimentResults] promote write failed experiment=%s: %s", experimentId, written.error || "");
          return RpcHelpers.errorResponse(written.error || "promote write failed");
        }
        var verified = QuestEngine.runPromoteStep(nk, logger, questGameId, overlay, "verify", stepCtx);
        if (!verified.ok) {
          logger.warn("[ExperimentResults] promote verify failed experiment=%s: %s", experimentId, verified.error || "");
          return RpcHelpers.errorResponse(verified.error || "promote verify failed");
        }
      }

      def.status = "ended";
      def.winnerVariantId = variantId;
      def.endedAt = now;
      def.updatedAt = now;
      def.promotion.state = "finalized";
      def.promotion.finalizedAt = now;
      persistExperimentDef(nk, configKey, experiments, experimentId, def);
      logger.info("[quest_ab] promote gameId=%s experimentId=%s variantId=%s userId=%s auditKey=%s",
        questGameId, experimentId, variantId, ctx.userId || "admin", def.promotion.auditKey || "");
      logger.info("[ExperimentResults] promote finalized gameId=%s experiment=%s variant=%s auditKey=%s",
        questGameId, experimentId, variantId, def.promotion.auditKey || "");
      return RpcHelpers.successResponse({
        experimentId: experimentId,
        winnerVariantId: variantId,
        status: "ended",
        promoted: true,
        auditKey: def.promotion.auditKey || null,
        promotionState: "finalized"
      });
    }

    def.status = "ended";
    def.winnerVariantId = variantId;
    def.endedAt = now;
    def.updatedAt = now;
    persistExperimentDef(nk, configKey, experiments, experimentId, def);

    logger.info("[ExperimentResults] '%s' ended, winner='%s' (by admin, promote=%s)", experimentId, variantId, String(promote));
    return RpcHelpers.successResponse({
      experimentId: experimentId, winnerVariantId: variantId, status: "ended", promoted: false
    });
  }

  // satori_experiments_undo_promote — put the pre-promote quest list back.
  // Experiment stays ended. Payload: { experimentId, game_id?, auditKey? }
  function rpcUndoPromote(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    var experimentId = data.experimentId || data.experiment_id;
    if (!experimentId) return RpcHelpers.errorResponse("experimentId required");
    var gameId = RpcHelpers.gameId(data);

    var scopedKey = Constants.gameKey(gameId, "experiments");
    var configKey = scopedKey;
    var experiments = Storage.readSystemJson<{ [id: string]: any }>(nk, Constants.SATORI_CONFIGS_COLLECTION, scopedKey);
    if ((!experiments || !experiments[experimentId]) && scopedKey !== "experiments") {
      configKey = "experiments";
      experiments = Storage.readSystemJson<{ [id: string]: any }>(nk, Constants.SATORI_CONFIGS_COLLECTION, configKey);
    }
    if (!experiments || !experiments[experimentId]) {
      return RpcHelpers.errorResponse("Experiment '" + experimentId + "' not found");
    }

    var def = experiments[experimentId];
    if (def.configSystem !== "quest_engine") {
      return RpcHelpers.errorResponse("undo promote is only for quest_engine experiments");
    }
    var promo = def.promotion || {};
    var auditKey = data.auditKey || data.audit_key || promo.auditKey;
    if (!auditKey) return RpcHelpers.errorResponse("no promote audit snapshot to restore");

    var questGameId = def.gameId || gameId;
    if (!questGameId || questGameId === "default" || questGameId === Constants.DEFAULT_GAME_ID) {
      questGameId = Constants.QUIZVERSE_GAME_ID;
    }

    var restored = QuestEngine.restorePromoteAudit(nk, logger, ctx, questGameId, String(auditKey));
    if (!restored.ok) return RpcHelpers.errorResponse(restored.error || "restore failed");

    var now = Math.floor(Date.now() / 1000);
    def.promotion = def.promotion || {};
    def.promotion.restored = true;
    def.promotion.restoredAt = now;
    def.promotion.restoreAuditKey = restored.restoreAuditKey || promo.restoreAuditKey || null;
    def.updatedAt = now;
    persistExperimentDef(nk, configKey, experiments, experimentId, def);
    logger.info("[ExperimentResults] promote undone gameId=%s experiment=%s auditKey=%s",
      questGameId, experimentId, auditKey);
    return RpcHelpers.successResponse({
      experimentId: experimentId,
      restored: true,
      already: !!restored.already,
      auditKey: auditKey,
      restoreAuditKey: def.promotion.restoreAuditKey || null,
      status: def.status || "ended"
    });
  }

  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("satori_experiments_results", rpcResults);
    initializer.registerRpc("satori_experiments_declare_winner", rpcDeclareWinner);
    initializer.registerRpc("satori_experiments_undo_promote", rpcUndoPromote);
  }
}
