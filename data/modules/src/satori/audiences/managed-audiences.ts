// Satori Managed Audiences — bring-your-own-segment imports from external
// analytics platforms. Mirrors the "Managed audiences" pattern in
// https://heroiclabs.com/docs/satori/concepts/segmentation/understand-audiences/
//
// A managed audience is a read-only audience whose membership is supplied
// by an external system (CSV upload, S3 sync, BigQuery export, etc.). The
// SatoriAudiences module already supports `includeIds` for explicit
// membership — this module manages the lifecycle of those imports:
//
//   - register a managed audience source
//   - replace / append the membership snapshot
//   - schedule periodic refresh (HTTP fetch with bearer)
//   - audit each import with timestamp + row count
namespace SatoriManagedAudiences {

  interface ManagedSource {
    id: string;
    audienceId: string;          // refers to SatoriAudiences definition
    name: string;
    sourceType: "manual" | "http" | "s3";
    endpoint?: string;
    apiKey?: string;
    refreshIntervalSec?: number; // 0 = disabled
    lastRefreshedAt?: number;
    lastRowCount?: number;
    members: string[];           // current snapshot
  }

  interface ManagedConfig {
    sources: { [id: string]: ManagedSource };
  }

  function load(nk: nkruntime.Nakama, gameId?: string): ManagedConfig {
    var cfg = ConfigLoader.loadSatoriConfigForGame<ManagedConfig>(nk, "managed_audiences", gameId, { sources: {} });
    if (!cfg.sources) cfg.sources = {};
    return cfg;
  }

  function save(nk: nkruntime.Nakama, cfg: ManagedConfig, gameId?: string): void {
    ConfigLoader.saveSatoriConfigForGame(nk, "managed_audiences", gameId, cfg);
  }

  // Apply a membership snapshot to the underlying SatoriAudiences definition
  // by writing the includeIds array. Existing dynamic rules are preserved
  // because the audience definition is loaded, mutated, then saved back.
  function applyMembership(nk: nkruntime.Nakama, audienceId: string, members: string[], gameId?: string): void {
    var raw = ConfigLoader.loadSatoriConfigForGame<any>(nk, "audiences", gameId, {});
    var bag = raw && raw.audiences ? raw.audiences : raw;
    if (!bag || typeof bag !== "object") bag = {};
    var def = bag[audienceId] || { id: audienceId, name: audienceId };
    def.includeIds = members.slice();
    def.updatedAt = Math.floor(Date.now() / 1000);
    bag[audienceId] = def;
    var toSave = raw && raw.audiences ? { audiences: bag } : bag;
    ConfigLoader.saveSatoriConfigForGame(nk, "audiences", gameId, toSave);
    // also bust audiences cache
    ConfigLoader.invalidateCache(Constants.gameKey(gameId, "audiences"));
  }

  function fetchHttp(nk: nkruntime.Nakama, logger: nkruntime.Logger, src: ManagedSource): string[] | null {
    if (!src.endpoint) return null;
    try {
      var headers: { [k: string]: string } = { "Accept": "application/json" };
      if (src.apiKey) headers["Authorization"] = "Bearer " + src.apiKey;
      var resp = nk.httpRequest(src.endpoint, "get", headers, "");
      if (resp.code >= 400) { logger.warn("[ManagedAudiences] HTTP %d for %s", resp.code, src.id); return null; }
      var parsed = JSON.parse(resp.body);
      if (Array.isArray(parsed)) return parsed.map(String);
      if (parsed && Array.isArray(parsed.userIds)) return parsed.userIds.map(String);
      if (parsed && Array.isArray(parsed.members)) return parsed.members.map(String);
      logger.warn("[ManagedAudiences] HTTP response did not contain a userIds/members array for %s", src.id);
      return null;
    } catch (e: any) {
      logger.warn("[ManagedAudiences] fetchHttp failed for %s: %s", src.id, e.message || String(e));
      return null;
    }
  }

  // ----- Public API -----

  export function refreshSource(nk: nkruntime.Nakama, logger: nkruntime.Logger, sourceId: string, gameId?: string): { ok: boolean; rowCount: number } {
    var cfg = load(nk, gameId);
    var src = cfg.sources[sourceId];
    if (!src) return { ok: false, rowCount: 0 };
    var members: string[] | null = null;
    if (src.sourceType === "http") members = fetchHttp(nk, logger, src);
    if (members === null) return { ok: false, rowCount: 0 };
    src.members = members;
    src.lastRefreshedAt = Math.floor(Date.now() / 1000);
    src.lastRowCount = members.length;
    cfg.sources[sourceId] = src;
    save(nk, cfg, gameId);
    applyMembership(nk, src.audienceId, members, gameId);
    return { ok: true, rowCount: members.length };
  }

  export function refreshAllDue(nk: nkruntime.Nakama, logger: nkruntime.Logger, gameId?: string): { refreshed: number } {
    var cfg = load(nk, gameId);
    var now = Math.floor(Date.now() / 1000);
    var n = 0;
    for (var id in cfg.sources) {
      if (!cfg.sources.hasOwnProperty(id)) continue;
      var s = cfg.sources[id];
      if (!s.refreshIntervalSec || s.refreshIntervalSec <= 0) continue;
      var due = !s.lastRefreshedAt || (now - s.lastRefreshedAt) >= s.refreshIntervalSec;
      if (!due) continue;
      var r = refreshSource(nk, logger, id, gameId);
      if (r.ok) n++;
    }
    return { refreshed: n };
  }

  // ----- RPCs -----

  function rpcList(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    var cfg = load(nk, RpcHelpers.gameId(data));
    var out: any[] = [];
    for (var id in cfg.sources) {
      if (!cfg.sources.hasOwnProperty(id)) continue;
      var s = cfg.sources[id];
      out.push({
        id: s.id, audienceId: s.audienceId, name: s.name, sourceType: s.sourceType,
        endpoint: s.endpoint, refreshIntervalSec: s.refreshIntervalSec,
        lastRefreshedAt: s.lastRefreshedAt, lastRowCount: s.lastRowCount
      });
    }
    return RpcHelpers.successResponse({ sources: out });
  }

  function rpcUpsertSource(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.id || !data.audienceId || !data.sourceType) {
      return RpcHelpers.errorResponse("id, audienceId, and sourceType required");
    }
    var gameId = RpcHelpers.gameId(data);
    var cfg = load(nk, gameId);
    var existing = cfg.sources[data.id];
    cfg.sources[data.id] = {
      id: String(data.id),
      audienceId: String(data.audienceId),
      name: data.name || data.id,
      sourceType: data.sourceType,
      endpoint: data.endpoint,
      apiKey: data.apiKey,
      refreshIntervalSec: data.refreshIntervalSec,
      lastRefreshedAt: existing ? existing.lastRefreshedAt : 0,
      lastRowCount: existing ? existing.lastRowCount : 0,
      members: existing ? existing.members : []
    };
    save(nk, cfg, gameId);
    return RpcHelpers.successResponse({ source: cfg.sources[data.id] });
  }

  function rpcDeleteSource(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.id) return RpcHelpers.errorResponse("id required");
    var gameId = RpcHelpers.gameId(data);
    var cfg = load(nk, gameId);
    delete cfg.sources[data.id];
    save(nk, cfg, gameId);
    return RpcHelpers.successResponse({ deleted: data.id });
  }

  function rpcReplaceMembership(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.id || !Array.isArray(data.userIds)) return RpcHelpers.errorResponse("id and userIds[] required");
    var gameId = RpcHelpers.gameId(data);
    var cfg = load(nk, gameId);
    var src = cfg.sources[data.id];
    if (!src) return RpcHelpers.errorResponse("source not found");
    var members = data.userIds.map(String);
    src.members = members;
    src.lastRefreshedAt = Math.floor(Date.now() / 1000);
    src.lastRowCount = members.length;
    save(nk, cfg, gameId);
    applyMembership(nk, src.audienceId, members, gameId);
    return RpcHelpers.successResponse({ rowCount: members.length });
  }

  function rpcRefresh(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (data.id) {
      var r = refreshSource(nk, logger, String(data.id), RpcHelpers.gameId(data));
      return RpcHelpers.successResponse(r);
    }
    var all = refreshAllDue(nk, logger, RpcHelpers.gameId(data));
    return RpcHelpers.successResponse(all);
  }

  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("satori_managed_audiences_list", rpcList);
    initializer.registerRpc("satori_managed_audiences_upsert", rpcUpsertSource);
    initializer.registerRpc("satori_managed_audiences_delete", rpcDeleteSource);
    initializer.registerRpc("satori_managed_audiences_replace", rpcReplaceMembership);
    initializer.registerRpc("satori_managed_audiences_refresh", rpcRefresh);
  }
}
