import { useState } from "react";
import { motion } from "framer-motion";
import {
  Loader2,
  LockKeyhole,
  ShieldCheck,
  Activity,
  BarChart3,
  Zap,
  AlertCircle,
} from "lucide-react";
import { useAdminAuth } from "@/auth/admin-auth";
import { Logo, LogoMark } from "@/components/brand/Logo";
import { BrandBackdrop } from "@/components/brand/BrandBackdrop";
import { Button, Input, Label } from "@/components/ui";

const HIGHLIGHTS = [
  { icon: Zap, title: "Real-time LiveOps", desc: "Flags, events & experiments in one console." },
  { icon: BarChart3, title: "Deep analytics", desc: "Cohorts, retention & the data lake." },
  { icon: Activity, title: "Runtime health", desc: "Live diagnostics across Hiro & Satori." },
];

export function LoginPage() {
  const { login } = useAdminAuth();
  const [username, setUsername] = useState("ivx-admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      await login(username.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="grid min-h-screen w-full lg:grid-cols-2">
      {/* ── Brand panel ─────────────────────────────────────────── */}
      <div className="relative hidden overflow-hidden bg-surface lg:flex lg:flex-col lg:justify-between lg:p-12">
        <BrandBackdrop />
        <div className="relative">
          <Logo size={40} subtitle="LiveOps Console" />
        </div>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="relative max-w-md"
        >
          <h2 className="text-3xl font-bold leading-tight tracking-tight">
            Operate your game,
            <br />
            <span className="brand-gradient-text">in real time.</span>
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
            The mission control for QuizVerse &amp; LastToLive — tune the economy,
            ship experiments, and watch player signals live.
          </p>

          <div className="mt-8 space-y-3">
            {HIGHLIGHTS.map((h, i) => (
              <motion.div
                key={h.title}
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.2 + i * 0.1, duration: 0.4 }}
                className="flex items-start gap-3 rounded-xl border border-border/60 bg-card/50 p-3 backdrop-blur-sm"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <h.icon className="h-[18px] w-[18px]" strokeWidth={1.75} />
                </span>
                <div>
                  <p className="text-sm font-semibold">{h.title}</p>
                  <p className="text-xs text-muted-foreground">{h.desc}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </motion.div>

        <p className="relative text-xs text-muted-foreground">
          Nakama 3.35 · Powered by IntelliVerseX
        </p>
      </div>

      {/* ── Form panel ──────────────────────────────────────────── */}
      <div className="relative flex items-center justify-center px-4 py-12 sm:px-8">
        <div className="absolute inset-0 lg:hidden">
          <BrandBackdrop />
        </div>
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          className="relative w-full max-w-sm"
        >
          <div className="mb-8 flex flex-col items-center text-center lg:hidden">
            <LogoMark size={48} />
            <h1 className="mt-4 text-2xl font-bold tracking-tight">Nakama Admin</h1>
          </div>

          <div className="rounded-2xl border border-border bg-card p-7 shadow-soft-lg sm:p-8">
            <div className="mb-7">
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <ShieldCheck className="h-6 w-6" strokeWidth={1.75} />
              </div>
              <h2 className="text-xl font-bold tracking-tight">Welcome back</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Sign in to access the admin console.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">
              <div>
                <Label htmlFor="admin-username">Username</Label>
                <Input
                  id="admin-username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  placeholder="your-admin-handle"
                />
              </div>

              <div>
                <Label htmlFor="admin-password">Password</Label>
                <Input
                  id="admin-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  placeholder="••••••••••••"
                />
              </div>

              {error && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
                >
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </motion.div>
              )}

              <Button
                type="submit"
                size="lg"
                className="w-full"
                disabled={isSubmitting || !username.trim() || !password}
                leftIcon={
                  isSubmitting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <LockKeyhole className="h-4 w-4" />
                  )
                }
              >
                {isSubmitting ? "Signing in…" : "Sign In"}
              </Button>
            </form>
          </div>

          <p className="mt-6 text-center text-xs text-muted-foreground">
            Protected area · Authorized personnel only
          </p>
        </motion.div>
      </div>
    </div>
  );
}

export default LoginPage;
