// =============================================================================
// RPC: admin_revenuecat_dashboard
//
// Admin Metrics money panel:
//   IAP (stores / RC web) → RevenueCat Charts API — ground truth for RC path
//   Stripe (/pricing Payment Links + other web Checkout) → Stripe Charges API
//   Ads → Nakama analytics_live_daily / rollup ad_revenue_usd (Unity ILRD)
//   Total = IAP + Stripe + Ads (shown separately; never a silent blend)
//
// Required env (RUNTIME_ENV_KEYS):
//   REVENUECAT_SECRET_API_KEY  — RevenueCat project secret key (sk_…)
//   REVENUECAT_PROJECT_ID      — defaults to QuizVerse proj0d38847e
//   STRIPE_SECRET_KEY          — Stripe secret (sk_live_… / sk_test_…)
// Optional:
//   STRIPE_METRICS_PRICE_IDS   — comma-separated price_… IDs to include only
//                                B2C /pricing (or other) products. If empty,
//                                all succeeded USD charges on the account.
// =============================================================================

namespace QuizVerseRevenueCatAdmin {

  var RC_API_BASE = "https://api.revenuecat.com/v2";
  var STRIPE_API_BASE = "https://api.stripe.com/v1";
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

  function unixSec(d: Date): number {
    return Math.floor(d.getTime() / 1000);
  }

  function endOfDayUnix(dateStr: string): number {
    return Math.floor(new Date(dateStr + "T23:59:59Z").getTime() / 1000);
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

  function stripeGet(
    nk: nkruntime.Nakama,
    path: string,
    apiKey: string
  ): { ok: boolean; status: number; body: any; error: string } {
    try {
      var resp: any = nk.httpRequest(
        STRIPE_API_BASE + path,
        "get",
        {
          Accept: "application/json",
          Authorization: "Bearer " + apiKey,
        },
        "",
        25000
      );
      var status = resp.code || 0;
      var parsed = RpcHelpers.safeJsonParse(resp.body || "{}");
      if (status < 200 || status >= 300) {
        var errMsg = "";
        if (parsed.success && parsed.data) {
          if (parsed.data.error && parsed.data.error.message) {
            errMsg = String(parsed.data.error.message);
          } else if (parsed.data.message) {
            errMsg = String(parsed.data.message);
          }
        }
        if (!errMsg) errMsg = (resp.body || "").substring(0, 240);
        return { ok: false, status: status, body: null, error: errMsg || ("HTTP " + status) };
      }
      if (!parsed.success) {
        return { ok: false, status: 502, body: null, error: "invalid JSON from Stripe" };
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

  function emptyDailySeries(startStr: string, endStr: string): Array<{ date: string; revenue: number; transactions: number }> {
    var out: Array<{ date: string; revenue: number; transactions: number }> = [];
    var cursor = new Date(startStr + "T00:00:00Z");
    var end = new Date(endStr + "T00:00:00Z");
    while (cursor.getTime() <= end.getTime()) {
      out.push({ date: isoDateUtc(cursor), revenue: 0, transactions: 0 });
      cursor = addDaysUtc(cursor, 1);
    }
    return out;
  }

  function parsePriceIdAllowlist(raw: string): { [id: string]: boolean } {
    var map: { [id: string]: boolean } = {};
    if (!raw) return map;
    var parts = raw.split(",");
    for (var i = 0; i < parts.length; i++) {
      var id = (parts[i] || "").trim();
      if (id.indexOf("price_") === 0) map[id] = true;
    }
    return map;
  }

  function chargeMatchesPriceFilter(charge: any, allow: { [id: string]: boolean }): boolean {
    var keys = Object.keys(allow);
    if (keys.length === 0) return true;
    var inv = charge && charge.invoice;
    if (!inv || typeof inv === "string") return false;
    var lines = inv.lines && inv.lines.data ? inv.lines.data : [];
    for (var i = 0; i < lines.length; i++) {
      var price = lines[i] && lines[i].price;
      var pid = price && price.id ? String(price.id) : "";
      if (pid && allow[pid]) return true;
    }
    return false;
  }

  /**
   * Sum succeeded USD Stripe charges in [startStr, endStr] (UTC days).
   * Net = (amount - amount_refunded) / 100.
   */
  function readStripeRevenueRange(
    nk: nkruntime.Nakama,
    logger: nkruntime.Logger,
    apiKey: string,
    startStr: string,
    endStr: string,
    priceAllowRaw: string
  ): {
    configured: boolean;
    error: string;
    daily: Array<{ date: string; revenue: number; transactions: number }>;
    total: number;
    transactions: number;
    filteredByPrice: boolean;
  } {
    var empty = emptyDailySeries(startStr, endStr);
    if (!apiKey) {
      return {
        configured: false,
        error: "Stripe not configured — set STRIPE_SECRET_KEY on the Nakama pod (RUNTIME_ENV_KEYS) and redeploy.",
        daily: empty,
        total: 0,
        transactions: 0,
        filteredByPrice: false,
      };
    }

    var allow = parsePriceIdAllowlist(priceAllowRaw);
    var filteredByPrice = Object.keys(allow).length > 0;
    var gte = unixSec(new Date(startStr + "T00:00:00Z"));
    var lte = endOfDayUnix(endStr);
    var dailyMap: { [date: string]: { revenue: number; transactions: number } } = {};
    var i: number;
    for (i = 0; i < empty.length; i++) {
      dailyMap[empty[i].date] = { revenue: 0, transactions: 0 };
    }

    var startingAfter = "";
    var pages = 0;
    var maxPages = 20;
    while (pages < maxPages) {
      pages++;
      var path =
        "/charges?limit=100" +
        "&created[gte]=" +
        gte +
        "&created[lte]=" +
        lte +
        "&expand[]=data.invoice";
      if (startingAfter) {
        path += "&starting_after=" + encodeURIComponent(startingAfter);
      }
      var resp = stripeGet(nk, path, apiKey);
      if (!resp.ok) {
        logger.warn("[RevenueCatAdmin] Stripe charges failed: " + resp.error);
        return {
          configured: true,
          error: "Stripe charges failed: " + resp.error,
          daily: empty,
          total: 0,
          transactions: 0,
          filteredByPrice: filteredByPrice,
        };
      }
      var data = resp.body && resp.body.data ? resp.body.data : [];
      for (i = 0; i < data.length; i++) {
        var ch = data[i];
        if (!ch || ch.status !== "succeeded" || ch.paid !== true) continue;
        if (String(ch.currency || "").toLowerCase() !== "usd") continue;
        if (!chargeMatchesPriceFilter(ch, allow)) continue;
        var netCents = (parseInt(String(ch.amount || 0), 10) || 0) - (parseInt(String(ch.amount_refunded || 0), 10) || 0);
        if (netCents <= 0) continue;
        var created = typeof ch.created === "number" ? ch.created : 0;
        var day = isoDateUtc(new Date(created * 1000));
        if (!dailyMap[day]) dailyMap[day] = { revenue: 0, transactions: 0 };
        dailyMap[day].revenue += netCents / 100;
        dailyMap[day].transactions += 1;
      }
      if (!resp.body.has_more || data.length === 0) break;
      startingAfter = String(data[data.length - 1].id || "");
      if (!startingAfter) break;
    }

    var daily: Array<{ date: string; revenue: number; transactions: number }> = [];
    var total = 0;
    var tx = 0;
    var dates = Object.keys(dailyMap).sort();
    for (i = 0; i < dates.length; i++) {
      var d = dates[i];
      var pt = dailyMap[d];
      daily.push({
        date: d,
        revenue: round2(pt.revenue),
        transactions: pt.transactions,
      });
      total += pt.revenue;
      tx += pt.transactions;
    }

    return {
      configured: true,
      error: "",
      daily: daily,
      total: round2(total),
      transactions: tx,
      filteredByPrice: filteredByPrice,
    };
  }

  function stripeBlockFromResult(stripe: {
    configured: boolean;
    error: string;
    daily: Array<{ date: string; revenue: number; transactions: number }>;
    total: number;
    transactions: number;
    filteredByPrice: boolean;
  }): any {
    return {
      status: stripe.configured && !stripe.error ? "live" : stripe.configured ? "error" : "pending",
      source: "stripe_charges",
      message: stripe.error
        ? stripe.error
        : stripe.filteredByPrice
          ? "Stripe succeeded USD charges filtered by STRIPE_METRICS_PRICE_IDS (B2C /pricing prices)."
          : "Stripe succeeded USD charges (all products on this Stripe account). Set STRIPE_METRICS_PRICE_IDS to scope to /pricing only.",
      total: stripe.total,
      transactions: stripe.transactions,
      daily: stripe.daily,
      configured: stripe.configured,
      error: stripe.error || undefined,
      filteredByPrice: stripe.filteredByPrice,
    };
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
    var stripeKey = env(ctx, "STRIPE_SECRET_KEY");
    var stripePriceIds = env(ctx, "STRIPE_METRICS_PRICE_IDS");
    var stripe = readStripeRevenueRange(nk, logger, stripeKey, startStr, endStr, stripePriceIds);
    var stripeBlock = stripeBlockFromResult(stripe);

    var apiKey = env(ctx, "REVENUECAT_SECRET_API_KEY");
    var projectId = env(ctx, "REVENUECAT_PROJECT_ID") || DEFAULT_PROJECT_ID;

    if (!apiKey) {
      logger.warn("[RevenueCatAdmin] REVENUECAT_SECRET_API_KEY missing — returning Stripe + ads");
      var combinedNoRc = round2(stripe.total + ads.total);
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
        daily: emptyDailySeries(startStr, endStr),
        totals: {
          revenue: 0,
          transactions: 0,
          stripeRevenue: stripe.total,
          adRevenue: ads.total,
          combined: combinedNoRc,
        },
        stripeRevenue: stripeBlock,
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
    var combined = round2(iapTotal + stripe.total + ads.total);

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
        stripeRevenue: stripe.total,
        adRevenue: ads.total,
        combined: combined,
      },
      stripeRevenue: stripeBlock,
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
