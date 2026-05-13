// FunnelsPage — multi-step conversion-funnel builder + report viewer.
//
// Mirrors Heroic Labs Satori › Reports › Funnels:
//   • Create a funnel: name, audience target, conversion window, ordered
//     steps with optional value/metadata filters.
//   • View results as a bar chart: per-step player count, drop-off,
//     accumulated drop-off %.
//   • Switch between Bar / Funnel-cone / Line views.
//   • Refresh on demand and re-run.
//
// Wired to runtime RPCs:
//   satori_funnel_list / satori_funnel_upsert / satori_funnel_delete /
//   satori_funnel_run

import { useState, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Filter,
  Plus,
  Trash2,
  Play,
  RefreshCw,
  Loader2,
  AlertTriangle,
  ChevronRight,
  TrendingDown,
  Layers,
  X,
  GripVertical,
  BarChart3,
  Triangle,
} from "lucide-react";
import { callRpc, serverKeyAuth } from "@nakama/shared";
import { cn } from "@/lib/utils";

interface FunnelStep {
  // Match backend field name: eventName.
  eventName: string;
  label?: string;
  filters?: Array<{ path: string; op: string; value: string | number }>;
}

interface FunnelDef {
  id: string;
  name: string;
  description?: string;
  audienceId?: string;
  excludeAudienceId?: string;
  conversionWindow?: "unlimited" | "time_full" | "time_step" | "session_full";
  timeWindowSec?: number;
  steps: FunnelStep[];
  createdAt?: number;
  updatedAt?: number;
}

interface StepResult {
  eventName?: string;
  event?: string;
  label?: string;
  players_completed: number;
  pct_of_first?: number;
  avg_time_to_complete_sec?: number;
  players_dropped_off?: number;
  pct_accumulated?: number;
}

interface FunnelReport {
  funnel_id: string;
  steps: StepResult[];
  last_refreshed_at?: number;
}

function unwrap<T>(v: unknown): T {
  if (v && typeof v === "object" && "success" in v && "data" in v) {
    return (v as { data: T }).data;
  }
  return v as T;
}

function useFunnels() {
  return useQuery({
    queryKey: ["satori", "funnels"],
    queryFn: () =>
      callRpc("satori_funnel_list", {}, serverKeyAuth()).then((v) =>
        unwrap<{ funnels?: FunnelDef[] }>(v),
      ),
    select: (d) => d.funnels ?? [],
    staleTime: 30_000,
  });
}

function useUpsertFunnel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (def: FunnelDef) =>
      callRpc("satori_funnel_upsert", def as unknown as Record<string, unknown>, serverKeyAuth()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["satori", "funnels"] }),
  });
}

function useDeleteFunnel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      callRpc("satori_funnel_delete", { id }, serverKeyAuth()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["satori", "funnels"] }),
  });
}

function useRunFunnel(id: string | null) {
  return useQuery({
    queryKey: ["satori", "funnel-run", id],
    enabled: !!id,
    queryFn: () =>
      callRpc("satori_funnel_run", { id, window_secs: 7 * 86400 }, serverKeyAuth()).then((v) =>
        unwrap<FunnelReport>(v),
      ),
    staleTime: 30_000,
  });
}

function useAudiences() {
  return useQuery({
    queryKey: ["satori", "audiences-light"],
    queryFn: () =>
      callRpc("satori_audiences_list", {}, serverKeyAuth()).then((v) =>
        unwrap<{ audiences?: Array<{ id: string; name?: string }> }>(v),
      ),
    select: (d) => d.audiences ?? [],
    staleTime: 60_000,
  });
}

const CONVERSION_WINDOW_OPTIONS: Array<{
  value: NonNullable<FunnelDef["conversionWindow"]>;
  label: string;
  hint: string;
}> = [
  { value: "unlimited", label: "Unlimited", hint: "No time limit between steps." },
  { value: "time_full", label: "Time-based (full)", hint: "All steps within total window." },
  { value: "time_step", label: "Time-based (per step)", hint: "Window applies between adjacent steps." },
  { value: "session_full", label: "Session-based", hint: "All steps within one session." },
];

function FunnelForm({
  initial,
  onSubmit,
  onCancel,
  isPending,
}: {
  initial?: FunnelDef;
  onSubmit: (def: FunnelDef) => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  const [id, setId] = useState(initial?.id ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [audienceId, setAudienceId] = useState(initial?.audienceId ?? "");
  const [excludeAudienceId, setExcludeAudienceId] = useState(initial?.excludeAudienceId ?? "");
  const [conversionWindow, setConversionWindow] = useState<NonNullable<FunnelDef["conversionWindow"]>>(
    initial?.conversionWindow ?? "unlimited",
  );
  const [windowSecs, setWindowSecs] = useState(initial?.timeWindowSec ?? 86400);
  const [steps, setSteps] = useState<FunnelStep[]>(initial?.steps ?? [{ eventName: "" }]);
  const audiences = useAudiences();

  function updateStep(idx: number, patch: Partial<FunnelStep>) {
    setSteps((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
  }
  function addStep() {
    setSteps((prev) => [...prev, { eventName: "" }]);
  }
  function removeStep(idx: number) {
    setSteps((prev) => prev.filter((_, i) => i !== idx));
  }
  function moveStep(idx: number, dir: -1 | 1) {
    setSteps((prev) => {
      const next = [...prev];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!id || !name || steps.length === 0 || steps.some((s) => !s.eventName)) return;
    onSubmit({
      id,
      name,
      description: description || undefined,
      audienceId: audienceId || undefined,
      excludeAudienceId: excludeAudienceId || undefined,
      conversionWindow,
      timeWindowSec: conversionWindow === "unlimited" ? undefined : windowSecs,
      steps,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5 rounded-lg border border-border bg-card p-5">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">ID *</label>
          <input
            value={id}
            onChange={(e) => setId(e.target.value.replace(/[^a-z0-9_]/gi, "_").toLowerCase())}
            disabled={!!initial}
            placeholder="onboarding_funnel"
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm font-mono"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Name *</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Onboarding"
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
          />
        </div>
        <div className="space-y-1.5 md:col-span-2">
          <label className="text-xs font-medium text-muted-foreground">Description</label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Track new-player drop-off through tutorial"
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Target audience</label>
          <select
            value={audienceId}
            onChange={(e) => setAudienceId(e.target.value)}
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
          >
            <option value="">ALL players</option>
            {audiences.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name ?? a.id}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Exclude audience</label>
          <select
            value={excludeAudienceId}
            onChange={(e) => setExcludeAudienceId(e.target.value)}
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm"
          >
            <option value="">None</option>
            {audiences.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name ?? a.id}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground">Conversion window</label>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
          {CONVERSION_WINDOW_OPTIONS.map((opt) => (
            <button
              type="button"
              key={opt.value}
              onClick={() => setConversionWindow(opt.value)}
              className={cn(
                "rounded-md border p-3 text-left text-xs transition-colors",
                conversionWindow === opt.value
                  ? "border-primary bg-primary/5 text-foreground"
                  : "border-border bg-background text-muted-foreground hover:border-border/80",
              )}
            >
              <div className="font-semibold text-foreground">{opt.label}</div>
              <div className="mt-0.5 text-[11px]">{opt.hint}</div>
            </button>
          ))}
        </div>
        {conversionWindow !== "unlimited" && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>Window:</span>
            <input
              type="number"
              min={60}
              value={windowSecs}
              onChange={(e) => setWindowSecs(Number(e.target.value) || 0)}
              className="h-7 w-32 rounded border border-border bg-background px-2 text-xs"
            />
            <span>seconds</span>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-muted-foreground">Steps (in order)</label>
          <button
            type="button"
            onClick={addStep}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-accent"
          >
            <Plus className="h-3 w-3" />
            Add step
          </button>
        </div>
        <div className="space-y-2">
          {steps.map((step, idx) => (
            <div key={idx} className="flex items-start gap-2 rounded-md border border-border bg-background p-2">
              <div className="flex flex-col items-center gap-1 pt-1.5">
                <button type="button" onClick={() => moveStep(idx, -1)} disabled={idx === 0} className="text-muted-foreground hover:text-foreground disabled:opacity-30">
                  <GripVertical className="h-3.5 w-3.5" />
                </button>
                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold text-primary">S{idx + 1}</span>
              </div>
              <div className="flex-1 space-y-1.5">
                <div className="grid grid-cols-2 gap-2">
                  <input
                    value={step.label ?? ""}
                    onChange={(e) => updateStep(idx, { label: e.target.value })}
                    placeholder="Label (e.g. Tutorial start)"
                    className="h-8 rounded border border-border bg-card px-2 text-xs"
                  />
                  <input
                    value={step.eventName}
                    onChange={(e) => updateStep(idx, { eventName: e.target.value })}
                    placeholder="Event name (e.g. tutorialStarted, _identityCreate)"
                    className="h-8 rounded border border-border bg-card px-2 font-mono text-xs"
                  />
                </div>
              </div>
              {steps.length > 1 && (
                <button type="button" onClick={() => removeStep(idx)} className="text-muted-foreground hover:text-destructive">
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Tip: synthetic events <code>_identityCreate</code>, <code>_experimentJoin</code>, <code>_liveEventJoin</code> can anchor system milestones.
        </p>
      </div>

      <div className="flex justify-end gap-2 border-t border-border pt-4">
        <button type="button" onClick={onCancel} className="h-9 rounded-md border border-border px-4 text-sm hover:bg-accent">
          Cancel
        </button>
        <button
          type="submit"
          disabled={isPending || !id || !name || steps.some((s) => !s.eventName)}
          className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          {initial ? "Update funnel" : "Create funnel"}
        </button>
      </div>
    </form>
  );
}

type ViewMode = "bar" | "funnel" | "line";

function ReportView({ report, mode }: { report: FunnelReport; mode: ViewMode }) {
  const total = report.steps[0]?.players_completed ?? 0;
  if (mode === "funnel") {
    return (
      <div className="flex flex-col items-center gap-1 py-4">
        {report.steps.map((s, idx) => {
          const pct = total > 0 ? (s.players_completed / total) * 100 : 0;
          const widthPct = Math.max(pct, 10);
          return (
            <div key={idx} className="w-full max-w-2xl text-center" style={{ width: `${widthPct}%` }}>
              <div className="rounded bg-primary/30 px-3 py-3 text-xs font-medium">
                {s.label ?? s.eventName ?? s.event}: {s.players_completed.toLocaleString()} ({pct.toFixed(1)}%)
              </div>
            </div>
          );
        })}
      </div>
    );
  }
  // Bar chart
  return (
    <div className="space-y-2">
      {report.steps.map((s, idx) => {
        const pct = total > 0 ? (s.players_completed / total) * 100 : 0;
        return (
          <div key={idx} className="space-y-0.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium">
                S{idx + 1}: {s.label ?? s.eventName ?? s.event}
              </span>
              <span className="font-mono text-muted-foreground">
                {s.players_completed.toLocaleString()} ({pct.toFixed(1)}%)
                {s.players_dropped_off ? (
                  <span className="ml-2 text-destructive">−{s.players_dropped_off.toLocaleString()} dropped</span>
                ) : null}
              </span>
            </div>
            <div className="h-7 overflow-hidden rounded bg-muted">
              <div className="flex h-full">
                <div
                  className="bg-primary"
                  style={{ width: `${pct}%` }}
                />
                {s.pct_accumulated != null && (
                  <div
                    className="bg-destructive/30"
                    style={{ width: `${100 - pct}%` }}
                  />
                )}
              </div>
            </div>
            {s.avg_time_to_complete_sec != null && (
              <div className="text-[10px] text-muted-foreground">
                Avg time to reach this step: {s.avg_time_to_complete_sec.toFixed(1)}s
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function FunnelsPage() {
  const funnels = useFunnels();
  const upsert = useUpsertFunnel();
  const del = useDeleteFunnel();

  const [editing, setEditing] = useState<FunnelDef | null>(null);
  const [creating, setCreating] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("bar");
  const report = useRunFunnel(activeId);

  const sorted = useMemo(
    () => [...(funnels.data ?? [])].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
    [funnels.data],
  );

  const handleSubmit = useCallback(
    (def: FunnelDef) => {
      upsert.mutate(def, {
        onSuccess: () => {
          setEditing(null);
          setCreating(false);
        },
      });
    },
    [upsert],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Filter className="h-6 w-6 text-primary" />
            Funnels
          </h2>
          <p className="text-muted-foreground">
            Build multi-step funnels from any sequence of analytic events. See drop-off at every stage.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {funnels.isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          <button
            onClick={() => funnels.refetch()}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-card px-3 text-sm hover:bg-accent"
          >
            <RefreshCw className={cn("h-4 w-4", funnels.isFetching && "animate-spin")} />
            Refresh
          </button>
          {!creating && !editing && (
            <button
              onClick={() => setCreating(true)}
              className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              <Plus className="h-4 w-4" />
              New funnel
            </button>
          )}
        </div>
      </div>

      {(creating || editing) && (
        <FunnelForm
          initial={editing ?? undefined}
          onSubmit={handleSubmit}
          onCancel={() => {
            setCreating(false);
            setEditing(null);
          }}
          isPending={upsert.isPending}
        />
      )}

      {funnels.isError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertTriangle className="mr-2 inline h-4 w-4" />
          {funnels.error instanceof Error ? funnels.error.message : "Failed to load funnels"}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-2 lg:col-span-1">
          <h3 className="text-xs font-semibold uppercase text-muted-foreground">Saved funnels</h3>
          {sorted.length === 0 && !funnels.isLoading && (
            <div className="rounded-md border border-dashed border-border p-6 text-center text-xs text-muted-foreground">
              <Layers className="mx-auto h-6 w-6 opacity-40" />
              <p className="mt-2">No funnels yet</p>
            </div>
          )}
          {sorted.map((f) => (
            <button
              key={f.id}
              onClick={() => setActiveId(f.id)}
              className={cn(
                "group w-full rounded-md border p-3 text-left transition-colors",
                activeId === f.id
                  ? "border-primary bg-primary/5"
                  : "border-border bg-card hover:border-border/80",
              )}
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="text-sm font-semibold">{f.name}</div>
                  <div className="font-mono text-[11px] text-muted-foreground">{f.id}</div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {f.steps.length} step{f.steps.length !== 1 ? "s" : ""}
                    {f.audienceId && ` · audience: ${f.audienceId}`}
                  </div>
                </div>
                <div className="flex flex-col gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditing(f);
                      setCreating(false);
                    }}
                    className="text-xs text-muted-foreground hover:text-foreground"
                    title="Edit"
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`Delete funnel "${f.name}"?`)) del.mutate(f.id);
                    }}
                    className="text-xs text-muted-foreground hover:text-destructive"
                    title="Delete"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </button>
          ))}
        </div>

        <div className="space-y-3 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase text-muted-foreground">
              {activeId ? `Report — ${activeId}` : "Select a funnel"}
            </h3>
            {activeId && (
              <div className="flex items-center gap-1 rounded-md border border-border bg-card p-0.5">
                {([
                  ["bar", BarChart3],
                  ["funnel", Triangle],
                  ["line", TrendingDown],
                ] as const).map(([mode, Icon]) => (
                  <button
                    key={mode}
                    onClick={() => setViewMode(mode)}
                    className={cn(
                      "flex h-7 w-7 items-center justify-center rounded transition-colors",
                      viewMode === mode ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-accent",
                    )}
                    title={mode}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </button>
                ))}
                <button
                  onClick={() => report.refetch()}
                  className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-accent"
                  title="Re-run"
                >
                  <Play className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => setActiveId(null)}
                  className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-accent"
                  title="Close"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
          </div>
          <div className="min-h-[300px] rounded-md border border-border bg-card p-4">
            {!activeId ? (
              <div className="flex h-64 flex-col items-center justify-center gap-2 text-center text-xs text-muted-foreground">
                <Filter className="h-8 w-8 opacity-30" />
                <p>Pick a funnel from the left to view its report.</p>
              </div>
            ) : report.isLoading ? (
              <div className="flex h-64 items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : report.isError ? (
              <div className="text-xs text-destructive">
                <AlertTriangle className="mr-1 inline h-3 w-3" />
                Failed to compute funnel:{" "}
                {report.error instanceof Error ? report.error.message : "unknown"}
              </div>
            ) : report.data ? (
              <ReportView report={report.data} mode={viewMode} />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

export default FunnelsPage;
