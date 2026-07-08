import { cn } from "@/lib/utils";

export type BadgeTone =
  | "neutral"
  | "primary"
  | "success"
  | "warning"
  | "info"
  | "destructive";

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: "bg-muted text-muted-foreground ring-border",
  primary: "bg-primary/10 text-primary ring-primary/20",
  success:
    "bg-success/10 text-success ring-success/20 dark:text-[hsl(152_60%_60%)]",
  warning:
    "bg-warning/10 text-warning ring-warning/25 dark:text-[hsl(38_92%_64%)]",
  info: "bg-info/10 text-info ring-info/20 dark:text-[hsl(199_89%_66%)]",
  destructive: "bg-destructive/10 text-destructive ring-destructive/20",
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  dot?: boolean;
}

export function Badge({
  className,
  tone = "neutral",
  dot = false,
  children,
  ...props
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset",
        TONE_CLASSES[tone],
        className,
      )}
      {...props}
    >
      {dot && (
        <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" />
      )}
      {children}
    </span>
  );
}

export interface StatusPillProps {
  status: "ok" | "error" | "loading" | "warning";
  label: string;
  className?: string;
}

export function StatusPill({ status, label, className }: StatusPillProps) {
  const tone: BadgeTone =
    status === "ok"
      ? "success"
      : status === "error"
        ? "destructive"
        : status === "warning"
          ? "warning"
          : "neutral";
  return (
    <Badge tone={tone} className={cn("capitalize", className)}>
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          status === "ok" && "bg-success animate-pulse-ring",
          status === "error" && "bg-destructive",
          status === "warning" && "bg-warning",
          status === "loading" && "bg-muted-foreground animate-pulse",
        )}
      />
      {label}
    </Badge>
  );
}

export default Badge;
