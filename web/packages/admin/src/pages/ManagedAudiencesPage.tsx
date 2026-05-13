// ManagedAudiencesPage — bring-your-own segments imported from external
// analytics platforms (per Satori "Managed audiences" capability).
//
// Mirrors Heroic Labs Satori › Segmentation › Manage audiences › Bring
// your own segment data:
//   • Define a managed source (Amplitude, Mixpanel, GA4, Snowflake table…)
//   • Upload / sync membership snapshots (CSV or JSON list of identity IDs)
//   • View last-sync status, member counts, source provenance
//
// Wired to:
//   satori_managed_audiences_list / _upsert / _delete / _sync_now /
//   _members_upload (admin RPCs)

import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  UploadCloud,
  Plus,
  Trash2,
  RefreshCw,
  Loader2,
  AlertTriangle,
  Database,
  CheckCircle2,
  Layers,
} from "lucide-react";
import { callRpc, serverKeyAuth } from "@nakama/shared";
import { cn } from "@/lib/utils";

interface ManagedAudience {
  id: string;
  name: string;
  // Backend uses sourceType + audienceId + lastRefreshedAt + lastRowCount.
  source?: string;
  sourceType?: string;
  audienceId?: string;
  description?: string;
  member_count?: number;
  lastRowCount?: number;
  last_synced_at?: number;
  lastRefreshedAt?: number;
  enabled?: boolean;
  endpoint?: string;
  api_key?: string;
  refreshIntervalSec?: number;
}

const SOURCES = ["amplitude", "mixpanel", "ga4", "snowflake", "bigquery", "csv_upload", "custom"] as const;

function unwrap<T>(v: unknown): T {
  if (v && typeof v === "object" && "success" in v && "data" in v) return (v as { data: T }).data;
  return v as T;
}

function useManaged() {
  return useQuery({
    queryKey: ["satori", "managed-audiences"],
    queryFn: () =>
      callRpc("satori_managed_audiences_list", {}, serverKeyAuth())
        .then((v) => unwrap<{ sources?: ManagedAudience[]; audiences?: ManagedAudience[] }>(v)),
    select: (d) => d.sources ?? d.audiences ?? [],
    staleTime: 30_000,
  });
}

function useUpsert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: ManagedAudience) =>
      callRpc("satori_managed_audiences_upsert", a as unknown as Record<string, unknown>, serverKeyAuth()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["satori", "managed-audiences"] }),
  });
}

function useDelete() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      callRpc("satori_managed_audiences_delete", { id }, serverKeyAuth()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["satori", "managed-audiences"] }),
  });
}

function useSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      callRpc("satori_managed_audiences_refresh", { id }, serverKeyAuth()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["satori", "managed-audiences"] }),
  });
}

function useUploadMembers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (p: { id: string; identity_ids: string[] }) =>
      // Backend payload contract: { id, userIds[] }.
      callRpc(
        "satori_managed_audiences_replace",
        { id: p.id, userIds: p.identity_ids } as unknown as Record<string, unknown>,
        serverKeyAuth(),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["satori", "managed-audiences"] }),
  });
}

function CreateForm({ onCancel, onSuccess }: { onCancel: () => void; onSuccess: () => void }) {
  const [id, setId] = useState("");
  const [audienceId, setAudienceId] = useState("");
  const [name, setName] = useState("");
  const [source, setSource] = useState<typeof SOURCES[number]>("amplitude");
  const [description, setDescription] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const upsert = useUpsert();

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!id || !name || !audienceId) return;
        // Backend payload contract: { id, audienceId, name, sourceType, endpoint, apiKey, refreshIntervalSec }.
        upsert.mutate(
          {
            id,
            name,
            audienceId,
            sourceType: source === "csv_upload" ? "manual" : source === "snowflake" || source === "bigquery" || source === "custom" ? "http" : source,
            description,
            endpoint: endpoint || undefined,
            api_key: apiKey || undefined,
            enabled: true,
          } as ManagedAudience,
          { onSuccess },
        );
      }}
      className="space-y-3 rounded-md border border-border bg-card p-4"
    >
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">ID *</label>
          <input
            value={id}
            onChange={(e) => setId(e.target.value.replace(/[^a-z0-9_]/gi, "_").toLowerCase())}
            placeholder="amplitude_whales"
            className="h-8 w-full rounded border border-border bg-background px-2 font-mono text-xs"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Name *</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Amplitude — Whales" className="h-8 w-full rounded border border-border bg-background px-2 text-xs" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Target audience ID *</label>
          <input value={audienceId} onChange={(e) => setAudienceId(e.target.value.replace(/[^a-z0-9_]/gi, "_").toLowerCase())} placeholder="whales" className="h-8 w-full rounded border border-border bg-background px-2 font-mono text-xs" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Source *</label>
          <select value={source} onChange={(e) => setSource(e.target.value as typeof SOURCES[number])} className="h-8 w-full rounded border border-border bg-background px-2 text-xs">
            {SOURCES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Endpoint / table</label>
          <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="cohort_table or webhook URL" className="h-8 w-full rounded border border-border bg-background px-2 font-mono text-xs" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">API key</label>
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} className="h-8 w-full rounded border border-border bg-background px-2 text-xs" />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Description</label>
          <input value={description} onChange={(e) => setDescription(e.target.value)} className="h-8 w-full rounded border border-border bg-background px-2 text-xs" />
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-border pt-2">
        <button type="button" onClick={onCancel} className="h-8 rounded border border-border px-3 text-xs hover:bg-accent">Cancel</button>
        <button
          type="submit"
          disabled={upsert.isPending}
          className="inline-flex h-8 items-center gap-1 rounded bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {upsert.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
          Create source
        </button>
      </div>
    </form>
  );
}

function UploadPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const upload = useUploadMembers();
  const [text, setText] = useState("");
  const ids = useMemo(() => text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean), [text]);
  return (
    <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
      <div className="text-xs font-semibold">Upload members for {id}</div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        placeholder="Paste identity IDs, one per line (or comma-separated)…"
        className="w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-[11px]"
      />
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{ids.length.toLocaleString()} identities parsed.</span>
        <div className="flex gap-1">
          <button onClick={onClose} className="h-7 rounded border border-border px-2 text-xs hover:bg-accent">Cancel</button>
          <button
            disabled={upload.isPending || ids.length === 0}
            onClick={() => upload.mutate({ id, identity_ids: ids }, { onSuccess: onClose })}
            className="inline-flex h-7 items-center gap-1 rounded bg-primary px-2 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {upload.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <UploadCloud className="h-3 w-3" />}
            Upload
          </button>
        </div>
      </div>
    </div>
  );
}

export function ManagedAudiencesPage() {
  const list = useManaged();
  const del = useDelete();
  const sync = useSync();
  const [creating, setCreating] = useState(false);
  const [uploadingId, setUploadingId] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Database className="h-6 w-6 text-primary" />
            Managed audiences
          </h2>
          <p className="text-muted-foreground">
            Bring your own segment data from external analytics platforms. Imported audiences can be used directly for live events, experiments, flags, and messages.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => list.refetch()} className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-card px-3 text-sm hover:bg-accent">
            <RefreshCw className={cn("h-4 w-4", list.isFetching && "animate-spin")} />
            Refresh
          </button>
          {!creating && (
            <button onClick={() => setCreating(true)} className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90">
              <Plus className="h-4 w-4" />
              New source
            </button>
          )}
        </div>
      </div>

      {creating && <CreateForm onCancel={() => setCreating(false)} onSuccess={() => setCreating(false)} />}

      {list.isError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertTriangle className="mr-2 inline h-4 w-4" />
          {list.error instanceof Error ? list.error.message : "Failed to load managed audiences"}
        </div>
      )}

      <div className="space-y-2">
        {(list.data ?? []).length === 0 && !list.isLoading ? (
          <div className="rounded-md border border-dashed border-border p-10 text-center text-xs text-muted-foreground">
            <Layers className="mx-auto h-8 w-8 opacity-30" />
            <p className="mt-2">No managed audience sources yet.</p>
          </div>
        ) : (
          (list.data ?? []).map((a) => (
            <div key={a.id} className="rounded-md border border-border bg-card p-3">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{a.name}</span>
                    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">{a.id}</code>
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">{a.source ?? a.sourceType ?? "manual"}</span>
                    {a.audienceId && (
                      <code className="rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">→ {a.audienceId}</code>
                    )}
                    {a.enabled !== false && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-600">
                        <CheckCircle2 className="h-2.5 w-2.5" /> Active
                      </span>
                    )}
                  </div>
                  {a.description && <div className="mt-0.5 text-[11px] text-muted-foreground">{a.description}</div>}
                  <div className="mt-1 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
                    <span>{(a.lastRowCount ?? a.member_count ?? 0).toLocaleString()} members</span>
                    {(a.lastRefreshedAt ?? a.last_synced_at) && (
                      <span>Last sync: {new Date(((a.lastRefreshedAt ?? a.last_synced_at) as number) * 1000).toLocaleString()}</span>
                    )}
                    {a.endpoint && <code className="font-mono">{a.endpoint}</code>}
                  </div>
                </div>
                <div className="flex gap-1">
                  <button
                    onClick={() => sync.mutate(a.id)}
                    disabled={sync.isPending}
                    className="inline-flex h-7 items-center gap-1 rounded border border-border px-2 text-xs text-muted-foreground hover:text-foreground"
                  >
                    {sync.isPending && sync.variables === a.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                    Sync now
                  </button>
                  <button
                    onClick={() => setUploadingId(uploadingId === a.id ? null : a.id)}
                    className="inline-flex h-7 items-center gap-1 rounded border border-border px-2 text-xs text-muted-foreground hover:text-foreground"
                  >
                    <UploadCloud className="h-3 w-3" />
                    Upload
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`Delete managed audience "${a.name}"?`)) del.mutate(a.id);
                    }}
                    className="rounded border border-border p-1 text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </div>
              {uploadingId === a.id && (
                <div className="mt-3">
                  <UploadPanel id={a.id} onClose={() => setUploadingId(null)} />
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default ManagedAudiencesPage;
