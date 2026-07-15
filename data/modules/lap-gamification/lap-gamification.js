/**
 * QuizVerse Link & Play — gamification (XP / streak / client badges).
 *
 * Source of truth for cross-device sync. Client localStorage is a cache.
 *
 * Collection: lap_gamification
 * Key: state
 * Value: {
 *   xp, streak, longestStreak, lastActiveDate, badges[], counts{},
 *   streakFreezes, playedDates[], notesCreated, luckyLinkCounter,
 *   updatedAt
 * }
 *
 * RPCs:
 *   quizverse_lap_gamification_get
 *   quizverse_lap_gamification_upsert
 */

var LAP_XP_COLLECTION = "lap_gamification";
var LAP_XP_KEY = "state";
var LAP_XP_MAX_PLAYED_DATES = 90;
var LAP_XP_MAX_BADGES = 64;

function lapXpNow() {
  return new Date().toISOString();
}

function lapXpParse(payload) {
  try {
    return JSON.parse(payload || "{}");
  } catch (e) {
    return {};
  }
}

function lapXpRequireUser(ctx) {
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

function lapXpEmpty() {
  return {
    xp: 0,
    streak: 0,
    longestStreak: 0,
    lastActiveDate: "",
    badges: [],
    counts: {},
    streakFreezes: 0,
    playedDates: [],
    notesCreated: 0,
    luckyLinkCounter: 0,
    updatedAt: "",
  };
}

function lapXpClampInt(n, min, max) {
  var v = Math.round(Number(n));
  if (isNaN(v)) v = min;
  if (v < min) v = min;
  if (v > max) v = max;
  return v;
}

function lapXpNormalizeBadges(arr) {
  if (!arr || !(arr instanceof Array)) return [];
  var seen = {};
  var out = [];
  for (var i = 0; i < arr.length && out.length < LAP_XP_MAX_BADGES; i++) {
    var id = String(arr[i] || "").trim();
    if (!id || seen[id]) continue;
    seen[id] = true;
    out.push(id);
  }
  return out;
}

function lapXpNormalizeCounts(obj) {
  var out = {};
  if (!obj || typeof obj !== "object") return out;
  var keys = Object.keys(obj);
  for (var i = 0; i < keys.length; i++) {
    var k = keys[i];
    out[k] = lapXpClampInt(obj[k], 0, 1000000);
  }
  return out;
}

function lapXpNormalizeDates(arr) {
  if (!arr || !(arr instanceof Array)) return [];
  var seen = {};
  var out = [];
  for (var i = 0; i < arr.length; i++) {
    var d = String(arr[i] || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || seen[d]) continue;
    seen[d] = true;
    out.push(d);
  }
  out.sort();
  if (out.length > LAP_XP_MAX_PLAYED_DATES) {
    out = out.slice(out.length - LAP_XP_MAX_PLAYED_DATES);
  }
  return out;
}

function lapXpDaysBetween(a, b) {
  if (!a || !b) return 9999;
  var ms = Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z");
  if (isNaN(ms)) return 9999;
  return Math.round(ms / 86400000);
}

/** Recompute current streak from sorted playedDates (newest wins as lastActive). */
function lapXpRecomputeStreak(playedDates) {
  if (!playedDates || playedDates.length === 0) {
    return { streak: 0, longestStreak: 0, lastActiveDate: "" };
  }
  var dates = playedDates.slice().sort();
  var last = dates[dates.length - 1];
  var streak = 1;
  for (var i = dates.length - 2; i >= 0; i--) {
    var gap = lapXpDaysBetween(dates[i], dates[i + 1]);
    if (gap === 1) {
      streak += 1;
    } else if (gap === 0) {
      continue;
    } else {
      break;
    }
  }
  // Historical longest: walk all contiguous runs
  var longest = streak;
  var run = 1;
  for (var j = 1; j < dates.length; j++) {
    var g = lapXpDaysBetween(dates[j - 1], dates[j]);
    if (g === 1) {
      run += 1;
      if (run > longest) longest = run;
    } else if (g === 0) {
      continue;
    } else {
      run = 1;
    }
  }
  return { streak: streak, longestStreak: longest, lastActiveDate: last };
}

function lapXpRead(nk, userId) {
  try {
    var rows = nk.storageRead([
      {
        collection: LAP_XP_COLLECTION,
        key: LAP_XP_KEY,
        userId: userId,
      },
    ]);
    if (!rows || rows.length === 0 || !rows[0].value) return lapXpEmpty();
    return lapXpSanitize(rows[0].value);
  } catch (e) {
    return lapXpEmpty();
  }
}

function lapXpSanitize(raw) {
  var base = lapXpEmpty();
  if (!raw || typeof raw !== "object") return base;
  var played = lapXpNormalizeDates(raw.playedDates);
  var recomputed = lapXpRecomputeStreak(played);
  return {
    xp: lapXpClampInt(raw.xp, 0, 10000000),
    streak: recomputed.streak,
    longestStreak: Math.max(
      lapXpClampInt(raw.longestStreak, 0, 10000),
      recomputed.longestStreak,
    ),
    lastActiveDate: recomputed.lastActiveDate || String(raw.lastActiveDate || ""),
    badges: lapXpNormalizeBadges(raw.badges),
    counts: lapXpNormalizeCounts(raw.counts),
    streakFreezes: lapXpClampInt(raw.streakFreezes, 0, 100),
    playedDates: played,
    notesCreated: lapXpClampInt(raw.notesCreated, 0, 100000),
    luckyLinkCounter: lapXpClampInt(raw.luckyLinkCounter, 0, 6),
    updatedAt: String(raw.updatedAt || ""),
  };
}

function lapXpMergeCounts(a, b) {
  var out = {};
  var keys = {};
  var ka = Object.keys(a || {});
  var kb = Object.keys(b || {});
  var i;
  for (i = 0; i < ka.length; i++) keys[ka[i]] = true;
  for (i = 0; i < kb.length; i++) keys[kb[i]] = true;
  var all = Object.keys(keys);
  for (i = 0; i < all.length; i++) {
    var k = all[i];
    out[k] = Math.max(
      lapXpClampInt((a || {})[k], 0, 1000000),
      lapXpClampInt((b || {})[k], 0, 1000000),
    );
  }
  return out;
}

function lapXpMergeBadges(a, b) {
  return lapXpNormalizeBadges([].concat(a || [], b || []));
}

function lapXpMerge(server, client) {
  var s = lapXpSanitize(server);
  var c = lapXpSanitize(client);
  var played = lapXpNormalizeDates([].concat(s.playedDates, c.playedDates));
  var recomputed = lapXpRecomputeStreak(played);
  var sUpdated = s.updatedAt ? Date.parse(s.updatedAt) : 0;
  var cUpdated = c.updatedAt ? Date.parse(c.updatedAt) : 0;
  if (isNaN(sUpdated)) sUpdated = 0;
  if (isNaN(cUpdated)) cUpdated = 0;
  // Freezes: prefer the newer write (consume on one device should win).
  var freezes = cUpdated >= sUpdated ? c.streakFreezes : s.streakFreezes;
  var lucky =
    cUpdated >= sUpdated ? c.luckyLinkCounter : s.luckyLinkCounter;

  return {
    xp: Math.max(s.xp, c.xp),
    streak: recomputed.streak,
    longestStreak: Math.max(s.longestStreak, c.longestStreak, recomputed.longestStreak),
    lastActiveDate: recomputed.lastActiveDate,
    badges: lapXpMergeBadges(s.badges, c.badges),
    counts: lapXpMergeCounts(s.counts, c.counts),
    streakFreezes: freezes,
    playedDates: played,
    notesCreated: Math.max(s.notesCreated, c.notesCreated),
    luckyLinkCounter: lucky,
    updatedAt: lapXpNow(),
  };
}

function lapXpWrite(nk, userId, state) {
  var clean = lapXpSanitize(state);
  clean.updatedAt = lapXpNow();
  nk.storageWrite([
    {
      collection: LAP_XP_COLLECTION,
      key: LAP_XP_KEY,
      userId: userId,
      value: clean,
      permissionRead: 1,
      permissionWrite: 0,
    },
  ]);
  return clean;
}

/**
 * RPC: quizverse_lap_gamification_get
 * Payload: {}
 * Response: { success, progress }
 */
var rpcQuizverseLapGamificationGet = function (ctx, logger, nk, payload) {
  var auth = lapXpRequireUser(ctx);
  if (!auth.ok) return auth.body;
  try {
    var progress = lapXpRead(nk, auth.userId);
    return JSON.stringify({ success: true, progress: progress });
  } catch (err) {
    logger.error("[LAP-XP] get error: " + err.message);
    return JSON.stringify({
      success: false,
      error: err.message,
      progress: lapXpEmpty(),
    });
  }
};

/**
 * RPC: quizverse_lap_gamification_upsert
 * Payload: { progress: { ...LAPProgress fields } }
 * Merges with server state (max XP/counts, union badges/dates, recompute streak).
 */
var rpcQuizverseLapGamificationUpsert = function (ctx, logger, nk, payload) {
  var auth = lapXpRequireUser(ctx);
  if (!auth.ok) return auth.body;
  try {
    var data = lapXpParse(payload);
    var incoming = data.progress || data;
    if (!incoming || typeof incoming !== "object") {
      return JSON.stringify({
        success: false,
        error: "progress object required",
      });
    }
    var server = lapXpRead(nk, auth.userId);
    var merged = lapXpMerge(server, incoming);
    var saved = lapXpWrite(nk, auth.userId, merged);
    return JSON.stringify({ success: true, progress: saved });
  } catch (err) {
    logger.error("[LAP-XP] upsert error: " + err.message);
    return JSON.stringify({ success: false, error: err.message });
  }
};

function InitModule(ctx, logger, nk, initializer) {
  try {
    initializer.registerRpc(
      "quizverse_lap_gamification_get",
      rpcQuizverseLapGamificationGet,
    );
    logger.info("[LAP-XP] Registered RPC: quizverse_lap_gamification_get");
  } catch (e) {
    logger.error("[LAP-XP] Failed to register get: " + e.message);
  }
  try {
    initializer.registerRpc(
      "quizverse_lap_gamification_upsert",
      rpcQuizverseLapGamificationUpsert,
    );
    logger.info("[LAP-XP] Registered RPC: quizverse_lap_gamification_upsert");
  } catch (e) {
    logger.error("[LAP-XP] Failed to register upsert: " + e.message);
  }
  logger.info("[LAP-XP] LAP gamification module initialized");
}
