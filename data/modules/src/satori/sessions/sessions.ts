// Satori Sessions — session lifecycle tracking and analytics. Mirrors the
// "About sessions" Satori doc: sessions begin on `session_start` and close
// either explicitly via `session_end` or implicitly after an inactivity
// timeout. Per-user session lengths feed into properties like
// `_avgSessionDurationSec`, `_totalSessionsCount`, and `_lastSessionAt`,
// which audiences can target on.
namespace SatoriSessions {

  interface SessionConfig {
    inactivityTimeoutSec: number; // default 1800 (30 min)
    maxSessionDurationSec: number; // default 14400 (4h)
  }

  interface ActiveSession {
    sessionId: string;
    startedAt: number; // unix sec
    lastSeenAt: number; // unix sec
    eventCount: number;
  }

  interface UserSessionState {
    active: ActiveSession | null;
    history: { sessionId: string; startedAt: number; endedAt: number; durationSec: number; eventCount: number }[];
    totals: { sessions: number; durationSec: number };
  }

  function loadConfig(nk: nkruntime.Nakama, gameId?: string): SessionConfig {
    return ConfigLoader.loadSatoriConfigForGame<SessionConfig>(nk, "sessions", gameId, {
      inactivityTimeoutSec: 1800,
      maxSessionDurationSec: 14400
    });
  }

  function loadState(nk: nkruntime.Nakama, userId: string, gameId?: string): UserSessionState {
    var data = Storage.readJson<UserSessionState>(nk, Constants.SATORI_IDENTITY_COLLECTION, Constants.gameKey(gameId, "sessions"), userId);
    return data || { active: null, history: [], totals: { sessions: 0, durationSec: 0 } };
  }

  function saveState(nk: nkruntime.Nakama, userId: string, state: UserSessionState, gameId?: string): void {
    Storage.writeJson(nk, Constants.SATORI_IDENTITY_COLLECTION, Constants.gameKey(gameId, "sessions"), userId, state);
  }

  function uuid(nk: nkruntime.Nakama): string {
    try { return nk.uuidv4(); } catch (_) { return "s_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8); }
  }

  // Public API: called from Satori event capture pipeline (or directly via RPC).
  // Side-effects: when a session closes we update SatoriIdentities computed
  // properties so audiences can filter on session metrics.
  export function onEvent(nk: nkruntime.Nakama, logger: nkruntime.Logger, userId: string, eventName: string, eventTimestampMs: number, gameId?: string): void {
    try {
      var cfg = loadConfig(nk, gameId);
      var state = loadState(nk, userId, gameId);
      var nowSec = Math.floor((eventTimestampMs || Date.now()) / 1000);

      if (state.active) {
        var idle = nowSec - state.active.lastSeenAt;
        var ranTooLong = (nowSec - state.active.startedAt) > cfg.maxSessionDurationSec;
        if (idle > cfg.inactivityTimeoutSec || ranTooLong) {
          // close the previous session at the last seen ts
          closeActive(state, state.active.lastSeenAt);
        }
      }

      if (eventName === "session_start" || !state.active) {
        if (state.active) closeActive(state, nowSec);
        state.active = { sessionId: uuid(nk), startedAt: nowSec, lastSeenAt: nowSec, eventCount: 0 };
      }

      if (state.active) {
        state.active.lastSeenAt = nowSec;
        state.active.eventCount++;
      }

      if (eventName === "session_end") {
        closeActive(state, nowSec);
      }

      saveState(nk, userId, state, gameId);
      writeProperties(nk, userId, state);
    } catch (e: any) {
      logger.warn("[SatoriSessions] onEvent failed: %s", e.message || String(e));
    }
  }

  function closeActive(state: UserSessionState, endedAt: number): void {
    var a = state.active;
    if (!a) return;
    var duration = Math.max(0, endedAt - a.startedAt);
    state.history.push({ sessionId: a.sessionId, startedAt: a.startedAt, endedAt: endedAt, durationSec: duration, eventCount: a.eventCount });
    if (state.history.length > 100) state.history = state.history.slice(state.history.length - 100);
    state.totals.sessions++;
    state.totals.durationSec += duration;
    state.active = null;
  }

  function writeProperties(nk: nkruntime.Nakama, userId: string, state: UserSessionState): void {
    try {
      var allProps = SatoriIdentities.getAllProperties(nk, userId);
      var avg = state.totals.sessions > 0 ? Math.round(state.totals.durationSec / state.totals.sessions) : 0;
      allProps.computedProperties["_totalSessionsCount"] = String(state.totals.sessions);
      allProps.computedProperties["_avgSessionDurationSec"] = String(avg);
      if (state.history.length > 0) {
        allProps.computedProperties["_lastSessionEndedAt"] = String(state.history[state.history.length - 1].endedAt);
      }
      // Avoid touching defaultProperties / customProperties; only computed.
      Storage.writeJson(nk, Constants.SATORI_IDENTITY_COLLECTION, "props", userId, allProps);
    } catch (_) { /* best effort */ }
  }

  // ----- RPCs -----

  function rpcGet(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload);
    var state = loadState(nk, userId, RpcHelpers.gameId(data));
    return RpcHelpers.successResponse({ state: state });
  }

  function rpcStartSession(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload);
    onEvent(nk, logger, userId, "session_start", Date.now(), RpcHelpers.gameId(data));
    var state = loadState(nk, userId, RpcHelpers.gameId(data));
    return RpcHelpers.successResponse({ session: state.active });
  }

  function rpcEndSession(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload);
    onEvent(nk, logger, userId, "session_end", Date.now(), RpcHelpers.gameId(data));
    var state = loadState(nk, userId, RpcHelpers.gameId(data));
    return RpcHelpers.successResponse({ totals: state.totals, lastSession: state.history[state.history.length - 1] || null });
  }

  function rpcGetConfig(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    var cfg = loadConfig(nk, RpcHelpers.gameId(data));
    return RpcHelpers.successResponse({
      config: {
        idle_timeout_sec: cfg.inactivityTimeoutSec,
        max_session_sec: cfg.maxSessionDurationSec,
        send_session_end_event: true
      }
    });
  }

  function rpcSetConfig(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    var gameId = RpcHelpers.gameId(data);
    var cfg = loadConfig(nk, gameId);
    if (data.idle_timeout_sec != null) cfg.inactivityTimeoutSec = parseInt(String(data.idle_timeout_sec), 10);
    if (data.max_session_sec != null) cfg.maxSessionDurationSec = parseInt(String(data.max_session_sec), 10);
    ConfigLoader.saveSatoriConfigForGame(nk, "sessions", gameId, cfg);
    return RpcHelpers.successResponse({ config: cfg });
  }

  function rpcSummary(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    var nowMs = Date.now();
    var fromMs = data.fromMs || (nowMs - 7 * 86400000);
    var toMs = data.toMs || nowMs;
    var page = nk.storageList(Constants.SYSTEM_USER_ID, Constants.SATORI_EVENTS_COLLECTION, 200, "");
    var totalStarts = 0, totalEnds = 0, byUser: { [u: string]: number } = {};
    if (page.objects) {
      for (var i = 0; i < page.objects.length; i++) {
        var v = page.objects[i].value as any;
        if (!v || !v.timestamp || v.timestamp < fromMs || v.timestamp > toMs) continue;
        if (v.name === "session_start") totalStarts++;
        if (v.name === "session_end") totalEnds++;
        if (v.userId) byUser[v.userId] = (byUser[v.userId] || 0) + 1;
      }
    }
    return RpcHelpers.successResponse({
      rangeStartMs: fromMs,
      rangeEndMs: toMs,
      sessionStarts: totalStarts,
      sessionEnds: totalEnds,
      activeUsers: Object.keys(byUser).length
    });
  }

  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("satori_sessions_get", rpcGet);
    initializer.registerRpc("satori_sessions_start", rpcStartSession);
    initializer.registerRpc("satori_sessions_end", rpcEndSession);
    initializer.registerRpc("satori_sessions_summary", rpcSummary);
    initializer.registerRpc("satori_sessions_config_get", rpcGetConfig);
    initializer.registerRpc("satori_sessions_config_set", rpcSetConfig);
  }
}
