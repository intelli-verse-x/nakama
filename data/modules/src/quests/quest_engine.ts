namespace QuestEngine {

  // ─── Types ────────────────────────────────────────────────────────────────

  interface QuestStepConfig {
    id: string;
    description: string;
    eventType: string;
    requiredCount: number;
    requiredValue?: number;
    filterField?: string;
    filterValue?: string;
  }

  interface QuestConfig {
    id: string;
    name: string;
    description?: string;
    category?: string;
    steps: QuestStepConfig[];
    reward?: Hiro.Reward;
    expiresAt?: number;
    prerequisiteIds?: string[];
    repeatable?: boolean;
    resetIntervalSec?: number;
    // Surprise reward: invisible until the player has started or completed it.
    // Events still progress it server-side. Overlay hidden cannot hide in-flight
    // or completed-unclaimed work — get still returns those rows.
    hidden?: boolean;
    // Soft-disable: keeps the quest in config but hides it from players who
    // have not started it. Overlay enabled:false cannot hide in-flight work
    // or block claim of a completed-unclaimed reward.
    enabled?: boolean;
    // Bucket-specific: how many bucket quests a player may have active at once.
    // Only meaningful when category === "bucket".
    maxConcurrent?: number;
    // Whether the player must explicitly opt-in to this quest before it progresses.
    // Useful for "choose your own quest" bucket systems.
    requiresOptIn?: boolean;
    additionalProperties?: { [key: string]: string };
  }

  interface QuestsConfig {
    quests: { [questId: string]: QuestConfig };
  }

  interface StepProgress {
    count: number;
    completedAt: number | null;
  }

  interface QuestProgress {
    questId: string;
    steps: { [stepId: string]: StepProgress };
    startedAt: number | null;
    completedAt: number | null;
    claimedAt: number | null;
    resetCount: number;
    lastResetAt: number | null;
    // Promised payout at first startedAt. Claim/auto-grant use this so an
    // experiment end or promote cannot change a prize the player already earned.
    rewardSnapshot?: Hiro.Reward | null;
    // Frozen A/B context at first exposure (get) or first start. Never rewrite.
    // Do not send this field to Unity clients.
    abAttribution?: QuestAbAttribution | null;
  }

  interface QuestAbAttribution {
    experimentId: string;
    variantId: string;
    phaseId: string | null;
    configRevision: string;
    gameId: string;
    questId: string;
    exposedAt: number;
  }

  interface QuestAbContext {
    experimentId: string;
    variantId: string;
    phaseId: string | null;
    configRevision: string;
    gameId: string;
    trackedQuestIds: string[];
  }

  interface UserQuestState {
    quests: { [questId: string]: QuestProgress };
  }

  // ─── Constants ────────────────────────────────────────────────────────────

  // Collection used for per-player state (owner-readable, server-write only)
  var QUEST_ENGINE_COLLECTION = "qv_quests";
  // Collection used for admin-managed quest config (public-read, system-write)
  var QUEST_CONFIG_COLLECTION = "qv_quest_config";
  // Players who called quest_engine_get for an App-ID — fan-out target for new quests
  var QUEST_SUBSCRIBERS_COLLECTION = "qv_quest_subscribers";
  var QUEST_CONFIG_AUDIT_COLLECTION = "qv_quest_config_audit";
  var DEFAULT_QUESTS_CONFIG: QuestsConfig = { quests: {} };
  // In-app inbox code for "new quest published" (reward deliveries use 9101)
  var NOTIFICATION_CODE_NEW_QUEST = 9102;
  var MAX_QUEST_SUBSCRIBERS = 2000;
  var MAX_NOTIFY_BATCH = 100;

  // ─── Calendar helpers ────────────────────────────────────────────────────
  // Returns the next midnight UTC boundary from a given unix timestamp (seconds).
  function nextMidnightUtc(nowSec: number): number {
    var ms = nowSec * 1000;
    var d = new Date(ms);
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + 1);
    return Math.floor(d.getTime() / 1000);
  }

  // Returns the unix timestamp for the start of the next Monday UTC.
  function nextMondayMidnightUtc(nowSec: number): number {
    var ms = nowSec * 1000;
    var d = new Date(ms);
    d.setUTCHours(0, 0, 0, 0);
    var day = d.getUTCDay(); // 0=Sun, 1=Mon … 6=Sat
    var daysUntilMonday = day === 1 ? 7 : (8 - day) % 7 || 7;
    d.setUTCDate(d.getUTCDate() + daysUntilMonday);
    return Math.floor(d.getTime() / 1000);
  }

  // Returns the unix timestamp for the 1st day of the next UTC month.
  function nextMonthStartUtc(nowSec: number): number {
    var ms = nowSec * 1000;
    var d = new Date(ms);
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCMonth(d.getUTCMonth() + 1, 1);
    return Math.floor(d.getTime() / 1000);
  }

  // Admin users allowed to save quest config (server-key or specific roles).
  // An empty userId in ctx means the call came via server key — always allowed.
  function isAdminCaller(ctx: nkruntime.Context): boolean {
    return !ctx.userId || ctx.userId === Constants.SYSTEM_USER_ID;
  }

  // ─── Storage ──────────────────────────────────────────────────────────────

  // ─── Storage helpers ──────────────────────────────────────────────────────

  // Config key: "{gameId}" — matches KT Section 13.
  function configKey(gameId: string): string {
    return gameId;
  }

  // Player state key: "{gameId}_{userId}" — matches KT Section 13.
  function stateKey(gameId: string, userId: string): string {
    return gameId + "_" + userId;
  }

  function loadConfig(nk: nkruntime.Nakama, gameId: string): QuestsConfig {
    var rows: nkruntime.StorageObject[] = [];
    try {
      rows = nk.storageRead([{
        collection: QUEST_CONFIG_COLLECTION,
        key: configKey(gameId),
        userId: Constants.SYSTEM_USER_ID
      }]);
    } catch (_) {}
    if (rows && rows.length > 0 && rows[0].value) {
      return rows[0].value as QuestsConfig;
    }
    // Migrate orphaned "default" tenant → QuizVerse UUID (copy-forward write).
    if (gameId === Constants.QUIZVERSE_GAME_ID) {
      try {
        rows = nk.storageRead([{
          collection: QUEST_CONFIG_COLLECTION,
          key: "default",
          userId: Constants.SYSTEM_USER_ID
        }]);
      } catch (_) {
        rows = [];
      }
      if (rows && rows.length > 0 && rows[0].value) {
        var migrated = rows[0].value as QuestsConfig;
        try {
          saveConfig(nk, Constants.QUIZVERSE_GAME_ID, migrated);
        } catch (_) { /* best-effort migrate */ }
        return migrated;
      }
    }
    return DEFAULT_QUESTS_CONFIG;
  }

  // Admin preview / personalizer: raw jar only (no overlay).
  export function loadRawConfig(nk: nkruntime.Nakama, gameId: string): QuestsConfig {
    return loadConfig(nk, gameId);
  }

  // Player-facing config: base quest list + Satori/Hiro overlay.
  // Admin save/get MUST keep using loadConfig (raw). Overlay failure never
  // breaks gameplay — fall back to the stored list.
  var QUEST_ENGINE_SYSTEM = "quest_engine";

  function loadPlayerConfig(
    nk: nkruntime.Nakama, logger: nkruntime.Logger,
    userId: string, gameId: string
  ): QuestsConfig {
    var base = loadConfig(nk, gameId);
    if (!userId) return base;
    try {
      if (typeof HiroPersonalizers !== "undefined" && HiroPersonalizers.personalize) {
        return HiroPersonalizers.personalize(nk, userId, QUEST_ENGINE_SYSTEM, base, gameId, logger);
      }
    } catch (err: any) {
      logger.warn(
        "[QuestEngine] overlay skipped gameId=%s user=%s: %s",
        gameId, userId, err && err.message ? err.message : String(err)
      );
    }
    return base;
  }

  function loadConfigRecord(nk: nkruntime.Nakama, gameId: string): { config: QuestsConfig; version: string } {
    var rows: nkruntime.StorageObject[] = [];
    try {
      rows = nk.storageRead([{
        collection: QUEST_CONFIG_COLLECTION,
        key: configKey(gameId),
        userId: Constants.SYSTEM_USER_ID
      }]);
    } catch (_) {}
    if (rows && rows.length > 0 && rows[0].value) {
      return { config: rows[0].value as QuestsConfig, version: rows[0].version || "" };
    }
    return { config: loadConfig(nk, gameId), version: "" };
  }

  function saveConfigOcc(nk: nkruntime.Nakama, gameId: string, config: QuestsConfig, version: string): boolean {
    try {
      var writeObj: nkruntime.StorageWriteRequest = {
        collection: QUEST_CONFIG_COLLECTION,
        key: configKey(gameId),
        userId: Constants.SYSTEM_USER_ID,
        value: config,
        permissionRead:  2 as nkruntime.ReadPermissionValues,
        permissionWrite: 0 as nkruntime.WritePermissionValues
      };
      if (version) (writeObj as any).version = version;
      nk.storageWrite([writeObj]);
      return true;
    } catch (_e: any) {
      return false;
    }
  }

  function cloneJson(obj: any): any {
    return JSON.parse(JSON.stringify(obj == null ? {} : obj));
  }

  function hashQuestsConfig(config: any): string {
    var quests = (config && config.quests) || {};
    var ids: string[] = [];
    for (var k in quests) {
      if (quests.hasOwnProperty(k)) ids.push(k);
    }
    ids.sort();
    var parts: string[] = [];
    for (var i = 0; i < ids.length; i++) {
      parts.push(ids[i] + ":" + JSON.stringify(quests[ids[i]]));
    }
    var s = parts.join("\n");
    var hash = 0;
    for (var c = 0; c < s.length; c++) {
      hash = ((hash << 5) - hash) + s.charCodeAt(c);
      hash = hash & 0x7FFFFFFF;
    }
    return String(hash) + ":" + String(s.length);
  }

  function applyWinnerOverlay(base: QuestsConfig, overlay: any): QuestsConfig {
    var copy = cloneJson(base) as QuestsConfig;
    if (!copy.quests) copy.quests = {};
    if (typeof HiroPersonalizers !== "undefined" && HiroPersonalizers.applyQuestEngineOverlay) {
      return HiroPersonalizers.applyQuestEngineOverlay(copy, overlay || { quests: {} });
    }
    return copy;
  }

  // Prepare → write → verify. Caller persists experiment promotion state between
  // steps so a crash can resume. Never ends the experiment here.
  export function runPromoteStep(
    nk: nkruntime.Nakama, logger: nkruntime.Logger,
    gameId: string, overlay: any, step: string, ctx: any
  ): { ok: boolean; auditKey?: string; desiredHash?: string; error?: string } {
    if (!gameId) return { ok: false, error: "gameId required" };
    var experimentId = ctx && ctx.experimentId ? String(ctx.experimentId) : "";
    var variantId = ctx && ctx.variantId ? String(ctx.variantId) : "";
    var now = Math.floor(Date.now() / 1000);

    if (step === "prepare") {
      var rec = loadConfigRecord(nk, gameId);
      var desired = applyWinnerOverlay(rec.config, overlay);
      var desiredHash = hashQuestsConfig(desired);
      var auditKey = "promote_" + experimentId + "_" + now;
      try {
        nk.storageWrite([{
          collection: QUEST_CONFIG_AUDIT_COLLECTION,
          key: auditKey,
          userId: Constants.SYSTEM_USER_ID,
          value: {
            gameId: gameId,
            experimentId: experimentId,
            variantId: variantId,
            actor: "promote",
            timestamp: now,
            previous: rec.config,
            desired: desired,
            desiredHash: desiredHash,
            promotion: true
          },
          permissionRead: 2 as nkruntime.ReadPermissionValues,
          permissionWrite: 0 as nkruntime.WritePermissionValues
        }]);
      } catch (err: any) {
        logger.warn("[QuestEngine] promote audit failed: %s", err && err.message ? err.message : String(err));
        return { ok: false, error: "failed to snapshot quest config" };
      }
      logger.info("[QuestEngine] promote prepared gameId=%s experiment=%s variant=%s auditKey=%s",
        gameId, experimentId, variantId, auditKey);
      return { ok: true, auditKey: auditKey, desiredHash: desiredHash };
    }

    if (step === "write") {
      var auditKeyW = ctx && ctx.auditKey ? String(ctx.auditKey) : "";
      var desiredHashW = ctx && ctx.desiredHash ? String(ctx.desiredHash) : "";
      if (!auditKeyW) return { ok: false, error: "auditKey required" };
      var auditRows: nkruntime.StorageObject[] = [];
      try {
        auditRows = nk.storageRead([{
          collection: QUEST_CONFIG_AUDIT_COLLECTION,
          key: auditKeyW,
          userId: Constants.SYSTEM_USER_ID
        }]);
      } catch (_) {}
      var audit = (auditRows && auditRows.length > 0 && auditRows[0].value) ? auditRows[0].value : null;
      if (!audit || !audit.desired) return { ok: false, error: "promote audit missing" };
      var live = loadConfigRecord(nk, gameId);
      if (hashQuestsConfig(live.config) === (audit.desiredHash || desiredHashW)) {
        return { ok: true, auditKey: auditKeyW, desiredHash: audit.desiredHash || desiredHashW };
      }
      if (!saveConfigOcc(nk, gameId, audit.desired as QuestsConfig, live.version)) {
        return { ok: false, error: "quest config changed during promote; retry" };
      }
      logger.info("[QuestEngine] promote wrote gameId=%s experiment=%s auditKey=%s",
        gameId, experimentId, auditKeyW);
      return { ok: true, auditKey: auditKeyW, desiredHash: audit.desiredHash || desiredHashW };
    }

    if (step === "verify") {
      var want = ctx && ctx.desiredHash ? String(ctx.desiredHash) : "";
      var liveV = loadConfig(nk, gameId);
      var got = hashQuestsConfig(liveV);
      if (!want || got !== want) {
        return { ok: false, error: "promote verify failed: quest config hash mismatch", desiredHash: want };
      }
      return { ok: true, desiredHash: got, auditKey: ctx && ctx.auditKey ? String(ctx.auditKey) : "" };
    }

    return { ok: false, error: "unknown promote step" };
  }

  function saveConfig(nk: nkruntime.Nakama, gameId: string, config: QuestsConfig): void {
    nk.storageWrite([{
      collection: QUEST_CONFIG_COLLECTION,
      key: configKey(gameId),
      userId: Constants.SYSTEM_USER_ID,
      value: config,
      permissionRead:  2 as nkruntime.ReadPermissionValues,
      permissionWrite: 0 as nkruntime.WritePermissionValues
    }]);
  }

  function auditConfigChange(
    nk: nkruntime.Nakama, ctx: nkruntime.Context, logger: nkruntime.Logger,
    gameId: string, config: QuestsConfig, newQuestIds: string[]
  ): void {
    try {
      var actor = ctx.userId || "server-key";
      var remote = ctx.clientIp || "";
      nk.storageWrite([{
        collection: QUEST_CONFIG_AUDIT_COLLECTION,
        key: gameId + "_" + Math.floor(Date.now() / 1000),
        userId: Constants.SYSTEM_USER_ID,
        value: {
          gameId: gameId,
          actor: actor,
          remote: remote,
          questCount: Object.keys(config.quests).length,
          newQuestIds: newQuestIds,
          timestamp: Math.floor(Date.now() / 1000)
        },
        permissionRead: 2,
        permissionWrite: 0
      }]);
    } catch (e: any) {
      logger.warn("[QuestEngine] auditConfigChange failed: " + (e && e.message ? e.message : String(e)));
    }
  }

  function loadSubscribers(nk: nkruntime.Nakama, gameId: string): string[] {
    try {
      var rows = nk.storageRead([{
        collection: QUEST_SUBSCRIBERS_COLLECTION,
        key: configKey(gameId),
        userId: Constants.SYSTEM_USER_ID
      }]);
      if (rows && rows.length > 0 && rows[0].value && Array.isArray(rows[0].value.userIds)) {
        return rows[0].value.userIds as string[];
      }
      // Migrate orphaned "default" subscribers → QuizVerse UUID (copy-forward write).
      if (gameId === Constants.QUIZVERSE_GAME_ID) {
        rows = nk.storageRead([{
          collection: QUEST_SUBSCRIBERS_COLLECTION,
          key: "default",
          userId: Constants.SYSTEM_USER_ID
        }]);
        if (rows && rows.length > 0 && rows[0].value && Array.isArray(rows[0].value.userIds)) {
          var migratedIds = rows[0].value.userIds as string[];
          try {
            saveSubscribers(nk, Constants.QUIZVERSE_GAME_ID, migratedIds);
          } catch (_) { /* best-effort migrate */ }
          return migratedIds;
        }
      }
    } catch (_) {}
    return [];
  }

  function saveSubscribers(nk: nkruntime.Nakama, gameId: string, userIds: string[]): void {
    nk.storageWrite([{
      collection: QUEST_SUBSCRIBERS_COLLECTION,
      key: configKey(gameId),
      userId: Constants.SYSTEM_USER_ID,
      value: { userIds: userIds, updatedAt: Math.floor(Date.now() / 1000) },
      permissionRead:  1 as nkruntime.ReadPermissionValues,
      permissionWrite: 0 as nkruntime.WritePermissionValues
    }]);
  }

  /** Register player for new-quest inbox notifications for this App-ID. */
  function subscribeUser(nk: nkruntime.Nakama, gameId: string, userId: string): void {
    if (!userId || !gameId) return;
    var ids = loadSubscribers(nk, gameId);
    if (ids.indexOf(userId) >= 0) return;
    ids.push(userId);
    if (ids.length > MAX_QUEST_SUBSCRIBERS) {
      ids = ids.slice(ids.length - MAX_QUEST_SUBSCRIBERS);
    }
    try {
      saveSubscribers(nk, gameId, ids);
    } catch (_) { /* never break get */ }
  }

  function notifyNewQuests(
    nk: nkruntime.Nakama, logger: nkruntime.Logger,
    gameId: string, newQuests: QuestConfig[], extraUserIds?: string[]
  ): number {
    if (!newQuests || newQuests.length === 0) return 0;
    var visible: QuestConfig[] = [];
    for (var i = 0; i < newQuests.length; i++) {
      if (!newQuests[i].hidden) visible.push(newQuests[i]);
    }
    if (visible.length === 0) return 0;

    var userIds = loadSubscribers(nk, gameId);
    if (extraUserIds && extraUserIds.length) {
      for (var e = 0; e < extraUserIds.length; e++) {
        if (extraUserIds[e] && userIds.indexOf(extraUserIds[e]) < 0) userIds.push(extraUserIds[e]);
      }
    }
    if (userIds.length === 0) {
      logger.info("[QuestEngine] New quests saved but no subscribers yet for gameId=%s", gameId);
      return 0;
    }

    var names: string[] = [];
    for (var n = 0; n < visible.length && n < 5; n++) names.push(visible[n].name || visible[n].id);
    var subject = visible.length === 1
      ? ("🆕 New quest: " + (visible[0].name || visible[0].id))
      : ("🆕 " + visible.length + " new quests");
    var body = visible.length === 1
      ? (visible[0].description || "A new quest is available. Open Quests to start.")
      : ("New: " + names.join(", ") + (visible.length > 5 ? "…" : ""));

    var questIds: string[] = [];
    for (var q = 0; q < visible.length; q++) questIds.push(visible[q].id);

    var sent = 0;
    for (var b = 0; b < userIds.length; b += MAX_NOTIFY_BATCH) {
      var slice = userIds.slice(b, b + MAX_NOTIFY_BATCH);
      var batch: nkruntime.NotificationRequest[] = [];
      for (var u = 0; u < slice.length; u++) {
        batch.push({
          userId: slice[u],
          subject: subject,
          content: {
            type: "quest_new",
            eventType: "quest_new",
            gameId: gameId,
            body: body,
            questIds: questIds,
            count: visible.length
          },
          code: NOTIFICATION_CODE_NEW_QUEST,
          persistent: true,
          senderId: Constants.SYSTEM_USER_ID
        });
      }
      try {
        nk.notificationsSend(batch);
        sent += batch.length;
      } catch (err: any) {
        logger.warn("[QuestEngine] notificationsSend failed: " + (err && err.message ? err.message : String(err)));
      }
    }
    logger.info("[QuestEngine] Notified %d subscribers of %d new quest(s) gameId=%s", sent, visible.length, gameId);
    return sent;
  }

  function loadUserState(nk: nkruntime.Nakama, userId: string, gameId: string): UserQuestState {
    var rows: nkruntime.StorageObject[] = [];
    try {
      rows = nk.storageRead([{
        collection: QUEST_ENGINE_COLLECTION,
        key: stateKey(gameId, userId),
        userId: userId
      }]);
    } catch (_) {}
    if (rows && rows.length > 0 && rows[0].value) {
      return rows[0].value as UserQuestState;
    }
    return { quests: {} };
  }

  function saveUserState(nk: nkruntime.Nakama, userId: string, gameId: string, state: UserQuestState): void {
    // permissionWrite: 0 — server-only writes prevent client-side cheating.
    // permissionRead: 1 — owner can read their own state.
    nk.storageWrite([{
      collection: QUEST_ENGINE_COLLECTION,
      key: stateKey(gameId, userId),
      userId: userId,
      value: state,
      permissionRead:  1 as nkruntime.ReadPermissionValues,
      permissionWrite: 0 as nkruntime.WritePermissionValues
    }]);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function getOrCreateQuestProgress(state: UserQuestState, questId: string): QuestProgress {
    if (!state.quests[questId]) {
      state.quests[questId] = {
        questId: questId,
        steps: {},
        startedAt: null,
        completedAt: null,
        claimedAt: null,
        resetCount: 0,
        lastResetAt: null,
        rewardSnapshot: null,
        abAttribution: null
      };
    }
    return state.quests[questId];
  }

  function cloneReward(reward: Hiro.Reward): Hiro.Reward {
    try {
      return JSON.parse(JSON.stringify(reward));
    } catch (_) {
      return reward;
    }
  }

  function stampRewardSnapshot(progress: QuestProgress, reward: Hiro.Reward): void {
    if (progress.rewardSnapshot) return;
    if (!reward) return;
    progress.rewardSnapshot = cloneReward(reward);
  }

  function effectiveReward(progress: QuestProgress, qConfig: QuestConfig): Hiro.Reward {
    if (progress && progress.rewardSnapshot) return progress.rewardSnapshot;
    return (qConfig && qConfig.reward) ? qConfig.reward : undefined;
  }

  function rewardPreviewOf(progress: QuestProgress, qConfig: QuestConfig): any {
    var reward = effectiveReward(progress, qConfig);
    return (reward && reward.guaranteed) ? reward.guaranteed : null;
  }

  function loadQuestAbContext(
    nk: nkruntime.Nakama, userId: string, gameId: string
  ): QuestAbContext | null {
    try {
      if (typeof SatoriExperiments !== "undefined" && SatoriExperiments.getRunningQuestEngineAttribution) {
        return SatoriExperiments.getRunningQuestEngineAttribution(nk, userId, gameId);
      }
    } catch (_) {}
    return null;
  }

  function isTrackedQuest(ctx: QuestAbContext, questId: string): boolean {
    if (!ctx || !questId) return false;
    var tracked = ctx.trackedQuestIds;
    if (!tracked || tracked.length === 0) return false;
    for (var i = 0; i < tracked.length; i++) {
      if (tracked[i] === questId) return true;
    }
    return false;
  }

  // First write wins. Overlay stop / new phase / promote cannot rewrite history.
  // Untracked quests get no stamp so later completes cannot count as conversions.
  function stampAbAttribution(
    progress: QuestProgress, ctx: QuestAbContext, questId: string, now: number
  ): boolean {
    if (!progress || !ctx || !questId) return false;
    if (progress.abAttribution) return false;
    if (!isTrackedQuest(ctx, questId)) return false;
    progress.abAttribution = {
      experimentId: ctx.experimentId,
      variantId: ctx.variantId,
      phaseId: ctx.phaseId || null,
      configRevision: String(ctx.configRevision || ""),
      gameId: ctx.gameId,
      questId: questId,
      exposedAt: now
    };
    return true;
  }

  function recordAbFunnel(
    nk: nkruntime.Nakama, logger: nkruntime.Logger,
    userId: string, progress: QuestProgress, step: string
  ): void {
    var a = progress && progress.abAttribution;
    if (!a || !a.experimentId || !a.variantId || !userId) return;
    try {
      SatoriExperiments.recordQuestFunnelStep(nk, logger, {
        userId: userId,
        gameId: a.gameId,
        experimentId: a.experimentId,
        variantId: a.variantId,
        step: step
      });
    } catch (err: any) {
      logger.warn(
        "[QuestEngine] funnel %s failed: %s",
        step, err && err.message ? err.message : String(err)
      );
    }
  }

  function getStepCount(progress: QuestProgress, stepId: string): number {
    return (progress.steps[stepId] && progress.steps[stepId].count) || 0;
  }

  function getStepCompletedAt(progress: QuestProgress, stepId: string): number | null {
    return (progress.steps[stepId] && progress.steps[stepId].completedAt) || null;
  }

  function isQuestUnlocked(config: QuestConfig, state: UserQuestState): boolean {
    if (!config.prerequisiteIds || config.prerequisiteIds.length === 0) return true;
    for (var i = 0; i < config.prerequisiteIds.length; i++) {
      var pre = state.quests[config.prerequisiteIds[i]];
      if (!pre || !pre.completedAt) return false;
    }
    return true;
  }

  function isQuestExpired(config: QuestConfig, now: number): boolean {
    return !!(config.expiresAt && now > config.expiresAt);
  }

  function isQuestEnabled(config: QuestConfig): boolean {
    return config.enabled !== false; // default true when omitted
  }

  function hasInFlightProgress(progress: QuestProgress): boolean {
    return !!(progress && (progress.startedAt || progress.completedAt));
  }

  function isQuestVisible(config: QuestConfig, progress: QuestProgress): boolean {
    // A/B overlay (or liveops) may set hidden/enabled:false. Never hide a
    // quest the player already started or completed — including unclaimed.
    if (hasInFlightProgress(progress)) return true;
    if (!isQuestEnabled(config)) return false;
    if (config.hidden) return false;
    return true;
  }

  function validateQuestConfig(q: QuestConfig): string | null {
    if (!q || typeof q !== "object") return "Quest must be an object";
    if (!q.id || typeof q.id !== "string" || q.id.length === 0) return "Quest id is required and must be a non-empty string";
    if (!q.name || typeof q.name !== "string" || q.name.length === 0) return "Quest name is required";
    if (!Array.isArray(q.steps) || q.steps.length === 0) return "Quest must have at least one step";

    var stepIds: { [id: string]: boolean } = {};
    for (var i = 0; i < q.steps.length; i++) {
      var s = q.steps[i];
      if (!s.id || typeof s.id !== "string") return "Step " + i + " missing id";
      if (stepIds[s.id]) return "Duplicate step id: " + s.id;
      stepIds[s.id] = true;
      if (!s.eventType || typeof s.eventType !== "string") return "Step " + s.id + " missing eventType";
      if (typeof s.requiredCount !== "number" || s.requiredCount < 1) return "Step " + s.id + " requiredCount must be >= 1";
      if (s.filterField && !s.filterValue) return "Step " + s.id + " has filterField but no filterValue";
    }

    if (q.reward) {
      var err = validateReward(q.reward);
      if (err) return err;
    }

    if (q.expiresAt !== undefined && typeof q.expiresAt !== "number") return "expiresAt must be a unix timestamp number";
    if (q.resetIntervalSec !== undefined && typeof q.resetIntervalSec !== "number") return "resetIntervalSec must be a number";
    if (q.repeatable !== undefined && typeof q.repeatable !== "boolean") return "repeatable must be boolean";
    if (q.hidden !== undefined && typeof q.hidden !== "boolean") return "hidden must be boolean";
    if (q.enabled !== undefined && typeof q.enabled !== "boolean") return "enabled must be boolean";
    if (q.requiresOptIn !== undefined && typeof q.requiresOptIn !== "boolean") return "requiresOptIn must be boolean";
    if (q.maxConcurrent !== undefined && (typeof q.maxConcurrent !== "number" || q.maxConcurrent < 1)) return "maxConcurrent must be >= 1";

    if (q.prerequisiteIds) {
      if (!Array.isArray(q.prerequisiteIds)) return "prerequisiteIds must be an array";
      for (var p = 0; p < q.prerequisiteIds.length; p++) {
        if (typeof q.prerequisiteIds[p] !== "string") return "prerequisiteIds[" + p + "] must be a string";
      }
    }

    return null;
  }

  function validateReward(r: Hiro.Reward): string | null {
    if (!r || typeof r !== "object") return "Reward must be an object";
    if (r.guaranteed) {
      var gErr = validateRewardGrant(r.guaranteed, "guaranteed");
      if (gErr) return gErr;
    }
    if (r.weighted) {
      if (!Array.isArray(r.weighted)) return "weighted must be an array";
      var totalWeight = 0;
      for (var w = 0; w < r.weighted.length; w++) {
        var entry = r.weighted[w];
        if (typeof entry.weight !== "number" || entry.weight <= 0) return "weighted[" + w + "] weight must be > 0";
        totalWeight += entry.weight;
        var wErr = validateRewardGrant(entry, "weighted[" + w + "]");
        if (wErr) return wErr;
      }
      if (totalWeight <= 0) return "weighted total weight must be > 0";
    }
    if (r.maxRolls !== undefined && (typeof r.maxRolls !== "number" || r.maxRolls < 1)) return "maxRolls must be >= 1";
    return null;
  }

  function validateRewardGrant(g: Hiro.RewardGrant, path: string): string | null {
    if (!g || typeof g !== "object") return path + " must be an object";
    if (g.currencies) {
      for (var cid in g.currencies) {
        if (typeof g.currencies[cid] !== "number" || g.currencies[cid] < 0) return path + ".currencies[" + cid + "] must be >= 0";
      }
    }
    if (g.items) {
      for (var iid in g.items) {
        var itemDef = g.items[iid];
        if (!itemDef || typeof itemDef !== "object") return path + ".items[" + iid + "] invalid";
        if (typeof itemDef.min !== "number" || itemDef.min < 0) return path + ".items[" + iid + "].min must be >= 0";
        if (itemDef.max !== undefined && (typeof itemDef.max !== "number" || itemDef.max < itemDef.min)) return path + ".items[" + iid + "].max must be >= min";
      }
    }
    if (g.energies) {
      for (var eid in g.energies) {
        if (typeof g.energies[eid] !== "number" || g.energies[eid] < 0) return path + ".energies[" + eid + "] must be >= 0";
      }
    }
    if (g.gifts) {
      if (!Array.isArray(g.gifts)) return path + ".gifts must be an array";
      for (var gi = 0; gi < g.gifts.length; gi++) {
        var gift = g.gifts[gi];
        if (!gift || typeof gift !== "object") return path + ".gifts[" + gi + "] invalid";
        if (!gift.id || typeof gift.id !== "string") return path + ".gifts[" + gi + "] id required";
        if (!gift.name || typeof gift.name !== "string") return path + ".gifts[" + gi + "] name required";
        if (!gift.type || ["physical", "voucher", "experience", "digital", "merch"].indexOf(gift.type) < 0) {
          return path + ".gifts[" + gi + "] type must be physical/voucher/experience/digital/merch";
        }
      }
    }
    return null;
  }

  function shouldResetQuest(config: QuestConfig, progress: QuestProgress, now: number): boolean {
    if (!config.repeatable || !progress.completedAt) return false;
    // resetIntervalSec takes priority (custom interval).
    if (config.resetIntervalSec) {
      return now >= (progress.completedAt + config.resetIntervalSec);
    }
    // Calendar-based reset derived from category.
    // A quest completed in a previous window should reset once the new window starts.
    var cat = config.category || "";
    if (cat === "daily") {
      return now >= nextMidnightUtc(progress.completedAt);
    }
    if (cat === "weekly") {
      return now >= nextMondayMidnightUtc(progress.completedAt);
    }
    if (cat === "monthly") {
      return now >= nextMonthStartUtc(progress.completedAt);
    }
    return false;
  }

  function resetQuestProgress(progress: QuestProgress, now: number): void {
    progress.steps = {};
    progress.startedAt = null;
    progress.completedAt = null;
    progress.claimedAt = null;
    progress.rewardSnapshot = null;
    progress.abAttribution = null;
    progress.resetCount = (progress.resetCount || 0) + 1;
    progress.lastResetAt = now;
  }

  function areAllStepsDone(config: QuestConfig, progress: QuestProgress): boolean {
    for (var i = 0; i < config.steps.length; i++) {
      var sp = progress.steps[config.steps[i].id];
      if (!sp || sp.count < config.steps[i].requiredCount) return false;
    }
    return true;
  }

  function eventMatchesStep(
    step: QuestStepConfig, eventType: string, value: number,
    metadata: { [k: string]: string }
  ): boolean {
    if (step.eventType !== eventType) return false;
    if (step.requiredValue !== undefined && step.requiredValue !== null && value < step.requiredValue) return false;
    if (step.filterField && step.filterValue) {
      if (!metadata || metadata[step.filterField] !== step.filterValue) return false;
    }
    return true;
  }

  var GAME_ID_REQUIRED = "gameId required (registry UUID). Use default only as the QuizVerse alias.";

  function resolveGameId(data: any): string {
    var id = RpcHelpers.gameId(data) || "";
    // Alias legacy Admin/EventBus "default" tenant onto QuizVerse UUID only.
    // Missing ids must not steal QuizVerse quests.
    if (id === "default" || id === Constants.DEFAULT_GAME_ID) {
      return Constants.QUIZVERSE_GAME_ID;
    }
    return id;
  }

  // ─── RPC: quest_engine_get ─────────────────────────────────────────────────
  // Returns all non-expired quests with per-step progress for the calling user.
  // Writes state on repeatable reset and on first A/B exposure stamp.
  // Never sends experiment ids to Unity.

  function rpcQuestEngineGet(
    ctx: nkruntime.Context, logger: nkruntime.Logger,
    nk: nkruntime.Nakama, payload: string
  ): string {
    var data = RpcHelpers.parseRpcPayload(payload);
    var gameId = resolveGameId(data);
    if (!gameId) return RpcHelpers.errorResponse(GAME_ID_REQUIRED);
    var userId: string;
    if (isAdminCaller(ctx) && data.userId) {
      userId = String(data.userId);
    } else {
      userId = RpcHelpers.requireUserId(ctx);
    }
    var now = Math.floor(Date.now() / 1000);

    // Opt player into new-quest inbox fan-out for this App-ID
    try { subscribeUser(nk, gameId, userId); } catch (_) {}

    var config = loadPlayerConfig(nk, logger, userId, gameId);
    var state = loadUserState(nk, userId, gameId);
    var stateModified = false;
    var abCtx = loadQuestAbContext(nk, userId, gameId);

    var result: any[] = [];
    var questIds = Object.keys(config.quests);
    var funnelExposeProgress: QuestProgress = null;

    for (var i = 0; i < questIds.length; i++) {
      var questId = questIds[i];
      var qConfig = config.quests[questId];

      if (isQuestExpired(qConfig, now)) continue;

      var progress = getOrCreateQuestProgress(state, questId);

      if (shouldResetQuest(qConfig, progress, now)) {
        resetQuestProgress(progress, now);
        stateModified = true;
      }

      if (!isQuestVisible(qConfig, progress)) continue;

      if (stampAbAttribution(progress, abCtx, questId, now)) stateModified = true;
      if (progress.abAttribution) funnelExposeProgress = progress;

      var unlocked = isQuestUnlocked(qConfig, state);

      var stepsOut: any[] = [];
      for (var s = 0; s < qConfig.steps.length; s++) {
        var stepCfg = qConfig.steps[s];
        stepsOut.push({
          id: stepCfg.id,
          description: stepCfg.description,
          requiredCount: stepCfg.requiredCount,
          count: getStepCount(progress, stepCfg.id),
          completedAt: getStepCompletedAt(progress, stepCfg.id)
        });
      }

      result.push({
        id: qConfig.id,
        name: qConfig.name,
        description: qConfig.description || null,
        category: qConfig.category || null,
        unlocked: unlocked,
        hidden: !!qConfig.hidden,
        repeatable: !!qConfig.repeatable,
        steps: stepsOut,
        startedAt: progress.startedAt,
        completedAt: progress.completedAt,
        claimedAt: progress.claimedAt,
        expiresAt: qConfig.expiresAt || null,
        resetCount: progress.resetCount,
        // Guaranteed-only preview so clients can render "you'll earn X" without
        // ever needing their own copy of the reward config. Weighted/random
        // rewards stay unexposed until granted, so surprises stay surprises.
        rewardPreview: rewardPreviewOf(progress, qConfig),
        additionalProperties: qConfig.additionalProperties || null
      });
    }

    // Write on repeatable reset or first A/B exposure stamp.
    if (stateModified) {
      saveUserState(nk, userId, gameId, state);
    }
    if (funnelExposeProgress) {
      recordAbFunnel(nk, logger, userId, funnelExposeProgress, "exposed");
    }

    var payloadOut: any = { quests: result };
    if (data.debug === true && isAdminCaller(ctx) && abCtx) {
      payloadOut.debug = {
        experiment: {
          experimentId: abCtx.experimentId,
          variantId: abCtx.variantId,
          gameId: gameId
        }
      };
    }
    return RpcHelpers.successResponse(payloadOut);
  }

  // ─── Core event processing (shared by RPC and EventBus bridge) ───────────
  // This is the main quest progression logic, extracted so it can be called
  // from both the RPC endpoint and the EventBus bridge.
  //
  // Two-phase design (data-integrity guarantee):
  //   Phase 1 — scan all quests, advance steps, mark completions in memory.
  //   Phase 2 — persist state FIRST (progress is safe even if reward fails).
  //   Phase 3 — grant auto-rewards; each wrapped in try/catch so a reward
  //             engine error never rolls back the player's hard-earned progress.
  //             If auto-grant fails, claimedAt stays null and the client can
  //             retry via quest_engine_claim_reward.

  interface ProcessEventResult {
    updatedCount: number;
    updatedQuests: { [questId: string]: any };
  }

  function processEventInternal(
    nk: nkruntime.Nakama,
    logger: nkruntime.Logger,
    ctx: nkruntime.Context,
    userId: string,
    gameId: string,
    eventType: string,
    value: number,
    metadata: { [k: string]: string }
  ): ProcessEventResult {
    var now = Math.floor(Date.now() / 1000);

    var config = loadPlayerConfig(nk, logger, userId, gameId);
    var state = loadUserState(nk, userId, gameId);
    var abCtx = loadQuestAbContext(nk, userId, gameId);

    var updatedCount = 0;
    var updatedQuests: { [questId: string]: any } = {};
    // Track quests that completed this call and need auto-reward granting
    var rewardPending: Array<{ questId: string; reward: Hiro.Reward }> = [];

    // ── Phase 1: scan + advance ──────────────────────────────────────────────
    var questIds = Object.keys(config.quests);
    for (var i = 0; i < questIds.length; i++) {
      var questId = questIds[i];
      var qConfig = config.quests[questId];

      if (isQuestExpired(qConfig, now)) continue;
      if (!isQuestUnlocked(qConfig, state)) continue;

      var progress = getOrCreateQuestProgress(state, questId);

      // Auto-reset expired repeatable quests before processing new event
      if (shouldResetQuest(qConfig, progress, now)) {
        resetQuestProgress(progress, now);
      }

      // Overlay enabled:false must not start new work. In-flight (started or
      // completed-unclaimed) still progresses so the player can finish/claim.
      // Hidden surprise quests still progress in the background.
      if (!isQuestEnabled(qConfig) && !hasInFlightProgress(progress)) continue;

      // Skip quests that are still completed (non-repeatable, or repeatable window not expired yet)
      if (progress.completedAt) continue;

      var questUpdated = false;

      for (var s = 0; s < qConfig.steps.length; s++) {
        var stepCfg = qConfig.steps[s];

        if (progress.steps[stepCfg.id] && progress.steps[stepCfg.id].completedAt) continue;
        if (!eventMatchesStep(stepCfg, eventType, value, metadata)) continue;

        if (!progress.steps[stepCfg.id]) {
          progress.steps[stepCfg.id] = { count: 0, completedAt: null };
        }
        if (!progress.startedAt) {
          progress.startedAt = now;
          stampRewardSnapshot(progress, qConfig.reward);
          stampAbAttribution(progress, abCtx, questId, now);
          recordAbFunnel(nk, logger, userId, progress, "started");
        }

        var prevCount = progress.steps[stepCfg.id].count;
        // For count-based steps (requiredValue not set) increment by 1 each event.
        // For accumulation steps (e.g. "earn 500 XP") increment by the event value.
        // Either way, never add more than the remaining delta so the count stays
        // accurate even when the same event fires multiple times in a session.
        var increment = (stepCfg.requiredValue !== undefined && stepCfg.requiredValue !== null && value > 0) ? value : 1;
        progress.steps[stepCfg.id].count = Math.min(prevCount + increment, stepCfg.requiredCount);
        questUpdated = true;

        // Fire event only on the incomplete→complete transition
        if (prevCount < stepCfg.requiredCount &&
            progress.steps[stepCfg.id].count >= stepCfg.requiredCount) {
          progress.steps[stepCfg.id].completedAt = now;
          try {
            EventBus.emit(nk, logger, ctx, EventBus.Events.QUEST_STEP_COMPLETED, {
              userId: userId, questId: questId, stepId: stepCfg.id
            });
          } catch (busErr: any) {
            logger.warn("[QuestEngine] EventBus step emit failed: " + (busErr && busErr.message ? busErr.message : String(busErr)));
          }
          logger.info("[QuestEngine] Step completed: quest=%s step=%s user=%s", questId, stepCfg.id, userId);
        }
      }

      if (questUpdated) {
        updatedCount++;

        if (areAllStepsDone(qConfig, progress) && !progress.completedAt) {
          progress.completedAt = now;
          try {
            var emitData: any = { userId: userId, questId: questId, gameId: gameId };
            if (progress.abAttribution) {
              emitData.experimentId = progress.abAttribution.experimentId;
              emitData.variantId = progress.abAttribution.variantId;
              emitData.phaseId = progress.abAttribution.phaseId;
              emitData.configRevision = progress.abAttribution.configRevision;
              emitData.exposedAt = progress.abAttribution.exposedAt;
            }
            EventBus.emit(nk, logger, ctx, EventBus.Events.QUEST_COMPLETED, emitData);
          } catch (busErr: any) {
            logger.warn("[QuestEngine] EventBus quest emit failed: " + (busErr && busErr.message ? busErr.message : String(busErr)));
          }
          logger.info("[QuestEngine] Quest completed: quest=%s user=%s", questId, userId);

          // Queue reward for Phase 3 — do NOT grant yet (state not saved)
          var payoutReward = effectiveReward(progress, qConfig);
          if (payoutReward) {
            rewardPending.push({ questId: questId, reward: payoutReward });
          }
        }

        updatedQuests[questId] = {
          questId: questId,
          steps: progress.steps,
          startedAt: progress.startedAt,
          completedAt: progress.completedAt,
          claimedAt: progress.claimedAt,
          resetCount: progress.resetCount
        };
      }
    }

    // ── Phase 2: persist progress (safe even if Phase 3 fails) ───────────────
    if (updatedCount > 0) {
      saveUserState(nk, userId, gameId, state);
    }

    // ── Phase 3: grant auto-rewards (isolated, non-fatal) ────────────────────
    var anyClaimedAt = false;
    for (var r = 0; r < rewardPending.length; r++) {
      var rq = rewardPending[r];
      try {
        var resolved = RewardEngine.resolveReward(nk, rq.reward);
        RewardEngine.grantReward(nk, logger, ctx, userId, gameId, resolved);
        state.quests[rq.questId].claimedAt = now;
        updatedQuests[rq.questId].claimedAt = now;
        anyClaimedAt = true;
        recordAbFunnel(nk, logger, userId, state.quests[rq.questId], "claimed");
        logger.info("[QuestEngine] Reward auto-granted: quest=%s user=%s", rq.questId, userId);

        // Server-driven fulfilment + player notification (reward catalog).
        // Isolated: delivery problems never roll back grants or progress.
        try {
          var grantedCfg = config.quests[rq.questId];
          RewardDelivery.onQuestReward(nk, logger, ctx, userId, gameId,
            rq.questId, (grantedCfg && grantedCfg.name) || rq.questId, resolved);
        } catch (dlvErr: any) {
          logger.warn("[QuestEngine] RewardDelivery hook failed: " + (dlvErr && dlvErr.message ? dlvErr.message : String(dlvErr)));
        }
      } catch (rewardErr: any) {
        logger.error("[QuestEngine] Reward grant failed (claimedAt stays null, client can retry): quest=%s err=%s",
          rq.questId, (rewardErr && rewardErr.message ? rewardErr.message : String(rewardErr)));
      }
    }

    // Only write again if at least one claimedAt was actually set in Phase 3
    if (anyClaimedAt) {
      saveUserState(nk, userId, gameId, state);
    }

    // ── Battle pass XP hook ──────────────────────────────────────────────────
    // The same gameplay events that progress quests also accrue battle pass XP
    // (both the record_event RPC and the EventBus bridge funnel through here).
    // Isolated so a battle pass failure never breaks quest processing.
    try {
      if (typeof BattlePassEngine !== "undefined" && BattlePassEngine.processEvent) {
        BattlePassEngine.processEvent(nk, logger, ctx, userId, gameId, eventType, value);
      }
    } catch (bpErr: any) {
      logger.warn("[QuestEngine] BattlePass hook failed: " + (bpErr && bpErr.message ? bpErr.message : String(bpErr)));
    }

    return { updatedCount: updatedCount, updatedQuests: updatedQuests };
  }

  // ─── RPC: quest_engine_record_event ──────────────────────────────────────
  // Reports a player action via RPC. Calls the internal processor.
  
  function rpcQuestEngineRecordEvent(
    ctx: nkruntime.Context, logger: nkruntime.Logger,
    nk: nkruntime.Nakama, payload: string
  ): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload);
    var gameId = resolveGameId(data);
    if (!gameId) return RpcHelpers.errorResponse(GAME_ID_REQUIRED);
    var eventType = data.eventType as string;
    var value = (data.value !== undefined && data.value !== null) ? Number(data.value) : 0;
    var metadata = (data.metadata as { [k: string]: string }) || {};

    if (!eventType) return RpcHelpers.errorResponse("eventType is required");

    var result = processEventInternal(nk, logger, ctx, userId, gameId, eventType, value, metadata);
    return RpcHelpers.successResponse({ updatedQuests: result.updatedCount, quests: result.updatedQuests });
  }

  // ─── Public API: processEvent ────────────────────────────────────────────
  // Called by QuestEventBusBridge to process events from EventBus.
  // Apps don't need to call any RPC — events flow automatically.
  
  export function processEvent(
    nk: nkruntime.Nakama,
    logger: nkruntime.Logger,
    ctx: nkruntime.Context,
    userId: string,
    gameId: string,
    eventType: string,
    value: number,
    metadata: { [k: string]: string }
  ): ProcessEventResult {
    return processEventInternal(nk, logger, ctx, userId, gameId, eventType, value, metadata);
  }

  // ─── RPC: quest_engine_claim_reward ──────────────────────────────────────
  // Manually claims reward for a completed quest (deferred-claim UI pattern).

  // F14: bounded OCC retry count (same shape as QvSubmit.mergeSeenOcc).
  var CLAIM_OCC_MAX_RETRIES = 3;

  // F14: persist claimedAt under an OCC version CAS. Returns:
  //   "claimed"       — marker durably written by this call
  //   "already"       — marker already present (concurrent/duplicate claim)
  //   "not_completed" — quest has not completed yet
  //   "conflict"      — OCC retries exhausted (a concurrent writer won; the
  //                     safe response is to treat the claim as not ours)
  function markQuestClaimedOcc(
    nk: nkruntime.Nakama, logger: nkruntime.Logger,
    userId: string, gameId: string, questId: string, now: number
  ): string {
    for (var attempt = 0; attempt < CLAIM_OCC_MAX_RETRIES; attempt++) {
      try {
        var rows = nk.storageRead([{
          collection: QUEST_ENGINE_COLLECTION,
          key: stateKey(gameId, userId),
          userId: userId
        }]);
        var rec = (rows && rows.length > 0) ? rows[0] : null;
        var ver: string = (rec && rec.version) ? rec.version : "";
        var state: UserQuestState = (rec && rec.value) ? (rec.value as UserQuestState) : { quests: {} };
        var progress = state.quests[questId];
        if (!progress || !progress.completedAt) return "not_completed";
        if (progress.claimedAt) return "already";
        progress.claimedAt = now;
        var writeObj: nkruntime.StorageWriteRequest = {
          collection: QUEST_ENGINE_COLLECTION,
          key: stateKey(gameId, userId),
          userId: userId,
          value: state,
          permissionRead: 1 as nkruntime.ReadPermissionValues,
          permissionWrite: 0 as nkruntime.WritePermissionValues
        };
        if (ver) (writeObj as any).version = ver; // OCC guard (omit on first write)
        nk.storageWrite([writeObj]);
        return "claimed";
      } catch (e: any) {
        // Version conflict or transient storage error → re-read and retry.
      }
    }
    logger.warn("[QuestEngine] claim marker OCC exhausted: quest=%s user=%s", questId, userId);
    return "conflict";
  }

  // F14: best-effort clear of claimedAt (used to roll back when the reward
  // grant fails after the marker was persisted, so the player can retry).
  function clearQuestClaimedOcc(
    nk: nkruntime.Nakama, logger: nkruntime.Logger,
    userId: string, gameId: string, questId: string
  ): boolean {
    for (var attempt = 0; attempt < CLAIM_OCC_MAX_RETRIES; attempt++) {
      try {
        var rows = nk.storageRead([{
          collection: QUEST_ENGINE_COLLECTION,
          key: stateKey(gameId, userId),
          userId: userId
        }]);
        var rec = (rows && rows.length > 0) ? rows[0] : null;
        var ver: string = (rec && rec.version) ? rec.version : "";
        var state: UserQuestState = (rec && rec.value) ? (rec.value as UserQuestState) : { quests: {} };
        var progress = state.quests[questId];
        if (!progress || !progress.claimedAt) return true; // nothing to clear
        progress.claimedAt = null;
        var writeObj: nkruntime.StorageWriteRequest = {
          collection: QUEST_ENGINE_COLLECTION,
          key: stateKey(gameId, userId),
          userId: userId,
          value: state,
          permissionRead: 1 as nkruntime.ReadPermissionValues,
          permissionWrite: 0 as nkruntime.WritePermissionValues
        };
        if (ver) (writeObj as any).version = ver;
        nk.storageWrite([writeObj]);
        return true;
      } catch (e: any) {
        // retry
      }
    }
    return false;
  }

  function rpcQuestEngineClaimReward(
    ctx: nkruntime.Context, logger: nkruntime.Logger,
    nk: nkruntime.Nakama, payload: string
  ): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload);
    var gameId = resolveGameId(data);
    if (!gameId) return RpcHelpers.errorResponse(GAME_ID_REQUIRED);
    var questId = data.questId as string;

    if (!questId) return RpcHelpers.errorResponse("questId is required");

    var config = loadPlayerConfig(nk, logger, userId, gameId);
    var qConfig = config.quests[questId];
    if (!qConfig) return RpcHelpers.errorResponse("Unknown quest: " + questId);

    // Overlay hidden/enabled:false must not block a completed-unclaimed claim.
    // Fast-path checks for clean error messages — the authoritative guard is
    // the OCC-guarded marker write below.
    var peek = loadUserState(nk, userId, gameId);
    var peekProgress = peek.quests[questId];

    if (!peekProgress || !peekProgress.completedAt) return RpcHelpers.errorResponse("Quest not completed");
    if (peekProgress.claimedAt) return RpcHelpers.errorResponse("Quest reward already claimed");
    var payReward = effectiveReward(peekProgress, qConfig);
    if (!payReward) return RpcHelpers.successResponse({ reward: null });

    var now = Math.floor(Date.now() / 1000);

    // F14 SECURITY: persist claimedAt FIRST with an OCC version CAS, before
    // granting anything. Previously the reward was granted BEFORE the marker
    // write (and the state write carried no OCC version), so a retry or
    // concurrent claim between grant and save double-granted the reward.
    var mark = markQuestClaimedOcc(nk, logger, userId, gameId, questId, now);
    if (mark === "already" || mark === "conflict") {
      return RpcHelpers.errorResponse("Quest reward already claimed");
    }
    if (mark === "not_completed") {
      return RpcHelpers.errorResponse("Quest not completed");
    }

    // Marker is durable — only now resolve and grant the reward.
    var resolved: Hiro.ResolvedReward;
    try {
      resolved = RewardEngine.resolveReward(nk, payReward);
      RewardEngine.grantReward(nk, logger, ctx, userId, gameId, resolved);
    } catch (grantErr: any) {
      // Grant failed after the claim marker was persisted. Best-effort
      // rollback so the player can retry; if the rollback fails the marker
      // stays (a double grant is still impossible) and we log loudly.
      logger.error("[QuestEngine] Reward grant failed after claim marker persisted (quest=%s user=%s) — attempting rollback: %s",
        questId, userId, (grantErr && grantErr.message ? grantErr.message : String(grantErr)));
      var rolledBack = clearQuestClaimedOcc(nk, logger, userId, gameId, questId);
      if (!rolledBack) {
        logger.error("[QuestEngine] CRITICAL: claim rollback failed (quest=%s user=%s) — manual reconciliation required", questId, userId);
      }
      return RpcHelpers.errorResponse("Reward grant failed — please retry");
    }
    logger.info("[QuestEngine] Reward claimed manually: quest=%s user=%s", questId, userId);
    recordAbFunnel(nk, logger, userId, peekProgress, "claimed");

    // Same server-driven fulfilment path as auto-grant (catalog + notification).
    try {
      RewardDelivery.onQuestReward(nk, logger, ctx, userId, gameId, questId, qConfig.name || questId, resolved);
    } catch (dlvErr: any) {
      logger.warn("[QuestEngine] RewardDelivery hook failed (claim): " + (dlvErr && dlvErr.message ? dlvErr.message : String(dlvErr)));
    }

    return RpcHelpers.successResponse({ reward: resolved });
  }

  function persistAdminConfig(
    nk: nkruntime.Nakama, ctx: nkruntime.Context, logger: nkruntime.Logger,
    gameId: string, config: QuestsConfig, opts: { silent?: boolean; notifyUserIds?: string[] }
  ): { ok: boolean; error?: string; questCount?: number; newQuestCount?: number; notified?: number } {
    if (!config || !config.quests || typeof config.quests !== "object" || Array.isArray(config.quests)) {
      return { ok: false, error: "config.quests object required" };
    }
    var cleaned: { [questId: string]: QuestConfig } = {};
    var rawKeys = Object.keys(config.quests);
    for (var ck = 0; ck < rawKeys.length; ck++) {
      var ckId = rawKeys[ck];
      if (ckId === "__proto__" || ckId === "constructor" || ckId === "prototype") continue;
      cleaned[ckId] = config.quests[ckId];
    }
    config = { quests: cleaned };

    var questCount = Object.keys(config.quests).length;
    var validationErrors: string[] = [];
    var questKeys = Object.keys(config.quests);
    for (var vi = 0; vi < questKeys.length; vi++) {
      var vq = config.quests[questKeys[vi]];
      var verr = validateQuestConfig(vq);
      if (verr) validationErrors.push((vq && vq.id ? vq.id : questKeys[vi]) + ": " + verr);
    }
    if (validationErrors.length > 0) {
      return { ok: false, error: "Invalid quest config: " + validationErrors.join("; ") };
    }

    var prev = loadConfig(nk, gameId);
    var prevIds: { [id: string]: boolean } = {};
    var prevKeys = Object.keys(prev.quests || {});
    for (var pi = 0; pi < prevKeys.length; pi++) prevIds[prevKeys[pi]] = true;

    var newlyAdded: QuestConfig[] = [];
    var newKeys = Object.keys(config.quests);
    for (var ni = 0; ni < newKeys.length; ni++) {
      var nid = newKeys[ni];
      if (!prevIds[nid]) newlyAdded.push(config.quests[nid]);
    }

    saveConfig(nk, gameId, config);
    logger.info("[QuestEngine] Config saved: gameId=%s quests=%d new=%d", gameId, questCount, newlyAdded.length);

    var newIds: string[] = [];
    for (var ai = 0; ai < newlyAdded.length; ai++) newIds.push(newlyAdded[ai].id);
    auditConfigChange(nk, ctx, logger, gameId, config, newIds);

    var notified = 0;
    if (!opts.silent && newlyAdded.length > 0) {
      notified = notifyNewQuests(nk, logger, gameId, newlyAdded, opts.notifyUserIds);
    }
    return { ok: true, questCount: questCount, newQuestCount: newlyAdded.length, notified: notified };
  }

  // Put the pre-promote quest list back. Writes through persistAdminConfig
  // (same door as quest_engine_admin_save_config). Does not reopen the test.
  export function restorePromoteAudit(
    nk: nkruntime.Nakama, logger: nkruntime.Logger, ctx: nkruntime.Context,
    gameId: string, auditKey: string
  ): { ok: boolean; error?: string; already?: boolean; restored?: boolean; restoreAuditKey?: string; experimentId?: string } {
    if (!auditKey) return { ok: false, error: "auditKey required" };
    if (!gameId) return { ok: false, error: "gameId required" };
    var auditRows: nkruntime.StorageObject[] = [];
    try {
      auditRows = nk.storageRead([{
        collection: QUEST_CONFIG_AUDIT_COLLECTION,
        key: auditKey,
        userId: Constants.SYSTEM_USER_ID
      }]);
    } catch (_) {}
    var audit = (auditRows && auditRows.length > 0 && auditRows[0].value) ? auditRows[0].value : null;
    if (!audit || audit.promotion !== true || !audit.previous || !audit.previous.quests) {
      return { ok: false, error: "promote audit snapshot missing" };
    }
    var auditGame = audit.gameId ? String(audit.gameId) : "";
    if (auditGame && auditGame !== gameId) {
      return { ok: false, error: "audit gameId does not match" };
    }
    var previous = cloneJson(audit.previous) as QuestsConfig;
    var live = loadConfig(nk, gameId);
    var liveHash = hashQuestsConfig(live);
    var prevHash = hashQuestsConfig(previous);
    var desiredHash = audit.desiredHash ? String(audit.desiredHash) : hashQuestsConfig(audit.desired);
    if (liveHash === prevHash) {
      return {
        ok: true, already: true, restored: true, experimentId: audit.experimentId ? String(audit.experimentId) : ""
      };
    }
    if (desiredHash && liveHash !== desiredHash) {
      return { ok: false, error: "quest list changed after promote; cannot restore" };
    }
    var saved = persistAdminConfig(nk, ctx, logger, gameId, previous, { silent: true });
    if (!saved.ok) return { ok: false, error: saved.error || "restore save failed" };
    var now = Math.floor(Date.now() / 1000);
    var experimentId = audit.experimentId ? String(audit.experimentId) : "";
    var restoreAuditKey = "restore_" + experimentId + "_" + now;
    try {
      nk.storageWrite([{
        collection: QUEST_CONFIG_AUDIT_COLLECTION,
        key: restoreAuditKey,
        userId: Constants.SYSTEM_USER_ID,
        value: {
          gameId: gameId,
          experimentId: experimentId,
          actor: "restore",
          timestamp: now,
          restoreOf: auditKey,
          previous: live,
          desired: previous,
          restore: true
        },
        permissionRead: 2 as nkruntime.ReadPermissionValues,
        permissionWrite: 0 as nkruntime.WritePermissionValues
      }]);
    } catch (err: any) {
      logger.warn("[QuestEngine] restore audit failed: %s", err && err.message ? err.message : String(err));
    }
    logger.info("[QuestEngine] promote restored gameId=%s experiment=%s auditKey=%s restoreAuditKey=%s",
      gameId, experimentId, auditKey, restoreAuditKey);
    return {
      ok: true, restored: true, already: false, restoreAuditKey: restoreAuditKey, experimentId: experimentId
    };
  }

  // ─── RPC: quest_engine_admin_save_config ─────────────────────────────────
  // Saves quest config to storage. Server-key only — rejects authenticated users.
  //
  // Accepts two equivalent payload shapes (as documented in KT Section 11):
  //   (a) Keyed-map form:  { "gameId": "...", "config": { "quests": { "q1": {...} } } }
  //   (b) Array form:      { "gameId": "...", "quests": [ { "id": "q1", ... } ] }
  // Both are normalised to QuestsConfig internally before saving.

  function rpcQuestEngineAdminSaveConfig(
    ctx: nkruntime.Context, logger: nkruntime.Logger,
    nk: nkruntime.Nakama, payload: string
  ): string {
    if (!isAdminCaller(ctx)) {
      return RpcHelpers.errorResponse("Forbidden: server key required");
    }

    var data = RpcHelpers.parseRpcPayload(payload);
    var gameId = resolveGameId(data);
    if (!gameId) return RpcHelpers.errorResponse(GAME_ID_REQUIRED);

    var config: QuestsConfig;

    // Shape (a): { config: { quests: { ... } } }
    if (data.config && data.config.quests && !Array.isArray(data.config.quests)) {
      config = data.config as QuestsConfig;
    }
    // Shape (b): { quests: [ { id, name, ... } ] }  — KT Section 11 canonical form
    else if (Array.isArray(data.quests)) {
      var map: { [questId: string]: QuestConfig } = {};
      var arr = data.quests as QuestConfig[];
      for (var qi = 0; qi < arr.length; qi++) {
        var q = arr[qi];
        if (!q.id) return RpcHelpers.errorResponse("Each quest in quests[] must have an id field");
        map[q.id] = q;
      }
      config = { quests: map };
    }
    else {
      return RpcHelpers.errorResponse("Payload must contain config.quests (object) or quests (array)");
    }

    var saved = persistAdminConfig(nk, ctx, logger, gameId, config, {
      silent: data.silent === true || data.notifyNewQuests === false,
      notifyUserIds: Array.isArray(data.notifyUserIds) ? data.notifyUserIds : undefined
    });
    if (!saved.ok) return RpcHelpers.errorResponse(saved.error || "failed to save quest config");
    return RpcHelpers.successResponse({
      saved: true,
      questCount: saved.questCount,
      newQuestCount: saved.newQuestCount,
      notified: saved.notified
    });
  }

  // ─── RPC: quest_engine_admin_get_config ──────────────────────────────────
  // Returns the stored quest config for a game. Server-key only.

  function rpcQuestEngineAdminGetConfig(
    ctx: nkruntime.Context, logger: nkruntime.Logger,
    nk: nkruntime.Nakama, payload: string
  ): string {
    if (!isAdminCaller(ctx)) {
      return RpcHelpers.errorResponse("Forbidden: server key required");
    }

    var data = RpcHelpers.parseRpcPayload(payload);
    var gameId = resolveGameId(data);
    if (!gameId) return RpcHelpers.errorResponse(GAME_ID_REQUIRED);

    var config = loadConfig(nk, gameId);
    var questCount = Object.keys(config.quests).length;
    logger.info("[QuestEngine] Config retrieved: gameId=%s quests=%d", gameId, questCount);

    return RpcHelpers.successResponse({ config: config, questCount: questCount });
  }

  // ─── Register ─────────────────────────────────────────────────────────────

  export function register(initializer: nkruntime.Initializer): void {
    // withCleanAuthError wraps a handler once at registration time.
    // When register() is auto-invoked at IIFE scope by the postbuild script,
    // RpcHelpers may not be initialised yet (it lives in a later IIFE). Use a
    // lazy wrapper so the actual wrapping is deferred to first-call time.
    type StrictRpc = (ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string) => string;
    function auth(fn: nkruntime.RpcFunction): nkruntime.RpcFunction {
      var wrapped: StrictRpc | null = null;
      return function(ctx, logger, nk, payload): string {
        if (!wrapped) {
          const strictFn = fn as StrictRpc;
          wrapped = (typeof RpcHelpers !== "undefined" && RpcHelpers.withCleanAuthError)
            ? RpcHelpers.withCleanAuthError(strictFn)
            : strictFn;
        }
        return wrapped(ctx, logger, nk, payload);
      };
    }
    initializer.registerRpc("quest_engine_get",               auth(rpcQuestEngineGet));
    initializer.registerRpc("quest_engine_record_event",      auth(rpcQuestEngineRecordEvent));
    initializer.registerRpc("quest_engine_claim_reward",      auth(rpcQuestEngineClaimReward));
    initializer.registerRpc("quest_engine_admin_save_config", rpcQuestEngineAdminSaveConfig);
    initializer.registerRpc("quest_engine_admin_get_config",  rpcQuestEngineAdminGetConfig);
  }
}
