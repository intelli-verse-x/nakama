import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Server,
  Gamepad2,
  Users,
  Cpu,
  RefreshCw,
  ArrowRight,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Puzzle,
  Sparkles,
  Flag,
  CalendarClock,
  FlaskConical,
  Shield,
  Database,
  BarChart3,
  LayoutDashboard,
  Activity,
} from "lucide-react";
import {
  serverKeyAuth,
  nakama,
  HIRO_SYSTEMS,
  SATORI_SYSTEMS,
  callRpc,
} from "@nakama/shared";
import { cn } from "@/lib/utils";
import {
  Button,
  Card,
  StatCard,
  StatusPill,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  PageHeader,
  EmptyState,
} from "@/components/ui";

const REFETCH_MS = 15_000;
const MAX_POINTS = 30;

function isHealthyStatus(status?: string) {
  const normalized = String(status ?? "").toLowerCase();
  return normalized === "ok" || normalized === "healthy";
}

function useHealth() {
  return useQuery({
    queryKey: ["admin", "health"],
    queryFn: () => nakama.getHealthcheck(serverKeyAuth()),
    refetchInterval: REFETCH_MS,
    retry: 1,
  });
}

function useMatches() {
  return useQuery({
    queryKey: ["admin", "matches"],
    queryFn: () =>
      nakama.listMatches({ ...serverKeyAuth(), limit: 100 }) as Promise<{
        matches?: { match_id: string; size: number; label?: string }[];
      }>,
    refetchInterval: REFETCH_MS,
    retry: 1,
  });
}

function useHiroStatus() {
  return useQuery({
    queryKey: ["admin", "hiro-status"],
    queryFn: async () => {
      const results: Record<string, "ok" | "error"> = {};
      const opts = serverKeyAuth();
      await Promise.allSettled(
        HIRO_SYSTEMS.map(async (sys) => {
          try {
            await callRpc("admin_config_get", { system: sys }, opts);
            results[sys] = "ok";
          } catch {
            results[sys] = "error";
          }
        }),
      );
      return results;
    },
    refetchInterval: 60_000,
    retry: 0,
  });
}

function useSatoriStatus() {
  return useQuery({
    queryKey: ["admin", "satori-status"],
    queryFn: async () => {
      const results: Record<string, "ok" | "error"> = {};
      const opts = serverKeyAuth();
      await Promise.allSettled(
        SATORI_SYSTEMS.map(async (sys) => {
          try {
            await callRpc("satori_config_get", { system: sys }, opts);
            results[sys] = "ok";
          } catch {
            results[sys] = "error";
          }
        }),
      );
      return results;
    },
    refetchInterval: 60_000,
    retry: 0,
  });
}

interface Point {
  t: string;
  sessions: number;
  goroutines: number;
}

function ActivityChart({ data }: { data: Point[] }) {
  if (data.length < 2) {
    return (
      <div className="flex h-[240px] flex-col items-center justify-center gap-2 text-center">
        <Activity className="h-7 w-7 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">
          Collecting live signal…
        </p>
        <p className="text-xs text-muted-foreground/70">
          Updates every {REFETCH_MS / 1000}s
        </p>
      </div>
    );
  }
  return (
    <div className="h-[240px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
          <defs>
            <linearGradient id="dash-sessions" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="hsl(var(--chart-1))" stopOpacity={0.35} />
              <stop offset="100%" stopColor="hsl(var(--chart-1))" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="dash-goroutines" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="hsl(var(--chart-2))" stopOpacity={0.3} />
              <stop offset="100%" stopColor="hsl(var(--chart-2))" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="hsl(var(--border))"
            vertical={false}
          />
          <XAxis
            dataKey="t"
            tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
            axisLine={false}
            tickLine={false}
            minTickGap={28}
          />
          <YAxis
            tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
            axisLine={false}
            tickLine={false}
            width={44}
            allowDecimals={false}
          />
          <Tooltip
            contentStyle={{
              background: "hsl(var(--popover))",
              border: "1px solid hsl(var(--border))",
              borderRadius: "0.75rem",
              fontSize: "12px",
              boxShadow: "0 8px 30px -6px hsl(224 47% 11% / 0.3)",
            }}
            labelStyle={{ color: "hsl(var(--muted-foreground))" }}
          />
          <Area
            type="monotone"
            dataKey="sessions"
            name="Sessions"
            stroke="hsl(var(--chart-1))"
            strokeWidth={2}
            fill="url(#dash-sessions)"
            isAnimationActive={false}
          />
          <Area
            type="monotone"
            dataKey="goroutines"
            name="Goroutines"
            stroke="hsl(var(--chart-2))"
            strokeWidth={2}
            fill="url(#dash-goroutines)"
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function QuickAction({
  label,
  description,
  icon: Icon,
  to,
}: {
  label: string;
  description: string;
  icon: React.ElementType;
  to: string;
}) {
  const navigate = useNavigate();
  return (
    <button
      onClick={() => navigate(to)}
      className="group flex items-center gap-4 rounded-2xl border border-border bg-card p-4 text-left shadow-soft transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-soft-md"
    >
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary transition-transform duration-200 group-hover:scale-105">
        <Icon className="h-5 w-5" strokeWidth={1.75} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">{label}</p>
        <p className="truncate text-xs text-muted-foreground">{description}</p>
      </div>
      <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-primary" />
    </button>
  );
}

function SystemsPanel({
  title,
  icon: Icon,
  systems,
  statusMap,
  loading,
}: {
  title: string;
  icon: React.ElementType;
  systems: readonly string[];
  statusMap: Record<string, "ok" | "error"> | undefined;
  loading: boolean;
}) {
  const okCount = statusMap
    ? Object.values(statusMap).filter((s) => s === "ok").length
    : 0;
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
        <div className="flex items-center gap-2">
          <Icon className="h-4 w-4 text-primary" strokeWidth={1.75} />
          <h3 className="text-sm font-semibold">{title}</h3>
        </div>
        <span className="text-xs text-muted-foreground tnum">
          {loading ? "checking…" : `${okCount}/${systems.length} healthy`}
        </span>
      </div>
      <div className="flex flex-wrap gap-2 p-5">
        {systems.map((sys) => (
          <StatusPill
            key={sys}
            label={sys.replace(/_/g, " ")}
            status={loading ? "loading" : (statusMap?.[sys] ?? "error")}
          />
        ))}
      </div>
    </Card>
  );
}

export function DashboardPage() {
  const navigate = useNavigate();
  const health = useHealth();
  const matches = useMatches();
  const hiroStatus = useHiroStatus();
  const satoriStatus = useSatoriStatus();

  const [history, setHistory] = useState<Point[]>([]);
  const lastUpdateRef = useRef<number>(0);

  useEffect(() => {
    if (!health.data || health.dataUpdatedAt === lastUpdateRef.current) return;
    lastUpdateRef.current = health.dataUpdatedAt;
    setHistory((prev) =>
      [
        ...prev,
        {
          t: new Date(health.dataUpdatedAt || Date.now()).toLocaleTimeString(
            "en-US",
            { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" },
          ),
          sessions: health.data?.session_count ?? 0,
          goroutines: health.data?.goroutine_count ?? 0,
        },
      ].slice(-MAX_POINTS),
    );
  }, [health.data, health.dataUpdatedAt]);

  const isOnline =
    health.isSuccess &&
    (isHealthyStatus(health.data?.status) || health.data?.status === undefined);
  const statusText = health.data?.status ?? (health.isSuccess ? "reachable" : "unknown");
  const matchList = matches.data?.matches ?? [];
  const totalPlayers = matchList.reduce((sum, m) => sum + (m.size ?? 0), 0);
  const sessionTrend = history.map((h) => h.sessions);
  const goroutineTrend = history.map((h) => h.goroutines);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={LayoutDashboard}
        title="Dashboard"
        description="Server health, active sessions, and system overview."
        actions={
          <Button
            variant="outline"
            onClick={() => {
              health.refetch();
              matches.refetch();
              hiroStatus.refetch();
              satoriStatus.refetch();
            }}
            disabled={health.isFetching}
            leftIcon={
              <RefreshCw className={cn("h-4 w-4", health.isFetching && "animate-spin")} />
            }
          >
            Refresh
          </Button>
        }
      />

      {/* Server Health Banner */}
      <Card
        className={cn(
          "flex items-center gap-3 border-l-4 p-4",
          health.isLoading && "border-l-border",
          health.isError && "border-l-destructive bg-destructive/[0.03]",
          isOnline && "border-l-success bg-success/[0.03]",
          !health.isLoading && !health.isError && !isOnline && "border-l-warning bg-warning/[0.03]",
        )}
      >
        {health.isLoading ? (
          <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : health.isError ? (
          <XCircle className="h-5 w-5 text-destructive" />
        ) : isOnline ? (
          <CheckCircle2 className="h-5 w-5 text-success" />
        ) : (
          <AlertTriangle className="h-5 w-5 text-warning" />
        )}
        <div className="flex-1">
          <p className="text-sm font-semibold">
            {health.isLoading
              ? "Checking server status…"
              : health.isError
                ? "Server unreachable"
                : isOnline
                  ? "Server is healthy"
                  : `Server status: ${statusText}`}
          </p>
          {health.data && (
            <p className="text-xs text-muted-foreground">
              Node: {health.data.node ?? "Nakama REST healthcheck"}
            </p>
          )}
        </div>
        {health.dataUpdatedAt > 0 && (
          <p className="text-xs text-muted-foreground tnum">
            Updated {new Date(health.dataUpdatedAt).toLocaleTimeString()}
          </p>
        )}
      </Card>

      {/* KPI Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          index={0}
          title="Server Status"
          value={isOnline ? "Online" : health.isError ? "Offline" : "—"}
          icon={Server}
          tone={isOnline ? "success" : health.isError ? "destructive" : "warning"}
          subtitle={health.data?.node ?? "Nakama healthcheck"}
          loading={health.isLoading}
          error={health.isError}
        />
        <StatCard
          index={1}
          title="Active Sessions"
          value={health.data?.session_count ?? "—"}
          icon={Users}
          tone="primary"
          subtitle="Connected players"
          loading={health.isLoading}
          error={health.isError}
          trend={sessionTrend}
        />
        <StatCard
          index={2}
          title="Goroutines"
          value={health.data?.goroutine_count ?? "—"}
          icon={Cpu}
          tone="info"
          subtitle="Server concurrency"
          loading={health.isLoading}
          error={health.isError}
          trend={goroutineTrend}
        />
        <StatCard
          index={3}
          title="Active Matches"
          value={matchList.length}
          icon={Gamepad2}
          tone="warning"
          subtitle={`${totalPlayers} players in matches`}
          loading={matches.isLoading}
          error={matches.isError}
        />
      </div>

      {/* Live activity + matches */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="flex items-center justify-between px-5 pt-5">
            <div>
              <h3 className="text-sm font-semibold">Live Activity</h3>
              <p className="text-xs text-muted-foreground">
                Sessions &amp; goroutines over time
              </p>
            </div>
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-chart-1" /> Sessions
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-chart-2" /> Goroutines
              </span>
            </div>
          </div>
          <div className="px-3 pb-3 pt-4">
            <ActivityChart data={history} />
          </div>
        </Card>

        <Card className="flex flex-col">
          <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
            <h3 className="text-sm font-semibold">Active Matches</h3>
            {matchList.length > 0 && (
              <button
                onClick={() => navigate("/matches")}
                className="text-xs font-medium text-primary hover:underline"
              >
                View all
              </button>
            )}
          </div>
          <div className="flex-1 p-3">
            {matchList.length === 0 ? (
              <EmptyState
                icon={Gamepad2}
                title="No active matches"
                description="Live matches will appear here when players connect."
                className="h-full border-0 bg-transparent py-8"
              />
            ) : (
              <div className="space-y-1">
                {matchList.slice(0, 6).map((m) => (
                  <div
                    key={m.match_id}
                    className="flex items-center justify-between rounded-lg px-2.5 py-2 transition-colors hover:bg-muted/50"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-mono text-xs">
                        {m.match_id.slice(0, 16)}…
                      </p>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {m.label || "no label"}
                      </p>
                    </div>
                    <span className="flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary tnum">
                      <Users className="h-3 w-3" />
                      {m.size}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>
      </div>

      {matchList.length > 0 && (
        <Table>
          <THead>
            <TR className="hover:bg-transparent">
              <TH>Match ID</TH>
              <TH>Label</TH>
              <TH className="text-right">Players</TH>
            </TR>
          </THead>
          <TBody>
            {matchList.slice(0, 5).map((m) => (
              <TR key={m.match_id}>
                <TD className="font-mono text-xs">{m.match_id.slice(0, 24)}…</TD>
                <TD className="text-muted-foreground">{m.label || "—"}</TD>
                <TD className="text-right tnum">{m.size}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      {/* Systems status */}
      <div className="grid gap-4 lg:grid-cols-2">
        <SystemsPanel
          title="Hiro Meta-game Systems"
          icon={Puzzle}
          systems={HIRO_SYSTEMS}
          statusMap={hiroStatus.data}
          loading={hiroStatus.isLoading}
        />
        <SystemsPanel
          title="Satori LiveOps Systems"
          icon={Sparkles}
          systems={SATORI_SYSTEMS}
          statusMap={satoriStatus.data}
          loading={satoriStatus.isLoading}
        />
      </div>

      {/* Quick Actions */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Quick Actions</h3>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <QuickAction label="Feature Flags" description="Toggle flags and rollout percentages" icon={Flag} to="/flags" />
          <QuickAction label="Live Events" description="Create and manage live events" icon={CalendarClock} to="/events" />
          <QuickAction label="Experiments" description="A/B tests and variant analysis" icon={FlaskConical} to="/experiments" />
          <QuickAction label="Account Management" description="Ban, unban, and manage players" icon={Shield} to="/accounts" />
          <QuickAction label="Storage Browser" description="Browse and edit storage objects" icon={Database} to="/storage" />
          <QuickAction label="Analytics" description="Metrics, data lake, and cohort analysis" icon={BarChart3} to="/analytics" />
        </div>
      </div>
    </div>
  );
}
