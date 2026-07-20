/**
 * QuizVerse Link & Play — saved learn artifacts (server-authoritative).
 *
 * Collection: lap_saved_artifacts
 * Key: savedId (UUID)
 * Value: { savedId, type, title, noteId, noteTitle, tags, pinned,
 *          recallCount, lastRecalledAt, createdAt, updatedAt, snapshot, sourceItemId }
 *
 * RPCs:
 *   quizverse_lap_library_save
 *   quizverse_lap_library_list
 *   quizverse_lap_library_get
 *   quizverse_lap_library_delete
 *   quizverse_lap_library_pin
 *   quizverse_lap_library_recall
 *   quizverse_lap_library_stats
 */

var LAP_LIB_COLLECTION = "lap_saved_artifacts";
var LAP_LIB_FREE_CAP = 20;
var LAP_LIB_MAX_SNAPSHOT_CHARS = 200000;

var LAP_LIB_TYPES = {
  mindmap: true,
  audio_overview: true,
  speed_reading: true,
  microlearning: true,
  audiobook: true,
  flashcard_deck: true,
  explainer_video: true,
};

function lapLibNow() {
  return new Date().toISOString();
}

function lapLibParse(payload) {
  try {
    return JSON.parse(payload || "{}");
  } catch (e) {
    return {};
  }
}

function lapLibIsPro(nk, userId) {
  try {
    var rows = nk.storageRead([
      {
        collection: "qv_entitlements",
        key: "subscriptions",
        userId: userId,
      },
    ]);
    if (!rows || rows.length === 0 || !rows[0].value) return false;
    var subs = rows[0].value;
    var tier = String(subs.tier || "").toLowerCase();
    var status = String(subs.status || "active").toLowerCase();
    if (!tier || status === "expired" || status === "revoked" || status === "inactive") {
      return false;
    }
    if (subs.expiresAt) {
      var expiryMs = new Date(subs.expiresAt).getTime();
      if (!isNaN(expiryMs) && expiryMs <= Date.now()) return false;
    }
    return (
      tier === "pro" ||
      tier === "plus" ||
      tier === "pro_plus" ||
      tier === "linkplay_pro" ||
      tier === "linkplay_pro_plus"
    );
  } catch (e) {
    return false;
  }
}

function lapLibCount(nk, userId) {
  var total = 0;
  var cursor = "";
  for (var guard = 0; guard < 50; guard++) {
    var page = nk.storageList(userId, LAP_LIB_COLLECTION, 100, cursor);
    var objects = page.objects || page;
    if (!objects || objects.length === 0) break;
    total += objects.length;
    cursor = page.cursor || "";
    if (!cursor) break;
  }
  return total;
}

function lapLibNormalize(row) {
  var v = (row && row.value) || {};
  var savedId = String(v.savedId || (row && row.key) || "");
  return {
    savedId: savedId,
    type: String(v.type || ""),
    title: String(v.title || "Untitled"),
    noteId: v.noteId ? String(v.noteId) : "",
    noteTitle: v.noteTitle ? String(v.noteTitle) : "",
    tags: Array.isArray(v.tags) ? v.tags : [],
    pinned: !!v.pinned,
    recallCount: Math.max(0, Math.round(Number(v.recallCount) || 0)),
    lastRecalledAt: v.lastRecalledAt ? String(v.lastRecalledAt) : "",
    createdAt: String(v.createdAt || ""),
    updatedAt: String(v.updatedAt || ""),
    snapshot: v.snapshot && typeof v.snapshot === "object" ? v.snapshot : {},
    data: v.snapshot && typeof v.snapshot === "object" ? v.snapshot : {},
    sourceItemId: v.sourceItemId ? String(v.sourceItemId) : "",
  };
}

function lapLibWrite(nk, userId, savedId, value) {
  nk.storageWrite([
    {
      collection: LAP_LIB_COLLECTION,
      key: savedId,
      userId: userId,
      value: value,
      permissionRead: 1,
      permissionWrite: 1,
    },
  ]);
}

function lapLibRead(nk, userId, savedId) {
  var rows = nk.storageRead([
    {
      collection: LAP_LIB_COLLECTION,
      key: savedId,
      userId: userId,
    },
  ]);
  if (!rows || rows.length === 0 || !rows[0].value) return null;
  return rows[0];
}

var rpcQuizverseLapLibrarySave = function (ctx, logger, nk, payload) {
  try {
    var userId = ctx.userId;
    if (!userId) {
      return JSON.stringify({ success: false, error: "unauthenticated" });
    }

    var data = lapLibParse(payload);
    var type = String(data.type || "").trim();
    if (!LAP_LIB_TYPES[type]) {
      return JSON.stringify({
        success: false,
        error: "unsupported type",
        allowed: Object.keys(LAP_LIB_TYPES),
      });
    }

    var title = String(data.title || "Untitled").trim() || "Untitled";
    var snapshot = data.snapshot && typeof data.snapshot === "object" ? data.snapshot : {};
    if (data.data && typeof data.data === "object" && Object.keys(snapshot).length === 0) {
      snapshot = data.data;
    }

    var snapStr = JSON.stringify(snapshot);
    if (snapStr.length > LAP_LIB_MAX_SNAPSHOT_CHARS) {
      return JSON.stringify({
        success: false,
        error: "snapshot too large",
        maxChars: LAP_LIB_MAX_SNAPSHOT_CHARS,
        size: snapStr.length,
      });
    }

    if (!lapLibIsPro(nk, userId)) {
      var count = lapLibCount(nk, userId);
      if (count >= LAP_LIB_FREE_CAP) {
        return JSON.stringify({
          success: false,
          error: "inventory_limit",
          total: count,
          limit: LAP_LIB_FREE_CAP,
        });
      }
    }

    var savedId = nk.uuidv4();
    var now = lapLibNow();
    var value = {
      savedId: savedId,
      type: type,
      title: title,
      noteId: data.noteId ? String(data.noteId) : "",
      noteTitle: data.noteTitle ? String(data.noteTitle) : "",
      tags: Array.isArray(data.tags) ? data.tags : [],
      pinned: false,
      recallCount: 0,
      lastRecalledAt: "",
      createdAt: now,
      updatedAt: now,
      snapshot: snapshot,
      sourceItemId: data.sourceItemId ? String(data.sourceItemId) : "",
    };

    lapLibWrite(nk, userId, savedId, value);
    return JSON.stringify({ success: true, item: lapLibNormalize({ key: savedId, value: value }) });
  } catch (err) {
    logger.error("[LAP-Library] save error: " + err.message);
    return JSON.stringify({ success: false, error: err.message });
  }
};

var rpcQuizverseLapLibraryList = function (ctx, logger, nk, payload) {
  try {
    var userId = ctx.userId;
    if (!userId) {
      return JSON.stringify({ success: false, error: "unauthenticated" });
    }

    var data = lapLibParse(payload);
    var typeFilter = data.type ? String(data.type).trim() : "";
    if (typeFilter === "speed_read") typeFilter = "speed_reading";
    var pinnedOnly = !!data.pinnedOnly;
    var limit = Math.min(200, Math.max(1, Math.round(Number(data.limit) || 100)));

    var items = [];
    var cursor = "";
    for (var guard = 0; guard < 50; guard++) {
      var page = nk.storageList(userId, LAP_LIB_COLLECTION, 100, cursor);
      var objects = page.objects || page;
      if (!objects || objects.length === 0) break;
      for (var i = 0; i < objects.length; i++) {
        var item = lapLibNormalize(objects[i]);
        if (typeFilter && item.type !== typeFilter) continue;
        if (pinnedOnly && !item.pinned) continue;
        items.push(item);
      }
      cursor = page.cursor || "";
      if (!cursor) break;
    }

    items.sort(function (a, b) {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });

    var total = items.length;
    if (items.length > limit) items = items.slice(0, limit);
    var pinned = 0;
    for (var p = 0; p < items.length; p++) {
      if (items[p].pinned) pinned++;
    }

    return JSON.stringify({
      success: true,
      items: items,
      total: total,
      pinned: pinned,
    });
  } catch (err) {
    logger.error("[LAP-Library] list error: " + err.message);
    return JSON.stringify({ success: false, error: err.message, items: [], total: 0, pinned: 0 });
  }
};

var rpcQuizverseLapLibraryGet = function (ctx, logger, nk, payload) {
  try {
    var userId = ctx.userId;
    if (!userId) {
      return JSON.stringify({ success: false, error: "unauthenticated" });
    }
    var data = lapLibParse(payload);
    var savedId = String(data.savedId || data.id || "").trim();
    if (!savedId) {
      return JSON.stringify({ success: false, error: "savedId is required" });
    }
    var row = lapLibRead(nk, userId, savedId);
    if (!row) {
      return JSON.stringify({ success: false, error: "not_found" });
    }
    return JSON.stringify({ success: true, item: lapLibNormalize(row) });
  } catch (err) {
    logger.error("[LAP-Library] get error: " + err.message);
    return JSON.stringify({ success: false, error: err.message });
  }
};

var rpcQuizverseLapLibraryDelete = function (ctx, logger, nk, payload) {
  try {
    var userId = ctx.userId;
    if (!userId) {
      return JSON.stringify({ success: false, error: "unauthenticated" });
    }
    var data = lapLibParse(payload);
    var savedId = String(data.savedId || data.id || "").trim();
    if (!savedId) {
      return JSON.stringify({ success: false, error: "savedId is required" });
    }
    nk.storageDelete([
      {
        collection: LAP_LIB_COLLECTION,
        key: savedId,
        userId: userId,
      },
    ]);
    return JSON.stringify({ success: true, savedId: savedId });
  } catch (err) {
    logger.error("[LAP-Library] delete error: " + err.message);
    return JSON.stringify({ success: false, error: err.message });
  }
};

var rpcQuizverseLapLibraryPin = function (ctx, logger, nk, payload) {
  try {
    var userId = ctx.userId;
    if (!userId) {
      return JSON.stringify({ success: false, error: "unauthenticated" });
    }
    var data = lapLibParse(payload);
    var savedId = String(data.savedId || data.id || "").trim();
    if (!savedId) {
      return JSON.stringify({ success: false, error: "savedId is required" });
    }
    var row = lapLibRead(nk, userId, savedId);
    if (!row) {
      return JSON.stringify({ success: false, error: "not_found" });
    }
    var value = row.value || {};
    value.pinned = !!data.pinned;
    value.updatedAt = lapLibNow();
    lapLibWrite(nk, userId, savedId, value);
    return JSON.stringify({ success: true, item: lapLibNormalize({ key: savedId, value: value }) });
  } catch (err) {
    logger.error("[LAP-Library] pin error: " + err.message);
    return JSON.stringify({ success: false, error: err.message });
  }
};

var rpcQuizverseLapLibraryRecall = function (ctx, logger, nk, payload) {
  try {
    var userId = ctx.userId;
    if (!userId) {
      return JSON.stringify({ success: false, error: "unauthenticated" });
    }
    var data = lapLibParse(payload);
    var savedId = String(data.savedId || data.id || "").trim();
    if (!savedId) {
      return JSON.stringify({ success: false, error: "savedId is required" });
    }
    var row = lapLibRead(nk, userId, savedId);
    if (!row) {
      return JSON.stringify({ success: false, error: "not_found" });
    }
    var value = row.value || {};
    value.recallCount = Math.max(0, Math.round(Number(value.recallCount) || 0)) + 1;
    value.lastRecalledAt = lapLibNow();
    value.updatedAt = value.lastRecalledAt;
    lapLibWrite(nk, userId, savedId, value);
    return JSON.stringify({ success: true, item: lapLibNormalize({ key: savedId, value: value }) });
  } catch (err) {
    logger.error("[LAP-Library] recall error: " + err.message);
    return JSON.stringify({ success: false, error: err.message });
  }
};

var rpcQuizverseLapLibraryStats = function (ctx, logger, nk, payload) {
  try {
    var userId = ctx.userId;
    if (!userId) {
      return JSON.stringify({ success: false, error: "unauthenticated" });
    }

    var byType = {};
    var total = 0;
    var pinned = 0;
    var recalledLast7d = 0;
    var weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    var cursor = "";

    for (var guard = 0; guard < 50; guard++) {
      var page = nk.storageList(userId, LAP_LIB_COLLECTION, 100, cursor);
      var objects = page.objects || page;
      if (!objects || objects.length === 0) break;
      for (var i = 0; i < objects.length; i++) {
        var item = lapLibNormalize(objects[i]);
        total++;
        byType[item.type] = (byType[item.type] || 0) + 1;
        if (item.pinned) pinned++;
        if (item.lastRecalledAt) {
          var t = new Date(item.lastRecalledAt).getTime();
          if (!isNaN(t) && t >= weekAgo) recalledLast7d++;
        }
      }
      cursor = page.cursor || "";
      if (!cursor) break;
    }

    return JSON.stringify({
      success: true,
      total: total,
      byType: byType,
      pinned: pinned,
      recalledLast7Days: recalledLast7d,
      recalledLast7d: recalledLast7d,
      freeLimit: LAP_LIB_FREE_CAP,
      isPro: lapLibIsPro(nk, userId),
    });
  } catch (err) {
    logger.error("[LAP-Library] stats error: " + err.message);
    return JSON.stringify({
      success: false,
      error: err.message,
      total: 0,
      byType: {},
      pinned: 0,
      recalledLast7Days: 0,
    });
  }
};

function InitModule(ctx, logger, nk, initializer) {
  // Direct registerRpc calls required — postbuild AST walker does not detect loops/helpers.
  try {
    initializer.registerRpc("quizverse_lap_library_save", rpcQuizverseLapLibrarySave);
    logger.info("[LAP-Library] Registered RPC: quizverse_lap_library_save");
  } catch (e) {
    logger.error("[LAP-Library] Failed to register save: " + e.message);
  }
  try {
    initializer.registerRpc("quizverse_lap_library_list", rpcQuizverseLapLibraryList);
    logger.info("[LAP-Library] Registered RPC: quizverse_lap_library_list");
  } catch (e) {
    logger.error("[LAP-Library] Failed to register list: " + e.message);
  }
  try {
    initializer.registerRpc("quizverse_lap_library_get", rpcQuizverseLapLibraryGet);
    logger.info("[LAP-Library] Registered RPC: quizverse_lap_library_get");
  } catch (e) {
    logger.error("[LAP-Library] Failed to register get: " + e.message);
  }
  try {
    initializer.registerRpc("quizverse_lap_library_delete", rpcQuizverseLapLibraryDelete);
    logger.info("[LAP-Library] Registered RPC: quizverse_lap_library_delete");
  } catch (e) {
    logger.error("[LAP-Library] Failed to register delete: " + e.message);
  }
  try {
    initializer.registerRpc("quizverse_lap_library_pin", rpcQuizverseLapLibraryPin);
    logger.info("[LAP-Library] Registered RPC: quizverse_lap_library_pin");
  } catch (e) {
    logger.error("[LAP-Library] Failed to register pin: " + e.message);
  }
  try {
    initializer.registerRpc("quizverse_lap_library_recall", rpcQuizverseLapLibraryRecall);
    logger.info("[LAP-Library] Registered RPC: quizverse_lap_library_recall");
  } catch (e) {
    logger.error("[LAP-Library] Failed to register recall: " + e.message);
  }
  try {
    initializer.registerRpc("quizverse_lap_library_stats", rpcQuizverseLapLibraryStats);
    logger.info("[LAP-Library] Registered RPC: quizverse_lap_library_stats");
  } catch (e) {
    logger.error("[LAP-Library] Failed to register stats: " + e.message);
  }
  logger.info("[LAP-Library] LAP saved artifacts module initialized");
}
