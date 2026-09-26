// Generic group surface RPCs (any game). Cover is a URL stored on the
// Nakama group avatar — the runtime has no file bucket. Week stats count
// real rows in group_activity_<groupId> from the last 7 days.
namespace SocialGroupSurface {

  var SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";
  var WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  var WEEK_CACHE_MS = 45 * 1000;
  var MAX_COVER_LEN = 2048;
  var WEEK_CACHE_COLLECTION = "ivx_social_week_cache";

  function groupActivityCollection(groupId: string): string {
    return "group_activity_" + groupId;
  }

  function isMember(nk: nkruntime.Nakama, userId: string, groupId: string): boolean {
    var cursor = "";
    for (var page = 0; page < 5; page++) {
      var list = nk.userGroupsList(userId, 100, undefined, cursor);
      var rows = list && list.userGroups ? list.userGroups : [];
      for (var i = 0; i < rows.length; i++) {
        var ug = rows[i];
        if (ug && ug.group && ug.group.id === groupId && ug.state !== 3) return true;
      }
      if (!list || !list.cursor) break;
      cursor = list.cursor;
    }
    return false;
  }

  // ivx_social_group_cover_set { groupId, avatarUrl }
  // avatarUrl must be an https URL. Members only.
  function rpcGroupCoverSet(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    try {
      var userId = RpcHelpers.requireUserId(ctx);
      var data = RpcHelpers.parseRpcPayload(payload) || {};
      var groupId = typeof data.groupId === "string" ? data.groupId : "";
      var avatarUrl = typeof data.avatarUrl === "string" ? data.avatarUrl.trim() : "";
      if (!groupId) return RpcHelpers.errorResponse("groupId required");
      if (avatarUrl.length < 12 || avatarUrl.length > MAX_COVER_LEN || avatarUrl.indexOf("https://") !== 0) {
        return RpcHelpers.errorResponse("avatarUrl must be an https URL");
      }
      if (!isMember(nk, userId, groupId)) {
        return RpcHelpers.errorResponse("Only group members can set the cover");
      }
      var groups = nk.groupsGetId([groupId]);
      if (!groups || groups.length === 0) return RpcHelpers.errorResponse("group not found");
      var group = groups[0];
      var meta = typeof group.metadata === "string"
        ? group.metadata
        : JSON.stringify(group.metadata || {});
      // Same argument order as groups.js rpcLogGroupActivity (this runtime's
      // JS binding). nakama-common's d.ts lists a different order.
      (nk as any).groupUpdate(
        groupId,
        userId,
        group.name,
        group.description,
        avatarUrl,
        group.langTag,
        meta,
        group.open,
        group.maxCount
      );
      return RpcHelpers.successResponse({ groupId: groupId, avatarUrl: avatarUrl });
    } catch (e: any) {
      return RpcHelpers.errorResponse((e && e.message) || "Failed to set cover");
    }
  }

  // ivx_social_group_week_stats { groupId }
  // quizzes / debates / weeklyXp come only from logged activity rows.
  function rpcGroupWeekStats(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    try {
      RpcHelpers.requireUserId(ctx);
      var data = RpcHelpers.parseRpcPayload(payload) || {};
      var groupId = typeof data.groupId === "string" ? data.groupId : "";
      if (!groupId) return RpcHelpers.errorResponse("groupId required");
      var now = Date.now();
      var cached = nk.storageRead([{
        collection: WEEK_CACHE_COLLECTION,
        key: groupId,
        userId: SYSTEM_USER_ID
      }]);
      if (cached && cached.length > 0 && cached[0].value) {
        var hit = cached[0].value;
        var age = now - (parseInt(hit.cachedAt, 10) || 0);
        if (age >= 0 && age < WEEK_CACHE_MS) {
          return RpcHelpers.successResponse({
            groupId: groupId,
            quizzes: hit.quizzes || 0,
            debates: hit.debates || 0,
            weeklyXp: hit.weeklyXp || 0,
            windowDays: 7
          });
        }
      }
      var since = now - WEEK_MS;
      var quizzes = 0;
      var debates = 0;
      var weeklyXp = 0;
      var cursor = "";
      var collection = groupActivityCollection(groupId);
      for (var page = 0; page < 5; page++) {
        var listed = nk.storageList(SYSTEM_USER_ID, collection, 100, cursor);
        var objects = listed && listed.objects ? listed.objects : [];
        for (var i = 0; i < objects.length; i++) {
          var value = objects[i] && objects[i].value ? objects[i].value : null;
          if (!value) continue;
          var ts = Date.parse(value.timestamp || "");
          if (isNaN(ts) || ts < since) continue;
          var action = (typeof value.action === "string" ? value.action : "").toLowerCase();
          if (action.indexOf("quiz") >= 0) quizzes++;
          if (action.indexOf("debate") >= 0) debates++;
          var xp = parseInt(value.xp_earned, 10);
          if (!isNaN(xp) && xp > 0) weeklyXp += xp;
        }
        if (!listed || !listed.cursor) break;
        cursor = listed.cursor;
      }
      try {
        nk.storageWrite([{
          collection: WEEK_CACHE_COLLECTION,
          key: groupId,
          userId: SYSTEM_USER_ID,
          value: {
            quizzes: quizzes,
            debates: debates,
            weeklyXp: weeklyXp,
            cachedAt: now
          },
          permissionRead: 0,
          permissionWrite: 0
        }]);
      } catch (_) {}
      return RpcHelpers.successResponse({
        groupId: groupId,
        quizzes: quizzes,
        debates: debates,
        weeklyXp: weeklyXp,
        windowDays: 7
      });
    } catch (e: any) {
      return RpcHelpers.errorResponse((e && e.message) || "Failed to read week stats");
    }
  }

  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("ivx_social_group_cover_set", rpcGroupCoverSet);
    initializer.registerRpc("ivx_social_group_week_stats", rpcGroupWeekStats);
  }
}
