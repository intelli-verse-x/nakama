// SessionsPage — Satori session analytics surface.
//
// Shows session lifecycle metrics (active sessions, mean duration, p95
// duration, sessions per user) and session-config controls (max idle,
// session-end heuristic).
//
// Wired to: satori_sessions_overview, satori_sessions_config_get / _set

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Clock,
  RefreshCw,
  Loader2,
  AlertTriangle,
  Save,
  Users,
} from "lucide-react";
import { callRpc, serverKeyAuth } from "@nakama/shared";
import { cn } from "@/lib/utils";

interface SessionsOverview {
  active_sessions?: number;
  total_sessions_today?: number;
  mean_duration_sec?: number;
  p95_duration_sec?: number;
  sessions_per_dau?: number;
  recent_sessions?: Array<{
    user_id: string;
    started_at?: number;
    ended_at?: number;
    duration_sec?: number;
    event_count?: number;
  }>;
}

interface SessionsConfig {
  idle_timeout_sec?: number;
  max_session_sec?: number;
  send_session_end_event?: boolean;
}

function unwrap<T>(v: unknown): T {
  if (v && typeof v === "object" && "success" in v && "data" in v) return (v as { data: T }).data;
  return v as T;
}

interface SessionsRaw {
  rangeStartMs?: number;
  rangeEndMs?: number;
  sessionStarts?: number;
  sessionEnds?: number;
  activeUsers?: number;
}

function useOverview() {
  return useQuery({
    queryKey: ["satori", "sessions-overview"],
    queryFn: async () => {
      const raw = await callRpc("satori_sessions_summary", {}, serverKeyAuth()).then((v) =>
        unwrap<SessionsRaw>(v),
      );
      const overview: SessionsOverview = {
        active_sessions: raw.activeUsers,
        total_sessions_today: raw.sessionStarts,
        sessions_per_dau:
          raw.activeUsers && raw.activeUsers > 0 && raw.sessionStarts
            ? raw.sessionStarts / raw.activeUsers
            : undefined,
        recent_sessions: [],
      };
      return overview;
    },
    staleTime: 30_000,
  });
}

function useConfig() {
  return useQuery({
    queryKey: ["satori", "sessions-config"],
    queryFn: () =>
      callRpc("satori_sessions_config_get", {}, serverKeyAuth())
        .then((v) => unwrap<{ config?: SessionsConfig }>(v))
        .catch(() => ({ config: {} as SessionsConfig })),
    select: (d): SessionsConfig => d.config ?? {},
    staleTime: 30_000,
  });
}

function useSetConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (c: SessionsConfig) =>
      callRpc("satori_sessions_config_set", c as unknown as Record<string, unknown>, serverKeyAuth()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["satori", "sessions-config"] }),
  });
}

function fmtDuration(sec?: number) {
  if (sec == null) return "—";
  if (sec < 60) return `${sec.toFixed(0)}s`;
  if (sec < 3600) return `${(sec / 60).toFixed(1)}m`;
  return `${(sec / 3600).toFixed(2)}h`;
}

export function SessionsPage() {
  const overview = useOverview();
  const config = useConfig();
  const setCfg = useSetConfig();

  const [idle, setIdle] = useState(300);
  const [maxSec, setMaxSec] = useState(7200);
  const [sendEndEvent, setSendEndEvent] = useState(true);

  // Hydrate form once config loads.
  useEffect(() => {
    if (config.data) {
      setIdle(config.data.idle_timeout_sec ?? 300);
      setMaxSec(config.data.max_session_sec ?? 7200);
      setSendEndEvent(config.data.send_session_end_event ?? true);
    }
  }, [config.data]);

  const o = overview.data ?? {};

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Activity className="h-6 w-6 text-primary" />
            Sessions
          </h2>
          <p className="text-muted-foreground">
            Session-level analytics and configuration. Accurate session tracking is the foundation for retention, RoAS, and funnels.
          </p>
        </div>
        <button onClick={() => { overview.refetch(); config.refetch(); }} className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-card px-3 text-sm hover:bg-accent">
          <RefreshCw className={cn("h-4 w-4", (overview.isFetching || config.isFetching) && "animate-spin")} />
          Refresh
        </button>
      </div>

      {(overview.isError || config.isError) && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertTriangle className="mr-2 inline h-4 w-4" />
          Failed to load session data.
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-md border border-border bg-card p-4">
          <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <span>Active sessions</span>
            <Users className="h-3 w-3" />
          </div>
          <div className="mt-1 text-2xl font-bold tabular-nums">{o.active_sessions?.toLocaleString() ?? "—"}</div>
        </div>
        <div className="rounded-md border border-border bg-card p-4">
          <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <span>Sessions today</span>
            <Activity className="h-3 w-3" />
          </div>
          <div className="mt-1 text-2xl font-bold tabular-nums">{o.total_sessions_today?.toLocaleString() ?? "—"}</div>
        </div>
        <div className="rounded-md border border-border bg-card p-4">
          <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <span>Mean duration</span>
            <Clock className="h-3 w-3" />
          </div>
          <div className="mt-1 text-2xl font-bold tabular-nums">{fmtDuration(o.mean_duration_sec)}</div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">p95 {fmtDuration(o.p95_duration_sec)}</div>
        </div>
        <div className="rounded-md border border-border bg-card p-4">
          <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <span>Sessions / DAU</span>
            <Users className="h-3 w-3" />
          </div>
          <div className="mt-1 text-2xl font-bold tabular-nums">{o.sessions_per_dau?.toFixed(2) ?? "—"}</div>
        </div>
      </div>

      <div className="rounded-md border border-border bg-card">
        <div className="border-b border-border px-4 py-2 text-xs font-semibold uppercase text-muted-foreground">Recent sessions</div>
        {overview.isLoading ? (
          <div className="flex h-32 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (o.recent_sessions ?? []).length === 0 ? (
          <div className="p-6 text-center text-xs text-muted-foreground">No sessions tracked yet.</div>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-muted/40 text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left">User ID</th>
                <th className="px-3 py-2 text-right">Started</th>
                <th className="px-3 py-2 text-right">Ended</th>
                <th className="px-3 py-2 text-right">Duration</th>
                <th className="px-3 py-2 text-right">Events</th>
              </tr>
            </thead>
            <tbody>
              {(o.recent_sessions ?? []).map((s, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="px-3 py-2 font-mono">{s.user_id.slice(0, 8)}…</td>
                  <td className="px-3 py-2 text-right">{s.started_at ? new Date(s.started_at * 1000).toLocaleString() : "—"}</td>
                  <td className="px-3 py-2 text-right">{s.ended_at ? new Date(s.ended_at * 1000).toLocaleString() : "active"}</td>
                  <td className="px-3 py-2 text-right">{fmtDuration(s.duration_sec)}</td>
                  <td className="px-3 py-2 text-right">{s.event_count ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="rounded-md border border-border bg-card p-4">
        <h3 className="mb-3 text-xs font-semibold uppercase text-muted-foreground">Session configuration</h3>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Idle timeout (sec)</label>
            <input type="number" min={30} value={idle} onChange={(e) => setIdle(Number(e.target.value))} className="h-8 w-full rounded border border-border bg-background px-2 text-xs" />
            <p className="mt-1 text-[10px] text-muted-foreground">Inactivity that ends a session.</p>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Max session (sec)</label>
            <input type="number" min={60} value={maxSec} onChange={(e) => setMaxSec(Number(e.target.value))} className="h-8 w-full rounded border border-border bg-background px-2 text-xs" />
            <p className="mt-1 text-[10px] text-muted-foreground">Hard cap on a single session.</p>
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={sendEndEvent} onChange={(e) => setSendEndEvent(e.target.checked)} />
              Emit synthetic <code className="font-mono">_sessionEnd</code>
            </label>
          </div>
        </div>
        <div className="mt-3 flex justify-end">
          <button
            onClick={() => setCfg.mutate({ idle_timeout_sec: idle, max_session_sec: maxSec, send_session_end_event: sendEndEvent })}
            disabled={setCfg.isPending}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {setCfg.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save configuration
          </button>
        </div>
      </div>
    </div>
  );
}

export default SessionsPage;
