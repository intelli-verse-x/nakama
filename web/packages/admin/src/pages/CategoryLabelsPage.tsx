// CategoryLabelsPage — manage Satori category labels.
//
// Mirrors Heroic Labs Satori › Settings › Category labels:
//   • Define labels (name, color, description) used to organize live events,
//     feature flags, experiments, audiences, messages, and funnels.
//   • Apply / remove a label across entity types.
//
// Wired to: satori_category_labels_list / _upsert / _delete / _assign / _unassign

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Tags,
  Plus,
  Trash2,
  RefreshCw,
  Loader2,
  AlertTriangle,
  Edit3,
} from "lucide-react";
import { callRpc, serverKeyAuth } from "@nakama/shared";
import { cn } from "@/lib/utils";

interface CategoryLabel {
  id: string;
  name: string;
  description?: string;
  color?: string;
  createdAt?: number;
  updatedAt?: number;
}

const COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4",
  "#3b82f6", "#6366f1", "#a855f7", "#ec4899", "#64748b",
];

const ENTITY_TYPES = ["live_event", "flag", "experiment", "audience", "message"] as const;

function unwrap<T>(v: unknown): T {
  if (v && typeof v === "object" && "success" in v && "data" in v) return (v as { data: T }).data;
  return v as T;
}

function useLabels() {
  return useQuery({
    queryKey: ["satori", "category-labels"],
    queryFn: () =>
      callRpc("satori_category_labels_list", {}, serverKeyAuth()).then((v) =>
        unwrap<{ labels?: CategoryLabel[] }>(v),
      ),
    select: (d) => d.labels ?? [],
    staleTime: 30_000,
  });
}

function useUpsertLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (l: Partial<CategoryLabel> & { id: string; name: string }) =>
      callRpc("satori_category_labels_upsert", l as unknown as Record<string, unknown>, serverKeyAuth()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["satori", "category-labels"] }),
  });
}

function useDeleteLabel() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      callRpc("satori_category_labels_delete", { id }, serverKeyAuth()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["satori", "category-labels"] }),
  });
}

function useAssignLabel() {
  return useMutation({
    mutationFn: (a: { label_id: string; entity_type: string; entity_id: string }) =>
      // Backend payload contract: { target, entityId, labelIds[] }.
      callRpc(
        "satori_category_labels_assign",
        { target: a.entity_type, entityId: a.entity_id, labelIds: [a.label_id] },
        serverKeyAuth(),
      ),
  });
}

function LabelForm({ initial, onSubmit, onCancel, isPending }: {
  initial?: CategoryLabel;
  onSubmit: (l: Partial<CategoryLabel> & { id: string; name: string }) => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  const [id, setId] = useState(initial?.id ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [color, setColor] = useState(initial?.color ?? COLORS[5]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!id || !name) return;
        onSubmit({ id, name, description: description || undefined, color });
      }}
      className="space-y-3 rounded-md border border-border bg-card p-4"
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">ID *</label>
          <input
            value={id}
            disabled={!!initial}
            onChange={(e) => setId(e.target.value.replace(/[^a-z0-9_-]/gi, "_").toLowerCase())}
            className="h-8 w-full rounded border border-border bg-background px-2 font-mono text-xs"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Name *</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="h-8 w-full rounded border border-border bg-background px-2 text-xs"
          />
        </div>
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">Description</label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="h-8 w-full rounded border border-border bg-background px-2 text-xs"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">Color</label>
        <div className="flex flex-wrap gap-1.5">
          {COLORS.map((c) => (
            <button
              type="button"
              key={c}
              onClick={() => setColor(c)}
              style={{ background: c }}
              className={cn(
                "h-6 w-6 rounded-full border-2 transition-transform",
                color === c ? "scale-110 border-foreground" : "border-transparent",
              )}
            />
          ))}
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-border pt-2">
        <button type="button" onClick={onCancel} className="h-8 rounded-md border border-border px-3 text-xs hover:bg-accent">
          Cancel
        </button>
        <button
          type="submit"
          disabled={isPending || !id || !name}
          className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
          {initial ? "Update" : "Create"}
        </button>
      </div>
    </form>
  );
}

function AssignPanel({ label }: { label: CategoryLabel }) {
  const assign = useAssignLabel();
  const [entityType, setEntityType] = useState<typeof ENTITY_TYPES[number]>("live_event");
  const [entityId, setEntityId] = useState("");

  return (
    <div className="rounded-md border border-border bg-muted/30 p-3">
      <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">Assign to entity</div>
      <div className="grid grid-cols-3 gap-2">
        <select
          value={entityType}
          onChange={(e) => setEntityType(e.target.value as typeof ENTITY_TYPES[number])}
          className="h-8 rounded border border-border bg-background px-2 text-xs"
        >
          {ENTITY_TYPES.map((t) => (
            <option key={t} value={t}>{t.replace("_", " ")}</option>
          ))}
        </select>
        <input
          value={entityId}
          onChange={(e) => setEntityId(e.target.value)}
          placeholder="entity ID"
          className="h-8 rounded border border-border bg-background px-2 font-mono text-xs"
        />
        <button
          disabled={!entityId || assign.isPending}
          onClick={() =>
            assign.mutate(
              { label_id: label.id, entity_type: entityType, entity_id: entityId },
              {
                onSuccess: () => setEntityId(""),
              },
            )
          }
          className="h-8 rounded bg-primary text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {assign.isPending ? <Loader2 className="mx-auto h-3 w-3 animate-spin" /> : "Assign"}
        </button>
      </div>
      {assign.isSuccess && <div className="mt-1.5 text-[10px] text-emerald-600">Assigned.</div>}
      {assign.isError && (
        <div className="mt-1.5 text-[10px] text-destructive">
          {assign.error instanceof Error ? assign.error.message : "Assign failed"}
        </div>
      )}
    </div>
  );
}

export function CategoryLabelsPage() {
  const labels = useLabels();
  const upsert = useUpsertLabel();
  const del = useDeleteLabel();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<CategoryLabel | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const sorted = useMemo(
    () => [...(labels.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [labels.data],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Tags className="h-6 w-6 text-primary" />
            Category labels
          </h2>
          <p className="text-muted-foreground">
            Tag live events, feature flags, experiments, audiences, messages, and funnels with shared labels.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {labels.isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          <button onClick={() => labels.refetch()} className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-card px-3 text-sm hover:bg-accent">
            <RefreshCw className={cn("h-4 w-4", labels.isFetching && "animate-spin")} />
            Refresh
          </button>
          {!creating && !editing && (
            <button onClick={() => setCreating(true)} className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90">
              <Plus className="h-4 w-4" />
              New label
            </button>
          )}
        </div>
      </div>

      {(creating || editing) && (
        <LabelForm
          initial={editing ?? undefined}
          isPending={upsert.isPending}
          onCancel={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSubmit={(l) =>
            upsert.mutate(l, {
              onSuccess: () => {
                setCreating(false);
                setEditing(null);
              },
            })
          }
        />
      )}

      {labels.isError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertTriangle className="mr-2 inline h-4 w-4" />
          {labels.error instanceof Error ? labels.error.message : "Failed to load labels"}
        </div>
      )}

      <div className="space-y-2">
        {sorted.length === 0 ? (
          <div className="rounded-md border border-dashed border-border p-10 text-center text-xs text-muted-foreground">
            <Tags className="mx-auto h-8 w-8 opacity-30" />
            <p className="mt-2">No category labels yet.</p>
          </div>
        ) : (
          sorted.map((l) => (
            <div key={l.id} className="rounded-md border border-border bg-card">
              <div className="flex items-center justify-between p-3">
                <div className="flex items-center gap-3">
                  <span
                    className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium text-white"
                    style={{ background: l.color ?? COLORS[5] }}
                  >
                    {l.name}
                  </span>
                  <code className="font-mono text-[11px] text-muted-foreground">{l.id}</code>
                  {l.description && <span className="text-xs text-muted-foreground">— {l.description}</span>}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setExpandedId(expandedId === l.id ? null : l.id)}
                    className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                    title="Assign"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => {
                      setEditing(l);
                      setCreating(false);
                    }}
                    className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                    title="Edit"
                  >
                    <Edit3 className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`Delete label "${l.name}"?`)) del.mutate(l.id);
                    }}
                    className="rounded p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    title="Delete"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              {expandedId === l.id && (
                <div className="border-t border-border p-3">
                  <AssignPanel label={l} />
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default CategoryLabelsPage;
