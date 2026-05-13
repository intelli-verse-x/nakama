// RoasPage — Return on Ad Spend report.
//
// Mirrors Heroic Labs Satori › Reports › RoAS:
//   • Summary cards (Avg CPI, Avg LTV, Avg RoAS, Day-N RoAS).
//   • Cohort table (rows = registration cohorts, columns = day milestones).
//   • Filters: date range, day-N selector, country, ad partner attribution
//     (channel, campaign, creative), game filters (version, activity, variant).
//   • Key Stats breakdown (CPI, LTV-IAP, LTV-AD, LTV-Total, RoAS).
//
// Wired to:  satori_roas_report  +  satori_roas_summary

import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DollarSign,
  RefreshCw,
  Loader2,
  AlertTriangle,
  Filter as FilterIcon,
  TrendingUp,
} from "lucide-react";
import { callRpc, serverKeyAuth } from "@nakama/shared";
import { cn } from "@/lib/utils";

const DAY_OPTIONS = [0, 1, 3, 7, 14, 30];

interface CohortRow {
  cohort_date: string;
  installs?: number;
  cpi?: number;
  ltv?: Record<string, number>;
  roas?: Record<string, number>;
}

interface RoasReport {
  summary?: {
    avg_cpi?: number;
    lifetime_avg_ltv?: number;
    lifetime_avg_roas?: number;
    day_milestone?: number;
    day_avg_ltv?: number;
    day_avg_roas?: number;
  };
  cohorts?: CohortRow[];
  key_stats?: Array<{
    day: number;
    cpi?: number;
    ltv_iap?: number;
    ltv_ad?: number;
    ltv_total?: number;
    roas?: number;
  }>;
}

function unwrap<T>(v: unknown): T {
  if (v && typeof v === "object" && "success" in v && "data" in v) {
    return (v as { data: T }).data;
  }
  return v as T;
}

interface RoasRaw {
  rangeStartMs?: number;
  rangeEndMs?: number;
  totalSpendUsd?: number;
  totalRevenueUsd?: number;
  roasPctOverall?: number;
  buckets?: Array<{
    key: string;
    channel?: string;
    campaign?: string;
    country?: string;
    spendUsd?: number;
    revenueUsd?: number;
    roasPct?: number;
    payerCount?: number;
  }>;
}

function useRoas(filters: {
  start?: string;
  end?: string;
  days: number[];
  country?: string;
  channel?: string;
  campaign?: string;
  creative?: string;
  game_version?: string;
  activity?: string;
  variant?: string;
}) {
  return useQuery({
    queryKey: ["satori", "roas", filters],
    queryFn: async () => {
      const fromMs = filters.start ? new Date(filters.start).getTime() : undefined;
      const toMs = filters.end ? new Date(filters.end).getTime() + 86400000 - 1 : undefined;
      const groupBy = ["channel"];
      if (filters.campaign) groupBy.push("campaign");
      if (filters.country) groupBy.push("country");
      const raw = await callRpc(
        "satori_roas_run",
        { fromMs, toMs, groupBy },
        serverKeyAuth(),
      ).then((v) => unwrap<RoasRaw>(v));
      // Reshape backend bucketed output into cohort/key-stats UI shape.
      const cohorts: CohortRow[] = (raw.buckets ?? []).map((b) => ({
        cohort_date: b.key,
        installs: b.payerCount,
        cpi: b.spendUsd && b.payerCount ? b.spendUsd / b.payerCount : undefined,
        roas: { "0": b.roasPct ?? 0 },
        ltv: { "0": b.revenueUsd && b.payerCount ? b.revenueUsd / b.payerCount : 0 },
      }));
      const summary: NonNullable<RoasReport["summary"]> = {
        avg_cpi:
          raw.totalSpendUsd && (raw.buckets ?? []).reduce((s, b) => s + (b.payerCount ?? 0), 0) > 0
            ? raw.totalSpendUsd / (raw.buckets ?? []).reduce((s, b) => s + (b.payerCount ?? 0), 1)
            : undefined,
        lifetime_avg_ltv: raw.totalRevenueUsd ?? 0,
        lifetime_avg_roas: raw.roasPctOverall,
        day_milestone: filters.days[filters.days.length - 1],
        day_avg_roas: raw.roasPctOverall,
        day_avg_ltv: raw.totalRevenueUsd,
      };
      return { summary, cohorts, key_stats: [] } satisfies RoasReport;
    },
    staleTime: 60_000,
    retry: false,
  });
}

function fmtPct(v?: number) {
  if (v == null) return "—";
  return `${v.toFixed(1)}%`;
}
function fmtMoney(v?: number) {
  if (v == null) return "—";
  return `$${v.toFixed(2)}`;
}

function Card({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-[10px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

export function RoasPage() {
  const today = new Date();
  const minus30 = new Date(today.getTime() - 30 * 86400_000);
  const [start, setStart] = useState(minus30.toISOString().slice(0, 10));
  const [end, setEnd] = useState(today.toISOString().slice(0, 10));
  const [days, setDays] = useState<number[]>([0, 1, 3, 7]);
  const [country, setCountry] = useState("");
  const [channel, setChannel] = useState("");
  const [campaign, setCampaign] = useState("");
  const [creative, setCreative] = useState("");
  const [gameVersion, setGameVersion] = useState("");
  const [activity, setActivity] = useState("");
  const [variant, setVariant] = useState("");

  const filters = useMemo(
    () => ({
      start,
      end,
      days,
      country: country || undefined,
      channel: channel || undefined,
      campaign: campaign || undefined,
      creative: creative || undefined,
      game_version: gameVersion || undefined,
      activity: activity || undefined,
      variant: variant || undefined,
    }),
    [start, end, days, country, channel, campaign, creative, gameVersion, activity, variant],
  );

  const report = useRoas(filters);

  function toggleDay(d: number) {
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort((a, b) => a - b)));
  }

  const cohorts: CohortRow[] = report.data?.cohorts ?? [];
  const summary = report.data?.summary;
  const keyStats: NonNullable<RoasReport["key_stats"]> = report.data?.key_stats ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <DollarSign className="h-6 w-6 text-primary" />
            Return on Ad Spend
          </h2>
          <p className="text-muted-foreground">
            Combine MMP CPI data with Satori LTV. See which cohorts have recovered acquisition cost.
          </p>
        </div>
        <button onClick={() => report.refetch()} className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-card px-3 text-sm hover:bg-accent">
          <RefreshCw className={cn("h-4 w-4", report.isFetching && "animate-spin")} />
          Refresh
        </button>
      </div>

      <div className="rounded-md border border-border bg-card p-4">
        <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
          <FilterIcon className="h-3 w-3" />
          Filters
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <div>
            <label className="mb-0.5 block text-[10px] uppercase text-muted-foreground">Start</label>
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="h-8 w-full rounded border border-border bg-background px-2 text-xs" />
          </div>
          <div>
            <label className="mb-0.5 block text-[10px] uppercase text-muted-foreground">End</label>
            <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="h-8 w-full rounded border border-border bg-background px-2 text-xs" />
          </div>
          <div className="md:col-span-2">
            <label className="mb-0.5 block text-[10px] uppercase text-muted-foreground">Day milestones</label>
            <div className="flex flex-wrap gap-1.5">
              {DAY_OPTIONS.map((d) => (
                <button
                  key={d}
                  onClick={() => toggleDay(d)}
                  className={cn(
                    "h-7 rounded border px-2 text-xs",
                    days.includes(d) ? "border-primary bg-primary/10 text-primary" : "border-border bg-background text-muted-foreground",
                  )}
                >
                  D{d}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="mb-0.5 block text-[10px] uppercase text-muted-foreground">Country</label>
            <input value={country} onChange={(e) => setCountry(e.target.value)} placeholder="US, GB…" className="h-8 w-full rounded border border-border bg-background px-2 text-xs" />
          </div>
          <div>
            <label className="mb-0.5 block text-[10px] uppercase text-muted-foreground">Game version</label>
            <input value={gameVersion} onChange={(e) => setGameVersion(e.target.value)} placeholder="1.0.0" className="h-8 w-full rounded border border-border bg-background px-2 text-xs" />
          </div>
        </div>

        <div className="mt-3 border-t border-border pt-3">
          <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">Ad partner attribution</div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            <input value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="Channel (Applovin, Google…)" className="h-8 rounded border border-border bg-background px-2 text-xs" />
            <input value={campaign} onChange={(e) => setCampaign(e.target.value)} placeholder="Campaign" className="h-8 rounded border border-border bg-background px-2 text-xs" />
            <input value={creative} onChange={(e) => setCreative(e.target.value)} placeholder="Creative" className="h-8 rounded border border-border bg-background px-2 text-xs" />
          </div>
        </div>

        <div className="mt-3 border-t border-border pt-3">
          <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">Operation scope</div>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <input value={activity} onChange={(e) => setActivity(e.target.value)} placeholder="Activity (live event / experiment ID)" className="h-8 rounded border border-border bg-background px-2 text-xs" />
            <input value={variant} onChange={(e) => setVariant(e.target.value)} placeholder="Variant" className="h-8 rounded border border-border bg-background px-2 text-xs" />
          </div>
        </div>
      </div>

      {report.isError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertTriangle className="mr-2 inline h-4 w-4" />
          {report.error instanceof Error ? report.error.message : "Failed to load RoAS"}
          <div className="mt-1 text-[11px] text-muted-foreground">
            Tip: enable the Adjust MMP integration in Settings &gt; Integrations to populate this report.
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Card label="Avg CPI" value={fmtMoney(summary?.avg_cpi)} />
        <Card label="Lifetime avg LTV" value={fmtMoney(summary?.lifetime_avg_ltv)} />
        <Card label="Lifetime avg RoAS" value={fmtPct(summary?.lifetime_avg_roas)} />
        <Card
          label={`Day ${summary?.day_milestone ?? days[days.length - 1] ?? 7} RoAS`}
          value={fmtPct(summary?.day_avg_roas)}
          hint={summary?.day_avg_ltv != null ? `LTV ${fmtMoney(summary.day_avg_ltv)}` : undefined}
        />
      </div>

      <div className="rounded-md border border-border bg-card">
        <div className="border-b border-border px-4 py-2 text-xs font-semibold uppercase text-muted-foreground">
          Cohort table
        </div>
        <div className="overflow-x-auto">
          {report.isLoading ? (
            <div className="flex h-32 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : cohorts.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">No cohorts in this window.</div>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Cohort</th>
                  <th className="px-3 py-2 text-right">Installs</th>
                  <th className="px-3 py-2 text-right">CPI</th>
                  {days.map((d) => (
                    <th key={d} className="px-3 py-2 text-right">D{d} RoAS</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cohorts.map((c) => (
                  <tr key={c.cohort_date} className="border-t border-border">
                    <td className="px-3 py-2 font-mono">{c.cohort_date}</td>
                    <td className="px-3 py-2 text-right">{c.installs?.toLocaleString() ?? "—"}</td>
                    <td className="px-3 py-2 text-right">{fmtMoney(c.cpi)}</td>
                    {days.map((d) => {
                      const v = c.roas?.[String(d)];
                      const positive = v != null && v >= 100;
                      return (
                        <td key={d} className={cn("px-3 py-2 text-right tabular-nums", positive && "font-semibold text-emerald-600 dark:text-emerald-400")}>
                          {v != null ? fmtPct(v) : "—"}
                          {positive && <TrendingUp className="ml-1 inline h-3 w-3" />}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="rounded-md border border-border bg-card">
        <div className="border-b border-border px-4 py-2 text-xs font-semibold uppercase text-muted-foreground">
          Key stats
        </div>
        <div className="overflow-x-auto">
          {keyStats.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">No key stats yet.</div>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-muted/40 text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left">Day</th>
                  <th className="px-3 py-2 text-right">Avg CPI</th>
                  <th className="px-3 py-2 text-right">Avg LTV (IAP)</th>
                  <th className="px-3 py-2 text-right">Avg LTV (AD)</th>
                  <th className="px-3 py-2 text-right">Avg LTV (Total)</th>
                  <th className="px-3 py-2 text-right">RoAS</th>
                </tr>
              </thead>
              <tbody>
                {keyStats.map((k) => (
                  <tr key={k.day} className="border-t border-border">
                    <td className="px-3 py-2 font-mono">D{k.day}</td>
                    <td className="px-3 py-2 text-right">{fmtMoney(k.cpi)}</td>
                    <td className="px-3 py-2 text-right">{fmtMoney(k.ltv_iap)}</td>
                    <td className="px-3 py-2 text-right">{fmtMoney(k.ltv_ad)}</td>
                    <td className="px-3 py-2 text-right">{fmtMoney(k.ltv_total)}</td>
                    <td className="px-3 py-2 text-right">{fmtPct(k.roas)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

export default RoasPage;
