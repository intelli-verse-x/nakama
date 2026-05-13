// Satori Audience Recompute Scheduler — periodic precomputation of audience
// membership matrices so audience-membership queries don't have to scan
// every user at request time. Mirrors the "Recompute audiences" Satori
// concept (see https://heroiclabs.com/docs/satori/concepts/segmentation/recompute-audience/).
//
// Strategy:
//   - The scheduler maintains a per-audience snapshot of {userId -> true}.
//   - On each tick (default every 600s) it scans all users with stored
//     identity properties and re-evaluates SatoriAudiences.isInAudience.
//   - The snapshot is also refreshed for any user the moment they fire a
//     real-time event via SatoriEventCapture; we expose `markUserDirty()`
//     so the event capture path can opportunistically re-evaluate just
//     that one user.
namespace SatoriAudienceRecompute {

  interface Snapshot {
    audienceId: string;
    members: { [userId: string]: boolean };
    computedAt: number;
    sizeApprox: number;
  }

  interface State {
    lastFullRecomputeAt: number;
    intervalSec: number;
    snapshots: { [audienceId: string]: Snapshot };
  }

  var DEFAULT_INTERVAL_SEC = 600;
  var MAX_USERS_PER_TICK = 1000;

  function load(nk: nkruntime.Nakama, gameId?: string): State {
    return ConfigLoader.loadSatoriConfigForGame<State>(nk, "audience_snapshots", gameId, {
      lastFullRecomputeAt: 0,
      intervalSec: DEFAULT_INTERVAL_SEC,
      snapshots: {}
    });
  }

  function save(nk: nkruntime.Nakama, st: State, gameId?: string): void {
    ConfigLoader.saveSatoriConfigForGame(nk, "audience_snapshots", gameId, st);
  }

  // Iterate users in the satori_identity_props collection.
  function listUsers(nk: nkruntime.Nakama, max: number): string[] {
    var users: string[] = [];
    var cursor = "";
    while (users.length < max) {
      var page = nk.storageList(undefined as any, Constants.SATORI_IDENTITY_COLLECTION, 200, cursor);
      if (!page.objects || page.objects.length === 0) break;
      for (var i = 0; i < page.objects.length; i++) {
        if (page.objects[i].userId && page.objects[i].userId !== Constants.SYSTEM_USER_ID) {
          users.push(page.objects[i].userId);
        }
      }
      if (!page.cursor) break;
      cursor = page.cursor;
    }
    return users;
  }

  function listAudienceIds(nk: nkruntime.Nakama, gameId?: string): string[] {
    var raw = ConfigLoader.loadSatoriConfigForGame<any>(nk, "audiences", gameId, {});
    var bag = raw && raw.audiences ? raw.audiences : raw;
    var ids: string[] = [];
    for (var k in bag) if (bag.hasOwnProperty(k)) ids.push(k);
    return ids;
  }

  // Recompute every audience for all currently-known identities.
  export function fullRecompute(nk: nkruntime.Nakama, logger: nkruntime.Logger, gameId?: string): { audiences: number; users: number } {
    var st = load(nk, gameId);
    var users = listUsers(nk, MAX_USERS_PER_TICK);
    var audIds = listAudienceIds(nk, gameId);

    for (var a = 0; a < audIds.length; a++) {
      var aid = audIds[a];
      var snap: Snapshot = { audienceId: aid, members: {}, computedAt: Math.floor(Date.now() / 1000), sizeApprox: 0 };
      for (var u = 0; u < users.length; u++) {
        if (SatoriAudiences.isInAudience(nk, users[u], aid, gameId)) {
          snap.members[users[u]] = true;
          snap.sizeApprox++;
        }
      }
      st.snapshots[aid] = snap;
    }
    st.lastFullRecomputeAt = Math.floor(Date.now() / 1000);
    save(nk, st, gameId);
    logger.info("[AudienceRecompute] full recompute over %d audiences × %d users", audIds.length, users.length);
    return { audiences: audIds.length, users: users.length };
  }

  // Re-evaluate just one user across every audience and patch existing
  // snapshots in place. Cheap; suitable to call on every captured event.
  export function markUserDirty(nk: nkruntime.Nakama, userId: string, gameId?: string): void {
    if (!userId) return;
    try {
      var st = load(nk, gameId);
      var ids = listAudienceIds(nk, gameId);
      for (var i = 0; i < ids.length; i++) {
        var aid = ids[i];
        if (!st.snapshots[aid]) {
          st.snapshots[aid] = { audienceId: aid, members: {}, computedAt: 0, sizeApprox: 0 };
        }
        var snap = st.snapshots[aid];
        var member = SatoriAudiences.isInAudience(nk, userId, aid, gameId);
        var existed = !!snap.members[userId];
        if (member && !existed) { snap.members[userId] = true; snap.sizeApprox++; }
        else if (!member && existed) { delete snap.members[userId]; snap.sizeApprox = Math.max(0, snap.sizeApprox - 1); }
      }
      save(nk, st, gameId);
    } catch (_) { /* opportunistic */ }
  }

  export function tickIfDue(nk: nkruntime.Nakama, logger: nkruntime.Logger, gameId?: string): boolean {
    var st = load(nk, gameId);
    var nowSec = Math.floor(Date.now() / 1000);
    if (st.lastFullRecomputeAt && (nowSec - st.lastFullRecomputeAt) < (st.intervalSec || DEFAULT_INTERVAL_SEC)) return false;
    fullRecompute(nk, logger, gameId);
    return true;
  }

  // ----- RPCs -----

  function rpcStatus(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = RpcHelpers.parseRpcPayload(payload);
    var st = load(nk, RpcHelpers.gameId(data));
    var snaps: any[] = [];
    for (var aid in st.snapshots) {
      if (!st.snapshots.hasOwnProperty(aid)) continue;
      snaps.push({ audienceId: aid, computedAt: st.snapshots[aid].computedAt, sizeApprox: st.snapshots[aid].sizeApprox });
    }
    return RpcHelpers.successResponse({
      lastFullRecomputeAt: st.lastFullRecomputeAt,
      intervalSec: st.intervalSec,
      snapshots: snaps
    });
  }

  function rpcRecompute(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    var r = fullRecompute(nk, logger, RpcHelpers.gameId(data));
    return RpcHelpers.successResponse(r);
  }

  function rpcMembers(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.audienceId) return RpcHelpers.errorResponse("audienceId required");
    var st = load(nk, RpcHelpers.gameId(data));
    var snap = st.snapshots[String(data.audienceId)];
    if (!snap) return RpcHelpers.errorResponse("snapshot not yet computed; run recompute first");
    var members: string[] = [];
    for (var u in snap.members) if (snap.members.hasOwnProperty(u)) members.push(u);
    return RpcHelpers.successResponse({ audienceId: data.audienceId, computedAt: snap.computedAt, members: members });
  }

  function rpcSetInterval(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    var n = parseInt(String(data.intervalSec || 0), 10);
    if (!isFinite(n) || n < 60) return RpcHelpers.errorResponse("intervalSec must be >= 60");
    var gameId = RpcHelpers.gameId(data);
    var st = load(nk, gameId);
    st.intervalSec = n;
    save(nk, st, gameId);
    return RpcHelpers.successResponse({ intervalSec: n });
  }

  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("satori_audience_snapshot_status", rpcStatus);
    initializer.registerRpc("satori_audience_recompute", rpcRecompute);
    initializer.registerRpc("satori_audience_snapshot_members", rpcMembers);
    initializer.registerRpc("satori_audience_recompute_set_interval", rpcSetInterval);
  }
}
