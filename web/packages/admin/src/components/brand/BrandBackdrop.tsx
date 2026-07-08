import { cn } from "@/lib/utils";

export function BrandBackdrop({ className }: { className?: string }) {
  return (
    <div
      className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}
      aria-hidden="true"
    >
      <div className="absolute inset-0 bg-grid-pattern [background-size:36px_36px] opacity-[0.35] [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)]" />

      <div className="absolute -left-24 -top-24 h-[28rem] w-[28rem] rounded-full bg-primary/25 blur-[120px]" />
      <div className="absolute right-[-6rem] top-1/3 h-[24rem] w-[24rem] rounded-full bg-fuchsia-500/20 blur-[120px]" />
      <div className="absolute bottom-[-8rem] left-1/3 h-[26rem] w-[26rem] rounded-full bg-indigo-500/20 blur-[130px]" />

      <svg
        className="absolute inset-0 h-full w-full opacity-40"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <radialGradient id="brand-glow" cx="50%" cy="0%" r="80%">
            <stop offset="0%" stopColor="hsl(var(--brand-via))" stopOpacity="0.18" />
            <stop offset="100%" stopColor="hsl(var(--brand-via))" stopOpacity="0" />
          </radialGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#brand-glow)" />
      </svg>
    </div>
  );
}

export default BrandBackdrop;
