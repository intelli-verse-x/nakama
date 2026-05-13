// Hiro Sub-Achievements — group hierarchy for parent/child achievements.
// Mirrors https://heroiclabs.com/docs/hiro/concepts/achievements/sub-achievements/
//
// A parent achievement defines `subAchievements: [string]` (child IDs) and
// `parentRequiresAll` (default true). The parent is automatically marked
// completed when all listed children reach `completed` state. We don't
// rewrite HiroAchievements; this module reads the existing achievements
// config + per-user state and derives parent completion on demand.
namespace HiroSubAchievements {

  interface ProgressLite {
    [achievementId: string]: { count: number; completedAt?: number; claimedAt?: number };
  }

  function loadConfig(nk: nkruntime.Nakama, gameId?: string): { [id: string]: any } {
    var raw = ConfigLoader.loadConfigForGame<{ [id: string]: any }>(nk, "achievements", gameId, {});
    return raw || {};
  }

  function loadProgress(nk: nkruntime.Nakama, userId: string, gameId?: string): ProgressLite {
    var data = Storage.readJson<{ progress: ProgressLite }>(nk, Constants.HIRO_ACHIEVEMENTS_COLLECTION, Constants.gameKey(gameId, "progress"), userId);
    return (data && data.progress) || {};
  }

  function saveProgress(nk: nkruntime.Nakama, userId: string, progress: ProgressLite, gameId?: string): void {
    Storage.writeJson(nk, Constants.HIRO_ACHIEVEMENTS_COLLECTION, Constants.gameKey(gameId, "progress"), userId, { progress: progress });
  }

  function isCompleted(p: { count: number; completedAt?: number } | undefined): boolean {
    return !!(p && p.completedAt && p.completedAt > 0);
  }

  // Walk every parent achievement; if all of its children are complete,
  // mark the parent complete. Returns the list of newly completed parent
  // ids (so callers can grant the parent's reward via HiroEconomy).
  export function reconcile(nk: nkruntime.Nakama, userId: string, gameId?: string): string[] {
    var cfg = loadConfig(nk, gameId);
    var progress = loadProgress(nk, userId, gameId);
    var nowSec = Math.floor(Date.now() / 1000);
    var newlyCompleted: string[] = [];
    var changed = false;

    for (var id in cfg) {
      if (!cfg.hasOwnProperty(id)) continue;
      var def = cfg[id];
      var subs: string[] = (def && def.subAchievements) || (def && def.children) || [];
      if (!Array.isArray(subs) || subs.length === 0) continue;

      var requireAll = def.parentRequiresAll !== false;
      var done = 0;
      for (var i = 0; i < subs.length; i++) {
        if (isCompleted(progress[subs[i]])) done++;
      }
      var ok = requireAll ? (done === subs.length) : (done > 0);
      if (!ok) continue;

      if (!progress[id]) progress[id] = { count: 0 };
      if (!isCompleted(progress[id])) {
        progress[id].completedAt = nowSec;
        if (!progress[id].count) progress[id].count = subs.length;
        newlyCompleted.push(id);
        changed = true;
      }
    }

    if (changed) saveProgress(nk, userId, progress, gameId);
    return newlyCompleted;
  }

  // ----- RPCs -----

  function rpcReconcile(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload);
    var newly = reconcile(nk, userId, RpcHelpers.gameId(data));
    return RpcHelpers.successResponse({ newlyCompleted: newly });
  }

  function rpcTree(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = RpcHelpers.parseRpcPayload(payload);
    var cfg = loadConfig(nk, RpcHelpers.gameId(data));
    var tree: any[] = [];
    for (var id in cfg) {
      if (!cfg.hasOwnProperty(id)) continue;
      var def = cfg[id];
      var subs: string[] = (def && def.subAchievements) || (def && def.children) || [];
      if (!Array.isArray(subs) || subs.length === 0) continue;
      tree.push({ parentId: id, name: def.name || id, subAchievementIds: subs, parentRequiresAll: def.parentRequiresAll !== false });
    }
    return RpcHelpers.successResponse({ tree: tree });
  }

  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("hiro_sub_achievements_reconcile", rpcReconcile);
    initializer.registerRpc("hiro_sub_achievements_tree", rpcTree);
  }
}
