import { cn } from "@/lib/utils";

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  className?: string;
  size?: "sm" | "md";
}

export function Switch({
  checked,
  onChange,
  disabled,
  label,
  className,
  size = "md",
}: SwitchProps) {
  const dims =
    size === "sm"
      ? { track: "h-5 w-9", knob: "h-4 w-4", shift: "translate-x-4" }
      : { track: "h-6 w-11", knob: "h-5 w-5", shift: "translate-x-5" };
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex shrink-0 items-center rounded-full transition-colors duration-200 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
        dims.track,
        checked ? "bg-primary" : "bg-muted-foreground/30",
        className,
      )}
    >
      <span
        className={cn(
          "pointer-events-none ml-0.5 inline-block transform rounded-full bg-white shadow-sm transition-transform duration-200",
          dims.knob,
          checked ? dims.shift : "translate-x-0",
        )}
      />
    </button>
  );
}

export default Switch;
