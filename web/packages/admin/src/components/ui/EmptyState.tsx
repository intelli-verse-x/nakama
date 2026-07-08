import { cn } from "@/lib/utils";

export function EmptyIllustration({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 200 140"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("h-28 w-auto", className)}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="empty-grad" x1="40" y1="24" x2="160" y2="120" gradientUnits="userSpaceOnUse">
          <stop stopColor="hsl(var(--brand-from))" stopOpacity="0.9" />
          <stop offset="1" stopColor="hsl(var(--brand-to))" stopOpacity="0.9" />
        </linearGradient>
      </defs>
      <ellipse cx="100" cy="122" rx="62" ry="8" fill="hsl(var(--foreground))" fillOpacity="0.06" />
      <rect x="44" y="30" width="112" height="76" rx="12" fill="hsl(var(--muted))" />
      <rect
        x="44"
        y="30"
        width="112"
        height="76"
        rx="12"
        stroke="hsl(var(--border))"
        strokeWidth="1.5"
      />
      <rect x="44" y="30" width="112" height="22" rx="12" fill="url(#empty-grad)" fillOpacity="0.16" />
      <circle cx="56" cy="41" r="2.5" fill="hsl(var(--brand-from))" />
      <circle cx="65" cy="41" r="2.5" fill="hsl(var(--brand-via))" fillOpacity="0.6" />
      <circle cx="74" cy="41" r="2.5" fill="hsl(var(--brand-to))" fillOpacity="0.4" />
      <rect x="58" y="64" width="84" height="8" rx="4" fill="hsl(var(--foreground))" fillOpacity="0.1" />
      <rect x="58" y="80" width="56" height="8" rx="4" fill="hsl(var(--foreground))" fillOpacity="0.07" />
      <circle cx="150" cy="96" r="18" fill="url(#empty-grad)" />
      <path
        d="M150 89v14M143 96h14"
        stroke="white"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export interface EmptyStateProps {
  icon?: React.ElementType;
  illustration?: boolean;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  illustration = false,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card/40 px-6 py-14 text-center",
        className,
      )}
    >
      {illustration ? (
        <EmptyIllustration className="mb-5" />
      ) : Icon ? (
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <Icon className="h-7 w-7" strokeWidth={1.5} />
        </div>
      ) : null}
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      {description && (
        <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
          {description}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export default EmptyState;
