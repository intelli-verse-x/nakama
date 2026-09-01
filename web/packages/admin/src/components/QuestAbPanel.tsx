import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  FlaskConical,
  Loader2,
  Pause,
  Play,
  Trophy,
  Undo2,
  X,
} from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  serverKeyAuth,
  satori,
  type Audience,
  type Experiment,
  type ExperimentResults,
  type ExperimentVariantResult,
  type QuestEngineQuest,
} from "@nakama/shared";
import { cn } from "@/lib/utils";
import { RewardBuilder, type RewardBuilderReward } from "@/components/RewardBuilder";

type Recipe = "reward" | "vs";
type LaunchStage = "draft" | "qa" | "live";
type SplitPreset = "50" | "90" | "custom";

export function variantOverlay(variant: Experiment["variants"][number] | undefined): Record<string, unknown> {
  if (!variant) return {};
  const raw = (variant.config || variant.data || {}) as Record<string, unknown>;
  return raw && typeof raw === "object" ? raw : {};
}

export function overlayQuestIds(exp: Experiment): string[] {
  const ids = new Set<string>();
  for (const variant of exp.variants || []) {
    const overlay = variantOverlay(variant);
    const quests = overlay.quests as Record<string, unknown> | undefined;
    if (quests && typeof quests === "object") {
      for (const id of Object.keys(quests)) ids.add(id);
    }
  }
  for (const id of exp.trackedQuestIds || []) ids.add(id);
  return Array.from(ids);
}

export function questAbBadgeLabel(questId: string, experiments: Experiment[]): string | null {
  const running = experiments.find(
    (exp) =>
      exp.configSystem === "quest_engine" &&
      (exp.status === "running" || exp.enabled) &&
      exp.status !== "ended" &&
      exp.status !== "draft" &&
      overlayQuestIds(exp).includes(questId),
  );
  if (!running) return null;
  const test = (running.variants || []).find((v) => v.name !== "control") || running.variants?.[1];
  const overlay = variantOverlay(test);
  const quests = (overlay.quests || {}) as Record<string, { reward?: { guaranteed?: { currencies?: Record<string, number> } }; hidden?: boolean }>;
  const patch = quests[questId];
  const weight = test?.weight ?? 50;
  const currencies = patch?.reward?.guaranteed?.currencies;
  if (currencies && Object.keys(currencies).length > 0) {
    const prize = Object.entries(currencies).map(([k, v]) => `${v} ${k}`).join(", ");
    return `A/B ${weight}% · ${prize}`;
  }
  const other = overlayQuestIds(running).find((id) => id !== questId);
  return other ? `vs ${other}` : `A/B ${weight}%`;
}

function lifecycle(exp: Experiment): "draft" | "qa" | "live" | "ended" {
  if (exp.status === "ended") return "ended";
  if (exp.status === "draft" || exp.enabled === false) return "draft";
  if ((exp.audiences || []).length > 0) return "qa";
  return "live";
}

function rewardFromQuest(quest: QuestEngineQuest | undefined): RewardBuilderReward {
  const guaranteed = quest?.reward?.guaranteed;
  if (!guaranteed) return { currencies: { game: 100 } };
  return {
    currencies: guaranteed.currencies,
    items: guaranteed.items,
    energies: guaranteed.energies,
    xp: guaranteed.xp,
    gifts: guaranteed.gifts,
    energyModifiers: guaranteed.energyModifiers,
    rewardModifiers: guaranteed.rewardModifiers,
  };
}

function rewardToGuaranteed(reward: RewardBuilderReward): { guaranteed: Record<string, unknown> } | null {
  const guaranteed: Record<string, unknown> = {};
  if (reward.currencies && Object.keys(reward.currencies).length > 0) guaranteed.currencies = reward.currencies;
  if (reward.items && Object.keys(reward.items).length > 0) guaranteed.items = reward.items;
  if (reward.energies && Object.keys(reward.energies).length > 0) guaranteed.energies = reward.energies;
  if (reward.xp) guaranteed.xp = reward.xp;
  if (reward.gifts && reward.gifts.length > 0) guaranteed.gifts = reward.gifts;
  if (reward.energyModifiers && reward.energyModifiers.length > 0) guaranteed.energyModifiers = reward.energyModifiers;
  if (reward.rewardModifiers && reward.rewardModifiers.length > 0) guaranteed.rewardModifiers = reward.rewardModifiers;
  if (Object.keys(guaranteed).length === 0) return null;
  return { guaranteed };
}

function throwIfRpcFailed(value: unknown, fallback: string): void {
  if (value && typeof value === "object" && "success" in value) {
    const envelope = value as { success: boolean; error?: string };
    if (envelope.success === false) throw new Error(envelope.error || fallback);
  }
}

function rateLabel(num: number, den: number): string {
  if (!den) return "—";
  return ((num / den) * 100).toFixed(1) + "%";
}

function funnelCounts(
  variant: ExperimentVariantResult,
  funnel?: ExperimentResults["funnel"],
): { assigned: number; exposed: number; started: number; completed: number; claimed: number } {
  const id = variant.id;
  return {
    assigned: variant.assigned ?? funnel?.assigned?.[id] ?? 0,
    exposed: variant.exposed ?? funnel?.exposed?.[id] ?? variant.exposures ?? 0,
    started: variant.started ?? funnel?.started?.[id] ?? 0,
    completed: variant.completed ?? funnel?.completed?.[id] ?? variant.conversions ?? 0,
    claimed: variant.claimed ?? funnel?.claimed?.[id] ?? 0,
  };
}

function sparklineRows(
  byDay: ExperimentResults["byDay"],
): { day: string; assigned: number; completed: number }[] {
  const days = Object.keys(byDay || {}).sort().slice(-60);
  return days.map((day) => {
    const bucket = byDay![day];
    const assigned = Object.values(bucket.assigned || {}).reduce((sum, n) => sum + (n || 0), 0);
    const completed = Object.values(bucket.completed || {}).reduce((sum, n) => sum + (n || 0), 0);
    return { day: day.slice(5), assigned, completed };
  });
}

function slugId(recipe: Recipe, questId: string): string {
  const raw = `qe_${recipe}_${questId}_${Date.now().toString(36)}`;
  return raw.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 64);
}

export function QuestAbPanel({
  gameId,
  quests,
  seedQuestId,
  onSeedHandled,
}: {
  gameId: string;
  quests: QuestEngineQuest[];
  seedQuestId?: string | null;
  onSeedHandled?: () => void;
}) {
  const qc = useQueryClient();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [recipe, setRecipe] = useState<Recipe>("reward");
  const [questA, setQuestA] = useState("");
  const [questB, setQuestB] = useState("");
  const [testReward, setTestReward] = useState<RewardBuilderReward>({ currencies: { game: 200 } });
  const [splitPreset, setSplitPreset] = useState<SplitPreset>("50");
  const [customTestWeight, setCustomTestWeight] = useState("50");
  const [stage, setStage] = useState<LaunchStage>("draft");
  const [audienceId, setAudienceId] = useState("");
  const [error, setError] = useState("");
  const [resultsFor, setResultsFor] = useState<Experiment | null>(null);

  const experimentsQuery = useQuery({
    queryKey: ["satori", "experiments", gameId],
    queryFn: () => satori.getAllExperiments(serverKeyAuth(), gameId),
    select: (d: { experiments?: Experiment[] }) =>
      (d.experiments ?? []).filter((exp) => exp.configSystem === "quest_engine"),
    staleTime: 15_000,
  });

  const audiencesQuery = useQuery({
    queryKey: ["satori", "audiences", gameId],
    queryFn: () => satori.listAudiences(serverKeyAuth(), gameId),
    select: (d: { audiences?: Audience[] } | Audience[]) =>
      Array.isArray(d) ? d : (d.audiences ?? []),
    staleTime: 60_000,
  });

  const setup = useMutation({
    mutationFn: async (params: Parameters<typeof satori.setupExperiment>[0]) => {
      const value = await satori.setupExperiment(params, serverKeyAuth());
      throwIfRpcFailed(value, "Failed to save A/B test");
      return value;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["satori", "experiments", gameId] }),
  });

  const experiments = experimentsQuery.data ?? [];
  const running = experiments.find((exp) => lifecycle(exp) === "qa" || lifecycle(exp) === "live");

  useEffect(() => {
    if (!seedQuestId) return;
    setQuestA(seedQuestId);
    setRecipe("reward");
    const found = quests.find((q) => q.id === seedQuestId);
    setTestReward(rewardFromQuest(found));
    setDrawerOpen(true);
    onSeedHandled?.();
  }, [seedQuestId, quests, onSeedHandled]);

  const testWeight = useMemo(() => {
    if (splitPreset === "90") return 10;
    if (splitPreset === "custom") {
      const n = parseInt(customTestWeight, 10);
      return Number.isFinite(n) ? Math.min(99, Math.max(1, n)) : 50;
    }
    return 50;
  }, [splitPreset, customTestWeight]);

  const openNew = useCallback((questId?: string) => {
    setError("");
    setRecipe("reward");
    setQuestA(questId || quests[0]?.id || "");
    setQuestB("");
    setTestReward(rewardFromQuest(quests.find((q) => q.id === (questId || quests[0]?.id))));
    setSplitPreset("50");
    setStage("draft");
    setAudienceId("");
    setDrawerOpen(true);
  }, [quests]);

  const saveTest = useCallback(async () => {
    setError("");
    if (!questA) {
      setError("Pick a quest first.");
      return;
    }
    if (running && lifecycle(running) !== "draft") {
      setError(`This game already has a running test (${running.id}). Pause or end it first.`);
      return;
    }
    if (stage === "qa" && !audienceId) {
      setError("QA launch needs an audience. Live is everyone.");
      return;
    }

    let controlConfig: Record<string, unknown> = {};
    let testConfig: Record<string, unknown> = {};
    let tracked: string[] = [questA];
    let name = "";

    if (recipe === "reward") {
      const guaranteed = rewardToGuaranteed(testReward);
      if (!guaranteed) {
        setError("Test prize needs at least one currency, item, or XP.");
        return;
      }
      testConfig = { quests: { [questA]: { reward: guaranteed } } };
      name = `Prize test · ${questA}`;
    } else {
      if (!questB) {
        setError("Save the other quest first, then pick it here.");
        return;
      }
      if (questB === questA) {
        setError("Pick two different quests.");
        return;
      }
      if (!quests.some((q) => q.id === questB)) {
        setError("Save the other quest first.");
        return;
      }
      controlConfig = { quests: { [questB]: { hidden: true } } };
      testConfig = { quests: { [questA]: { hidden: true } } };
      tracked = [questA, questB];
      name = `${questA} vs ${questB}`;
    }

    const status = stage === "draft" ? "draft" : "running";
    const audiences = stage === "qa" && audienceId ? [audienceId] : [];
    try {
      await setup.mutateAsync({
        id: slugId(recipe, questA),
        name,
        variants_json: JSON.stringify([
          { name: "control", weight: 100 - testWeight, config: controlConfig, data: controlConfig },
          { name: "test", weight: testWeight, config: testConfig, data: testConfig },
        ]),
        enabled: status === "running",
        status,
        audiences_json: audiences.length ? JSON.stringify(audiences) : undefined,
        audienceId: audiences[0],
        game_id: gameId,
        configSystem: "quest_engine",
        goalMetric: "quest_completed",
        trackedQuestIds: tracked,
        minSamplePerArm: stage === "live" ? 100 : 30,
      });
      setDrawerOpen(false);
    } catch (e) {
      setError((e as Error).message || "Failed to save A/B test");
    }
  }, [questA, questB, recipe, testReward, running, stage, audienceId, testWeight, quests, setup, gameId]);

  const patchStatus = useCallback(async (exp: Experiment, next: { status: string; audiences?: string[] }) => {
    setError("");
    try {
      await setup.mutateAsync({
        id: exp.id,
        name: exp.name,
        variants_json: JSON.stringify(exp.variants ?? []),
        enabled: next.status === "running",
        status: next.status,
        audiences_json: next.audiences?.length ? JSON.stringify(next.audiences) : undefined,
        audienceId: next.audiences?.[0],
        game_id: gameId,
        configSystem: "quest_engine",
        goalMetric: exp.goalMetric || "quest_completed",
        trackedQuestIds: exp.trackedQuestIds,
        minSamplePerArm: exp.minSamplePerArm,
      });
    } catch (e) {
      setError((e as Error).message || "Failed to update test");
    }
  }, [setup, gameId]);

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="inline-flex items-center gap-1.5 text-sm font-medium text-foreground">
            <FlaskConical className="h-4 w-4 text-primary" />
            A/B tests for this game
          </p>
          <p className="text-xs text-muted-foreground">
            Same quest list, sticker only. Two recipes: new prize, or this quest vs that quest.
            Pause can take up to 1 minute to reach every server.
          </p>
        </div>
        <button
          type="button"
          onClick={() => openNew()}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          New A/B
        </button>
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}

      {experimentsQuery.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading tests…</p>
      ) : experiments.length === 0 ? (
        <p className="text-xs text-muted-foreground">No quest A/B tests on this game yet.</p>
      ) : (
        <ul className="space-y-2">
          {experiments.map((exp) => {
            const life = lifecycle(exp);
            return (
              <li key={exp.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-xs">
                <span className={cn(
                  "rounded-full px-2 py-0.5 font-medium capitalize",
                  life === "live" && "bg-emerald-500/10 text-emerald-400",
                  life === "qa" && "bg-amber-500/10 text-amber-400",
                  life === "draft" && "bg-muted text-muted-foreground",
                  life === "ended" && "bg-zinc-500/10 text-zinc-400",
                )}>
                  {life}
                </span>
                <span className="font-medium text-foreground">{exp.name}</span>
                <code className="font-mono text-muted-foreground">{exp.id}</code>
                <span className="ml-auto flex flex-wrap gap-1">
                  {life === "live" || life === "qa" ? (
                    <button
                      type="button"
                      className="rounded border border-border px-2 py-1 hover:bg-accent"
                      title="Pause can take up to 1 minute to reach every server (config cache)."
                      onClick={() => patchStatus(exp, { status: "draft" })}
                    >
                      <Pause className="mr-1 inline h-3 w-3" />Pause
                    </button>
                  ) : null}
                  {life === "draft" ? (
                    <button type="button" className="rounded border border-border px-2 py-1 hover:bg-accent" onClick={() => patchStatus(exp, { status: "running", audiences: exp.audiences })}>
                      <Play className="mr-1 inline h-3 w-3" />Resume
                    </button>
                  ) : null}
                  {life !== "ended" ? (
                    <button type="button" className="rounded border border-border px-2 py-1 hover:bg-accent" onClick={() => setResultsFor(exp)}>
                      See results
                    </button>
                  ) : (
                    <button type="button" className="rounded border border-border px-2 py-1 hover:bg-accent" onClick={() => setResultsFor(exp)}>
                      Results
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {drawerOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
          <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-lg border border-border bg-card p-5 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">New quest A/B</h3>
              <button type="button" onClick={() => setDrawerOpen(false)} className="rounded p-1 text-muted-foreground hover:bg-accent">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="mb-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setRecipe("reward")}
                className={cn("rounded-md border px-3 py-2 text-left text-xs", recipe === "reward" ? "border-primary bg-primary/10" : "border-border")}
              >
                Same quest, different prize
              </button>
              <button
                type="button"
                onClick={() => setRecipe("vs")}
                className={cn("rounded-md border px-3 py-2 text-left text-xs", recipe === "vs" ? "border-primary bg-primary/10" : "border-border")}
              >
                This quest vs that quest
              </button>
            </div>

            <label className="mb-3 block text-xs font-medium text-muted-foreground">
              Quest A
              <select
                value={questA}
                onChange={(e) => {
                  setQuestA(e.target.value);
                  setTestReward(rewardFromQuest(quests.find((q) => q.id === e.target.value)));
                }}
                className="mt-1 w-full rounded-md border border-border bg-background px-2 py-2 text-sm text-foreground"
              >
                <option value="">Pick a saved quest</option>
                {quests.map((q) => (
                  <option key={q.id} value={q.id}>{q.name} ({q.id})</option>
                ))}
              </select>
            </label>

            {recipe === "reward" ? (
              <div className="mb-3">
                <p className="mb-2 text-xs text-muted-foreground">Control keeps the jar prize. Test gets this sticker:</p>
                <RewardBuilder value={testReward} onChange={setTestReward} />
              </div>
            ) : (
              <label className="mb-3 block text-xs font-medium text-muted-foreground">
                Quest B (already saved)
                <select
                  value={questB}
                  onChange={(e) => setQuestB(e.target.value)}
                  className="mt-1 w-full rounded-md border border-border bg-background px-2 py-2 text-sm text-foreground"
                >
                  <option value="">Save the other quest first</option>
                  {quests.filter((q) => q.id !== questA).map((q) => (
                    <option key={q.id} value={q.id}>{q.name} ({q.id})</option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-muted-foreground">Control hides B. Test hides A. Players never see both.</p>
              </label>
            )}

            <div className="mb-3 flex flex-wrap gap-2 text-xs">
              {(["50", "90", "custom"] as SplitPreset[]).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setSplitPreset(p)}
                  className={cn("rounded border px-2 py-1", splitPreset === p ? "border-primary bg-primary/10" : "border-border")}
                >
                  {p === "50" ? "50 / 50" : p === "90" ? "90 / 10" : "Custom"}
                </button>
              ))}
              {splitPreset === "custom" ? (
                <input
                  value={customTestWeight}
                  onChange={(e) => setCustomTestWeight(e.target.value)}
                  className="w-16 rounded border border-border bg-background px-2 py-1"
                  aria-label="Test weight percent"
                />
              ) : null}
            </div>

            <div className="mb-3 flex flex-wrap gap-2 text-xs">
              {(["draft", "qa", "live"] as LaunchStage[]).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStage(s)}
                  className={cn("rounded border px-2 py-1 capitalize", stage === s ? "border-primary bg-primary/10" : "border-border")}
                >
                  {s === "qa" ? "QA audience" : s}
                </button>
              ))}
            </div>

            {stage === "qa" ? (
              <label className="mb-3 block text-xs font-medium text-muted-foreground">
                Audience
                <select
                  value={audienceId}
                  onChange={(e) => setAudienceId(e.target.value)}
                  className="mt-1 w-full rounded-md border border-border bg-background px-2 py-2 text-sm text-foreground"
                >
                  <option value="">Pick a QA audience</option>
                  {(audiencesQuery.data ?? []).map((a) => (
                    <option key={a.id} value={a.id}>{a.name || a.id}</option>
                  ))}
                </select>
              </label>
            ) : null}

            {error ? <p className="mb-2 text-xs text-destructive">{error}</p> : null}

            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setDrawerOpen(false)} className="rounded-md border border-border px-3 py-2 text-sm">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => { void saveTest(); }}
                disabled={setup.isPending || quests.length === 0}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {setup.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Save test
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {resultsFor ? (
        <QuestAbResultsCard
          experiment={resultsFor}
          gameId={gameId}
          onClose={() => setResultsFor(null)}
        />
      ) : null}
    </div>
  );
}

function QuestAbResultsCard({
  experiment,
  gameId,
  onClose,
}: {
  experiment: Experiment;
  gameId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<"promote" | "kill" | "undo" | null>(null);
  const results = useQuery({
    queryKey: ["satori", "experiment-results", gameId, experiment.id],
    queryFn: () => satori.getExperimentResults({ experimentId: experiment.id, game_id: gameId }, serverKeyAuth()),
  });

  const promote = useMutation({
    mutationFn: async (variantId: string) => {
      const value = await satori.declareExperimentWinner(
        { experimentId: experiment.id, variantId, game_id: gameId, promote: true },
        serverKeyAuth(),
      );
      throwIfRpcFailed(value, "Promote failed");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["satori", "experiments", gameId] });
      qc.invalidateQueries({ queryKey: ["satori", "experiment-results", gameId, experiment.id] });
      qc.invalidateQueries({ queryKey: ["questEngine", "config", gameId] });
      setConfirm(null);
    },
  });

  const kill = useMutation({
    mutationFn: async () => {
      const variantId = experiment.variants?.[0]?.name || "control";
      const value = await satori.declareExperimentWinner(
        { experimentId: experiment.id, variantId, game_id: gameId, promote: false },
        serverKeyAuth(),
      );
      throwIfRpcFailed(value, "Kill failed");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["satori", "experiments", gameId] });
      setConfirm(null);
      onClose();
    },
  });

  const undo = useMutation({
    mutationFn: async () => {
      const fromResults = results.data?.promotion?.auditKey;
      const auditKey = fromResults || experiment.promotion?.auditKey;
      const value = await satori.undoExperimentPromote(
        {
          experimentId: experiment.id,
          game_id: gameId,
          ...(auditKey ? { auditKey } : {}),
        },
        serverKeyAuth(),
      );
      throwIfRpcFailed(value, "Undo failed");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["satori", "experiments", gameId] });
      qc.invalidateQueries({ queryKey: ["satori", "experiment-results", gameId, experiment.id] });
      qc.invalidateQueries({ queryKey: ["questEngine", "config", gameId] });
      setConfirm(null);
    },
  });

  const data = results.data;
  const chart = sparklineRows(data?.byDay);
  const truncated = !!(data?.scan?.assignmentsTruncated || data?.scan?.eventsTruncated);
  const promo = data?.promotion || experiment.promotion;
  const canPromote = !!(data && data.minSample?.met !== false && data.srm?.passed !== false && data.suggestedWinner);
  const winner = data?.suggestedWinner || data?.winnerVariantId;
  const canUndo = !!(data?.winnerVariantId && promo?.auditKey && !promo?.restored);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-lg border border-border bg-card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-foreground">Results · {experiment.name}</h3>
          <button type="button" onClick={onClose} className="rounded p-1 text-muted-foreground hover:bg-accent">
            <X className="h-4 w-4" />
          </button>
        </div>
        {results.isLoading ? <p className="text-xs text-muted-foreground">Loading…</p> : null}
        {results.isError ? <p className="text-xs text-destructive">{(results.error as Error).message}</p> : null}
        {data ? (
          <div className="space-y-3 text-xs">
            <p className="text-muted-foreground">{data.recommendation}</p>

            {data.srm ? (
              <p className={cn("text-muted-foreground", data.srm.passed === false && "text-rose-500")}>
                Split check (SRM):{" "}
                {data.srm.skipped
                  ? "not enough traffic yet to judge the split"
                  : data.srm.passed
                    ? "fair — observed mix matches the planned weights"
                    : "lopsided — do not promote"}
                {typeof data.srm.pValue === "number" && !data.srm.skipped
                  ? " (p=" + data.srm.pValue.toExponential(2) + ")"
                  : ""}
                .
              </p>
            ) : null}

            {data.minSample ? (
              <p className="text-muted-foreground">
                Sample: {data.minSample.perArm} per variant (
                {data.minSample.mode === "qa" ? "QA" : data.minSample.mode === "live" ? "live" : "custom"}
                ) — {data.minSample.met ? "enough to recommend a winner" : "not enough yet"}
                {!data.minSample.met && data.minSample.shortVariants.length > 0
                  ? ". Short: " + data.minSample.shortVariants.join(", ")
                  : ""}
                .
              </p>
            ) : null}

            <div className="overflow-x-auto">
              <table className="w-full min-w-[36rem] text-left">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="py-1 pr-2">Variant</th>
                    <th className="py-1 pr-2">Assigned</th>
                    <th className="py-1 pr-2">Exposed</th>
                    <th className="py-1 pr-2">Started</th>
                    <th className="py-1 pr-2">Completed</th>
                    <th className="py-1 pr-2">Claimed</th>
                    <th className="py-1">Lift vs control</th>
                  </tr>
                </thead>
                <tbody>
                  {data.variants.map((v) => {
                    const funnel = funnelCounts(v, data.funnel);
                    const cmp = data.comparisons.find((c) => c.variantId === v.id);
                    return (
                      <tr key={v.id} className="border-t border-border align-top">
                        <td className="py-1.5 pr-2 font-medium">
                          {v.name}
                          {v.isControl ? (
                            <span className="ml-1 text-[10px] uppercase text-blue-500">control</span>
                          ) : null}
                        </td>
                        <td className="py-1.5 pr-2 font-mono">{funnel.assigned.toLocaleString()}</td>
                        <td className="py-1.5 pr-2 font-mono">{funnel.exposed.toLocaleString()}</td>
                        <td className="py-1.5 pr-2 font-mono">{funnel.started.toLocaleString()}</td>
                        <td className="py-1.5 pr-2 font-mono">{funnel.completed.toLocaleString()}</td>
                        <td className="py-1.5 pr-2 font-mono">{funnel.claimed.toLocaleString()}</td>
                        <td className="py-1.5">
                          {cmp && cmp.pValue !== null ? (
                            <span className={cn(cmp.lift > 0 ? "text-emerald-500" : "text-rose-500")}>
                              {cmp.lift > 0 ? "+" : ""}
                              {(cmp.lift * 100).toFixed(1)}%
                              {cmp.pValue !== null ? " p=" + cmp.pValue.toExponential(2) : ""}
                            </span>
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="space-y-1 text-muted-foreground">
              {data.variants.map((v) => {
                const funnel = funnelCounts(v, data.funnel);
                return (
                  <p key={v.id + "-rates"}>
                    {v.name} step rates:{" "}
                    {rateLabel(funnel.exposed, funnel.assigned)} exposed/assigned ·{" "}
                    {rateLabel(funnel.started, funnel.exposed)} started/exposed ·{" "}
                    {rateLabel(funnel.completed, funnel.started)} completed/started ·{" "}
                    {rateLabel(funnel.claimed, funnel.completed)} claimed/completed
                  </p>
                );
              })}
            </div>

            {chart.length > 0 ? (
              <div>
                <p className="mb-1 text-muted-foreground">Daily assigned + completed (UTC, last 60 days)</p>
                <div className="h-32">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chart} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="day" tick={{ fontSize: 10 }} />
                      <YAxis allowDecimals={false} tick={{ fontSize: 10 }} width={28} />
                      <Tooltip />
                      <Line type="monotone" dataKey="assigned" stroke="#94a3b8" dot={false} strokeWidth={1.5} />
                      <Line type="monotone" dataKey="completed" stroke="hsl(var(--primary))" dot={false} strokeWidth={1.5} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>
            ) : (
              <p className="text-muted-foreground">No daily sparkline yet — wait for assigned or completed events.</p>
            )}

            {truncated ? (
              <p className="inline-flex items-center gap-1 text-amber-500">
                <AlertTriangle className="h-3.5 w-3.5" />
                Scan truncated — figures are a lower-bound estimate
                {data.scan.assignmentsTruncated ? " (assignmentsTruncated)" : ""}
                {data.scan.eventsTruncated ? " (eventsTruncated)" : ""}.
              </p>
            ) : null}

            <p className="text-muted-foreground">
              Promote writes the winning sticker onto the real quest list.
            </p>
            <p className="text-muted-foreground">
              Pause can take up to 1 minute to reach every server (config cache). It is not instant.
            </p>
            {promo?.restored ? (
              <p className="text-amber-600 dark:text-amber-400">Old quest list restored. The test stays ended.</p>
            ) : null}

            {confirm === "promote" && winner ? (
              <div className="rounded-md border border-border bg-muted/40 p-3">
                <p>This writes the winning sticker onto the real quest list, then ends the test.</p>
                <div className="mt-2 flex justify-end gap-2">
                  <button type="button" className="rounded-md border border-border px-3 py-1.5" onClick={() => setConfirm(null)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground"
                    onClick={() => promote.mutate(winner)}
                  >
                    Write winner
                  </button>
                </div>
              </div>
            ) : null}
            {confirm === "kill" ? (
              <div className="rounded-md border border-border bg-muted/40 p-3">
                <p>End the test without writing a sticker onto the live quest list.</p>
                <div className="mt-2 flex justify-end gap-2">
                  <button type="button" className="rounded-md border border-border px-3 py-1.5" onClick={() => setConfirm(null)}>
                    Cancel
                  </button>
                  <button type="button" className="rounded-md border border-destructive px-3 py-1.5 text-destructive" onClick={() => kill.mutate()}>
                    Kill (no promote)
                  </button>
                </div>
              </div>
            ) : null}
            {confirm === "undo" ? (
              <div className="rounded-md border border-border bg-muted/40 p-3">
                <p>Put the old quest list back. The test stays ended.</p>
                <div className="mt-2 flex justify-end gap-2">
                  <button type="button" className="rounded-md border border-border px-3 py-1.5" onClick={() => setConfirm(null)}>
                    Cancel
                  </button>
                  <button type="button" className="rounded-md border border-amber-500/50 px-3 py-1.5" onClick={() => undo.mutate()}>
                    Undo — put old quest list back
                  </button>
                </div>
              </div>
            ) : null}

            <div className="flex flex-wrap justify-end gap-2">
              {canUndo ? (
                <button
                  type="button"
                  onClick={() => setConfirm("undo")}
                  disabled={undo.isPending}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2"
                >
                  {undo.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />}
                  Undo — put old quest list back
                </button>
              ) : null}
              {experiment.status !== "ended" ? (
                <button
                  type="button"
                  onClick={() => setConfirm("kill")}
                  disabled={kill.isPending}
                  className="rounded-md border border-border px-3 py-2"
                >
                  Kill (no promote)
                </button>
              ) : null}
              <button
                type="button"
                disabled={!canPromote || promote.isPending || experiment.status === "ended"}
                onClick={() => winner && setConfirm("promote")}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 font-medium text-primary-foreground disabled:opacity-50"
                title={!canPromote ? "Need sample + SRM pass" : undefined}
              >
                <Trophy className="h-3.5 w-3.5" />
                Promote winner
              </button>
            </div>
            {promote.error ? <p className="text-destructive">{(promote.error as Error).message}</p> : null}
            {kill.error ? <p className="text-destructive">{(kill.error as Error).message}</p> : null}
            {undo.error ? <p className="text-destructive">{(undo.error as Error).message}</p> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
