namespace HiroPersonalizers {

  interface PersonalizerOverride {
    path: string;
    value: any;
  }

  interface UserOverrides {
    overrides: { [system: string]: PersonalizerOverride[] };
    updatedAt: number;
  }

  var OVERRIDES_COLLECTION = "hiro_personalizer_overrides";
  var QUEST_ENGINE_SYSTEM = "quest_engine";
  // v1 progress-safe overlay. steps / requiredCount / eventType / new quest ids
  // are dropped at apply time (setup validator later rejects them loudly).
  var QUEST_ENGINE_OVERLAY_ALLOWLIST: { [k: string]: boolean } = {
    reward: true,
    hidden: true,
    enabled: true,
    name: true,
    description: true
  };

  function isUnsafeKey(key: string): boolean {
    return key === "__proto__" || key === "constructor" || key === "prototype";
  }

  function deepClone(obj: any): any {
    if (obj === null || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) {
      var arr: any[] = [];
      for (var i = 0; i < obj.length; i++) arr.push(deepClone(obj[i]));
      return arr;
    }
    var clone: any = {};
    for (var key in obj) {
      if (obj.hasOwnProperty(key) && !isUnsafeKey(key)) clone[key] = deepClone(obj[key]);
    }
    return clone;
  }

  function setNestedValue(obj: any, path: string, value: any): void {
    var parts = path.split(".");
    var current = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      if (isUnsafeKey(parts[i])) return;
      if (current[parts[i]] === undefined || current[parts[i]] === null) {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }
    var last = parts[parts.length - 1];
    if (isUnsafeKey(last)) return;
    current[last] = value;
  }

  function mergeDeep(target: any, source: any): any {
    if (!source || typeof source !== "object") return target;
    for (var key in source) {
      if (!source.hasOwnProperty(key) || isUnsafeKey(key)) continue;
      if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key]) &&
          target[key] && typeof target[key] === "object" && !Array.isArray(target[key])) {
        mergeDeep(target[key], source[key]);
      } else {
        target[key] = deepClone(source[key]);
      }
    }
    return target;
  }

  function parseMaybeJson(value: any): any {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch (_) {
      return value;
    }
  }

  // Admin UI stores variant.data; Hiro seed/docs use variant.config (string map or object).
  function normalizeVariantOverlay(variant: any): any {
    if (!variant) return null;
    var raw = variant.config || variant.data;
    if (raw == null) return null;
    raw = parseMaybeJson(raw);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    var out: any = {};
    for (var key in raw) {
      if (!raw.hasOwnProperty(key) || isUnsafeKey(key)) continue;
      out[key] = parseMaybeJson(raw[key]);
    }
    return out;
  }

  function hasRunningConfigSystem(nk: nkruntime.Nakama, system: string, gameId?: string): boolean {
    if (system === QUEST_ENGINE_SYSTEM && !gameId) return false;
    var experiments = ConfigLoader.loadSatoriConfigForGame<{ [id: string]: any }>(nk, "experiments", gameId, {});
    for (var expId in experiments) {
      var exp = experiments[expId];
      if (exp && exp.status === "running" && exp.configSystem === system) return true;
    }
    return false;
  }

  // Overlay existing quests only. Reward replaces the whole object (no currency merge).
  export function applyQuestEngineOverlay(config: any, overlay: any): any {
    if (!config || !config.quests || !overlay || !overlay.quests || typeof overlay.quests !== "object") {
      return config;
    }
    var patched = overlay.quests;
    for (var questId in patched) {
      if (!patched.hasOwnProperty(questId) || isUnsafeKey(questId)) continue;
      if (!config.quests.hasOwnProperty(questId)) continue;
      var src = patched[questId];
      if (!src || typeof src !== "object" || Array.isArray(src)) continue;
      var dest = config.quests[questId];
      if (src.hasOwnProperty("reward") && QUEST_ENGINE_OVERLAY_ALLOWLIST.reward) {
        dest.reward = deepClone(src.reward);
      }
      if (src.hasOwnProperty("hidden") && QUEST_ENGINE_OVERLAY_ALLOWLIST.hidden) {
        dest.hidden = !!src.hidden;
      }
      if (src.hasOwnProperty("enabled") && QUEST_ENGINE_OVERLAY_ALLOWLIST.enabled) {
        dest.enabled = !!src.enabled;
      }
      if (src.hasOwnProperty("name") && QUEST_ENGINE_OVERLAY_ALLOWLIST.name && typeof src.name === "string") {
        dest.name = src.name;
      }
      if (src.hasOwnProperty("description") && QUEST_ENGINE_OVERLAY_ALLOWLIST.description &&
          (src.description == null || typeof src.description === "string")) {
        dest.description = src.description;
      }
    }
    return config;
  }

  function applySystemOverlay(system: string, config: any, overlay: any): any {
    if (!overlay) return config;
    if (system === QUEST_ENGINE_SYSTEM) return applyQuestEngineOverlay(config, overlay);
    return mergeDeep(config, overlay);
  }

  // ---- Storage Personalizer ----
  function applyStorageOverrides(nk: nkruntime.Nakama, userId: string, system: string, config: any, gameId?: string): any {
    var data = Storage.readJson<UserOverrides>(nk, OVERRIDES_COLLECTION, Constants.gameKey(gameId, "overrides"), userId);
    if (!data || !data.overrides || !data.overrides[system]) return config;

    var overrides = data.overrides[system];
    for (var i = 0; i < overrides.length; i++) {
      setNestedValue(config, overrides[i].path, overrides[i].value);
    }
    return config;
  }

  // ---- Satori Personalizer (feature flags + experiments) ----
  function applySatoriOverrides(nk: nkruntime.Nakama, userId: string, system: string, config: any, gameId?: string, logger?: nkruntime.Logger): any {
    // Check feature flags for config overrides
    var flagName = "hiro_" + system + "_override";
    var flag = SatoriFeatureFlags.getFlag(nk, userId, flagName, undefined, gameId);
    if (flag && flag.value) {
      try {
        config = applySystemOverlay(system, config, JSON.parse(flag.value));
      } catch (_) {}
    }

    var experiments = ConfigLoader.loadSatoriConfigForGame<{ [id: string]: any }>(nk, "experiments", gameId, {});
    for (var expId in experiments) {
      var exp = experiments[expId];
      if (exp.status !== "running") continue;
      if (!exp.configSystem || exp.configSystem !== system) continue;

      var variant = SatoriExperiments.getVariant(nk, userId, expId, gameId, logger);
      var overlay = normalizeVariantOverlay(variant);
      if (overlay) {
        try {
          config = applySystemOverlay(system, config, overlay);
        } catch (_) {}
      }
    }

    return config;
  }

  // ---- Public API ----

  export function personalize<T>(nk: nkruntime.Nakama, userId: string, system: string, baseConfig: T, gameId?: string, logger?: nkruntime.Logger): T {
    // Fast path: no running quest_engine experiment → skip overlay clone/merge.
    // Storage overrides still apply if present.
    if (system === QUEST_ENGINE_SYSTEM && !hasRunningConfigSystem(nk, system, gameId)) {
      var stored = Storage.readJson<UserOverrides>(nk, OVERRIDES_COLLECTION, Constants.gameKey(gameId, "overrides"), userId);
      if (!stored || !stored.overrides || !stored.overrides[system] || stored.overrides[system].length === 0) {
        return baseConfig;
      }
      var storageOnly = deepClone(baseConfig);
      return applyStorageOverrides(nk, userId, system, storageOnly, gameId) as T;
    }
    var config = deepClone(baseConfig);
    config = applyStorageOverrides(nk, userId, system, config, gameId);
    config = applySatoriOverrides(nk, userId, system, config, gameId, logger);
    return config as T;
  }

  export function personalizeConfig<T>(nk: nkruntime.Nakama, userId: string, system: string, loader: () => T, gameId?: string): T {
    var base = loader();
    return personalize(nk, userId, system, base, gameId);
  }

  // ---- Admin RPCs ----

  function rpcSetOverride(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.userId || !data.system || !data.path) {
      return RpcHelpers.errorResponse("userId, system, and path required");
    }

    var gameId = RpcHelpers.gameId(data);
    var userOverrides = Storage.readJson<UserOverrides>(nk, OVERRIDES_COLLECTION, Constants.gameKey(gameId, "overrides"), data.userId);
    if (!userOverrides) userOverrides = { overrides: {}, updatedAt: 0 };
    if (!userOverrides.overrides[data.system]) userOverrides.overrides[data.system] = [];

    var existing = false;
    for (var i = 0; i < userOverrides.overrides[data.system].length; i++) {
      if (userOverrides.overrides[data.system][i].path === data.path) {
        userOverrides.overrides[data.system][i].value = data.value;
        existing = true;
        break;
      }
    }
    if (!existing) {
      userOverrides.overrides[data.system].push({ path: data.path, value: data.value });
    }

    userOverrides.updatedAt = Math.floor(Date.now() / 1000);
    Storage.writeJson(nk, OVERRIDES_COLLECTION, Constants.gameKey(gameId, "overrides"), data.userId, userOverrides);
    return RpcHelpers.successResponse({ saved: true, system: data.system, path: data.path });
  }

  function rpcRemoveOverride(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.userId || !data.system || !data.path) {
      return RpcHelpers.errorResponse("userId, system, and path required");
    }

    var gameId = RpcHelpers.gameId(data);
    var userOverrides = Storage.readJson<UserOverrides>(nk, OVERRIDES_COLLECTION, Constants.gameKey(gameId, "overrides"), data.userId);
    if (!userOverrides || !userOverrides.overrides[data.system]) {
      return RpcHelpers.successResponse({ removed: false });
    }

    userOverrides.overrides[data.system] = userOverrides.overrides[data.system].filter(function(o: PersonalizerOverride) {
      return o.path !== data.path;
    });
    userOverrides.updatedAt = Math.floor(Date.now() / 1000);
    Storage.writeJson(nk, OVERRIDES_COLLECTION, Constants.gameKey(gameId, "overrides"), data.userId, userOverrides);
    return RpcHelpers.successResponse({ removed: true });
  }

  function rpcGetOverrides(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.userId) return RpcHelpers.errorResponse("userId required");

    var userOverrides = Storage.readJson<UserOverrides>(nk, OVERRIDES_COLLECTION, Constants.gameKey(RpcHelpers.gameId(data), "overrides"), data.userId);
    return RpcHelpers.successResponse({ overrides: userOverrides || { overrides: {} } });
  }

  function rpcPreviewConfig(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.userId || !data.system) return RpcHelpers.errorResponse("userId and system required");

    var rawGame = RpcHelpers.gameId(data) || "";
    var gameId = (rawGame === "default" || rawGame === Constants.DEFAULT_GAME_ID)
      ? Constants.QUIZVERSE_GAME_ID
      : rawGame;
    var base: any;
    if (data.system === QUEST_ENGINE_SYSTEM) {
      RpcHelpers.requireAdmin(ctx, nk);
      if (!gameId) return RpcHelpers.errorResponse("gameId required (registry UUID). Use default only as the QuizVerse alias.");
      if (typeof QuestEngine === "undefined" || !QuestEngine.loadRawConfig) {
        return RpcHelpers.errorResponse("quest engine unavailable");
      }
      base = QuestEngine.loadRawConfig(nk, gameId);
    } else {
      base = ConfigLoader.loadConfigForGame<any>(nk, data.system, gameId, {});
    }
    var personalized = personalize(nk, data.userId, data.system, base, gameId, logger);
    var experiment: any = null;
    if (data.system === QUEST_ENGINE_SYSTEM) {
      try {
        if (typeof SatoriExperiments !== "undefined" && SatoriExperiments.getRunningQuestEngineAttribution) {
          experiment = SatoriExperiments.getRunningQuestEngineAttribution(nk, data.userId, gameId);
        }
      } catch (_) {}
    }
    return RpcHelpers.successResponse({
      system: data.system,
      userId: data.userId,
      gameId: gameId || null,
      baseConfig: base,
      personalizedConfig: personalized,
      experiment: experiment
    });
  }

  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("hiro_personalizer_set_override", rpcSetOverride);
    initializer.registerRpc("hiro_personalizer_remove_override", rpcRemoveOverride);
    initializer.registerRpc("hiro_personalizer_get_overrides", rpcGetOverrides);
    initializer.registerRpc("hiro_personalizer_preview", rpcPreviewConfig);
  }
}
