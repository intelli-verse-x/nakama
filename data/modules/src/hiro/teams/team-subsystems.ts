// Hiro Team Subsystems — Team Inventory, Team Mailbox, Team Store, Team
// Gifts, Team Event Leaderboards. Mirrors the Heroic Labs Hiro Teams docs
// (https://heroiclabs.com/docs/hiro/concepts/teams/).
//
// All state is keyed by the Nakama group id. We piggyback on the existing
// HiroTeams storage shape (TeamData) but break the new subsystems into
// independent storage keys so list/inspect calls don't bloat the parent
// blob.
namespace HiroTeamSubsystems {

  function teamInventoryKey(groupId: string): string { return "team_inv_" + groupId; }
  function teamMailboxKey(groupId: string): string { return "team_mail_" + groupId; }
  function teamStoreKey(groupId: string): string { return "team_store_" + groupId; }
  function teamGiftsKey(groupId: string): string { return "team_gifts_" + groupId; }
  function teamEventLBKey(groupId: string): string { return "team_eventlb_" + groupId; }

  // ---- Team Inventory ----

  interface TeamInventory { items: { [itemId: string]: { count: number; expiresAt?: number } }; }
  interface TeamMailbox { messages: { id: string; subject: string; body?: string; reward?: any; createdAt: number; claimedBy: string[] }[]; }
  interface TeamStore { offers: { id: string; name: string; cost: { currencies: { [c: string]: number } }; reward: any; remainingPurchases?: number; expiresAt?: number }[]; }
  interface TeamGifts { gifts: { id: string; senderUserId: string; reward: any; createdAt: number; redeemedBy: string[] }[]; }
  interface TeamEventLB { event: { id: string; name: string; startAt: number; endAt: number; scoreByGroup: { [gid: string]: number } } | null; }

  function readTI(nk: nkruntime.Nakama, gid: string): TeamInventory { return Storage.readSystemJson<TeamInventory>(nk, Constants.HIRO_CONFIGS_COLLECTION, teamInventoryKey(gid)) || { items: {} }; }
  function writeTI(nk: nkruntime.Nakama, gid: string, ti: TeamInventory) { Storage.writeSystemJson(nk, Constants.HIRO_CONFIGS_COLLECTION, teamInventoryKey(gid), ti); }
  function readTM(nk: nkruntime.Nakama, gid: string): TeamMailbox { return Storage.readSystemJson<TeamMailbox>(nk, Constants.HIRO_CONFIGS_COLLECTION, teamMailboxKey(gid)) || { messages: [] }; }
  function writeTM(nk: nkruntime.Nakama, gid: string, tm: TeamMailbox) { Storage.writeSystemJson(nk, Constants.HIRO_CONFIGS_COLLECTION, teamMailboxKey(gid), tm); }
  function readTS(nk: nkruntime.Nakama, gid: string): TeamStore { return Storage.readSystemJson<TeamStore>(nk, Constants.HIRO_CONFIGS_COLLECTION, teamStoreKey(gid)) || { offers: [] }; }
  function writeTS(nk: nkruntime.Nakama, gid: string, ts: TeamStore) { Storage.writeSystemJson(nk, Constants.HIRO_CONFIGS_COLLECTION, teamStoreKey(gid), ts); }
  function readTG(nk: nkruntime.Nakama, gid: string): TeamGifts { return Storage.readSystemJson<TeamGifts>(nk, Constants.HIRO_CONFIGS_COLLECTION, teamGiftsKey(gid)) || { gifts: [] }; }
  function writeTG(nk: nkruntime.Nakama, gid: string, tg: TeamGifts) { Storage.writeSystemJson(nk, Constants.HIRO_CONFIGS_COLLECTION, teamGiftsKey(gid), tg); }
  function readTE(nk: nkruntime.Nakama, gid: string): TeamEventLB { return Storage.readSystemJson<TeamEventLB>(nk, Constants.HIRO_CONFIGS_COLLECTION, teamEventLBKey(gid)) || { event: null }; }
  function writeTE(nk: nkruntime.Nakama, gid: string, te: TeamEventLB) { Storage.writeSystemJson(nk, Constants.HIRO_CONFIGS_COLLECTION, teamEventLBKey(gid), te); }

  function memberOf(nk: nkruntime.Nakama, userId: string, groupId: string): boolean {
    if (!userId || !groupId) return false;
    try {
      var groups = nk.userGroupsList(userId, 100, undefined, "");
      if (!groups || !groups.userGroups) return false;
      for (var i = 0; i < groups.userGroups.length; i++) {
        var ug = groups.userGroups[i];
        if (ug.group && ug.group.id === groupId) return true;
      }
    } catch (_) { /* fall through */ }
    return false;
  }

  // ----- Team Inventory RPCs -----

  function rpcInvList(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.groupId) return RpcHelpers.errorResponse("groupId required");
    return RpcHelpers.successResponse({ inventory: readTI(nk, data.groupId) });
  }

  function rpcInvGrant(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.groupId || !data.itemId || !data.count) return RpcHelpers.errorResponse("groupId, itemId, count required");
    var ti = readTI(nk, data.groupId);
    if (!ti.items[data.itemId]) ti.items[data.itemId] = { count: 0 };
    ti.items[data.itemId].count += parseInt(String(data.count), 10);
    if (data.expiresAt) ti.items[data.itemId].expiresAt = parseInt(String(data.expiresAt), 10);
    writeTI(nk, data.groupId, ti);
    return RpcHelpers.successResponse({ itemId: data.itemId, count: ti.items[data.itemId].count });
  }

  function rpcInvConsume(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.groupId || !data.itemId || !data.count) return RpcHelpers.errorResponse("groupId, itemId, count required");
    if (!memberOf(nk, userId, data.groupId)) return RpcHelpers.errorResponse("not a team member");
    var ti = readTI(nk, data.groupId);
    var have = ti.items[data.itemId] ? ti.items[data.itemId].count : 0;
    var need = parseInt(String(data.count), 10);
    if (have < need) return RpcHelpers.errorResponse("insufficient team inventory");
    ti.items[data.itemId].count = have - need;
    writeTI(nk, data.groupId, ti);
    return RpcHelpers.successResponse({ itemId: data.itemId, remaining: ti.items[data.itemId].count });
  }

  // ----- Team Mailbox RPCs -----

  function rpcMailList(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.groupId) return RpcHelpers.errorResponse("groupId required");
    if (!memberOf(nk, userId, data.groupId)) return RpcHelpers.errorResponse("not a team member");
    var tm = readTM(nk, data.groupId);
    return RpcHelpers.successResponse({ messages: tm.messages });
  }

  function rpcMailSend(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.groupId || !data.subject) return RpcHelpers.errorResponse("groupId and subject required");
    var tm = readTM(nk, data.groupId);
    var msg = {
      id: nk.uuidv4(),
      subject: String(data.subject),
      body: data.body,
      reward: data.reward,
      createdAt: Math.floor(Date.now() / 1000),
      claimedBy: [] as string[]
    };
    tm.messages.push(msg);
    writeTM(nk, data.groupId, tm);
    return RpcHelpers.successResponse({ message: msg });
  }

  function rpcMailClaim(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.groupId || !data.messageId) return RpcHelpers.errorResponse("groupId and messageId required");
    if (!memberOf(nk, userId, data.groupId)) return RpcHelpers.errorResponse("not a team member");
    var tm = readTM(nk, data.groupId);
    var found: any = null;
    for (var i = 0; i < tm.messages.length; i++) if (tm.messages[i].id === data.messageId) { found = tm.messages[i]; break; }
    if (!found) return RpcHelpers.errorResponse("message not found");
    if (found.claimedBy.indexOf(userId) >= 0) return RpcHelpers.errorResponse("already claimed");
    found.claimedBy.push(userId);
    writeTM(nk, data.groupId, tm);
    var reward = null;
    if (found.reward) {
      reward = RewardEngine.resolveReward(nk, found.reward);
      RewardEngine.grantReward(nk, logger, ctx, userId, RpcHelpers.gameId(data) || "default", reward);
    }
    return RpcHelpers.successResponse({ messageId: data.messageId, reward: reward });
  }

  // ----- Team Store RPCs -----

  function rpcStoreList(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.groupId) return RpcHelpers.errorResponse("groupId required");
    return RpcHelpers.successResponse({ store: readTS(nk, data.groupId) });
  }

  function rpcStoreUpsertOffer(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.groupId || !data.id || !data.name || !data.cost || !data.reward) {
      return RpcHelpers.errorResponse("groupId, id, name, cost, reward required");
    }
    var ts = readTS(nk, data.groupId);
    var idx = -1;
    for (var i = 0; i < ts.offers.length; i++) if (ts.offers[i].id === data.id) { idx = i; break; }
    var offer = { id: data.id, name: data.name, cost: data.cost, reward: data.reward, remainingPurchases: data.remainingPurchases, expiresAt: data.expiresAt };
    if (idx >= 0) ts.offers[idx] = offer;
    else ts.offers.push(offer);
    writeTS(nk, data.groupId, ts);
    return RpcHelpers.successResponse({ offer: offer });
  }

  function rpcStorePurchase(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.groupId || !data.offerId) return RpcHelpers.errorResponse("groupId and offerId required");
    if (!memberOf(nk, userId, data.groupId)) return RpcHelpers.errorResponse("not a team member");
    var ts = readTS(nk, data.groupId);
    var offer: any = null;
    for (var i = 0; i < ts.offers.length; i++) if (ts.offers[i].id === data.offerId) { offer = ts.offers[i]; break; }
    if (!offer) return RpcHelpers.errorResponse("offer not found");
    if (offer.remainingPurchases !== undefined && offer.remainingPurchases <= 0) return RpcHelpers.errorResponse("offer sold out");
    if (offer.expiresAt && Date.now() / 1000 > offer.expiresAt) return RpcHelpers.errorResponse("offer expired");

    // Charge the team wallet via HiroTeams; we read+write the team blob
    // directly to keep the API surface narrow.
    var teamData = Storage.readSystemJson<{ wallet: { [c: string]: number } }>(nk, Constants.HIRO_CONFIGS_COLLECTION, "team_" + data.groupId) || { wallet: {} };
    if (!teamData.wallet) teamData.wallet = {};
    if (offer.cost && offer.cost.currencies) {
      for (var c in offer.cost.currencies) {
        var have = teamData.wallet[c] || 0;
        if (have < offer.cost.currencies[c]) return RpcHelpers.errorResponse("team funds insufficient: " + c);
      }
      for (var c2 in offer.cost.currencies) {
        teamData.wallet[c2] = (teamData.wallet[c2] || 0) - offer.cost.currencies[c2];
      }
      Storage.writeSystemJson(nk, Constants.HIRO_CONFIGS_COLLECTION, "team_" + data.groupId, teamData);
    }
    if (offer.remainingPurchases !== undefined) offer.remainingPurchases--;
    writeTS(nk, data.groupId, ts);

    var reward = RewardEngine.resolveReward(nk, offer.reward);
    RewardEngine.grantReward(nk, logger, ctx, userId, RpcHelpers.gameId(data) || "default", reward);
    return RpcHelpers.successResponse({ offerId: data.offerId, reward: reward });
  }

  // ----- Team Gifts RPCs -----

  function rpcGiftSend(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.groupId || !data.reward) return RpcHelpers.errorResponse("groupId and reward required");
    if (!memberOf(nk, userId, data.groupId)) return RpcHelpers.errorResponse("not a team member");
    var tg = readTG(nk, data.groupId);
    var gift = { id: nk.uuidv4(), senderUserId: userId, reward: data.reward, createdAt: Math.floor(Date.now() / 1000), redeemedBy: [] as string[] };
    tg.gifts.push(gift);
    writeTG(nk, data.groupId, tg);
    return RpcHelpers.successResponse({ gift: gift });
  }

  function rpcGiftClaim(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.groupId || !data.giftId) return RpcHelpers.errorResponse("groupId and giftId required");
    if (!memberOf(nk, userId, data.groupId)) return RpcHelpers.errorResponse("not a team member");
    var tg = readTG(nk, data.groupId);
    var g: any = null;
    for (var i = 0; i < tg.gifts.length; i++) if (tg.gifts[i].id === data.giftId) { g = tg.gifts[i]; break; }
    if (!g) return RpcHelpers.errorResponse("gift not found");
    if (g.senderUserId === userId) return RpcHelpers.errorResponse("cannot claim own gift");
    if (g.redeemedBy.indexOf(userId) >= 0) return RpcHelpers.errorResponse("already claimed");
    g.redeemedBy.push(userId);
    writeTG(nk, data.groupId, tg);
    var reward = RewardEngine.resolveReward(nk, g.reward);
    RewardEngine.grantReward(nk, logger, ctx, userId, RpcHelpers.gameId(data) || "default", reward);
    return RpcHelpers.successResponse({ giftId: data.giftId, reward: reward });
  }

  function rpcGiftList(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.groupId) return RpcHelpers.errorResponse("groupId required");
    if (!memberOf(nk, userId, data.groupId)) return RpcHelpers.errorResponse("not a team member");
    return RpcHelpers.successResponse({ gifts: readTG(nk, data.groupId).gifts });
  }

  // ----- Team Event Leaderboards RPCs -----

  function rpcELBStart(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.id || !data.name || !data.endAt) return RpcHelpers.errorResponse("id, name, endAt required");
    var te: TeamEventLB = { event: { id: data.id, name: data.name, startAt: data.startAt || Math.floor(Date.now() / 1000), endAt: parseInt(String(data.endAt), 10), scoreByGroup: {} } };
    // Use a global key prefix for this leaderboard event so it spans all teams.
    Storage.writeSystemJson(nk, Constants.HIRO_CONFIGS_COLLECTION, "team_eventlb_global", te);
    return RpcHelpers.successResponse({ event: te.event });
  }

  function rpcELBSubmit(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.groupId || data.score === undefined) return RpcHelpers.errorResponse("groupId and score required");
    if (!memberOf(nk, userId, data.groupId)) return RpcHelpers.errorResponse("not a team member");
    var te = Storage.readSystemJson<TeamEventLB>(nk, Constants.HIRO_CONFIGS_COLLECTION, "team_eventlb_global") || { event: null };
    if (!te.event) return RpcHelpers.errorResponse("no active team event");
    if (Math.floor(Date.now() / 1000) > te.event.endAt) return RpcHelpers.errorResponse("event ended");
    te.event.scoreByGroup[data.groupId] = (te.event.scoreByGroup[data.groupId] || 0) + parseFloat(String(data.score));
    Storage.writeSystemJson(nk, Constants.HIRO_CONFIGS_COLLECTION, "team_eventlb_global", te);
    return RpcHelpers.successResponse({ groupId: data.groupId, total: te.event.scoreByGroup[data.groupId] });
  }

  function rpcELBLeaderboard(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var te = Storage.readSystemJson<TeamEventLB>(nk, Constants.HIRO_CONFIGS_COLLECTION, "team_eventlb_global") || { event: null };
    if (!te.event) return RpcHelpers.successResponse({ event: null, ranks: [] });
    var ranks: { groupId: string; score: number }[] = [];
    for (var gid in te.event.scoreByGroup) {
      if (!te.event.scoreByGroup.hasOwnProperty(gid)) continue;
      ranks.push({ groupId: gid, score: te.event.scoreByGroup[gid] });
    }
    ranks.sort(function (a, b) { return b.score - a.score; });
    return RpcHelpers.successResponse({ event: te.event, ranks: ranks });
  }

  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("hiro_team_inventory_list", rpcInvList);
    initializer.registerRpc("hiro_team_inventory_grant", rpcInvGrant);
    initializer.registerRpc("hiro_team_inventory_consume", rpcInvConsume);

    initializer.registerRpc("hiro_team_mailbox_list", rpcMailList);
    initializer.registerRpc("hiro_team_mailbox_send", rpcMailSend);
    initializer.registerRpc("hiro_team_mailbox_claim", rpcMailClaim);

    initializer.registerRpc("hiro_team_store_list", rpcStoreList);
    initializer.registerRpc("hiro_team_store_upsert_offer", rpcStoreUpsertOffer);
    initializer.registerRpc("hiro_team_store_purchase", rpcStorePurchase);

    initializer.registerRpc("hiro_team_gifts_send", rpcGiftSend);
    initializer.registerRpc("hiro_team_gifts_claim", rpcGiftClaim);
    initializer.registerRpc("hiro_team_gifts_list", rpcGiftList);

    initializer.registerRpc("hiro_team_event_leaderboard_start", rpcELBStart);
    initializer.registerRpc("hiro_team_event_leaderboard_submit", rpcELBSubmit);
    initializer.registerRpc("hiro_team_event_leaderboard_get", rpcELBLeaderboard);
  }
}
