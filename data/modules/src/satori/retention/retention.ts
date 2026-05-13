// Satori Retention — D0/D1/D3/D7/D14/D30 cohort retention reporting and
// rolling daily-active-user matrices. Mirrors the Satori "Analyse Retention"
// console feature.
//
// We build the report from `satori_events` records (collection
// SATORI_EVENTS_COLLECTION). For each user we extract:
//   - first_seen_date (earliest ts)
//   - per-day active set (any event with a configured "active" name)
// The cohort retention then asks: of all users whose first_seen falls on
// day D, how many were active on day D + N for N ∈ DEFAULT_BUCKETS?
//
// The legacy LegacyAnalyticsRetention module computes a similar metric over
// the legacy analytics_events table; this module is the Satori-namespaced
// counterpart that targets the canonical satori_events collection.
namespace SatoriRetention {

  var DEFAULT_BUCKETS = [0, 1, 3, 7, 14, 30];
  var ACTIVE_EVENT_DEFAULT = "session_start";
  var MAX_EVENTS_SCAN = 20000;

  interface RetentionConfig {
    activeEventNames: string[]; // events that count a player as DAU
    buckets: number[];
  }

  function loadConfig(nk: nkruntime.Nakama, gameId?: string): RetentionConfig {
    return ConfigLoader.loadSatoriConfigForGame<RetentionConfig>(nk, "retention", gameId, {
      activeEventNames: [ACTIVE_EVENT_DEFAULT],
      buckets: DEFAULT_BUCKETS.slice()
    });
  }

  interface CohortBucket {
    cohortDate: string;     // ISO yyyy-mm-dd
    cohortSize: number;     // users in this cohort
    retained: { [bucket: number]: number };  // bucket day -> count retained
    retainedPct: { [bucket: number]: number }; // bucket day -> %
  }

  interface RetentionReport {
    rangeStartMs: number;
    rangeEndMs: number;
    activeEventNames: string[];
    buckets: number[];
    cohorts: CohortBucket[];
    overallByBucket: { bucket: number; users: number; pct: number }[];
  }

  function dayKey(ts: number): string {
    return new Date(ts).toISOString().slice(0, 10);
  }

  function dayDiff(a: string, b: string): number {
    var ad = new Date(a + "T00:00:00Z").getTime();
    var bd = new Date(b + "T00:00:00Z").getTime();
    return Math.round((bd - ad) / 86400000);
  }

  // Returns events filtered to the active-event names within window.
  function scanActiveEvents(nk: nkruntime.Nakama, fromMs: number, toMs: number, names: string[]): any[] {
    var nameSet: { [n: string]: boolean } = {};
    for (var i = 0; i < names.length; i++) nameSet[names[i]] = true;
    var collected: any[] = [];
    var cursor = "";
    var pages = 0;
    while (collected.length < MAX_EVENTS_SCAN && pages < 100) {
      var page = nk.storageList(Constants.SYSTEM_USER_ID, Constants.SATORI_EVENTS_COLLECTION, 200, cursor);
      pages++;
      if (!page.objects || page.objects.length === 0) break;
      for (var i2 = 0; i2 < page.objects.length; i2++) {
        var v = page.objects[i2].value as any;
        if (!v || !v.timestamp) continue;
        if (!nameSet[v.name]) continue;
        if (v.timestamp < fromMs || v.timestamp > toMs) continue;
        collected.push(v);
      }
      if (!page.cursor) break;
      cursor = page.cursor;
    }
    return collected;
  }

  export function runReport(nk: nkruntime.Nakama, fromMs: number, toMs: number, gameId?: string): RetentionReport {
    var cfg = loadConfig(nk, gameId);
    var events = scanActiveEvents(nk, fromMs, toMs, cfg.activeEventNames);

    // userId -> earliest day (cohort)
    var firstSeen: { [u: string]: string } = {};
    // userId -> active days set
    var activeDays: { [u: string]: { [d: string]: boolean } } = {};

    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      var uid = String(ev.userId || ev.identityId || "anon");
      var d = dayKey(ev.timestamp);
      if (!firstSeen[uid] || d < firstSeen[uid]) firstSeen[uid] = d;
      if (!activeDays[uid]) activeDays[uid] = {};
      activeDays[uid][d] = true;
    }

    // Group users by cohort (firstSeen date)
    var cohorts: { [date: string]: string[] } = {};
    for (var u in firstSeen) {
      if (!firstSeen.hasOwnProperty(u)) continue;
      var c = firstSeen[u];
      if (!cohorts[c]) cohorts[c] = [];
      cohorts[c].push(u);
    }

    var buckets = cfg.buckets;
    var cohortOut: CohortBucket[] = [];
    var overallRetained: { [bucket: number]: number } = {};
    var overallSize = 0;

    var dates = Object.keys(cohorts).sort();
    for (var di = 0; di < dates.length; di++) {
      var cd = dates[di];
      var users = cohorts[cd];
      overallSize += users.length;
      var retained: { [bucket: number]: number } = {};
      var retainedPct: { [bucket: number]: number } = {};
      for (var bi = 0; bi < buckets.length; bi++) {
        var b = buckets[bi];
        var n = 0;
        for (var ui = 0; ui < users.length; ui++) {
          var ud = activeDays[users[ui]] || {};
          for (var dd in ud) {
            if (!ud.hasOwnProperty(dd)) continue;
            if (dayDiff(cd, dd) === b) { n++; break; }
          }
        }
        retained[b] = n;
        retainedPct[b] = users.length > 0 ? Math.round((n / users.length) * 10000) / 100 : 0;
        overallRetained[b] = (overallRetained[b] || 0) + n;
      }
      cohortOut.push({ cohortDate: cd, cohortSize: users.length, retained: retained, retainedPct: retainedPct });
    }

    var overallByBucket: { bucket: number; users: number; pct: number }[] = [];
    for (var bj = 0; bj < buckets.length; bj++) {
      var bk = buckets[bj];
      overallByBucket.push({
        bucket: bk,
        users: overallRetained[bk] || 0,
        pct: overallSize > 0 ? Math.round(((overallRetained[bk] || 0) / overallSize) * 10000) / 100 : 0
      });
    }

    return {
      rangeStartMs: fromMs,
      rangeEndMs: toMs,
      activeEventNames: cfg.activeEventNames,
      buckets: buckets,
      cohorts: cohortOut,
      overallByBucket: overallByBucket
    };
  }

  // ----- RPCs -----

  function rpcGetConfig(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = RpcHelpers.parseRpcPayload(payload);
    return RpcHelpers.successResponse({ config: loadConfig(nk, RpcHelpers.gameId(data)) });
  }

  function rpcSetConfig(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    var gameId = RpcHelpers.gameId(data);
    var cfg = loadConfig(nk, gameId);
    if (Array.isArray(data.activeEventNames)) cfg.activeEventNames = data.activeEventNames.map(String);
    if (Array.isArray(data.buckets)) cfg.buckets = data.buckets.map(function (b: any) { return parseInt(String(b), 10); }).filter(function (n: number) { return n >= 0; });
    ConfigLoader.saveSatoriConfigForGame(nk, "retention", gameId, cfg);
    return RpcHelpers.successResponse({ config: cfg });
  }

  function rpcRun(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = RpcHelpers.parseRpcPayload(payload);
    var nowMs = Date.now();
    var fromMs = data.fromMs || (nowMs - 60 * 86400000);
    var toMs = data.toMs || nowMs;
    var report = runReport(nk, fromMs, toMs, RpcHelpers.gameId(data));
    return RpcHelpers.successResponse(report);
  }

  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("satori_retention_get_config", rpcGetConfig);
    initializer.registerRpc("satori_retention_set_config", rpcSetConfig);
    initializer.registerRpc("satori_retention_run", rpcRun);
  }
}
