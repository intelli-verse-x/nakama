/**
 * QuizVerse Link & Play — recent notes index (cross-surface sync).
 *
 * Lightweight metadata only — note bodies stay in the AI notes DB.
 * Used so TutorX can show "Recent from Link & Play" via nakama_token
 * even when Cognito JWT is missing in the WebView.
 *
 * Collection: lap_recents
 * Key: list
 * Value: {
 *   items: [{ noteId, noteTitle, sourceType, thumbnailUrl, ts }],
 *   updatedAt
 * }
 *
 * RPCs:
 *   quizverse_lap_recents_get
 *   quizverse_lap_recents_touch
 *   quizverse_lap_recents_replace
 */

var LAP_RECENTS_COLLECTION = "lap_recents";
var LAP_RECENTS_KEY = "list";
var LAP_RECENTS_MAX = 20;

function lapRecentsNow() {
  return new Date().toISOString();
}

function lapRecentsParse(payload) {
  try {
    return JSON.parse(payload || "{}");
  } catch (e) {
    return {};
  }
}

function lapRecentsRequireUser(ctx) {
  if (!ctx.userId) {
    return {
      ok: false,
      body: JSON.stringify({
        success: false,
        error: "UNAUTHENTICATED",
        message: "Nakama session required",
      }),
    };
  }
  return { ok: true, userId: ctx.userId };
}

function lapRecentsEmpty() {
  return { items: [], updatedAt: "" };
}

function lapRecentsNormalizeItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  var noteId = String(raw.noteId || raw.id || raw.note_id || "").trim();
  if (!noteId) return null;
  var ts = Number(raw.ts);
  if (isNaN(ts) || ts <= 0) {
    var parsed = Date.parse(raw.updatedAt || raw.updated_at || raw.createdAt || "");
    ts = isNaN(parsed) ? Date.now() : parsed;
  }
  return {
    noteId: noteId,
    noteTitle: String(raw.noteTitle || raw.title || raw.note_title || "Untitled").slice(0, 160),
    sourceType: String(raw.sourceType || raw.source_type || raw.type || "text").slice(0, 32),
    thumbnailUrl: String(raw.thumbnailUrl || raw.thumbnail_url || "").slice(0, 512),
    ts: Math.round(ts),
  };
}

function lapRecentsNormalizeList(arr) {
  if (!arr || !(arr instanceof Array)) return [];
  var seen = {};
  var out = [];
  for (var i = 0; i < arr.length && out.length < LAP_RECENTS_MAX; i++) {
    var item = lapRecentsNormalizeItem(arr[i]);
    if (!item || seen[item.noteId]) continue;
    seen[item.noteId] = true;
    out.push(item);
  }
  out.sort(function (a, b) {
    return b.ts - a.ts;
  });
  if (out.length > LAP_RECENTS_MAX) {
    out = out.slice(0, LAP_RECENTS_MAX);
  }
  return out;
}

function lapRecentsRead(nk, userId) {
  var objects;
  try {
    objects = nk.storageRead([
      {
        collection: LAP_RECENTS_COLLECTION,
        key: LAP_RECENTS_KEY,
        userId: userId,
      },
    ]);
  } catch (e) {
    return lapRecentsEmpty();
  }
  if (!objects || !objects.length || !objects[0].value) {
    return lapRecentsEmpty();
  }
  var val = objects[0].value;
  return {
    items: lapRecentsNormalizeList(val.items),
    updatedAt: String(val.updatedAt || ""),
  };
}

function lapRecentsWrite(nk, userId, state) {
  var clean = {
    items: lapRecentsNormalizeList(state && state.items ? state.items : []),
    updatedAt: lapRecentsNow(),
  };
  nk.storageWrite([
    {
      collection: LAP_RECENTS_COLLECTION,
      key: LAP_RECENTS_KEY,
      userId: userId,
      value: clean,
      permissionRead: 1,
      permissionWrite: 0,
    },
  ]);
  return clean;
}

/**
 * RPC: quizverse_lap_recents_get
 * Payload: {}
 * Response: { success, items }
 */
var rpcQuizverseLapRecentsGet = function (ctx, logger, nk, payload) {
  var auth = lapRecentsRequireUser(ctx);
  if (!auth.ok) return auth.body;
  try {
    var state = lapRecentsRead(nk, auth.userId);
    return JSON.stringify({
      success: true,
      items: state.items,
      updatedAt: state.updatedAt,
    });
  } catch (err) {
    logger.error("[LAP-Recents] get error: " + err.message);
    return JSON.stringify({
      success: false,
      error: err.message,
      items: [],
    });
  }
};

/**
 * RPC: quizverse_lap_recents_touch
 * Payload: { noteId, noteTitle?, sourceType?, thumbnailUrl?, ts? }
 * Upserts one note to the front of the list.
 */
var rpcQuizverseLapRecentsTouch = function (ctx, logger, nk, payload) {
  var auth = lapRecentsRequireUser(ctx);
  if (!auth.ok) return auth.body;
  try {
    var data = lapRecentsParse(payload);
    var item = lapRecentsNormalizeItem(data.item || data);
    if (!item) {
      return JSON.stringify({
        success: false,
        error: "noteId required",
      });
    }
    if (!item.ts) item.ts = Date.now();
    var state = lapRecentsRead(nk, auth.userId);
    var rest = [];
    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].noteId !== item.noteId) rest.push(state.items[i]);
    }
    rest.unshift(item);
    var saved = lapRecentsWrite(nk, auth.userId, { items: rest });
    return JSON.stringify({
      success: true,
      items: saved.items,
      updatedAt: saved.updatedAt,
    });
  } catch (err) {
    logger.error("[LAP-Recents] touch error: " + err.message);
    return JSON.stringify({ success: false, error: err.message });
  }
};

/**
 * RPC: quizverse_lap_recents_replace
 * Payload: { items: [...] }
 * Full replace (LAP Home backfill from AI notes list).
 */
var rpcQuizverseLapRecentsReplace = function (ctx, logger, nk, payload) {
  var auth = lapRecentsRequireUser(ctx);
  if (!auth.ok) return auth.body;
  try {
    var data = lapRecentsParse(payload);
    var incoming = data.items;
    if (!incoming || !(incoming instanceof Array)) {
      return JSON.stringify({
        success: false,
        error: "items array required",
      });
    }
    var saved = lapRecentsWrite(nk, auth.userId, { items: incoming });
    return JSON.stringify({
      success: true,
      items: saved.items,
      updatedAt: saved.updatedAt,
    });
  } catch (err) {
    logger.error("[LAP-Recents] replace error: " + err.message);
    return JSON.stringify({ success: false, error: err.message });
  }
};

function InitModule(ctx, logger, nk, initializer) {
  // Direct single-line registerRpc — postbuild AST walker requires this form.
  try {
    initializer.registerRpc("quizverse_lap_recents_get", rpcQuizverseLapRecentsGet);
    logger.info("[LAP-Recents] Registered RPC: quizverse_lap_recents_get");
  } catch (e) {
    logger.error("[LAP-Recents] Failed to register get: " + e.message);
  }
  try {
    initializer.registerRpc("quizverse_lap_recents_touch", rpcQuizverseLapRecentsTouch);
    logger.info("[LAP-Recents] Registered RPC: quizverse_lap_recents_touch");
  } catch (e) {
    logger.error("[LAP-Recents] Failed to register touch: " + e.message);
  }
  try {
    initializer.registerRpc("quizverse_lap_recents_replace", rpcQuizverseLapRecentsReplace);
    logger.info("[LAP-Recents] Registered RPC: quizverse_lap_recents_replace");
  } catch (e) {
    logger.error("[LAP-Recents] Failed to register replace: " + e.message);
  }
  logger.info("[LAP-Recents] LAP recents module initialized");
}
