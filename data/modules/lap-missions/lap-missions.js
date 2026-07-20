/**
 * QuizVerse Link & Play — daily / weekly missions sync.
 *
 * Source of truth for cross-device sync. Client localStorage is a cache.
 *
 * Collection: lap_missions
 * Key: state
 * Value: {
 *   dailyDate, weekKey, daily[], weekly[], updatedAt
 * }
 *
 * RPCs:
 *   quizverse_lap_missions_get
 *   quizverse_lap_missions_upsert
 */

var LAP_MISSIONS_COLLECTION = "lap_missions";
var LAP_MISSIONS_KEY = "state";
var LAP_MISSIONS_MAX_LIST = 6;

function lapMissionsNow() {
  return new Date().toISOString();
}

function lapMissionsParse(payload) {
  try {
    return JSON.parse(payload || "{}");
  } catch (e) {
    return {};
  }
}

function lapMissionsRequireUser(ctx) {
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

function lapMissionsClampInt(n, min, max) {
  var v = Math.round(Number(n));
  if (isNaN(v)) v = min;
  if (v < min) v = min;
  if (v > max) v = max;
  return v;
}

function lapMissionsSanitizeReward(raw) {
  if (!raw || typeof raw !== "object") return { kind: "xp", amount: 0 };
  var kind = String(raw.kind || "xp");
  if (kind === "coins") {
    return { kind: "coins", amount: lapMissionsClampInt(raw.amount, 0, 100000) };
  }
  if (kind === "streak_freeze") {
    return { kind: "streak_freeze", amount: lapMissionsClampInt(raw.amount, 0, 100) };
  }
  if (kind === "chest") {
    var tier = String(raw.tier || "silver");
    if (tier !== "gold" && tier !== "lucky") tier = "silver";
    return { kind: "chest", tier: tier };
  }
  return { kind: "xp", amount: lapMissionsClampInt(raw.amount, 0, 100000) };
}

function lapMissionsSanitizeMission(raw) {
  if (!raw || typeof raw !== "object") return null;
  var id = String(raw.id || "").trim();
  if (!id) return null;
  var required = lapMissionsClampInt(raw.required, 1, 100000);
  var progress = lapMissionsClampInt(raw.progress, 0, required);
  var completed = !!raw.completed || progress >= required;
  return {
    id: id,
    title: String(raw.title || id).slice(0, 120),
    description: String(raw.description || "").slice(0, 240),
    emoji: String(raw.emoji || "🎯").slice(0, 16),
    activity: String(raw.activity || "").slice(0, 64),
    required: required,
    reward: lapMissionsSanitizeReward(raw.reward),
    progress: progress,
    completed: completed,
    claimed: !!raw.claimed,
  };
}

function lapMissionsSanitizeList(arr) {
  if (!arr || !(arr instanceof Array)) return [];
  var out = [];
  var seen = {};
  for (var i = 0; i < arr.length && out.length < LAP_MISSIONS_MAX_LIST; i++) {
    var m = lapMissionsSanitizeMission(arr[i]);
    if (!m || seen[m.id]) continue;
    seen[m.id] = true;
    out.push(m);
  }
  return out;
}

function lapMissionsEmpty() {
  return {
    dailyDate: "",
    weekKey: "",
    daily: [],
    weekly: [],
    updatedAt: "",
  };
}

function lapMissionsSanitize(raw) {
  var base = lapMissionsEmpty();
  if (!raw || typeof raw !== "object") return base;
  return {
    dailyDate: String(raw.dailyDate || "").slice(0, 16),
    weekKey: String(raw.weekKey || "").slice(0, 16),
    daily: lapMissionsSanitizeList(raw.daily),
    weekly: lapMissionsSanitizeList(raw.weekly),
    updatedAt: String(raw.updatedAt || ""),
  };
}

function lapMissionsMergeList(a, b) {
  var map = {};
  var order = [];
  function ingest(list) {
    if (!list) return;
    for (var i = 0; i < list.length; i++) {
      var m = lapMissionsSanitizeMission(list[i]);
      if (!m) continue;
      var prev = map[m.id];
      if (!prev) {
        map[m.id] = m;
        order.push(m.id);
        continue;
      }
      var progress = Math.max(prev.progress, m.progress);
      var required = Math.max(prev.required, m.required) || m.required;
      progress = Math.min(progress, required);
      map[m.id] = {
        id: m.id,
        title: m.title || prev.title,
        description: m.description || prev.description,
        emoji: m.emoji || prev.emoji,
        activity: m.activity || prev.activity,
        required: required,
        reward: m.reward || prev.reward,
        progress: progress,
        completed: prev.completed || m.completed || progress >= required,
        claimed: prev.claimed || m.claimed,
      };
    }
  }
  ingest(a);
  ingest(b);
  var out = [];
  for (var j = 0; j < order.length; j++) {
    out.push(map[order[j]]);
  }
  return out;
}

function lapMissionsPickPeriod(localVal, remoteVal, preferVal, localUpdated, remoteUpdated) {
  if (localVal === preferVal && remoteVal !== preferVal) return "local";
  if (remoteVal === preferVal && localVal !== preferVal) return "remote";
  if (localVal && !remoteVal) return "local";
  if (remoteVal && !localVal) return "remote";
  if (localVal === remoteVal) return "merge";
  return remoteUpdated >= localUpdated ? "remote" : "local";
}

/**
 * Merge client + server mission stores.
 * Same day/week → max progress, OR completed/claimed.
 * Different period → keep the set that matches today's UTC day / ISO week when possible.
 */
function lapMissionsMerge(server, client, todayUTC, weekKey) {
  var s = lapMissionsSanitize(server);
  var c = lapMissionsSanitize(client);
  var sUpdated = s.updatedAt ? Date.parse(s.updatedAt) : 0;
  var cUpdated = c.updatedAt ? Date.parse(c.updatedAt) : 0;
  if (isNaN(sUpdated)) sUpdated = 0;
  if (isNaN(cUpdated)) cUpdated = 0;

  var dailyPick = lapMissionsPickPeriod(
    c.dailyDate,
    s.dailyDate,
    todayUTC || "",
    cUpdated,
    sUpdated,
  );
  var weekPick = lapMissionsPickPeriod(
    c.weekKey,
    s.weekKey,
    weekKey || "",
    cUpdated,
    sUpdated,
  );

  var dailyDate = s.dailyDate;
  var daily = s.daily;
  if (dailyPick === "local") {
    dailyDate = c.dailyDate;
    daily = c.daily;
  } else if (dailyPick === "merge") {
    dailyDate = c.dailyDate || s.dailyDate;
    daily = lapMissionsMergeList(s.daily, c.daily);
  }

  var outWeekKey = s.weekKey;
  var weekly = s.weekly;
  if (weekPick === "local") {
    outWeekKey = c.weekKey;
    weekly = c.weekly;
  } else if (weekPick === "merge") {
    outWeekKey = c.weekKey || s.weekKey;
    weekly = lapMissionsMergeList(s.weekly, c.weekly);
  }

  return {
    dailyDate: dailyDate,
    weekKey: outWeekKey,
    daily: daily,
    weekly: weekly,
    updatedAt: lapMissionsNow(),
  };
}

function lapMissionsRead(nk, userId) {
  try {
    var rows = nk.storageRead([
      {
        collection: LAP_MISSIONS_COLLECTION,
        key: LAP_MISSIONS_KEY,
        userId: userId,
      },
    ]);
    if (!rows || rows.length === 0 || !rows[0].value) return lapMissionsEmpty();
    return lapMissionsSanitize(rows[0].value);
  } catch (e) {
    return lapMissionsEmpty();
  }
}

function lapMissionsWrite(nk, userId, state) {
  var clean = lapMissionsSanitize(state);
  clean.updatedAt = lapMissionsNow();
  nk.storageWrite([
    {
      collection: LAP_MISSIONS_COLLECTION,
      key: LAP_MISSIONS_KEY,
      userId: userId,
      value: clean,
      permissionRead: 1,
      permissionWrite: 0,
    },
  ]);
  return clean;
}

function lapMissionsTodayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function lapMissionsWeekKey() {
  var d = new Date();
  var thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() + (4 - (d.getUTCDay() || 7)));
  var year = thursday.getUTCFullYear();
  var jan4 = new Date(Date.UTC(year, 0, 4));
  var week = Math.ceil(
    ((thursday.getTime() - jan4.getTime()) / 86400000 + (jan4.getUTCDay() || 7) - 1) / 7 + 1,
  );
  return year + "-W" + (week < 10 ? "0" + week : String(week));
}

/**
 * RPC: quizverse_lap_missions_get
 * Payload: {}
 * Response: { success, missions }
 */
var rpcQuizverseLapMissionsGet = function (ctx, logger, nk, payload) {
  var auth = lapMissionsRequireUser(ctx);
  if (!auth.ok) return auth.body;
  try {
    var missions = lapMissionsRead(nk, auth.userId);
    return JSON.stringify({ success: true, missions: missions });
  } catch (err) {
    logger.error("[LAP-Missions] get error: " + err.message);
    return JSON.stringify({
      success: false,
      error: err.message,
      missions: lapMissionsEmpty(),
    });
  }
};

/**
 * RPC: quizverse_lap_missions_upsert
 * Payload: { missions: { dailyDate, weekKey, daily, weekly } }
 */
var rpcQuizverseLapMissionsUpsert = function (ctx, logger, nk, payload) {
  var auth = lapMissionsRequireUser(ctx);
  if (!auth.ok) return auth.body;
  try {
    var data = lapMissionsParse(payload);
    var incoming = data.missions || data;
    if (!incoming || typeof incoming !== "object") {
      return JSON.stringify({
        success: false,
        error: "missions object required",
      });
    }
    var server = lapMissionsRead(nk, auth.userId);
    var merged = lapMissionsMerge(
      server,
      incoming,
      lapMissionsTodayUTC(),
      lapMissionsWeekKey(),
    );
    var saved = lapMissionsWrite(nk, auth.userId, merged);
    return JSON.stringify({ success: true, missions: saved });
  } catch (err) {
    logger.error("[LAP-Missions] upsert error: " + err.message);
    return JSON.stringify({ success: false, error: err.message });
  }
};

function InitModule(ctx, logger, nk, initializer) {
  try {
    initializer.registerRpc(
      "quizverse_lap_missions_get",
      rpcQuizverseLapMissionsGet,
    );
    logger.info("[LAP-Missions] Registered RPC: quizverse_lap_missions_get");
  } catch (e) {
    logger.error("[LAP-Missions] Failed to register get: " + e.message);
  }
  try {
    initializer.registerRpc(
      "quizverse_lap_missions_upsert",
      rpcQuizverseLapMissionsUpsert,
    );
    logger.info("[LAP-Missions] Registered RPC: quizverse_lap_missions_upsert");
  } catch (e) {
    logger.error("[LAP-Missions] Failed to register upsert: " + e.message);
  }
  logger.info("[LAP-Missions] LAP missions module initialized");
}
