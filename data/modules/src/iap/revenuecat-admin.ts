// =============================================================================
// RPC: admin_revenuecat_dashboard
//
// Admin Metrics money panel:
//   IAP  → RevenueCat Charts API (production gross revenue) — ground truth
//   Ads  → Nakama analytics_live_daily / analytics_rollup_daily.ad_revenue_usd
//          (Unity ILRD: LevelPlay / AdMob / Appodeal)
//   Total = IAP + Ads (shown separately; never a silent blend)
//
// Required env (RUNTIME_ENV_KEYS):
//   REVENUECAT_SECRET_API_KEY  — RevenueCat project secret key (sk_…)
//   REVENUECAT_PROJECT_ID      — defaults to QuizVerse proj0d38847e
// =============================================================================

namespace QuizVerseRevenueCatAdmin {

  var RC_API_BASE = "https://api.revenuecat.com/v2";
  var DEFAULT_PROJECT_ID = "proj0d38847e";
  var MEASURE_REVENUE = 0;
  var MEASURE_TRANSACTIONS = 1;
  var LIVE_COLLECTION = "analytics_live_daily";
  var ROLLUP_COLLECTION = "analytics_rollup_daily";

  function env(ctx: nkruntime.Context, key: string): string {
    return (ctx.env && ctx.env[key]) || "";
  }

  function isoDateUtc(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  function addDaysUtc(d: Date, days: number): Date {
    var copy = new Date(d.getTime());
    copy.setUTCDate(copy.getUTCDate() + days);
    return copy;
  }

  function round2(n: number): number {
    return Math.round(n * 100) / 100;
  }

  function rcGet(
    nk: nkruntime.Nakama,
    path: string,
    apiKey: string
  ): { ok: boolean; status: number; body: any; error: string } {
    try {
      var resp: any = nk.httpRequest(
        RC_API_BASE + path,
        "get",
        {
          Accept: "application/json",
          Authorization: "Bearer " + apiKey,
        },
        "",
        20000
      );
      var status = resp.code || 0;
      var parsed = RpcHelpers.safeJsonParse(resp.body || "{}");
      if (status < 200 || status >= 300) {
        var errMsg = parsed.success && parsed.data && parsed.data.message
          ? String(parsed.data.message)
          : (resp.body || "").substring(0, 240);
        return { ok: false, status: status, body: null, error: errMsg || ("HTTP " + status) };
      }
      if (!parsed.success) {
        return { ok: false, status: 502, body: null, error: "invalid JSON from RevenueCat" };
      }
      return { ok: true, status: status, body: parsed.data, error: "" };
    } catch (err: any) {
      var em = err && err.message ? String(err.message) : String(err);
      return { ok: false, status: 502, body: null, error: em };
    }
  }

  function metricValue(metrics: any[], id: string): number {
    if (!metrics || !metrics.length) return 0;
    for (var i = 0; i < metrics.length; i++) {
      var m = metrics[i];
      if (m && String(m.id || "") === id) {
        var v = m.value;
        if (typeof v === "number" && !isNaN(v)) return v;
        var n = parseFloat(String(v));
        return isNaN(n) ? 0 : n;
      }
    }
    return 0;
  }

  function parseDailyRevenue(chart: any): {
    daily: Array<{ date: string; revenue: number; transactions: number }>;
    totalRevenue: number;
    totalTransactions: number;
  } {
    var dailyMap: { [date: string]: { revenue: number; transactions: number } } = {};
    var values = chart && chart.values ? chart.values : [];
    var i: number;
    for (i = 0; i < values.length; i++) {
      var row = values[i];
      if (!row || row.incomplete) continue;
      var cohort = row.cohort;
      if (typeof cohort !== "number") continue;
      var date = isoDateUtc(new Date(cohort * 1000));
      if (!dailyMap[date]) {
        dailyMap[date] = { revenue: 0, transactions: 0 };
      }
      var measure = row.measure;
      var val = typeof row.value === "number" ? row.value : parseFloat(String(row.value || 0));
      if (isNaN(val)) val = 0;
      if (measure === MEASURE_REVENUE) {
        dailyMap[date].revenue += val;
      } else if (measure === MEASURE_TRANSACTIONS) {
        dailyMap[date].transactions += val;
      }
    }

    var dates = Object.keys(dailyMap).sort();
    var daily: Array<{ date: string; revenue: number; transactions: number }> = [];
    var totalRevenue = 0;
    var totalTransactions = 0;
    for (i = 0; i < dates.length; i++) {
      var d = dates[i];
      var pt = dailyMap[d];
      daily.push({ date: d, revenue: pt.revenue, transactions: pt.transactions });
      totalRevenue += pt.revenue;
      totalTransactions += pt.transactions;
    }

    if (chart && chart.summary && chart.summary.total) {
      var sr = chart.summary.total.Revenue;
      var st = chart.summary.total.Transactions;
      if (typeof sr === "number" && !isNaN(sr)) totalRevenue = sr;
      if (typeof st === "number" && !isNaN(st)) totalTransactions = st;
    }

    return { daily: daily, totalRevenue: totalRevenue, totalTransactions: totalTransactions };
  }

  /**
   * Read ad_revenue_usd for one UTC date from rollup (preferred) or live_daily.
   * Uses platform-wide keys (live_all_ / rollup_all_) — same aggregate Unity ILRD writes.
   */
  function readAdRevenueDay(nk: nkruntime.Nakama, dateStr: string): number {
    var sys = Constants.SYSTEM_USER_ID;
    try {
      var recs = nk.storageRead([
        { collection: ROLLUP_COLLECTION, key: "rollup_all_" + dateStr, userId: sys },
        { collection: LIVE_COLLECTION, key: "live_all_" + dateStr, userId: sys },
      ]);
      var byKey: { [k: string]: any } = {};
      for (var i = 0; i < recs.length; i++) {
        if (recs[i] && recs[i].value) byKey[recs[i].key] = recs[i].value;
      }
      var rollup = byKey["rollup_all_" + dateStr];
      if (rollup && rollup.revenue) {
        var rad = parseFloat(rollup.revenue.ad_revenue_usd);
        if (!isNaN(rad)) return rad;
      }
      var live = byKey["live_all_" + dateStr];
      if (live) {
        var lad = parseFloat(live.ad_revenue_usd);
        if (!isNaN(lad)) return lad;
      }
    } catch (_e) { /* missing day → 0 */ }
    return 0;
  }

  function readAdRevenueRange(
    nk: nkruntime.Nakama,
    startStr: string,
    endStr: string
  ): {
    daily: Array<{ date: string; revenue: number }>;
    total: number;
  } {
    var daily: Array<{ date: string; revenue: number }> = [];
    var total = 0;
    var cursor = new Date(startStr + "T00:00:00Z");
    var end = new Date(endStr + "T00:00:00Z");
    while (cursor.getTime() <= end.getTime()) {
      var ds = isoDateUtc(cursor);
      var ad = readAdRevenueDay(nk, ds);
      daily.push({ date: ds, revenue: round2(ad) });
      total += ad;
      cursor = addDaysUtc(cursor, 1);
    }
    return { daily: daily, total: round2(total) };
  }

  function emptyIapDaily(startStr: string, endStr: string): Array<{ date: string; revenue: number; transactions: number }> {
    var out: Array<{ date: string; revenue: number; transactions: number }> = [];
    var cursor = new Date(startStr + "T00:00:00Z");
    var end = new Date(endStr + "T00:00:00Z");
    while (cursor.getTime() <= end.getTime()) {
      out.push({ date: isoDateUtc(cursor), revenue: 0, transactions: 0 });
      cursor = addDaysUtc(cursor, 1);
    }
    return out;
  }

  function rpcAdminRevenueCatDashboard(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string
  ): string {
    RpcHelpers.requireAdmin(ctx, nk);

    var req: any;
    try {
      req = RpcHelpers.parseRpcPayload(payload);
    } catch (err: any) {
      return RpcHelpers.errorResponse(err.message || "invalid payload", nkruntime.Codes.INVALID_ARGUMENT);
    }

    var days = 30;
    if (req && req.days !== undefined && req.days !== null) {
      var d = parseInt(String(req.days), 10);
      if (!isNaN(d) && d >= 7 && d <= 90) days = d;
    }

    var end = new Date();
    var start = addDaysUtc(end, -(days - 1));
    var startStr = isoDateUtc(start);
    var endStr = isoDateUtc(end);
    var currency = "USD";

    var ads = readAdRevenueRange(nk, startStr, endStr);
    var apiKey = env(ctx, "REVENUECAT_SECRET_API_KEY");
    var projectId = env(ctx, "REVENUECAT_PROJECT_ID") || DEFAULT_PROJECT_ID;

    // Soft-degrade: still return ad revenue if RC key is missing (prior panel
    // looked "broken" solely because this env was unset on the prod pod).
    if (!apiKey) {
      logger.warn("[RevenueCatAdmin] REVENUECAT_SECRET_API_KEY missing — returning ads only");
      return RpcHelpers.successResponse({
        source: "partial",
        currency: currency,
        projectId: projectId,
        days: days,
        dateRange: { start: startStr, end: endStr },
        iapConfigured: false,
        iapError:
          "RevenueCat not configured — set REVENUECAT_SECRET_API_KEY on the Nakama pod (RUNTIME_ENV_KEYS) and redeploy.",
        overview: {
          mrr: 0,
          revenue28d: 0,
          activeSubscriptions: 0,
          activeTrials: 0,
        },
        daily: emptyIapDaily(startStr, endStr),
        totals: {
          revenue: 0,
          transactions: 0,
          adRevenue: ads.total,
          combined: ads.total,
        },
        adRevenue: {
          status: "live",
          source: "nakama_ilrd",
          message:
            "Ad revenue from Unity ILRD (LevelPlay / AdMob / Appodeal) via analytics_live_daily / rollup.",
          total: ads.total,
          daily: ads.daily,
        },
      });
    }

    var overviewPath =
      "/projects/" +
      encodeURIComponent(projectId) +
      "/metrics/overview?currency=" +
      currency;

    var chartPath =
      "/projects/" +
      encodeURIComponent(projectId) +
      "/charts/revenue?currency=" +
      currency +
      "&start_date=" +
      startStr +
      "&end_date=" +
      endStr +
      "&resolution=0";

    var overviewResp = rcGet(nk, overviewPath, apiKey);
    if (!overviewResp.ok) {
      logger.warn("[RevenueCatAdmin] overview failed: " + overviewResp.error);
      return RpcHelpers.errorResponse(
        "RevenueCat overview failed: " + overviewResp.error,
        overviewResp.status || 502
      );
    }

    var chartResp = rcGet(nk, chartPath, apiKey);
    if (!chartResp.ok) {
      logger.warn("[RevenueCatAdmin] chart failed: " + chartResp.error);
      return RpcHelpers.errorResponse(
        "RevenueCat revenue chart failed: " + chartResp.error,
        chartResp.status || 502
      );
    }

    var metrics = overviewResp.body && overviewResp.body.metrics ? overviewResp.body.metrics : [];
    var parsed = parseDailyRevenue(chartResp.body);
    var iapTotal = round2(parsed.totalRevenue);
    var combined = round2(iapTotal + ads.total);

    return RpcHelpers.successResponse({
      source: "revenuecat",
      currency: currency,
      projectId: projectId,
      days: days,
      dateRange: { start: startStr, end: endStr },
      iapConfigured: true,
      overview: {
        mrr: metricValue(metrics, "mrr"),
        revenue28d: metricValue(metrics, "revenue"),
        activeSubscriptions: metricValue(metrics, "active_subscriptions"),
        activeTrials: metricValue(metrics, "active_trials"),
      },
      daily: parsed.daily,
      totals: {
        revenue: iapTotal,
        transactions: Math.round(parsed.totalTransactions),
        adRevenue: ads.total,
        combined: combined,
      },
      adRevenue: {
        status: "live",
        source: "nakama_ilrd",
        message:
          "Ad revenue from Unity ILRD (LevelPlay / AdMob / Appodeal) via analytics_live_daily / rollup. Live estimate until network reporting reconcile ships.",
        total: ads.total,
        daily: ads.daily,
      },
    });
  }

  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("admin_revenuecat_dashboard", rpcAdminRevenueCatDashboard);
  }
}
