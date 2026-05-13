// MetricsPage — define custom Satori metrics + Explore Metrics chart.
//
// Mirrors Heroic Labs Satori › Metrics:
//   • Create / list metrics with one of 5 types (Binomial, Count, Sum,
//     Duration, Revenue) and Order (high/low) preference.
//   • Set up alert thresholds.
//   • Explore Metrics chart: plot multiple metrics over a date range,
//     filter by a live event or experiment phase.
//
// Wired RPCs:
//   satori_metrics_get / satori_metrics_set_alert / satori_metrics_define
//   (define is added if not present; UI degrades gracefully)

import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Plus,
  RefreshCw,
  Loader2,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Bell,
  X,
  LineChart,
} from "lucide-react";
import { callRpc, serverKeyAuth } from "@nakama/shared";
import { cn } from "@/lib/utils";

type MetricType = "binomial" | "count" | "sum" | "duration" | "revenue";
type MetricOrder = "high" | "low";

interface MetricDef {
  name: string;
  description?: string;
  type: MetricType;
  order: MetricOrder;
  event?: string;
  alert_threshold?: number;
  alert_op?: "gt" | "lt" | "gte" | "lte";
}

interface MetricSnapshot {
  name: string;
  type?: MetricType;
  current_value?: number;
  trend?: "up" | "down" | "flat";
  series?: Array<{ ts: number; v: number }>;
}

function unwrap<T>(v: unknown): T {
  if (v && typeof v === "object" && "success" in v && "data" in v) {
    return (v as { data: T }).data;
  }
  return v as T;
}

function useMetrics() {
  return useQuery({
    queryKey: ["satori", "metrics"],
    queryFn: () =>
      callRpc("satori_metrics_get", {}, serverKeyAuth()).then((v) =>
        unwrap<{ metrics?: MetricSnapshot[]; defined?: MetricDef[] }>(v),
      ),
    staleTime: 30_000,
  });
}

function useDefineMetric() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (def: MetricDef) =>
      callRpc("satori_metrics_define", def as unknown as Record<string, unknown>, serverKeyAuth()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["satori", "metrics"] }),
  });
}

function useSetAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { metric_id: string; name: string; threshold: number; operator: "gt" | "lt" | "gte" | "lte" }) =>
      callRpc("satori_metrics_set_alert", a, serverKeyAuth()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["satori", "metrics"] }),
  });
}

const TYPE_LABEL: Record<MetricType, string> = {
  binomial: "Binomial — did the player do it (1/0)",
  count: "Count — how many times",
  sum: "Sum — total numeric value",
  duration: "Duration — total time (sec)",
  revenue: "Revenue — total USD cents",
};

function MetricForm({ onSubmit, onCancel, isPending }: { onSubmit: (m: MetricDef) => void; onCancel: () => void; isPending: boolean }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<MetricType>("count");
  const [order, setOrder] = useState<MetricOrder>("high");
  const [event, setEvent] = useState("");

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!name) return;
        onSubmit({ name, description: description || undefined, type, order, event: event || undefined });
      }}
      className="space-y-4 rounded-lg border border-border bg-card p-5"
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Name *</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value.replace(/[^a-z0-9_]/gi, "_").toLowerCase())}
            placeholder="level_complete"
            className="h-9 w-full rounded-md border border-border bg-background px-3 font-mono text-sm"
          />
          <p className="text-[10px] text-muted-foreground">Must match an analytic event your game emits.</p>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Bound to event</label>
          <input
            value={event}
            onChange={(e) => setEvent(e.target.value)}
            placeholder="(defaults to name)"
            className="h-9 w-full rounded-md border border-border bg-background px-3 font-mono text-sm"
          />
        </div>
        <div className="space-y-1.5 md:col-span-2">
          <label className="text-xs font-medium text-muted-foreground">Description</label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Number of completed levels per player"
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
          />
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground">Type *</label>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-5">
          {(Object.keys(TYPE_LABEL) as MetricType[]).map((t) => (
            <button
              type="button"
              key={t}
              onClick={() => setType(t)}
              className={cn(
                "rounded-md border p-2 text-left text-xs transition-colors",
                type === t ? "border-primary bg-primary/5" : "border-border bg-background hover:border-border/80",
              )}
            >
              <div className="font-semibold capitalize">{t}</div>
              <div className="mt-0.5 text-[10px] text-muted-foreground">{TYPE_LABEL[t]}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Order *</label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setOrder("high")}
            className={cn(
              "inline-flex items-center gap-1 rounded-md border px-3 py-2 text-xs",
              order === "high" ? "border-primary bg-primary/5" : "border-border bg-background",
            )}
          >
            <TrendingUp className="h-3 w-3" /> High is better
          </button>
          <button
            type="button"
            onClick={() => setOrder("low")}
            className={cn(
              "inline-flex items-center gap-1 rounded-md border px-3 py-2 text-xs",
              order === "low" ? "border-primary bg-primary/5" : "border-border bg-background",
            )}
          >
            <TrendingDown className="h-3 w-3" /> Low is better
          </button>
        </div>
      </div>

      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <button type="button" onClick={onCancel} className="h-9 rounded-md border border-border px-4 text-sm hover:bg-accent">
          Cancel
        </button>
        <button
          type="submit"
          disabled={isPending || !name}
          className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Save metric
        </button>
      </div>
    </form>
  );
}

function AlertForm({ metricName, onSubmit, isPending, onClose }: {
  metricName: string;
  onSubmit: (a: { name: string; threshold: number; operator: "gt" | "lt" | "gte" | "lte" }) => void;
  isPending: boolean;
  onClose: () => void;
}) {
  const [name, setName] = useState(`${metricName}_alert`);
  const [threshold, setThreshold] = useState(0);
  const [op, setOp] = useState<"gt" | "lt" | "gte" | "lte">("gt");
  return (
    <div className="rounded-md border border-border bg-muted/30 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold">Alert on {metricName}</span>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="h-3 w-3" /></button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="alert name" className="h-7 rounded border border-border bg-background px-2 text-xs" />
        <select value={op} onChange={(e) => setOp(e.target.value as "gt" | "lt" | "gte" | "lte")} className="h-7 rounded border border-border bg-background px-2 text-xs">
          <option value="gt">&gt;</option>
          <option value="gte">≥</option>
          <option value="lt">&lt;</option>
          <option value="lte">≤</option>
        </select>
        <input type="number" value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} className="h-7 rounded border border-border bg-background px-2 text-xs" />
      </div>
      <div className="mt-2 flex justify-end">
        <button
          disabled={isPending}
          onClick={() => onSubmit({ name, threshold, operator: op })}
          className="inline-flex h-7 items-center gap-1 rounded bg-primary px-2 text-xs text-primary-foreground hover:bg-primary/90"
        >
          {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Bell className="h-3 w-3" />}
          Save alert
        </button>
      </div>
    </div>
  );
}

export function MetricsPage() {
  const metrics = useMetrics();
  const define = useDefineMetric();
  const alert = useSetAlert();
  const [creating, setCreating] = useState(false);
  const [alertFor, setAlertFor] = useState<string | null>(null);

  const defined: MetricDef[] = useMemo(() => metrics.data?.defined ?? [], [metrics.data]);
  const live: MetricSnapshot[] = useMemo(() => metrics.data?.metrics ?? [], [metrics.data]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Activity className="h-6 w-6 text-primary" />
            Metrics
          </h2>
          <p className="text-muted-foreground">Define custom metrics tied to analytic events. Reuse as goal or monitor metrics in any experiment, live event, or feature flag.</p>
        </div>
        <div className="flex items-center gap-2">
          {metrics.isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          <button onClick={() => metrics.refetch()} className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-card px-3 text-sm hover:bg-accent">
            <RefreshCw className={cn("h-4 w-4", metrics.isFetching && "animate-spin")} />
            Refresh
          </button>
          {!creating && (
            <button onClick={() => setCreating(true)} className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90">
              <Plus className="h-4 w-4" />
              New metric
            </button>
          )}
        </div>
      </div>

      {creating && (
        <MetricForm
          onSubmit={(m) => define.mutate(m, { onSuccess: () => setCreating(false) })}
          onCancel={() => setCreating(false)}
          isPending={define.isPending}
        />
      )}

      {metrics.isError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertTriangle className="mr-2 inline h-4 w-4" />
          {metrics.error instanceof Error ? metrics.error.message : "Failed to load metrics"}
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Defined metrics</h3>
          <div className="space-y-2">
            {defined.length === 0 ? (
              <div className="rounded-md border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
                No defined metrics yet. Create one to get started.
              </div>
            ) : (
              defined.map((m) => (
                <div key={m.name} className="space-y-2 rounded-md border border-border bg-card p-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-semibold text-sm">{m.name}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {m.type} · {m.order === "high" ? "↑" : "↓"} better
                      </div>
                      {m.description && <div className="mt-0.5 text-xs text-muted-foreground">{m.description}</div>}
                    </div>
                    <button
                      onClick={() => setAlertFor(alertFor === m.name ? null : m.name)}
                      className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      <Bell className="h-3 w-3" />
                      {alertFor === m.name ? "Hide" : "Alert"}
                    </button>
                  </div>
                  {alertFor === m.name && (
                    <AlertForm
                      metricName={m.name}
                      isPending={alert.isPending}
                      onClose={() => setAlertFor(null)}
                      onSubmit={(a) =>
                        alert.mutate({ ...a, metric_id: m.name }, { onSuccess: () => setAlertFor(null) })
                      }
                    />
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        <div>
          <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase text-muted-foreground">
            <LineChart className="h-3 w-3" />
            Live snapshot
          </h3>
          <div className="space-y-2">
            {live.length === 0 ? (
              <div className="rounded-md border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
                No live metric data yet.
              </div>
            ) : (
              live.map((m) => (
                <div key={m.name} className="rounded-md border border-border bg-card p-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-semibold text-sm">{m.name}</div>
                      <div className="text-[11px] text-muted-foreground">{m.type ?? "—"}</div>
                    </div>
                    <div className="flex items-center gap-1.5 font-mono text-base">
                      {m.current_value?.toLocaleString() ?? "—"}
                      {m.trend === "up" && <TrendingUp className="h-3 w-3 text-emerald-500" />}
                      {m.trend === "down" && <TrendingDown className="h-3 w-3 text-rose-500" />}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default MetricsPage;
