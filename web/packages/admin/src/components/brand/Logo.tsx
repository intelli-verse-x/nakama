import { cn } from "@/lib/utils";

const GRADIENT_ID = "ivx-brand-gradient";

export function LogoMark({
  size = 32,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient
          id={GRADIENT_ID}
          x1="8"
          y1="6"
          x2="56"
          y2="58"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="hsl(var(--brand-from))" />
          <stop offset="0.5" stopColor="hsl(var(--brand-via))" />
          <stop offset="1" stopColor="hsl(var(--brand-to))" />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="56" height="56" rx="16" fill={`url(#${GRADIENT_ID})`} />
      <rect
        x="4.75"
        y="4.75"
        width="54.5"
        height="54.5"
        rx="15.25"
        stroke="white"
        strokeOpacity="0.18"
        strokeWidth="1.5"
      />
      <path
        d="M20 44V20L44 44V20"
        stroke="white"
        strokeWidth="5.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <circle cx="20" cy="20" r="3.4" fill="white" />
      <circle cx="44" cy="44" r="3.4" fill="white" />
    </svg>
  );
}

export function Logo({
  size = 32,
  showWordmark = true,
  className,
  subtitle,
}: {
  size?: number;
  showWordmark?: boolean;
  className?: string;
  subtitle?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <LogoMark size={size} className="shrink-0 drop-shadow-sm" />
      {showWordmark && (
        <div className="flex flex-col leading-none">
          <span className="text-[15px] font-bold tracking-tight text-foreground">
            Nakama
            <span className="brand-gradient-text"> Admin</span>
          </span>
          {subtitle && (
            <span className="mt-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              {subtitle}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default Logo;
