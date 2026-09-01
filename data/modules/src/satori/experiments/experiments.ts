namespace SatoriExperiments {

  function getExperiments(nk: nkruntime.Nakama, gameId?: string): { [id: string]: Satori.ExperimentDefinition } {
    return ConfigLoader.loadSatoriConfigForGame<{ [id: string]: Satori.ExperimentDefinition }>(nk, "experiments", gameId, {});
  }

  function getUserExperiments(nk: nkruntime.Nakama, userId: string, gameId?: string): Satori.UserExperiments {
    var data = Storage.readJson<Satori.UserExperiments>(nk, Constants.SATORI_ASSIGNMENTS_COLLECTION, Constants.gameKey(gameId, "assignments"), userId);
    return data || { assignments: {} };
  }

  function saveUserExperiments(nk: nkruntime.Nakama, userId: string, data: Satori.UserExperiments, gameId?: string): void {
    Storage.writeJson(nk, Constants.SATORI_ASSIGNMENTS_COLLECTION, Constants.gameKey(gameId, "assignments"), userId, data);
  }

  // Returns the canonical identifier for a variant — prefer id, fall back to name.
  function variantKey(v: any): string {
    return v.id || v.name || "0";
  }

  function deterministicAssign(userId: string, experimentId: string, variants: Satori.ExperimentVariant[], splitKey?: string): string {
    var totalWeight = 0;
    for (var i = 0; i < variants.length; i++) {
      totalWeight += variants[i].weight;
    }
    if (totalWeight <= 0) return variantKey(variants[0]);

    var seed = userId + ":" + experimentId;
    if (splitKey === "random") {
      seed = userId + ":" + experimentId + ":" + Date.now();
    }

    var hash = 0;
    for (var c = 0; c < seed.length; c++) {
      hash = ((hash << 5) - hash) + seed.charCodeAt(c);
      hash = hash & 0x7FFFFFFF;
    }
    var bucket = hash % totalWeight;
    var cumulative = 0;
    for (var j = 0; j < variants.length; j++) {
      cumulative += variants[j].weight;
      if (bucket < cumulative) return variantKey(variants[j]);
    }
    return variantKey(variants[variants.length - 1]);
  }

  function isExperimentActive(def: any): boolean {
    if (def.status !== "running") return false;
    var now = Math.floor(Date.now() / 1000);
    if (def.startAt && now < def.startAt) return false;
    if (def.endAt && now > def.endAt) return false;
    return true;
  }

  function isWithinAdmissionDeadline(def: any): boolean {
    if (!def.admissionDeadline) return true;
    return Math.floor(Date.now() / 1000) <= def.admissionDeadline;
  }

  function experimentConfigRevision(def: any): string {
    if (def && def.configRevision != null && String(def.configRevision) !== "") {
      return String(def.configRevision);
    }
    return String((def && (def.updatedAt || def.createdAt)) || 0);
  }

  function currentPhaseId(def: any): string | null {
    if (!def || !def.phases || !Array.isArray(def.phases) || def.phases.length === 0) return null;
    var now = Math.floor(Date.now() / 1000);
    for (var p = 0; p < def.phases.length; p++) {
      var phase = def.phases[p];
      if (!phase) continue;
      if (phase.startAt && now < phase.startAt) continue;
      if (phase.endAt && now > phase.endAt) continue;
      return phase.id || phase.name || String(p);
    }
    return null;
  }

  function overlayQuestIds(variant: any): string[] {
    var raw = variant && (variant.config || variant.data);
    if (typeof raw === "string") {
      try { raw = JSON.parse(raw); } catch (_) { return []; }
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    var quests = raw.quests;
    if (!quests || typeof quests !== "object" || Array.isArray(quests)) return [];
    var ids: string[] = [];
    for (var k in quests) {
      if (quests.hasOwnProperty(k) && k !== "__proto__" && k !== "constructor" && k !== "prototype") {
        ids.push(k);
      }
    }
    return ids;
  }

  function resolveTrackedQuestIds(def: any, variant: any): string[] {
    if (variant && Array.isArray(variant.trackedQuestIds) && variant.trackedQuestIds.length > 0) {
      return variant.trackedQuestIds.slice();
    }
    if (def && Array.isArray(def.trackedQuestIds) && def.trackedQuestIds.length > 0) {
      return def.trackedQuestIds.slice();
    }
    var fromVariant = overlayQuestIds(variant);
    if (fromVariant.length > 0) return fromVariant;
    var union: string[] = [];
    var seen: { [id: string]: boolean } = {};
    var variants = (def && def.variants) || [];
    for (var i = 0; i < variants.length; i++) {
      var ids = overlayQuestIds(variants[i]);
      for (var j = 0; j < ids.length; j++) {
        if (!seen[ids[j]]) {
          seen[ids[j]] = true;
          union.push(ids[j]);
        }
      }
    }
    return union;
  }

  function fillAssignmentFreeze(assignment: any, def: any): boolean {
    var changed = false;
    if (!assignment.configRevision) {
      assignment.configRevision = experimentConfigRevision(def);
      changed = true;
    }
    if (assignment.phaseId === undefined) {
      assignment.phaseId = currentPhaseId(def);
      changed = true;
    }
    return changed;
  }

  function findAssignedVariant(def: any, assignment: any): Satori.ExperimentVariant | null {
    var found: Satori.ExperimentVariant | null = null;
    for (var i = 0; i < def.variants.length; i++) {
      if (variantKey(def.variants[i]) === assignment.variantId) { found = def.variants[i]; break; }
    }
    if (def.phases && Array.isArray(def.phases)) {
      var now = Math.floor(Date.now() / 1000);
      for (var p = 0; p < def.phases.length; p++) {
        var phase = def.phases[p];
        if (now >= phase.startAt && now <= phase.endAt && phase.variants) {
          for (var pv = 0; pv < phase.variants.length; pv++) {
            if (phase.variants[pv].id === assignment.variantId) {
              found = phase.variants[pv];
              break;
            }
          }
          break;
        }
      }
    }
    return found;
  }

  export function getVariant(nk: nkruntime.Nakama, userId: string, experimentId: string, gameId?: string, logger?: nkruntime.Logger): Satori.ExperimentVariant | null {
    var experiments = getExperiments(nk, gameId);
    var def = experiments[experimentId] as any;
    if (!def || !isExperimentActive(def)) return null;
    if (!def.variants || def.variants.length === 0) return null;

    var userExp = getUserExperiments(nk, userId, gameId);
    var assignment = userExp.assignments[experimentId];

    // Sticky: admitted players keep their bucket even if they leave the audience.
    // Audience / admission deadline apply only to first assignment.
    if (assignment && assignment.variantId) {
      if (fillAssignmentFreeze(assignment, def)) {
        userExp.assignments[experimentId] = assignment;
        saveUserExperiments(nk, userId, userExp, gameId);
      }
      if (def.lockParticipation && assignment.locked) {
        // locked assignments cannot change
      }
      return findAssignedVariant(def, assignment);
    }

    if (def.audienceId && !SatoriAudiences.isInAudience(nk, userId, def.audienceId, gameId)) {
      return null;
    }
    if (!isWithinAdmissionDeadline(def)) return null;

    var variantId = deterministicAssign(userId, experimentId, def.variants, def.splitKey);
    assignment = {
      experimentId: experimentId,
      variantId: variantId,
      assignedAt: Math.floor(Date.now() / 1000),
      phaseId: currentPhaseId(def),
      configRevision: experimentConfigRevision(def)
    };
    userExp.assignments[experimentId] = assignment;
    saveUserExperiments(nk, userId, userExp, gameId);
    if (def.configSystem === "quest_engine") {
      try {
        bumpFunnelShardOcc(nk, userId, gameId || "", experimentId, variantId, "assigned", assignment.assignedAt);
      } catch (_assignBump: any) {
        // Assignment is the source of truth; shards rebuild from assignedAt.
      }
      if (logger) {
        logger.info("[quest_ab] assigned gameId=%s experimentId=%s variantId=%s userId=%s",
          gameId || "", experimentId, variantId, userId);
      }
    }
    return findAssignedVariant(def, assignment);
  }

  var CONVERT_OCC_MAX_RETRIES = 3;
  export var FUNNEL_SHARD_COUNT = 32;
  var FUNNEL_BY_DAY_MAX = 60;

  function funnelShardIndex(userId: string): number {
    var hash = 0;
    var seed = userId || "";
    for (var c = 0; c < seed.length; c++) {
      hash = ((hash << 5) - hash) + seed.charCodeAt(c);
      hash = hash & 0x7FFFFFFF;
    }
    return hash % FUNNEL_SHARD_COUNT;
  }

  function canonicalFunnelGameId(gameId: string): string {
    if (!gameId || gameId === "default" || gameId === Constants.DEFAULT_GAME_ID) {
      return Constants.QUIZVERSE_GAME_ID;
    }
    return gameId;
  }

  function funnelShardKey(gameId: string, experimentId: string, shard: number): string {
    return Constants.gameKey(canonicalFunnelGameId(gameId), "funnel:" + experimentId + ":" + String(shard));
  }

  function utcDayKey(unix: number): string {
    var ms = unix < 100000000000 ? unix * 1000 : unix;
    var d = new Date(ms);
    var m = d.getUTCMonth() + 1;
    var day = d.getUTCDate();
    var mm = m < 10 ? "0" + m : String(m);
    var dd = day < 10 ? "0" + day : String(day);
    return d.getUTCFullYear() + "-" + mm + "-" + dd;
  }

  function pruneByDay(doc: any): void {
    if (!doc || !doc.byDay) return;
    var days: string[] = [];
    for (var k in doc.byDay) {
      if (doc.byDay.hasOwnProperty(k)) days.push(k);
    }
    if (days.length <= FUNNEL_BY_DAY_MAX) return;
    days.sort();
    var drop = days.length - FUNNEL_BY_DAY_MAX;
    for (var i = 0; i < drop; i++) {
      delete doc.byDay[days[i]];
    }
  }

  export function emptyFunnelShardDoc(): any {
    return {
      assigned: {},
      exposed: {},
      started: {},
      completed: {},
      claimed: {},
      byDay: {},
      updatedAt: 0
    };
  }

  export function funnelShardIndexOf(userId: string): number {
    return funnelShardIndex(userId);
  }

  function isFunnelStep(step: string): boolean {
    return step === "assigned" || step === "exposed" || step === "started" ||
      step === "completed" || step === "claimed";
  }

  function bumpFunnelShardOcc(
    nk: nkruntime.Nakama, userId: string, gameId: string,
    experimentId: string, variantId: string, step: string, now: number
  ): void {
    if (!isFunnelStep(step) || !variantId || !experimentId) return;
    var key = funnelShardKey(gameId, experimentId, funnelShardIndex(userId));
    for (var attempt = 0; attempt < CONVERT_OCC_MAX_RETRIES; attempt++) {
      try {
        var rows = nk.storageRead([{
          collection: Constants.SATORI_ASSIGNMENTS_COLLECTION,
          key: key,
          userId: Constants.SYSTEM_USER_ID
        }]);
        var rec = (rows && rows.length > 0) ? rows[0] : null;
        var ver: string = (rec && rec.version) ? rec.version : "";
        var doc: any = (rec && rec.value) ? rec.value : emptyFunnelShardDoc();
        if (!doc[step] || typeof doc[step] !== "object") doc[step] = {};
        doc[step][variantId] = (doc[step][variantId] || 0) + 1;
        if (step === "assigned" || step === "completed") {
          if (!doc.byDay || typeof doc.byDay !== "object") doc.byDay = {};
          var day = utcDayKey(now);
          if (!doc.byDay[day] || typeof doc.byDay[day] !== "object") doc.byDay[day] = {};
          if (!doc.byDay[day][step] || typeof doc.byDay[day][step] !== "object") doc.byDay[day][step] = {};
          doc.byDay[day][step][variantId] = (doc.byDay[day][step][variantId] || 0) + 1;
          pruneByDay(doc);
        }
        doc.updatedAt = now;
        var writeObj: nkruntime.StorageWriteRequest = {
          collection: Constants.SATORI_ASSIGNMENTS_COLLECTION,
          key: key,
          userId: Constants.SYSTEM_USER_ID,
          value: doc,
          permissionRead: 1 as nkruntime.ReadPermissionValues,
          permissionWrite: 0 as nkruntime.WritePermissionValues
        };
        if (ver) (writeObj as any).version = ver;
        nk.storageWrite([writeObj]);
        return;
      } catch (_e: any) {
        // version conflict → retry
      }
    }
  }

  function addCountMap(dest: { [k: string]: number }, src: any): void {
    if (!src || typeof src !== "object") return;
    for (var k in src) {
      if (!src.hasOwnProperty(k)) continue;
      dest[k] = (dest[k] || 0) + (typeof src[k] === "number" ? src[k] : 0);
    }
  }

  export function loadFunnelShardSums(
    nk: nkruntime.Nakama, gameId: string, experimentId: string
  ): {
    assigned: { [k: string]: number };
    exposed: { [k: string]: number };
    started: { [k: string]: number };
    completed: { [k: string]: number };
    claimed: { [k: string]: number };
    byDay: any;
    shardsRead: number;
    shardsPresent: boolean;
  } {
    var sums = {
      assigned: {} as { [k: string]: number },
      exposed: {} as { [k: string]: number },
      started: {} as { [k: string]: number },
      completed: {} as { [k: string]: number },
      claimed: {} as { [k: string]: number },
      byDay: {} as any,
      shardsRead: 0,
      shardsPresent: false
    };
    if (!experimentId) return sums;
    var reqs: nkruntime.StorageReadRequest[] = [];
    for (var i = 0; i < FUNNEL_SHARD_COUNT; i++) {
      reqs.push({
        collection: Constants.SATORI_ASSIGNMENTS_COLLECTION,
        key: funnelShardKey(gameId, experimentId, i),
        userId: Constants.SYSTEM_USER_ID
      });
    }
    var rows = nk.storageRead(reqs) || [];
    sums.shardsRead = rows.length;
    sums.shardsPresent = rows.length > 0;
    for (var r = 0; r < rows.length; r++) {
      var val: any = rows[r] && rows[r].value ? rows[r].value : null;
      if (!val) continue;
      addCountMap(sums.assigned, val.assigned);
      addCountMap(sums.exposed, val.exposed);
      addCountMap(sums.started, val.started);
      addCountMap(sums.completed, val.completed);
      addCountMap(sums.claimed, val.claimed);
      if (val.byDay && typeof val.byDay === "object") {
        for (var day in val.byDay) {
          if (!val.byDay.hasOwnProperty(day)) continue;
          if (!sums.byDay[day]) sums.byDay[day] = { assigned: {}, completed: {} };
          addCountMap(sums.byDay[day].assigned, val.byDay[day].assigned);
          addCountMap(sums.byDay[day].completed, val.byDay[day].completed);
        }
      }
    }
    return sums;
  }

  export function replaceFunnelShards(
    nk: nkruntime.Nakama, gameId: string, experimentId: string, docs: any[]
  ): void {
    var writes: nkruntime.StorageWriteRequest[] = [];
    var now = Math.floor(Date.now() / 1000);
    for (var i = 0; i < FUNNEL_SHARD_COUNT; i++) {
      var doc = (docs && docs[i]) ? docs[i] : emptyFunnelShardDoc();
      pruneByDay(doc);
      doc.updatedAt = now;
      writes.push({
        collection: Constants.SATORI_ASSIGNMENTS_COLLECTION,
        key: funnelShardKey(gameId, experimentId, i),
        userId: Constants.SYSTEM_USER_ID,
        value: doc,
        permissionRead: 1 as nkruntime.ReadPermissionValues,
        permissionWrite: 0 as nkruntime.WritePermissionValues
      });
    }
    nk.storageWrite(writes);
  }

  function markAssignmentStampOcc(
    nk: nkruntime.Nakama, userId: string, gameId: string,
    experimentId: string, variantId: string, field: string, now: number
  ): string {
    var key = Constants.gameKey(gameId, "assignments");
    for (var attempt = 0; attempt < CONVERT_OCC_MAX_RETRIES; attempt++) {
      try {
        var rows = nk.storageRead([{
          collection: Constants.SATORI_ASSIGNMENTS_COLLECTION,
          key: key,
          userId: userId
        }]);
        var rec = (rows && rows.length > 0) ? rows[0] : null;
        var ver: string = (rec && rec.version) ? rec.version : "";
        var data: Satori.UserExperiments = (rec && rec.value)
          ? (rec.value as Satori.UserExperiments)
          : { assignments: {} };
        if (!data.assignments) data.assignments = {};
        var assignment = data.assignments[experimentId];
        if (!assignment || !assignment.variantId) return "unassigned";
        if (assignment.variantId !== variantId) return "mismatch";
        if ((assignment as any)[field]) return "already";
        (assignment as any)[field] = now;
        var writeObj: nkruntime.StorageWriteRequest = {
          collection: Constants.SATORI_ASSIGNMENTS_COLLECTION,
          key: key,
          userId: userId,
          value: data,
          permissionRead: 1 as nkruntime.ReadPermissionValues,
          permissionWrite: 0 as nkruntime.WritePermissionValues
        };
        if (ver) (writeObj as any).version = ver;
        nk.storageWrite([writeObj]);
        return "stamped";
      } catch (_e: any) {
        // version conflict → retry
      }
    }
    return "conflict";
  }

  // Exposed / started / claimed: stamp assignment then bump the user shard.
  // Completed stays on markQuestConvertedOcc (convertedAt).
  export function recordQuestFunnelStep(
    nk: nkruntime.Nakama, logger: nkruntime.Logger, data: any
  ): void {
    if (!data) return;
    var userId = data.userId ? String(data.userId) : "";
    var gameId = data.gameId || data.game_id ? String(data.gameId || data.game_id) : "";
    var experimentId = data.experimentId ? String(data.experimentId) : "";
    var variantId = data.variantId ? String(data.variantId) : "";
    var step = data.step ? String(data.step) : "";
    if (!userId || !gameId || !experimentId || !variantId) return;
    if (step !== "exposed" && step !== "started" && step !== "claimed") return;
    if (gameId === "default" || gameId === Constants.DEFAULT_GAME_ID) {
      gameId = Constants.QUIZVERSE_GAME_ID;
    }
    var field = step === "exposed" ? "exposedAt" : (step === "started" ? "startedAt" : "claimedAt");
    var now = Math.floor(Date.now() / 1000);
    var mark = markAssignmentStampOcc(nk, userId, gameId, experimentId, variantId, field, now);
    if (mark !== "stamped") return;
    try {
      bumpFunnelShardOcc(nk, userId, gameId, experimentId, variantId, step, now);
    } catch (err: any) {
      logger.warn(
        "[SatoriExperiments] funnel shard bump failed step=%s experiment=%s user=%s: %s",
        step, experimentId, userId, err && err.message ? err.message : String(err)
      );
    }
  }

  function markQuestConvertedOcc(
    nk: nkruntime.Nakama, userId: string, gameId: string,
    experimentId: string, variantId: string, now: number
  ): string {
    var key = Constants.gameKey(gameId, "assignments");
    for (var attempt = 0; attempt < CONVERT_OCC_MAX_RETRIES; attempt++) {
      try {
        var rows = nk.storageRead([{
          collection: Constants.SATORI_ASSIGNMENTS_COLLECTION,
          key: key,
          userId: userId
        }]);
        var rec = (rows && rows.length > 0) ? rows[0] : null;
        var ver: string = (rec && rec.version) ? rec.version : "";
        var data: Satori.UserExperiments = (rec && rec.value)
          ? (rec.value as Satori.UserExperiments)
          : { assignments: {} };
        if (!data.assignments) data.assignments = {};
        var assignment = data.assignments[experimentId];
        if (!assignment || !assignment.variantId) return "unassigned";
        if (assignment.variantId !== variantId) return "mismatch";
        if (assignment.convertedAt) return "already";
        assignment.convertedAt = now;
        var writeObj: nkruntime.StorageWriteRequest = {
          collection: Constants.SATORI_ASSIGNMENTS_COLLECTION,
          key: key,
          userId: userId,
          value: data,
          permissionRead: 1 as nkruntime.ReadPermissionValues,
          permissionWrite: 0 as nkruntime.WritePermissionValues
        };
        if (ver) (writeObj as any).version = ver;
        nk.storageWrite([writeObj]);
        return "converted";
      } catch (_e: any) {
        // version conflict → retry
      }
    }
    return "conflict";
  }

  function bumpConversionCounterOcc(
    nk: nkruntime.Nakama, userId: string, gameId: string, experimentId: string, variantId: string, now: number
  ): void {
    bumpFunnelShardOcc(nk, userId, gameId, experimentId, variantId, "completed", now);
  }

  // Once-per-user conversion. Requires frozen attribution on the event
  // (gameId + experimentId + variantId + questId). Unrelated completes no-op.
  export function recordQuestCompletedConversion(
    nk: nkruntime.Nakama, logger: nkruntime.Logger, data: any
  ): void {
    if (!data) return;
    var userId = data.userId ? String(data.userId) : "";
    var gameId = data.gameId || data.game_id ? String(data.gameId || data.game_id) : "";
    var questId = data.questId ? String(data.questId) : "";
    var experimentId = data.experimentId ? String(data.experimentId) : "";
    var variantId = data.variantId ? String(data.variantId) : "";
    if (!userId || !gameId || !questId || !experimentId || !variantId) return;
    if (gameId === "default" || gameId === Constants.DEFAULT_GAME_ID) {
      gameId = Constants.QUIZVERSE_GAME_ID;
    }
    var exposedAt = typeof data.exposedAt === "number" ? data.exposedAt : 0;
    var now = Math.floor(Date.now() / 1000);
    if (exposedAt && now < exposedAt) return;

    var mark = markQuestConvertedOcc(nk, userId, gameId, experimentId, variantId, now);
    if (mark !== "converted") return;
    try {
      bumpConversionCounterOcc(nk, userId, gameId, experimentId, variantId, now);
    } catch (err: any) {
      logger.warn(
        "[SatoriExperiments] conversion counter bump failed experiment=%s user=%s: %s",
        experimentId, userId, err && err.message ? err.message : String(err)
      );
    }
    logger.info(
      "[SatoriExperiments] quest_completed conversion experiment=%s variant=%s quest=%s user=%s gameId=%s",
      experimentId, variantId, questId, userId, gameId
    );
  }

  // Frozen context for quest A/B. Null if no running quest_engine experiment
  // assigned this user. Callers stamp this onto QuestProgress once and never rewrite.
  export function getRunningQuestEngineAttribution(
    nk: nkruntime.Nakama, userId: string, gameId: string
  ): {
    experimentId: string;
    variantId: string;
    phaseId: string | null;
    configRevision: string;
    gameId: string;
    trackedQuestIds: string[];
  } | null {
    if (!userId || !gameId) return null;
    var experiments = getExperiments(nk, gameId);
    for (var expId in experiments) {
      if (!experiments.hasOwnProperty(expId)) continue;
      var def = experiments[expId] as any;
      if (!def || def.configSystem !== "quest_engine" || !isExperimentActive(def)) continue;
      var variant = getVariant(nk, userId, expId, gameId);
      if (!variant) continue;
      var userExp = getUserExperiments(nk, userId, gameId);
      var assignment = userExp.assignments[expId];
      if (!assignment || !assignment.variantId) continue;
      return {
        experimentId: expId,
        variantId: assignment.variantId,
        phaseId: assignment.phaseId !== undefined ? assignment.phaseId : currentPhaseId(def),
        configRevision: assignment.configRevision || experimentConfigRevision(def),
        gameId: gameId,
        trackedQuestIds: resolveTrackedQuestIds(def, variant)
      };
    }
    return null;
  }

  // ---- RPCs ----

  function rpcGet(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload);
    var gameId = RpcHelpers.gameId(data);
    var experiments = getExperiments(nk, gameId);

    var result: any[] = [];
    for (var id in experiments) {
      var def = experiments[id] as any;
      if (!isExperimentActive(def)) continue;
      // getVariant is sticky: already-assigned players stay listed after audience change.
      var variant = getVariant(nk, userId, id, gameId);
      if (!variant) continue;
      result.push({
        id: id,
        name: def.name,
        description: def.description,
        type: def.experimentType || "custom",
        variant: variant ? { id: variantKey(variant), name: variant.name, config: variant.config || (variant as any).data || {} } : null,
        startAt: def.startAt,
        endAt: def.endAt,
        goalMetric: def.goalMetric
      });
    }

    return RpcHelpers.successResponse({ experiments: result });
  }

  function rpcGetVariant(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.experimentId) return RpcHelpers.errorResponse("experimentId required");

    var variant = getVariant(nk, userId, data.experimentId, RpcHelpers.gameId(data));
    var resp = variant ? { id: variantKey(variant), name: variant.name, config: variant.config || (variant as any).data || {} } : null;
    return RpcHelpers.successResponse({ variant: resp });
  }

  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("satori_experiments_get", rpcGet);
    initializer.registerRpc("satori_experiments_get_variant", rpcGetVariant);
    initializer.registerRpc("satori_experiments_get_all", rpcGet);
  }
}
