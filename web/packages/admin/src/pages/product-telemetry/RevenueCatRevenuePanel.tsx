import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CreditCard,
  DollarSign,
  Loader2,
  Megaphone,
  Radio,
  Sigma,
  TrendingUp,
  Users,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { quizverse, serverKeyAuth, type RevenueCatDashboardResult } from "@nakama/shared";

const IAP_COLOR = "142 71% 45%";
const STRIPE_COLOR = "262 83% 58%";
const AD_COLOR = "217 91% 60%";
const TOTAL_COLOR = "38 92% 50%";

function dayLabel(date: string) {
  const d = new Date(date + "T00:00:00Z");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

function money(v: number, currency = "USD") {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(v);
}

function OverviewCard({
  label,
  value,
  icon: Icon,
  hint,
  accent,
}: {
  label: string;
  value: string;
  icon: React.ElementType;
  hint?: string;
  accent?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5" style={accent ? { color: accent } : undefined} />
        {label}
      </div>
      <p className="text-2xl font-bold tabular-nums tracking-tight" style={accent ? { color: accent } : undefined}>
        {value}
      </p>
      {hint ? <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function mergeDailyChart(data: RevenueCatDashboardResult) {
  const adByDate = new Map((data.adRevenue?.daily ?? []).map((r) => [r.date, r.revenue]));
  const stripeByDate = new Map((data.stripeRevenue?.daily ?? []).map((r) => [r.date, r.revenue]));
  const allDates = Array.from(
    new Set([
      ...data.daily.map((r) => r.date),
      ...(data.adRevenue?.daily ?? []).map((r) => r.date),
      ...(data.stripeRevenue?.daily ?? []).map((r) => r.date),
    ]),
  ).sort();

  return allDates.map((date) => {
    const iap = data.daily.find((r) => r.date === date)?.revenue ?? 0;
    const stripe = stripeByDate.get(date) ?? 0;
    const ads = adByDate.get(date) ?? 0;
    return {
      label: dayLabel(date),
      iap,
      stripe,
      ads,
      total: iap + stripe + ads,
      revenue: iap,
    };
  });
}

export function RevenueCatRevenuePanel({ days = 30 }: { days?: number }) {
  const q = useQuery<RevenueCatDashboardResult>({
    queryKey: ["admin", "revenuecat-dashboard", days],
    queryFn: () => quizverse.fetchRevenueCatDashboard(serverKeyAuth(), days),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const currency = q.data?.currency ?? "USD";
  const iapTotal = q.data?.totals.revenue ?? 0;
  const stripeTotal = q.data?.totals.stripeRevenue ?? q.data?.stripeRevenue?.total ?? 0;
  const adTotal = q.data?.totals.adRevenue ?? q.data?.adRevenue?.total ?? 0;
  const combined = q.data?.totals.combined ?? iapTotal + stripeTotal + adTotal;
  const chartData = q.data ? mergeDailyChart(q.data) : [];
  const iapOk = q.data?.iapConfigured !== false && !q.data?.iapError;
  const stripeOk = q.data?.stripeRevenue?.configured !== false && !q.data?.stripeRevenue?.error;
  const stripePending = q.data?.stripeRevenue?.status === "pending";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <DollarSign className="h-4 w-4 text-primary" />
            Revenue
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            IAP (RevenueCat) · Stripe web · Ads (ILRD) · Total = sum of all three
          </p>
        </div>
        {q.data?.dateRange && (
          <span className="rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
            {q.data.dateRange.start} → {q.data.dateRange.end}
          </span>
        )}
      </div>

      {q.isLoading ? (
        <div className="flex h-40 items-center justify-center rounded-xl border border-border bg-card">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : q.isError ? (
        <div className="flex items-start gap-2 rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">Revenue panel unavailable</p>
            <p className="mt-1 text-xs opacity-90">
              {(q.error as Error)?.message ??
                "Check admin_revenuecat_dashboard and Nakama env."}
            </p>
          </div>
        </div>
      ) : q.data ? (
        <>
          {(!iapOk || stripePending || q.data.stripeRevenue?.error) && (
            <div className="space-y-2">
              {!iapOk && (
                <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
                  <div>
                    <p className="font-medium text-amber-800 dark:text-amber-300">
                      IAP (RevenueCat) not configured on Nakama
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {q.data.iapError ??
                        "Set REVENUECAT_SECRET_API_KEY on the Nakama pod (RUNTIME_ENV_KEYS)."}
                    </p>
                  </div>
                </div>
              )}
              {(stripePending || q.data.stripeRevenue?.error) && (
                <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" />
                  <div>
                    <p className="font-medium text-amber-800 dark:text-amber-300">
                      Stripe web revenue {stripePending ? "not configured" : "error"}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {q.data.stripeRevenue?.message ??
                        "Set STRIPE_SECRET_KEY on the Nakama pod (RUNTIME_ENV_KEYS). Optional: STRIPE_METRICS_PRICE_IDS for /pricing-only."}
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <OverviewCard
              label={`IAP · RevenueCat · ${days}d`}
              value={money(iapTotal, currency)}
              icon={DollarSign}
              hint={iapOk ? "App Store / Play / RC web" : "Needs REVENUECAT_SECRET_API_KEY"}
              accent={`hsl(${IAP_COLOR})`}
            />
            <OverviewCard
              label={`Stripe · web · ${days}d`}
              value={money(stripeTotal, currency)}
              icon={CreditCard}
              hint={
                stripeOk
                  ? q.data.stripeRevenue?.filteredByPrice
                    ? "Filtered by STRIPE_METRICS_PRICE_IDS"
                    : "All USD charges on Stripe account"
                  : "Needs STRIPE_SECRET_KEY"
              }
              accent={`hsl(${STRIPE_COLOR})`}
            />
            <OverviewCard
              label={`Ads · ILRD · ${days}d`}
              value={money(adTotal, currency)}
              icon={Megaphone}
              hint={q.data.adRevenue?.source === "nakama_ilrd" ? "LevelPlay / AdMob / Appodeal" : "Ad source"}
              accent={`hsl(${AD_COLOR})`}
            />
            <OverviewCard
              label={`Total · ${days}d`}
              value={money(combined, currency)}
              icon={Sigma}
              hint="IAP + Stripe + Ads"
              accent={`hsl(${TOTAL_COLOR})`}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <OverviewCard
              label="MRR (28d window)"
              value={money(q.data.overview.mrr, currency)}
              icon={TrendingUp}
            />
            <OverviewCard
              label="Active subscriptions"
              value={String(q.data.overview.activeSubscriptions)}
              icon={Users}
            />
            <OverviewCard
              label="Active trials"
              value={String(q.data.overview.activeTrials)}
              icon={Radio}
            />
          </div>

          <div className="rounded-xl border border-border bg-card p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h4 className="text-sm font-semibold">Daily revenue</h4>
                <p className="text-xs text-muted-foreground">
                  IAP (RC) + Stripe web + Ads (ILRD)
                </p>
              </div>
              <span className="text-lg font-bold tabular-nums" style={{ color: `hsl(${TOTAL_COLOR})` }}>
                {money(combined, currency)}
              </span>
            </div>
            {chartData.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">No revenue in this window</p>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={chartData} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                  <defs>
                    <linearGradient id="rc_iap_grad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={`hsl(${IAP_COLOR})`} stopOpacity={0.4} />
                      <stop offset="100%" stopColor={`hsl(${IAP_COLOR})`} stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="rc_stripe_grad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={`hsl(${STRIPE_COLOR})`} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={`hsl(${STRIPE_COLOR})`} stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="rc_ads_grad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={`hsl(${AD_COLOR})`} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={`hsl(${AD_COLOR})`} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(215 28% 17%)" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 10, fill: "hsl(217 10% 64%)" }}
                    interval="preserveStartEnd"
                    minTickGap={24}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: "hsl(217 10% 64%)" }}
                    width={52}
                    tickFormatter={(v) => `$${v}`}
                  />
                  <Tooltip
                    formatter={(v: number, name: string) => [
                      money(v, currency),
                      name === "iap" ? "IAP" : name === "stripe" ? "Stripe" : name === "ads" ? "Ads" : name,
                    ]}
                    contentStyle={{
                      background: "hsl(222 47% 11%)",
                      border: "1px solid hsl(215 28% 17%)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                  />
                  <Legend
                    wrapperStyle={{ fontSize: 11 }}
                    formatter={(value) =>
                      value === "iap" ? "IAP" : value === "stripe" ? "Stripe" : value === "ads" ? "Ads" : value
                    }
                  />
                  <Area
                    type="monotone"
                    dataKey="iap"
                    name="iap"
                    stroke={`hsl(${IAP_COLOR})`}
                    fill="url(#rc_iap_grad)"
                    strokeWidth={2}
                    stackId="1"
                  />
                  <Area
                    type="monotone"
                    dataKey="stripe"
                    name="stripe"
                    stroke={`hsl(${STRIPE_COLOR})`}
                    fill="url(#rc_stripe_grad)"
                    strokeWidth={2}
                    stackId="1"
                  />
                  <Area
                    type="monotone"
                    dataKey="ads"
                    name="ads"
                    stroke={`hsl(${AD_COLOR})`}
                    fill="url(#rc_ads_grad)"
                    strokeWidth={2}
                    stackId="1"
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
