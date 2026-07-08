import { useEffect, useRef, useState } from "react";
import { Outlet, NavLink, useLocation, useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  LayoutDashboard,
  Users,
  Puzzle,
  Sparkles,
  Flag,
  CalendarClock,
  FlaskConical,
  UsersRound,
  MessageSquare,
  Shield,
  Tag,
  ScrollText,
  Award,
  Medal,
  Trophy,
  Database,
  Gamepad2,
  Terminal,
  Wallet,
  UserCheck,
  BarChart3,
  Download,
  Settings,
  BookOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Sun,
  Moon,
  Monitor,
  LogOut,
  Search,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAdminStore } from "@/stores/admin-store";
import { useAdminAuth } from "@/auth/admin-auth";
import { Logo, LogoMark } from "@/components/brand/Logo";
import { CommandPalette, type CommandItem } from "@/components/CommandPalette";

interface NavItem {
  label: string;
  to: string;
  icon: React.ElementType;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Overview",
    items: [{ label: "Dashboard", to: "/dashboard", icon: LayoutDashboard }],
  },
  {
    label: "Game Systems",
    items: [
      { label: "Hiro Config", to: "/hiro-config", icon: Puzzle },
      { label: "Satori Config", to: "/satori-config", icon: Sparkles },
    ],
  },
  {
    label: "LiveOps",
    items: [
      { label: "Feature Flags", to: "/flags", icon: Flag },
      { label: "Live Events", to: "/events", icon: CalendarClock },
      { label: "Experiments", to: "/experiments", icon: FlaskConical },
      { label: "Audiences", to: "/audiences", icon: UsersRound },
      { label: "Messages", to: "/messages", icon: MessageSquare },
    ],
  },
  {
    label: "Players",
    items: [
      { label: "Players", to: "/players", icon: Users },
      { label: "Accounts", to: "/accounts", icon: Shield },
    ],
  },
  {
    label: "Content",
    items: [
      { label: "Offers", to: "/offers", icon: Tag },
      { label: "Quests Config", to: "/quests-config", icon: ScrollText },
      { label: "Battle Pass Config", to: "/battlepass-config", icon: Award },
      { label: "Achievements", to: "/achievements", icon: Medal },
      { label: "Leaderboards Config", to: "/leaderboards-config", icon: Trophy },
    ],
  },
  {
    label: "Infrastructure",
    items: [
      { label: "Storage", to: "/storage", icon: Database },
      { label: "Matches", to: "/matches", icon: Gamepad2 },
      { label: "Server Logs", to: "/logs", icon: Terminal },
      { label: "Economy", to: "/economy", icon: Wallet },
      { label: "Retention", to: "/retention", icon: UserCheck },
      { label: "Analytics", to: "/analytics", icon: BarChart3 },
    ],
  },
  {
    label: "System",
    items: [
      { label: "Config Export", to: "/config-export", icon: Download },
      { label: "Settings", to: "/settings", icon: Settings },
      { label: "Developer Guide", to: "/dev-guide", icon: BookOpen },
    ],
  },
];

const ALL_NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items);
const COMMAND_ITEMS: CommandItem[] = NAV_GROUPS.flatMap((g) =>
  g.items.map((i) => ({ ...i, group: g.label })),
);

function getPage(pathname: string) {
  const group = NAV_GROUPS.find((g) => g.items.some((i) => i.to === pathname));
  const item = ALL_NAV_ITEMS.find((i) => i.to === pathname);
  return { title: item?.label ?? "Admin Console", group: group?.label ?? "" };
}

function NavItemLink({
  item,
  collapsed,
}: {
  item: NavItem;
  collapsed: boolean;
}) {
  return (
    <NavLink
      to={item.to}
      title={collapsed ? item.label : undefined}
      className={({ isActive }) =>
        cn(
          "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-150",
          isActive
            ? "bg-primary/10 text-primary"
            : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          collapsed && "justify-center px-2",
        )
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <motion.span
              layoutId="nav-accent"
              className="absolute left-0 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-primary"
              transition={{ type: "spring", stiffness: 500, damping: 34 }}
            />
          )}
          <item.icon
            size={18}
            strokeWidth={isActive ? 2 : 1.75}
            className="shrink-0"
          />
          {!collapsed && <span className="truncate">{item.label}</span>}
        </>
      )}
    </NavLink>
  );
}

function UserMenu() {
  const { session, logout } = useAdminAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const username = session?.username ?? "admin";
  const initials = username.slice(0, 2).toUpperCase();

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-full py-1 pl-1 pr-2.5 text-sm transition-colors hover:bg-accent"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full brand-gradient text-xs font-bold text-white">
          {initials}
        </span>
        <span className="hidden max-w-[7rem] truncate font-medium sm:inline">
          {username}
        </span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.97 }}
            transition={{ duration: 0.15 }}
            className="absolute right-0 top-full z-50 mt-2 w-56 overflow-hidden rounded-xl border border-border bg-popover shadow-soft-lg"
          >
            <div className="flex items-center gap-3 border-b border-border px-4 py-3">
              <span className="flex h-9 w-9 items-center justify-center rounded-full brand-gradient text-sm font-bold text-white">
                {initials}
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{username}</p>
                <p className="truncate text-xs capitalize text-muted-foreground">
                  {session?.role ?? "admin"}
                </p>
              </div>
            </div>
            <div className="p-1.5">
              <button
                onClick={() => {
                  navigate("/settings");
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Settings className="h-4 w-4" />
                Settings
              </button>
              <button
                onClick={logout}
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-destructive transition-colors hover:bg-destructive/10"
              >
                <LogOut className="h-4 w-4" />
                Sign out
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ThemeToggle() {
  const { theme, setTheme } = useAdminStore();
  const next = theme === "light" ? "dark" : theme === "dark" ? "system" : "light";
  const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  return (
    <button
      onClick={() => setTheme(next)}
      title={`Theme: ${theme} (click for ${next})`}
      aria-label={`Switch theme, current ${theme}`}
      className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <Icon className="h-[18px] w-[18px]" />
    </button>
  );
}

export function AdminLayout() {
  const [collapsed, setCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const location = useLocation();
  const { title, group } = getPage(location.pathname);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <motion.aside
        animate={{ width: collapsed ? 72 : 256 }}
        transition={{ type: "spring", stiffness: 380, damping: 34 }}
        className="z-20 flex flex-col border-r border-border bg-surface"
      >
        <div
          className={cn(
            "flex h-16 items-center border-b border-border px-4",
            collapsed ? "justify-center" : "justify-between",
          )}
        >
          {collapsed ? (
            <LogoMark size={30} />
          ) : (
            <Logo size={30} subtitle="LiveOps Console" />
          )}
        </div>

        <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-4">
          {NAV_GROUPS.map((grp) => (
            <div key={grp.label} className="pb-2">
              {collapsed ? (
                <div className="mx-2 my-2 border-t border-border/70" />
              ) : (
                <p className="mb-1 px-3 pt-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
                  {grp.label}
                </p>
              )}
              <div className="space-y-0.5">
                {grp.items.map((item) => (
                  <NavItemLink key={item.to} item={item} collapsed={collapsed} />
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="border-t border-border p-3">
          <button
            onClick={() => setCollapsed((c) => !c)}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
              collapsed && "justify-center px-2",
            )}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? (
              <PanelLeftOpen size={18} />
            ) : (
              <>
                <PanelLeftClose size={18} />
                <span>Collapse</span>
              </>
            )}
          </button>
        </div>
      </motion.aside>

      <main className="flex flex-1 flex-col overflow-hidden">
        <header className="sticky top-0 z-10 flex h-16 items-center justify-between gap-4 border-b border-border bg-surface/80 px-6 backdrop-blur-md">
          <div className="flex min-w-0 items-center gap-2">
            {group && (
              <>
                <span className="hidden text-sm font-medium text-muted-foreground sm:inline">
                  {group}
                </span>
                <ChevronRight className="hidden h-4 w-4 text-muted-foreground/50 sm:inline" />
              </>
            )}
            <h1 className="truncate text-base font-semibold tracking-tight">
              {title}
            </h1>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setPaletteOpen(true)}
              className="hidden items-center gap-2 rounded-lg border border-border bg-background/60 py-1.5 pl-3 pr-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:flex"
            >
              <Search className="h-4 w-4" />
              <span>Search</span>
              <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium">
                ⌘K
              </kbd>
            </button>
            <button
              onClick={() => setPaletteOpen(true)}
              aria-label="Open command palette"
              className="flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:hidden"
            >
              <Search className="h-[18px] w-[18px]" />
            </button>
            <ThemeToggle />
            <div className="mx-1 h-6 w-px bg-border" />
            <UserMenu />
          </div>
        </header>

        <div className="flex-1 overflow-y-auto">
          <AnimatePresence mode="wait">
            <motion.div
              key={location.pathname}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              className="mx-auto max-w-[1600px] p-6 lg:p-8"
            >
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </div>
      </main>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        items={COMMAND_ITEMS}
      />
    </div>
  );
}
