import { motion } from "framer-motion";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer } from "recharts";
import { cn } from "@/lib/utils";
import { Spinner } from "./Skeleton";

export type StatTone = "primary" | "success" | "warning" | "info" | "destructive";

const ICON_TONE: Record<StatTone, string> = {
  primary: "bg-primary/10 text-primary",
  success: "bg-success/10 text-success dark:text-[hsl(152_60%_60%)]",
  warning: "bg-warning/10 text-warning dark:text-[hsl(38_92%_64%)]",
  info: "bg-info/10 text-info dark:text-[hsl(199_89%_66%)]",
  destructive: "bg-destructive/10 text-destructive",
};

const CHART_TONE: Record<StatTone, string> = {
  primary: "hsl(var(--chart-1))",
  success: "hsl(var(--chart-3))",
  warning: "hsl(var(--chart-4))",
  info: "hsl(var(--chart-2))",
  destructive: "hsl(var(--chart-5))",
};

export interface StatCardProps {
  title: string;
  value: React.ReactNode;
  icon: React.ElementType;
  subtitle?: string;
  tone?: StatTone;
  loading?: boolean;
  error?: boolean;
  delta?: number;
  deltaLabel?: string;
  trend?: number[];
  index?: number;
  className?: string;
}

export function StatCard({
  title,
  value,
  icon: Icon,
  subtitle,
  tone = "primary",
  loading,
  error,
  delta,
  deltaLabel,
  trend,
  index = 0,
  className,
}: StatCardProps) {
  const deltaTone =
    delta == null
      ? "neutral"
      : delta > 0
        ? "up"
        : delta < 0
          ? "down"
          : "flat";
  const trendData = trend?.map((v, i) => ({ i, v }));

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: index * 0.05, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        "group relative overflow-hidden rounded-2xl border border-border bg-card p-5 shadow-soft transition-all duration-200 hover:-translate-y-0.5 hover:shadow-soft-md",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <p className="truncate text-sm font-medium text-muted-foreground">
            {title}
          </p>
          {loading ? (
            <Spinner size={22} className="mt-1" />
          ) : error ? (
            <p className="text-2xl font-bold text-muted-foreground/50">—</p>
          ) : (
            <p className="text-2xl font-bold tracking-tight tnum">{value}</p>
          )}
          <div className="flex items-center gap-2">
            {delta != null && !loading && !error && (
              <span
                className={cn(
                  "inline-flex items-center gap-0.5 text-xs font-semibold tnum",
                  deltaTone === "up" && "text-success dark:text-[hsl(152_60%_60%)]",
                  deltaTone === "down" && "text-destructive",
                  deltaTone === "flat" && "text-muted-foreground",
                )}
              >
                {deltaTone === "up" && <ArrowUpRight className="h-3.5 w-3.5" />}
                {deltaTone === "down" && <ArrowDownRight className="h-3.5 w-3.5" />}
                {deltaTone === "flat" && <Minus className="h-3.5 w-3.5" />}
                {Math.abs(delta)}%
              </span>
            )}
            {(subtitle || deltaLabel) && (
              <p className="truncate text-xs text-muted-foreground">
                {deltaLabel ?? subtitle}
              </p>
            )}
          </div>
        </div>
        <div
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-transform duration-200 group-hover:scale-105",
            ICON_TONE[tone],
          )}
        >
          <Icon className="h-5 w-5" strokeWidth={1.75} />
        </div>
      </div>

      {trendData && trendData.length > 1 && !loading && !error && (
        <div className="mt-3 h-10 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={trendData} margin={{ top: 2, bottom: 2, left: 0, right: 0 }}>
              <defs>
                <linearGradient id={`spark-${tone}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={CHART_TONE[tone]} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={CHART_TONE[tone]} stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area
                type="monotone"
                dataKey="v"
                stroke={CHART_TONE[tone]}
                strokeWidth={2}
                fill={`url(#spark-${tone})`}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </motion.div>
  );
}

export default StatCard;
