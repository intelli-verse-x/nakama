import { useState, useMemo, useCallback } from "react";
import { useScopedGameId } from "@/hooks/useScopedGame";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Swords,
  Search,
  Plus,
  RefreshCw,
  Loader2,
  Pencil,
  X,
  Check,
  AlertTriangle,
  Trash2,
  Copy,
  Eye,
  Target,
  Users,
  Clock,
  Gift,
  Timer,
  ChevronDown,
  ChevronUp,
  Repeat,
  Sparkles,
  Zap,
  CalendarClock,
  CheckCircle2,
  Ban,
  ShieldAlert,
  FileJson,
  Download,
  Upload,
} from "lucide-react";
import {
  serverKeyAuth,
  questEngine,
  type QuestEngineQuest,
  type QuestEngineStep,
  type QuestEngineConfig,
} from "@nakama/shared";
import { cn } from "@/lib/utils";
import { RewardBuilder, type RewardBuilderReward } from "@/components/RewardBuilder";

const GLOBAL_CONFIG_SCOPE = "global";
const QUEST_ENGINE_DEFAULT_GAME = "126bf539-dae2-4bcf-964d-316c0fa1f92b";

function rpcGameId(scope: string) {
  const trimmed = scope.trim();
  return trimmed && trimmed !== GLOBAL_CONFIG_SCOPE ? trimmed : QUEST_ENGINE_DEFAULT_GAME;
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type QuestStatus = "active" | "upcoming" | "expired" | "disabled" | "all";

const CATEGORIES = [
  "daily",
  "weekly",
  "monthly",
  "friend",
  "onboarding",
  "bucket",
  "event",
  "custom",
] as const;

const EVENT_TYPES = [
  "quiz_win",
  "quiz_completed",
  "perfect_round",
  "score_shared",
  "friend_challenged",
  "daily_quiz_complete",
  "guild_joined",
  "bucket_progress",
  "custom",
] as const;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function deriveStatus(q: QuestEngineQuest): Exclude<QuestStatus, "all"> {
  if (q.enabled === false) return "disabled";
  const now = Math.floor(Date.now() / 1000);
  const end = q.expiresAt ?? 0;
  if (end > 0 && now > end) return "expired";
  return "active";
}

function statusColor(s: Exclude<QuestStatus, "all">) {
  switch (s) {
    case "active": return "text-emerald-400";
    case "expired": return "text-zinc-500";
    case "disabled": return "text-amber-400";
  }
}

function statusBg(s: Exclude<QuestStatus, "all">) {
  switch (s) {
    case "active": return "bg-emerald-500/10 border-emerald-500/20";
    case "expired": return "bg-zinc-500/10 border-zinc-500/20";
    case "disabled": return "bg-amber-500/10 border-amber-500/20";
  }
}

function StatusIcon({ status }: { status: Exclude<QuestStatus, "all"> }) {
  switch (status) {
    case "active": return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />;
    case "expired": return <Clock className="h-3.5 w-3.5 text-zinc-500" />;
    case "disabled": return <Ban className="h-3.5 w-3.5 text-amber-400" />;
  }
}

function formatTs(sec?: number) {
  if (!sec) return "—";
  return new Date(sec * 1000).toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function toDatetimeLocal(sec?: number) {
  if (!sec) return "";
  const d = new Date(sec * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromDatetimeLocal(val: string) {
  if (!val) return undefined;
  return Math.floor(new Date(val).getTime() / 1000);
}

function formatRewardSummary(r?: QuestEngineQuest["reward"]): string[] {
  if (!r?.guaranteed) return [];
  const g = r.guaranteed;
  const parts: string[] = [];
  if (g.currencies) for (const [k, v] of Object.entries(g.currencies)) parts.push(`${v} ${k}`);
  if (g.items) for (const [itemId, count] of Object.entries(g.items)) parts.push(`${count}x ${itemId}`);
  if (g.energies) for (const [k, v] of Object.entries(g.energies)) parts.push(`${v} ${k} energy`);
  if ((g as any).xp) parts.push(`${(g as any).xp} XP`);
  if (g.gifts?.length) for (const gift of g.gifts) parts.push(`🎁 ${gift.name}`);
  return parts;
}

function parseInitialReward(reward?: QuestEngineQuest["reward"]): RewardBuilderReward {
  if (!reward?.guaranteed) return { currencies: { game: 100 }, xp: 25 };
  const g = reward.guaranteed;
  const result: RewardBuilderReward = {};
  if (g.currencies) result.currencies = g.currencies;
  if (g.items) result.items = g.items as Record<string, number>;
  if (g.energies) result.energies = g.energies;
  if ((g as any).xp) result.xp = (g as any).xp;
  if (g.gifts) result.gifts = g.gifts as any;
  if ((g as any).energyModifiers) result.energyModifiers = (g as any).energyModifiers;
  if ((g as any).rewardModifiers) result.rewardModifiers = (g as any).rewardModifiers;
  return result;
}

function rewardToEngineReward(r: RewardBuilderReward): QuestEngineQuest["reward"] | undefined {
  const grant: any = {};
  let hasAny = false;
  if (r.currencies && Object.keys(r.currencies).length > 0) { grant.currencies = r.currencies; hasAny = true; }
  if (r.items && Object.keys(r.items).length > 0) { grant.items = r.items; hasAny = true; }
  if (r.energies && Object.keys(r.energies).length > 0) { grant.energies = r.energies; hasAny = true; }
  if (r.xp) { grant.xp = r.xp; hasAny = true; }
  if (r.gifts && r.gifts.length > 0) { grant.gifts = r.gifts; hasAny = true; }
  if (r.energyModifiers && r.energyModifiers.length > 0) { grant.energyModifiers = r.energyModifiers; hasAny = true; }
  if (r.rewardModifiers && r.rewardModifiers.length > 0) { grant.rewardModifiers = r.rewardModifiers; hasAny = true; }
  return hasAny ? { guaranteed: grant } : undefined;
}

/* ------------------------------------------------------------------ */
/*  Hooks                                                              */
/* ------------------------------------------------------------------ */

function useQuestEngineConfig(gameScope: string | undefined) {
  return useQuery({
    queryKey: ["quest-engine", "config", gameScope || "global"],
    queryFn: () => questEngine.getQuestEngineConfig(rpcGameId(gameScope || ""), serverKeyAuth()),
    enabled: true,
    staleTime: 30_000,
  });
}

function useSaveQuestEngineConfig(gameScope: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (config: QuestEngineConfig) =>
      questEngine.saveQuestEngineConfig(rpcGameId(gameScope || ""), config, serverKeyAuth()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["quest-engine", "config", gameScope || "global"] }),
  });
}

/* ------------------------------------------------------------------ */
/*  Quest Form                                                         */
/* ------------------------------------------------------------------ */

interface QuestFormProps {
  initial?: QuestEngineQuest;
  onSubmit: (quest: QuestEngineQuest) => void;
  onCancel: () => void;
  isPending: boolean;
  existingIds: string[];
}

function QuestForm({ initial, onSubmit, onCancel, isPending, existingIds }: QuestFormProps) {
  const [id, setId] = useState(initial?.id ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [category, setCategory] = useState(initial?.category ?? "daily");
  const [steps, setSteps] = useState<QuestEngineStep[]>(
    (initial?.steps as QuestEngineStep[] | undefined)?.length
      ? (initial?.steps as QuestEngineStep[])
      : [{ id: "s1", description: "", eventType: "quiz_win", requiredCount: 1 }]
  );
  const [reward, setReward] = useState<RewardBuilderReward>(parseInitialReward(initial?.reward));
  const [expiresAt, setExpiresAt] = useState(toDatetimeLocal(initial?.expiresAt));
  const [resetIntervalSec, setResetIntervalSec] = useState(initial?.resetIntervalSec?.toString() ?? "");
  const [repeatable, setRepeatable] = useState<boolean>(initial?.repeatable ?? false);
  const [hidden, setHidden] = useState<boolean>(initial?.hidden ?? false);
  const [enabled, setEnabled] = useState<boolean>(initial?.enabled ?? true);
  const [requiresOptIn, setRequiresOptIn] = useState<boolean>(initial?.requiresOptIn ?? false);
  const [maxConcurrent, setMaxConcurrent] = useState(initial?.maxConcurrent?.toString() ?? "");
  const [prerequisiteIds, setPrerequisiteIds] = useState(initial?.prerequisiteIds?.join(", ") ?? "");
  const [showPreview, setShowPreview] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const idConflict = !initial && existingIds.includes(id.trim());

  const previewQuest = useMemo((): QuestEngineQuest | null => {
    const preconds = prerequisiteIds.split(",").map((s) => s.trim()).filter(Boolean);
    const resetSec = resetIntervalSec ? parseInt(resetIntervalSec, 10) : undefined;
    const maxCon = maxConcurrent ? parseInt(maxConcurrent, 10) : undefined;
    return {
      id: id.trim(),
      name: name.trim(),
      description: description.trim() || undefined,
      category: category || undefined,
      steps,
      reward: rewardToEngineReward(reward),
      expiresAt: fromDatetimeLocal(expiresAt),
      prerequisiteIds: preconds.length > 0 ? preconds : undefined,
      repeatable,
      resetIntervalSec: resetSec && resetSec > 0 ? resetSec : undefined,
      hidden,
      enabled,
      requiresOptIn,
      maxConcurrent: maxCon && maxCon > 0 ? maxCon : undefined,
    };
  }, [id, name, description, category, steps, reward, expiresAt, prerequisiteIds, repeatable, resetIntervalSec, hidden, enabled, requiresOptIn, maxConcurrent]);

  const validate = useCallback((): string[] => {
    const errs: string[] = [];
    if (!id.trim()) errs.push("Quest ID is required");
    if (!name.trim()) errs.push("Display name is required");
    if (idConflict) errs.push("A quest with this ID already exists");
    if (steps.length === 0) errs.push("At least one step is required");
    const stepIds = new Set<string>();
    steps.forEach((s, i) => {
      if (!s.id.trim()) errs.push(`Step ${i + 1} is missing an ID`);
      if (stepIds.has(s.id)) errs.push(`Duplicate step ID: ${s.id}`);
      stepIds.add(s.id);
      if (!s.eventType.trim()) errs.push(`Step ${s.id || i + 1} is missing an event type`);
      if (s.requiredCount < 1) errs.push(`Step ${s.id || i + 1} required count must be >= 1`);
      if (s.filterField && !s.filterValue) errs.push(`Step ${s.id || i + 1} has filterField but no filterValue`);
    });
    if (category === "bucket" && requiresOptIn && (!maxConcurrent || parseInt(maxConcurrent, 10) < 1)) {
      errs.push("Bucket opt-in quests require maxConcurrent >= 1");
    }
    return errs;
  }, [id, name, steps, idConflict, category, requiresOptIn, maxConcurrent]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const validationErrors = validate();
    setErrors(validationErrors);
    if (validationErrors.length > 0 || !previewQuest) return;
    onSubmit(previewQuest);
  };

  const addStep = () => setSteps([...steps, { id: `s${steps.length + 1}`, description: "", eventType: "quiz_win", requiredCount: 1 }]);
  const removeStep = (index: number) => setSteps(steps.filter((_, i) => i !== index));
  const updateStep = (index: number, field: keyof QuestEngineStep, value: any) => {
    const next = [...steps];
    next[index] = { ...next[index], [field]: value };
    setSteps(next);
  };

  const rewardParts = previewQuest ? formatRewardSummary(previewQuest.reward) : [];

  return (
    <form onSubmit={handleSubmit} className="space-y-5 rounded-lg border border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">{initial ? "Edit Quest" : "Create Quest"}</h3>
        <button type="button" onClick={() => setShowPreview(!showPreview)} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <Eye className="h-3.5 w-3.5" /> {showPreview ? "Hide Preview" : "Show Preview"}
        </button>
      </div>

      {errors.length > 0 && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 space-y-1">
          <div className="flex items-center gap-2 text-xs font-medium text-destructive">
            <ShieldAlert className="h-3.5 w-3.5" /> Please fix the following:
          </div>
          <ul className="list-disc list-inside text-xs text-destructive/90">
            {errors.map((err, i) => <li key={i}>{err}</li>)}
          </ul>
        </div>
      )}

      {showPreview && previewQuest && (
        <div className="rounded-lg border border-dashed border-primary/30 bg-primary/5 p-4 space-y-2">
          <p className="text-xs font-medium text-primary">Quest Card Preview</p>
          <div className="flex items-start gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <Target className="h-6 w-6 text-primary" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="text-sm font-semibold text-foreground">{previewQuest.name || "Untitled"}</p>
                {previewQuest.category && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground capitalize">{previewQuest.category}</span>
                )}
              </div>
              {previewQuest.description && <p className="text-xs text-muted-foreground line-clamp-1">{previewQuest.description}</p>}
              <div className="mt-1.5 flex flex-wrap gap-1">
                {rewardParts.length > 0 ? rewardParts.map((r, i) => (
                  <span key={i} className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">{r}</span>
                )) : <span className="text-[10px] text-muted-foreground">No reward configured</span>}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Quest ID *</label>
          <input value={id} onChange={(e) => setId(e.target.value)} disabled={!!initial} placeholder="qv_daily_win3"
            className={cn("w-full rounded-md border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50", idConflict ? "border-destructive" : "border-border")} />
          {idConflict && <p className="text-xs text-destructive">A quest with this ID already exists.</p>}
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Display Name *</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Win 3 Matches"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring" />
        </div>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">Description</label>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Win 3 matches in any game mode."
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none" />
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Category</label>
          <select value={category} onChange={(e) => setCategory(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring">
            {CATEGORIES.map((c) => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
          </select>
          <p className="text-[10px] text-muted-foreground">daily/weekly/monthly reset automatically.</p>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Expires At</label>
          <input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring" />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Custom Reset (sec)</label>
          <input value={resetIntervalSec} onChange={(e) => setResetIntervalSec(e.target.value)} placeholder="604800 = weekly"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring" />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Prerequisite Quest IDs</label>
          <input value={prerequisiteIds} onChange={(e) => setPrerequisiteIds(e.target.value)} placeholder="quest_a, quest_b"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring" />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-muted-foreground">Max Concurrent (bucket opt-in)</label>
          <input value={maxConcurrent} onChange={(e) => setMaxConcurrent(e.target.value)} placeholder="3" disabled={category !== "bucket"}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-40" />
        </div>
      </div>

      <div className="flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={repeatable} onChange={(e) => setRepeatable(e.target.checked)} className="rounded border-border" />
          Repeatable
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} className="rounded border-border" />
          Hidden (surprise reward)
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="rounded border-border" />
          Enabled
        </label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={requiresOptIn} onChange={(e) => setRequiresOptIn(e.target.checked)} className="rounded border-border" />
          Requires opt-in
        </label>
      </div>

      {/* Steps */}
      <div className="space-y-3 rounded-lg border border-border bg-background/50 p-3">
        <div className="flex items-center justify-between">
          <label className="text-xs font-semibold text-foreground">Steps *</label>
          <button type="button" onClick={addStep} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
            <Plus className="h-3.5 w-3.5" /> Add Step
          </button>
        </div>
        {steps.map((step, index) => (
          <div key={index} className="grid gap-2 sm:grid-cols-12 items-end rounded-md border border-border bg-background p-2">
            <div className="sm:col-span-2 space-y-1">
              <label className="text-[10px] text-muted-foreground">Step ID *</label>
              <input value={step.id} onChange={(e) => updateStep(index, "id", e.target.value)} placeholder="s1"
                className="w-full rounded border border-border bg-background px-2 py-1 text-xs" />
            </div>
            <div className="sm:col-span-3 space-y-1">
              <label className="text-[10px] text-muted-foreground">Event Type *</label>
              <select value={step.eventType} onChange={(e) => updateStep(index, "eventType", e.target.value)}
                className="w-full rounded border border-border bg-background px-2 py-1 text-xs">
                {EVENT_TYPES.map((et) => <option key={et} value={et}>{et}</option>)}
              </select>
            </div>
            <div className="sm:col-span-2 space-y-1">
              <label className="text-[10px] text-muted-foreground">Required Count *</label>
              <input type="number" min={1} value={step.requiredCount} onChange={(e) => updateStep(index, "requiredCount", parseInt(e.target.value) || 0)}
                className="w-full rounded border border-border bg-background px-2 py-1 text-xs" />
            </div>
            <div className="sm:col-span-2 space-y-1">
              <label className="text-[10px] text-muted-foreground">Filter Field</label>
              <input value={step.filterField || ""} onChange={(e) => updateStep(index, "filterField", e.target.value)} placeholder="topic"
                className="w-full rounded border border-border bg-background px-2 py-1 text-xs" />
            </div>
            <div className="sm:col-span-2 space-y-1">
              <label className="text-[10px] text-muted-foreground">Filter Value</label>
              <input value={step.filterValue || ""} onChange={(e) => updateStep(index, "filterValue", e.target.value)} placeholder="anime"
                className="w-full rounded border border-border bg-background px-2 py-1 text-xs" />
            </div>
            <div className="sm:col-span-1 flex justify-end">
              <button type="button" onClick={() => removeStep(index)} className="p-1.5 rounded hover:bg-accent text-destructive" title="Remove step">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="sm:col-span-12 space-y-1">
              <label className="text-[10px] text-muted-foreground">Description</label>
              <input value={step.description || ""} onChange={(e) => updateStep(index, "description", e.target.value)} placeholder="Win a quiz round"
                className="w-full rounded border border-border bg-background px-2 py-1 text-xs" />
            </div>
          </div>
        ))}
      </div>

      {/* Reward Builder */}
      <div className="space-y-2">
        <label className="text-xs font-semibold text-foreground flex items-center gap-1">
          <Gift className="h-3.5 w-3.5" /> Reward
        </label>
        <RewardBuilder value={reward} onChange={setReward} readOnly={isPending} />
      </div>

      <div className="flex items-center justify-end gap-3 pt-2">
        <button type="button" onClick={onCancel} className="rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-accent">
          Cancel
        </button>
        <button type="submit" disabled={isPending || !id.trim() || !name.trim() || idConflict}
          className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
          {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          {initial ? "Save Changes" : "Create Quest"}
        </button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Page                                                          */
/* ------------------------------------------------------------------ */

export default function QuestEngineConfigPage() {
  const gameScope = useScopedGameId();
  const { data: config, isLoading, error, refetch } = useQuestEngineConfig(gameScope);
  const save = useSaveQuestEngineConfig(gameScope);
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<QuestStatus>("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [showBulkJson, setShowBulkJson] = useState(false);
  const [bulkJson, setBulkJson] = useState("");
  const [bulkError, setBulkError] = useState("");
  const [saveError, setSaveError] = useState("");

  const quests = useMemo(() => {
    if (!config?.quests) return [];
    return Object.entries(config.quests).map(([key, val]) => ({ ...val, id: val.id || key }));
  }, [config]);

  const filteredQuests = useMemo(() => {
    return quests.filter((q) => {
      const matchesSearch = !search || q.id.toLowerCase().includes(search.toLowerCase()) || q.name.toLowerCase().includes(search.toLowerCase());
      const matchesCategory = categoryFilter === "all" || q.category === categoryFilter;
      const status = deriveStatus(q);
      const matchesStatus = statusFilter === "all" || status === statusFilter;
      return matchesSearch && matchesCategory && matchesStatus;
    });
  }, [quests, search, categoryFilter, statusFilter]);

  const existingIds = useMemo(() => quests.map((q) => q.id), [quests]);

  const handleSave = (quest: QuestEngineQuest) => {
    setSaveError("");
    const next: QuestEngineConfig = { quests: {} };
    for (const q of quests) next.quests[q.id] = q;
    next.quests[quest.id] = quest;
    save.mutate(next, {
      onSuccess: () => { setShowForm(false); setEditingId(null); },
      onError: (err: any) => setSaveError(err?.message || "Failed to save quest. Check server validation."),
    });
  };

  const handleDelete = (questId: string) => {
    if (!confirm(`Delete quest "${questId}"? This cannot be undone.`)) return;
    const next: QuestEngineConfig = { quests: {} };
    for (const q of quests) if (q.id !== questId) next.quests[q.id] = q;
    save.mutate(next);
  };

  const handleDuplicate = (q: QuestEngineQuest) => {
    let newId = q.id + "_copy";
    let counter = 2;
    while (existingIds.includes(newId)) { newId = `${q.id}_copy${counter}`; counter++; }
    const copy: QuestEngineQuest = { ...q, id: newId, name: q.name + " (Copy)", enabled: false };
    handleSave(copy);
  };

  const handleBulkImport = () => {
    setBulkError("");
    try {
      const parsed = JSON.parse(bulkJson);
      const incoming = Array.isArray(parsed) ? parsed : Object.values(parsed.quests || parsed);
      const next: QuestEngineConfig = { quests: {} };
      for (const q of quests) next.quests[q.id] = q;
      for (const raw of incoming) {
        const q = raw as QuestEngineQuest;
        if (!q.id || !q.name) throw new Error("Every quest must have id and name");
        next.quests[q.id] = q;
      }
      save.mutate(next, {
        onSuccess: () => { setShowBulkJson(false); setBulkJson(""); },
        onError: (err: any) => setBulkError(err?.message || "Bulk save failed"),
      });
    } catch (e: any) {
      setBulkError(e.message || "Invalid JSON");
    }
  };

  const exportJson = useMemo(() => {
    const obj: Record<string, QuestEngineQuest> = {};
    for (const q of filteredQuests) obj[q.id] = q;
    return JSON.stringify({ quests: obj }, null, 2);
  }, [filteredQuests]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Quest Engine Config</h1>
          <p className="text-sm text-muted-foreground">Manage event-driven quests and rewards for {gameScope || "QuizVerse"}.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => { setEditingId(null); setShowForm(!showForm); }} className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            <Plus className="h-4 w-4" /> {showForm ? "Close" : "Create Quest"}
          </button>
          <button onClick={() => setShowBulkJson(!showBulkJson)} className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-accent">
            <FileJson className="h-4 w-4" /> Bulk JSON
          </button>
          <button onClick={() => refetch()} disabled={isLoading} className="rounded-md border border-border p-2 text-muted-foreground hover:bg-accent">
            <RefreshCw className={cn("h-4 w-4", isLoading && "animate-spin")} />
          </button>
        </div>
      </div>

      {saveError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{saveError}</div>
      )}

      {showForm && (
        <QuestForm
          initial={editingId ? quests.find((q) => q.id === editingId) : undefined}
          onSubmit={handleSave}
          onCancel={() => { setShowForm(false); setEditingId(null); }}
          isPending={save.isPending}
          existingIds={existingIds}
        />
      )}

      {showBulkJson && (
        <div className="space-y-3 rounded-lg border border-border bg-card p-5">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">Bulk JSON Import / Export</h3>
            <div className="flex items-center gap-2">
              <button onClick={() => { const blob = new Blob([exportJson], { type: "application/json" }); const url = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = url; a.download = `quest-engine-${gameScope || "global"}.json`; a.click(); URL.revokeObjectURL(url); }}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                <Download className="h-3.5 w-3.5" /> Export filtered
              </button>
            </div>
          </div>
          {bulkError && <p className="text-xs text-destructive">{bulkError}</p>}
          <textarea value={bulkJson} onChange={(e) => setBulkJson(e.target.value)} rows={10} placeholder='{"quests":{"qv_daily_win3":{...}}}'
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-xs font-mono text-foreground focus:outline-none focus:ring-2 focus:ring-ring resize-none" />
          <div className="flex items-center justify-end gap-2">
            <button onClick={() => { setShowBulkJson(false); setBulkJson(""); setBulkError(""); }} className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent">Cancel</button>
            <button onClick={handleBulkImport} disabled={save.isPending} className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
              <Upload className="h-3.5 w-3.5" /> Import & Save
            </button>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search quests..."
            className="w-full rounded-md border border-border bg-background py-2 pl-9 pr-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring" />
        </div>
        <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}
          className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground">
          <option value="all">All Categories</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as QuestStatus)}
          className="rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground">
          <option value="all">All Statuses</option>
          <option value="active">Active</option>
          <option value="disabled">Disabled</option>
          <option value="expired">Expired</option>
        </select>
      </div>

      {/* Quest List */}
      {isLoading ? (
        <div className="flex h-64 items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
      ) : error ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">Failed to load quest config.</div>
      ) : filteredQuests.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">No quests match your filters.</div>
      ) : (
        <div className="space-y-3">
          {filteredQuests.map((q) => {
            const status = deriveStatus(q);
            const rewards = formatRewardSummary(q.reward);
            return (
              <div key={q.id} className="rounded-lg border border-border bg-card p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium", statusBg(status))}>
                        <StatusIcon status={status} /> {status}
                      </span>
                      {q.category && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground capitalize">{q.category}</span>}
                      {q.hidden && <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] font-medium text-violet-400">Hidden</span>}
                      {q.repeatable && <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-[10px] font-medium text-sky-400"><Repeat className="h-3 w-3 inline mr-0.5" />Repeatable</span>}
                      {q.requiresOptIn && <span className="rounded-full bg-fuchsia-500/10 px-2 py-0.5 text-[10px] font-medium text-fuchsia-400">Opt-in</span>}
                    </div>
                    <h3 className="mt-2 text-sm font-semibold text-foreground">{q.name}</h3>
                    <p className="text-xs text-muted-foreground font-mono">{q.id}</p>
                    {q.description && <p className="mt-1 text-xs text-muted-foreground">{q.description}</p>}
                    <div className="mt-2 flex flex-wrap gap-1">
                      {rewards.length > 0 ? rewards.map((r, i) => (
                        <span key={i} className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">{r}</span>
                      )) : <span className="text-[10px] text-muted-foreground">No reward</span>}
                    </div>
                    {q.expiresAt ? <p className="mt-1 text-[10px] text-muted-foreground">Expires: {formatTs(q.expiresAt)}</p> : null}
                    {q.prerequisiteIds?.length ? <p className="mt-1 text-[10px] text-muted-foreground">Requires: {q.prerequisiteIds.join(", ")}</p> : null}
                  </div>
                  <div className="flex items-center gap-1">
                    <button onClick={() => handleDuplicate(q)} className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" title="Duplicate">
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                    <button onClick={() => { setEditingId(q.id); setShowForm(true); window.scrollTo({ top: 0, behavior: "smooth" }); }} className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" title="Edit">
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button onClick={() => handleDelete(q.id)} className="rounded p-1.5 text-destructive hover:bg-destructive/10" title="Delete">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
