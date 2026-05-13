// Satori RoAS — Return on Ad Spend reporting per cohort, channel, and
// experiment variant. Mirrors the Satori console "Analyse RoAS" feature.
//
// Inputs:
//   - Marketing spend records (admin uploads): channel/campaign/country/date,
//     amountUsd. Stored as a system blob.
//   - Player attribution: each user identity may carry an `acquisitionChannel`,
//     `acquisitionCampaign`, `acquisitionCountry` recorded on first session.
//   - Spend events: any captured event with name `purchase` and metadata
//     `amount` (parsed as USD). Also picks up Hiro store / IAP base events.
//
// RoAS = sum(player_revenue_in_window) / sum(ad_spend) for the cohort window.
namespace SatoriRoAS {

  interface SpendRecord {
    id: string;
    channel: string;
    campaign?: string;
    country?: string;
    date: string;     // ISO yyyy-mm-dd
    amountUsd: number;
  }

  interface SpendStore {
    records: SpendRecord[];
  }

  interface RoASBucket {
    channel: string;
    campaign?: string;
    country?: string;
    cohortDate?: string;
    spendUsd: number;
    revenueUsd: number;
    roasPct: number;
    payerCount: number;
  }

  interface RoASReport {
    rangeStartMs: number;
    rangeEndMs: number;
    totalSpendUsd: number;
    totalRevenueUsd: number;
    roasPctOverall: number;
    buckets: RoASBucket[];
  }

  function loadSpend(nk: nkruntime.Nakama, gameId?: string): SpendStore {
    return ConfigLoader.loadSatoriConfigForGame<SpendStore>(nk, "roas_spend", gameId, { records: [] });
  }

  function saveSpend(nk: nkruntime.Nakama, store: SpendStore, gameId?: string): void {
    ConfigLoader.saveSatoriConfigForGame(nk, "roas_spend", gameId, store);
  }

  // Scan satori_events for purchase events in window.
  function scanRevenueEvents(nk: nkruntime.Nakama, fromMs: number, toMs: number): any[] {
    var collected: any[] = [];
    var cursor = "";
    var pages = 0;
    while (collected.length < 20000 && pages < 100) {
      var page = nk.storageList(Constants.SYSTEM_USER_ID, Constants.SATORI_EVENTS_COLLECTION, 200, cursor);
      pages++;
      if (!page.objects || page.objects.length === 0) break;
      for (var i = 0; i < page.objects.length; i++) {
        var v = page.objects[i].value as any;
        if (!v || !v.timestamp) continue;
        if (v.name !== "purchase" && v.name !== "iap_validated") continue;
        if (v.timestamp < fromMs || v.timestamp > toMs) continue;
        collected.push(v);
      }
      if (!page.cursor) break;
      cursor = page.cursor;
    }
    return collected;
  }

  function getUserAttribution(nk: nkruntime.Nakama, userId: string): { channel?: string; campaign?: string; country?: string } {
    try {
      var props = SatoriIdentities.getAllProperties(nk, userId);
      return {
        channel: props.customProperties["acquisitionChannel"] || props.defaultProperties["acquisitionChannel"],
        campaign: props.customProperties["acquisitionCampaign"] || props.defaultProperties["acquisitionCampaign"],
        country: props.defaultProperties["country"] || props.defaultProperties["country_code"]
      };
    } catch (_) { return {}; }
  }

  export function runReport(nk: nkruntime.Nakama, fromMs: number, toMs: number, groupBy: string[], gameId?: string): RoASReport {
    var spend = loadSpend(nk, gameId);
    var events = scanRevenueEvents(nk, fromMs, toMs);
    var fromDate = new Date(fromMs).toISOString().slice(0, 10);
    var toDate = new Date(toMs).toISOString().slice(0, 10);

    var bucketMap: { [key: string]: RoASBucket } = {};

    function bucketKey(b: { channel: string; campaign?: string; country?: string; cohortDate?: string }): string {
      return [b.channel, b.campaign || "", b.country || "", b.cohortDate || ""].join("|");
    }

    function ensureBucket(channel: string, campaign?: string, country?: string, cohortDate?: string): RoASBucket {
      var b: RoASBucket = { channel: channel, spendUsd: 0, revenueUsd: 0, roasPct: 0, payerCount: 0 };
      if (groupBy.indexOf("campaign") >= 0) b.campaign = campaign;
      if (groupBy.indexOf("country") >= 0) b.country = country;
      if (groupBy.indexOf("cohortDate") >= 0) b.cohortDate = cohortDate;
      var k = bucketKey(b);
      if (!bucketMap[k]) bucketMap[k] = b;
      return bucketMap[k];
    }

    // ---- spend ----
    for (var s = 0; s < spend.records.length; s++) {
      var r = spend.records[s];
      if (r.date < fromDate || r.date > toDate) continue;
      var b = ensureBucket(r.channel, r.campaign, r.country, r.date);
      b.spendUsd += r.amountUsd || 0;
    }

    // ---- revenue ----
    var payersByBucket: { [k: string]: { [u: string]: boolean } } = {};
    for (var e = 0; e < events.length; e++) {
      var ev = events[e];
      var uid = String(ev.userId || ev.identityId || "anon");
      var attr = getUserAttribution(nk, uid);
      var amt = parseFloat(String((ev.metadata && ev.metadata.amount) || (ev.metadata && ev.metadata.amountUsd) || 0));
      if (!isFinite(amt) || amt <= 0) continue;
      var b2 = ensureBucket(attr.channel || "unknown", attr.campaign, attr.country, new Date(ev.timestamp).toISOString().slice(0, 10));
      b2.revenueUsd += amt;
      var k2 = bucketKey({ channel: b2.channel, campaign: b2.campaign, country: b2.country, cohortDate: b2.cohortDate });
      if (!payersByBucket[k2]) payersByBucket[k2] = {};
      payersByBucket[k2][uid] = true;
    }

    var buckets: RoASBucket[] = [];
    var totalSpend = 0, totalRev = 0;
    for (var key in bucketMap) {
      if (!bucketMap.hasOwnProperty(key)) continue;
      var bk = bucketMap[key];
      bk.roasPct = bk.spendUsd > 0 ? Math.round((bk.revenueUsd / bk.spendUsd) * 10000) / 100 : 0;
      var payers = payersByBucket[key] || {};
      var pc = 0; for (var pu in payers) if (payers.hasOwnProperty(pu)) pc++;
      bk.payerCount = pc;
      totalSpend += bk.spendUsd; totalRev += bk.revenueUsd;
      buckets.push(bk);
    }

    return {
      rangeStartMs: fromMs,
      rangeEndMs: toMs,
      totalSpendUsd: totalSpend,
      totalRevenueUsd: totalRev,
      roasPctOverall: totalSpend > 0 ? Math.round((totalRev / totalSpend) * 10000) / 100 : 0,
      buckets: buckets
    };
  }

  // ----- RPCs -----

  function rpcSpendUpsert(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.records || !Array.isArray(data.records)) return RpcHelpers.errorResponse("records[] required");
    var gameId = RpcHelpers.gameId(data);
    var store = loadSpend(nk, gameId);
    var idx: { [id: string]: number } = {};
    for (var i = 0; i < store.records.length; i++) idx[store.records[i].id] = i;
    for (var r = 0; r < data.records.length; r++) {
      var rec = data.records[r];
      if (!rec || !rec.id || !rec.channel || !rec.date) continue;
      var sr: SpendRecord = {
        id: String(rec.id),
        channel: String(rec.channel),
        campaign: rec.campaign,
        country: rec.country,
        date: String(rec.date),
        amountUsd: parseFloat(String(rec.amountUsd || 0))
      };
      if (idx[sr.id] !== undefined) store.records[idx[sr.id]] = sr;
      else store.records.push(sr);
    }
    saveSpend(nk, store, gameId);
    return RpcHelpers.successResponse({ count: store.records.length });
  }

  function rpcSpendList(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = RpcHelpers.parseRpcPayload(payload);
    return RpcHelpers.successResponse({ records: loadSpend(nk, RpcHelpers.gameId(data)).records });
  }

  function rpcRun(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = RpcHelpers.parseRpcPayload(payload);
    var nowMs = Date.now();
    var fromMs = data.fromMs || (nowMs - 30 * 86400000);
    var toMs = data.toMs || nowMs;
    var groupBy: string[] = Array.isArray(data.groupBy) ? data.groupBy.map(String) : ["channel"];
    var report = runReport(nk, fromMs, toMs, groupBy, RpcHelpers.gameId(data));
    return RpcHelpers.successResponse(report);
  }

  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("satori_roas_spend_upsert", rpcSpendUpsert);
    initializer.registerRpc("satori_roas_spend_list", rpcSpendList);
    initializer.registerRpc("satori_roas_run", rpcRun);
  }
}
