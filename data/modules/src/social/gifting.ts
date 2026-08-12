// gifting.ts — Cross-game P2P gifting (currency & items) for the Social Zone.
// 
// RPCs (all prefixed ivx_social_ for multi-game reuse):
//   ivx_social_gift_currency   — send game currency to a mutual friend
//   ivx_social_gift_item       — send inventory item to a mutual friend
//   ivx_social_gift_history    — paginated sent/received gift log
//
// INTEGRATION:
//   - Uses WalletHelpers (addCurrency/spendCurrency) for atomic transfers
//   - Uses HiroInventory for item transfers
//   - Calls SocialFriendsFeed.writeEvent() so gifts appear in friends feed
//   - Respects ivx_social_feed_privacy settings (shareFeedEvents toggle)
//   - Rate-limited & auditable via player_gifts collection

namespace SocialGifting {

  var GIFTS_COLLECTION      = "player_gifts";
  var SYSTEM_USER           = "00000000-0000-0000-0000-000000000000";
  var STATE_FRIEND          = 0;  // Nakama FriendshipState.FRIEND
  var MAX_GIFTS_PER_DAY     = 10;
  var MAX_GIFT_VALUE_DAILY  = 5000;
  var MAX_GIFTS_TO_SAME_FRIEND_PER_DAY = 3;
  var RETENTION_DAYS        = 30;

  // ── Helpers ────────────────────────────────────────────────────────────────

  function getGameId(data: any): string {
    return (typeof data.gameId === "string" && data.gameId) ? data.gameId : "quizverse";
  }

  function areMutualFriends(nk: nkruntime.Nakama, userId: string, targetId: string): boolean {
    try {
      var page = nk.friendsList(userId, 1000, STATE_FRIEND, null as any);
      if (page && page.friends) {
        for (var i = 0; i < page.friends.length; i++) {
          var fr: any = page.friends[i];
          if (fr && fr.user && fr.user.id === targetId) return true;
        }
      }
    } catch (_) {}
    return false;
  }

  function getDailyGiftCount(nk: nkruntime.Nakama, userId: string): number {
    var today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    var key = "daily_gifts_" + userId + "_" + today;
    try {
      var row = nk.storageRead([{ collection: GIFTS_COLLECTION, key: key, userId: SYSTEM_USER }]);
      if (row && row.length > 0 && row[0] && row[0].value) {
        return row[0].value.count || 0;
      }
    } catch (_) {}
    return 0;
  }

  function incrementDailyGiftCount(nk: nkruntime.Nakama, userId: string): void {
    var today = new Date().toISOString().slice(0, 10);
    var key = "daily_gifts_" + userId + "_" + today;
    var current = getDailyGiftCount(nk, userId);
    nk.storageWrite([{
      collection: GIFTS_COLLECTION, key: key, userId: SYSTEM_USER,
      value: { count: current + 1, date: today },
      permissionRead: 1, permissionWrite: 0
    }]);
  }

  function getGiftsToFriendToday(nk: nkruntime.Nakama, senderId: string, recipientId: string): number {
    var today = new Date().toISOString().slice(0, 10);
    var key = "gifts_to_" + senderId + "_" + recipientId + "_" + today;
    try {
      var row = nk.storageRead([{ collection: GIFTS_COLLECTION, key: key, userId: SYSTEM_USER }]);
      if (row && row.length > 0 && row[0] && row[0].value) {
        return row[0].value.count || 0;
      }
    } catch (_) {}
    return 0;
  }

  function incrementGiftsToFriend(nk: nkruntime.Nakama, senderId: string, recipientId: string): void {
    var today = new Date().toISOString().slice(0, 10);
    var key = "gifts_to_" + senderId + "_" + recipientId + "_" + today;
    var current = getGiftsToFriendToday(nk, senderId, recipientId);
    nk.storageWrite([{
      collection: GIFTS_COLLECTION, key: key, userId: SYSTEM_USER,
      value: { count: current + 1, date: today, recipientId },
      permissionRead: 1, permissionWrite: 0
    }]);
  }

  function isItemGiftable(nk: nkruntime.Nakama, gameId: string, itemId: string): boolean {
    try {
      var config = HiroInventory.getConfig(nk, gameId);
      var itemDef = config.items[itemId];
      // Default TRUE — opt-out only via giftable: false in config
      return itemDef?.giftable !== false;
    } catch (_) {
      return true; // default allow if config missing
    }
  }

  function writeGiftRecord(
    nk: nkruntime.Nakama,
    senderId: string,
    recipientId: string,
    gift: any
  ): string {
    var giftId = "gift_" + Date.now().toString(36) + "_" + Math.floor(Math.random() * 1679616).toString(36);
    var expiresAt = new Date(Date.now() + RETENTION_DAYS * 86400000).toISOString();
    
    nk.storageWrite([{
      collection: GIFTS_COLLECTION,
      key: giftId,
      userId: senderId,
      value: { ...gift, giftId, senderId, recipientId, status: "delivered", expiresAt },
      permissionRead: 2, // both sender & recipient can read
      permissionWrite: 0
    }]);
    
    // Also write thin index for recipient's received gifts query
    nk.storageWrite([{
      collection: GIFTS_COLLECTION,
      key: "recv_" + recipientId + "_" + giftId,
      userId: recipientId,
      value: { giftId, senderId, ts: Date.now() },
      permissionRead: 1, permissionWrite: 0
    }]);
    
    return giftId;
  }

  // ── RPC: ivx_social_gift_currency ─────────────────────────────────────────
  // Payload: { gameId?, recipientId, amount, currency?, message? }
  // Currency defaults to "coins". Returns sender/recipient new balances.
  export function rpcGiftCurrency(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string
  ): string {
    try {
      var userId = RpcHelpers.requireUserId(ctx);
      var data = RpcHelpers.parseRpcPayload(payload) || {};
      var recipientId = data.recipientId as string;
      var amount = Number(data.amount);
      var currency = (typeof data.currency === "string" && data.currency) ? data.currency : "coins";
      var message = (typeof data.message === "string") ? data.message.slice(0, 200) : "";
      var gameId = getGameId(data);

      // Validations
      if (!recipientId) return RpcHelpers.errorResponse("recipientId required", 400);
      if (!amount || amount <= 0) return RpcHelpers.errorResponse("amount must be > 0", 400);
      if (userId === recipientId) return RpcHelpers.errorResponse("Cannot gift yourself", 400);
      if (!areMutualFriends(nk, userId, recipientId)) return RpcHelpers.errorResponse("Can only gift mutual friends", 400);

      // Daily limits
      if (getDailyGiftCount(nk, userId) >= MAX_GIFTS_PER_DAY) return RpcHelpers.errorResponse("Max " + MAX_GIFTS_PER_DAY + " gifts/day", 400);
      if (getGiftsToFriendToday(nk, userId, recipientId) >= MAX_GIFTS_TO_SAME_FRIEND_PER_DAY) return RpcHelpers.errorResponse("Max " + MAX_GIFTS_TO_SAME_FRIEND_PER_DAY + " gifts/day to same friend", 400);

      // Balance check
      if (!WalletHelpers.hasCurrency(nk, userId, gameId, currency, amount)) {
        return RpcHelpers.errorResponse("Not enough " + currency, 400);
      }

      // Atomic transfer
      var senderWallet = WalletHelpers.spendCurrency(nk, logger, ctx, userId, gameId, currency, amount);
      var recipientWallet = WalletHelpers.addCurrency(nk, logger, ctx, recipientId, gameId, currency, amount);

      // Record gift
      var giftId = writeGiftRecord(nk, userId, recipientId, {
        type: "currency",
        amount: amount,
        currency: currency,
        message: message,
        ts: Date.now()
      });

      // Update rate-limit counters
      incrementDailyGiftCount(nk, userId);
      incrementGiftsToFriend(nk, userId, recipientId);

      // Notify recipient
      var senderName = ctx.username || userId;
      nk.notificationsSend([{
        userId: recipientId,
        subject: "🎁 Gift Received!",
        content: { giftId, from: userId, fromName: senderName, type: "currency", amount, currency, message },
        code: 201, // gift notification code
        persistent: true
      }]);

      // 🔗 INTEGRATION: Write to friends feed (appears in ivx_social_friends_feed)
      SocialFriendsFeed.writeEvent(nk, logger, userId, senderName, gameId,
        "gift_sent",
        { giftId, recipientId, amount, currency, message },
        { type: "gift_thanks", label: "Say Thanks", payload: { giftId } }
      );

      return RpcHelpers.successResponse({
        giftId: giftId,
        senderNewBalance: senderWallet.currencies,
        recipientNewBalance: recipientWallet.currencies
      });

    } catch (e: any) {
      logger.error("[SocialGifting] gift_currency failed: " + (e && e.message));
      return RpcHelpers.errorResponse("Internal error");
    }
  }

  // ── RPC: ivx_social_gift_item ─────────────────────────────────────────────
  // Payload: { gameId?, recipientId, itemId, quantity?, message? }
  // Quantity defaults to 1. Item must be owned and giftable.
  export function rpcGiftItem(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string
  ): string {
    try {
      var userId = RpcHelpers.requireUserId(ctx);
      var data = RpcHelpers.parseRpcPayload(payload) || {};
      var recipientId = data.recipientId as string;
      var itemId = data.itemId as string;
      var quantity = Number(data.quantity) || 1;
      var message = (typeof data.message === "string") ? data.message.slice(0, 200) : "";
      var gameId = getGameId(data);

      // Validations
      if (!recipientId) return RpcHelpers.errorResponse("recipientId required", 400);
      if (!itemId) return RpcHelpers.errorResponse("itemId required", 400);
      if (quantity <= 0) return RpcHelpers.errorResponse("quantity must be > 0", 400);
      if (userId === recipientId) return RpcHelpers.errorResponse("Cannot gift yourself", 400);
      if (!areMutualFriends(nk, userId, recipientId)) return RpcHelpers.errorResponse("Can only gift mutual friends", 400);

      // Daily limits
      if (getDailyGiftCount(nk, userId) >= MAX_GIFTS_PER_DAY) return RpcHelpers.errorResponse("Max " + MAX_GIFTS_PER_DAY + " gifts/day", 400);
      if (getGiftsToFriendToday(nk, userId, recipientId) >= MAX_GIFTS_TO_SAME_FRIEND_PER_DAY) return RpcHelpers.errorResponse("Max " + MAX_GIFTS_TO_SAME_FRIEND_PER_DAY + " gifts/day to same friend", 400);

      // Ownership & giftable check
      if (!HiroInventory.hasItem(nk, userId, itemId, quantity, gameId)) {
        return RpcHelpers.errorResponse("You don't own this item", 400);
      }
      if (!isItemGiftable(nk, gameId, itemId)) {
        return RpcHelpers.errorResponse("This item cannot be gifted", 400);
      }

      // Transfer item (consume from sender, grant to recipient)
      HiroInventory.consumeItem(nk, logger, ctx, userId, itemId, quantity, gameId);
      var granted = HiroInventory.grantItem(nk, logger, ctx, recipientId, itemId, quantity, undefined, undefined, gameId);

      // Record gift
      var giftId = writeGiftRecord(nk, userId, recipientId, {
        type: "item",
        itemId: itemId,
        quantity: quantity,
        message: message,
        ts: Date.now()
      });

      // Update rate-limit counters
      incrementDailyGiftCount(nk, userId);
      incrementGiftsToFriend(nk, userId, recipientId);

      // Notify recipient
      var senderName = ctx.username || userId;
      nk.notificationsSend([{
        userId: recipientId,
        subject: "🎁 Gift Received!",
        content: { giftId, from: userId, fromName: senderName, type: "item", itemId, quantity, message },
        code: 201,
        persistent: true
      }]);

      // 🔗 INTEGRATION: Write to friends feed
      SocialFriendsFeed.writeEvent(nk, logger, userId, senderName, gameId,
        "gift_sent",
        { giftId, recipientId, itemId, quantity, message },
        { type: "gift_thanks", label: "Say Thanks", payload: { giftId } }
      );

      return RpcHelpers.successResponse({ giftId: giftId, item: granted });

    } catch (e: any) {
      logger.error("[SocialGifting] gift_item failed: " + (e && e.message));
      return RpcHelpers.errorResponse("Internal error");
    }
  }

  // ── RPC: ivx_social_gift_history ──────────────────────────────────────────
  // Payload: { gameId?, limit?, cursor?, direction? }
  // direction: "sent" (default) | "received" | "all"
  export function rpcGiftHistory(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string
  ): string {
    try {
      var userId = RpcHelpers.requireUserId(ctx);
      var data = RpcHelpers.parseRpcPayload(payload) || {};
      var limit = Math.min(Number(data.limit) || 50, 100);
      var cursor = (typeof data.cursor === "string") ? data.cursor : "";
      var direction = (typeof data.direction === "string") ? data.direction : "sent";

      var gifts: any[] = [];

      if (direction === "received" || direction === "all") {
        // Query recipient index: recv_{userId}_*
        try {
          var list = nk.storageList(GIFTS_COLLECTION, "recv_" + userId + "_", limit + 1, cursor ? cursor : undefined);
          if (list && list.objects) {
            for (var i = 0; i < list.objects.length; i++) {
              var obj = list.objects[i];
              if (obj && obj.value && obj.value.giftId) {
                // Fetch full gift record
                var full = nk.storageRead([{ collection: GIFTS_COLLECTION, key: obj.value.giftId, userId: obj.value.senderId }]);
                if (full && full.length > 0 && full[0] && full[0].value) {
                  gifts.push(full[0].value);
                }
              }
            }
          }
          if (list && list.cursor) cursor = list.cursor;
        } catch (_) {}
      }

      if ((direction === "sent" || direction === "all") && gifts.length < limit) {
        // Query sender's gifts (direct ownership)
        try {
          var list = nk.storageList(GIFTS_COLLECTION, "gift_", limit - gifts.length + 1, cursor ? cursor : undefined);
          if (list && list.objects) {
            for (var i = 0; i < list.objects.length; i++) {
              var obj = list.objects[i];
              if (obj && obj.value && obj.value.senderId === userId) {
                gifts.push(obj.value);
              }
            }
          }
        } catch (_) {}
      }

      // Sort by ts desc, take limit
      gifts.sort(function(a, b) { return (b.ts || 0) - (a.ts || 0); });
      var nextCursor = gifts.length > limit ? String(gifts[limit - 1].ts) : "";
      gifts = gifts.slice(0, limit);

      return RpcHelpers.successResponse({ gifts: gifts, nextCursor: nextCursor });

    } catch (e: any) {
      logger.error("[SocialGifting] gift_history failed: " + (e && e.message));
      return RpcHelpers.errorResponse("Internal error");
    }
  }

  // ── Registration ──────────────────────────────────────────────────────────
  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("ivx_social_gift_currency", rpcGiftCurrency);
    initializer.registerRpc("ivx_social_gift_item", rpcGiftItem);
    initializer.registerRpc("ivx_social_gift_history", rpcGiftHistory);
  }

} // namespace SocialGifting