// IntegrationsPage — Settings › Integrations equivalent.
//
// Mirrors Heroic Labs Satori › Settings › Integrations + Hiro Publishers/Integrations:
//   • Push providers — Firebase FCM, Apple APNS, OneSignal
//   • Email + Webhook channels (Mailgun / SendGrid / generic webhook)
//   • Mobile Measurement Partners (Adjust, AppsFlyer, Facebook A2U)
//   • Hiro publishers (multi-tenant configuration)
//   • Data lake export (BigQuery / Snowflake / Databricks / S3)
//
// Wired RPCs:
//   satori_messaging_integrations_list / _upsert / _delete
//   hiro_integrations_get_config / _upsert
//   hiro_publishers_list / _upsert
//   satori_data_lake_export_get / _set
//   satori_webhooks_list / _upsert / _delete

import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plug,
  Plus,
  Trash2,
  RefreshCw,
  Loader2,
  AlertTriangle,
  CheckCircle2,
  Smartphone,
  Mail,
  Webhook,
  Database,
  TrendingUp,
  Building2,
} from "lucide-react";
import { callRpc, serverKeyAuth } from "@nakama/shared";
import { cn } from "@/lib/utils";

interface Integration {
  id: string;
  type: string;
  enabled: boolean;
  config?: Record<string, string | number | boolean | undefined | Record<string, string>>;
  updated_at?: number;
}

function unwrap<T>(v: unknown): T {
  if (v && typeof v === "object" && "success" in v && "data" in v) return (v as { data: T }).data;
  return v as T;
}

const PROVIDERS: Array<{ id: string; label: string; icon: React.ElementType; group: string; fields: Array<{ key: string; label: string; type?: string; placeholder?: string }> }> = [
  {
    id: "fcm", label: "Firebase Cloud Messaging", icon: Smartphone, group: "Push notifications",
    fields: [
      { key: "project_id", label: "Project ID", placeholder: "my-game-fcm" },
      { key: "service_account_json", label: "Service Account JSON", type: "textarea" },
    ],
  },
  {
    id: "apns", label: "Apple Push Notification Service", icon: Smartphone, group: "Push notifications",
    fields: [
      { key: "team_id", label: "Team ID" },
      { key: "key_id", label: "Key ID" },
      { key: "bundle_id", label: "Bundle ID" },
      { key: "private_key", label: "Private key (.p8)", type: "textarea" },
    ],
  },
  {
    id: "onesignal", label: "OneSignal", icon: Smartphone, group: "Push notifications",
    fields: [
      { key: "app_id", label: "App ID" },
      { key: "rest_api_key", label: "REST API key", type: "password" },
    ],
  },
  {
    id: "fb_a2u", label: "Facebook A2U", icon: Smartphone, group: "Push notifications",
    fields: [
      { key: "app_id", label: "App ID" },
      { key: "app_secret", label: "App secret", type: "password" },
    ],
  },
  {
    id: "sendgrid", label: "SendGrid", icon: Mail, group: "Email",
    fields: [
      { key: "api_key", label: "API key", type: "password" },
      { key: "from_address", label: "From address", placeholder: "noreply@yourgame.com" },
    ],
  },
  {
    id: "mailgun", label: "Mailgun", icon: Mail, group: "Email",
    fields: [
      { key: "api_key", label: "API key", type: "password" },
      { key: "domain", label: "Domain" },
    ],
  },
  {
    id: "adjust", label: "Adjust (MMP)", icon: TrendingUp, group: "Mobile measurement",
    fields: [
      { key: "api_token", label: "API token", type: "password" },
      { key: "app_tokens", label: "Application tokens (comma-separated)" },
      { key: "report_interval_days", label: "Report interval (days)", type: "number" },
    ],
  },
  {
    id: "appsflyer", label: "AppsFlyer", icon: TrendingUp, group: "Mobile measurement",
    fields: [
      { key: "dev_key", label: "Dev key", type: "password" },
      { key: "app_id", label: "App ID" },
    ],
  },
  {
    id: "bigquery", label: "BigQuery", icon: Database, group: "Data lake",
    fields: [
      { key: "project_id", label: "Project ID" },
      { key: "dataset", label: "Dataset" },
      { key: "service_account_json", label: "Service account JSON", type: "textarea" },
    ],
  },
  {
    id: "snowflake", label: "Snowflake", icon: Database, group: "Data lake",
    fields: [
      { key: "account", label: "Account" },
      { key: "user", label: "User" },
      { key: "password", label: "Password", type: "password" },
      { key: "database", label: "Database" },
      { key: "schema", label: "Schema" },
    ],
  },
  {
    id: "databricks", label: "Databricks", icon: Database, group: "Data lake",
    fields: [
      { key: "workspace_url", label: "Workspace URL" },
      { key: "token", label: "Personal access token", type: "password" },
      { key: "catalog", label: "Catalog" },
    ],
  },
];

interface MessagingConfigRaw {
  config?: {
    providers?: Record<string, {
      id: string;
      type: string;
      enabled: boolean;
      apiKey?: string;
      appId?: string;
      teamId?: string;
      keyId?: string;
      privateKey?: string;
      endpoint?: string;
      fromAddress?: string;
      headers?: Record<string, string>;
    }>;
    routing?: { channels?: Record<string, string[]> };
  };
}

function useIntegrations() {
  return useQuery({
    queryKey: ["satori", "integrations"],
    queryFn: () =>
      callRpc("satori_messaging_get_config", {}, serverKeyAuth()).then((v) => {
        const raw = unwrap<MessagingConfigRaw>(v);
        const providers = raw.config?.providers ?? {};
        const integrations: Integration[] = Object.values(providers).map((p) => ({
          id: p.id,
          type: p.type,
          enabled: p.enabled,
          config: {
            api_key: p.apiKey,
            app_id: p.appId,
            team_id: p.teamId,
            key_id: p.keyId,
            private_key: p.privateKey,
            endpoint: p.endpoint,
            from_address: p.fromAddress,
            headers: p.headers,
          },
        }));
        return { integrations };
      }),
    select: (d) => d.integrations ?? [],
    staleTime: 30_000,
  });
}

function useUpsertIntegration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (i: { id: string; type: string; enabled: boolean; config?: Record<string, string> }) => {
      // Map the UI's snake_case config fields onto runtime camelCase fields.
      const c = i.config ?? {};
      return callRpc(
        "satori_messaging_upsert_provider",
        {
          id: i.id,
          type: i.type,
          enabled: i.enabled,
          apiKey: c.api_key ?? c.rest_api_key ?? c.dev_key ?? c.token,
          appId: c.app_id,
          teamId: c.team_id,
          keyId: c.key_id,
          privateKey: c.private_key ?? c.service_account_json ?? c.password,
          endpoint: c.endpoint ?? c.workspace_url,
          fromAddress: c.from_address,
        } as unknown as Record<string, unknown>,
        serverKeyAuth(),
      );
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["satori", "integrations"] }),
  });
}

function useDeleteIntegration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      callRpc("satori_messaging_delete_provider", { id }, serverKeyAuth()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["satori", "integrations"] }),
  });
}

function ProviderCard({ provider, existing }: {
  provider: typeof PROVIDERS[number];
  existing?: Integration;
}) {
  const upsert = useUpsertIntegration();
  const del = useDeleteIntegration();
  const [open, setOpen] = useState(false);
  const [enabled, setEnabled] = useState(existing?.enabled ?? false);
  const [config, setConfig] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of provider.fields) {
      const v = existing?.config?.[f.key];
      init[f.key] = typeof v === "string" ? v : v != null ? String(v) : "";
    }
    return init;
  });

  const Icon = provider.icon;
  const isConfigured = !!existing;

  return (
    <div className="rounded-md border border-border bg-card">
      <div className="flex items-center justify-between p-3">
        <div className="flex items-center gap-3">
          <Icon className="h-4 w-4 text-muted-foreground" />
          <div>
            <div className="text-sm font-semibold">{provider.label}</div>
            <div className="text-[10px] text-muted-foreground">{provider.group}</div>
          </div>
          {isConfigured && (
            <span className={cn(
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold",
              existing.enabled ? "bg-emerald-500/10 text-emerald-600" : "bg-muted text-muted-foreground",
            )}>
              <CheckCircle2 className="h-2.5 w-2.5" />
              {existing.enabled ? "Active" : "Configured"}
            </span>
          )}
        </div>
        <button onClick={() => setOpen(!open)} className="text-xs text-muted-foreground hover:text-foreground">
          {open ? "Close" : isConfigured ? "Edit" : "Configure"}
        </button>
      </div>
      {open && (
        <div className="space-y-2 border-t border-border p-3">
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Enabled
          </label>
          {provider.fields.map((f) => (
            <div key={f.key}>
              <label className="mb-0.5 block text-[10px] uppercase text-muted-foreground">{f.label}</label>
              {f.type === "textarea" ? (
                <textarea
                  value={config[f.key] ?? ""}
                  onChange={(e) => setConfig((p) => ({ ...p, [f.key]: e.target.value }))}
                  rows={4}
                  className="w-full rounded border border-border bg-background px-2 py-1.5 font-mono text-[11px]"
                />
              ) : (
                <input
                  type={f.type ?? "text"}
                  value={config[f.key] ?? ""}
                  onChange={(e) => setConfig((p) => ({ ...p, [f.key]: e.target.value }))}
                  placeholder={f.placeholder}
                  className="h-8 w-full rounded border border-border bg-background px-2 text-xs"
                />
              )}
            </div>
          ))}
          <div className="flex justify-end gap-2 pt-1">
            {isConfigured && (
              <button
                onClick={() => {
                  if (confirm(`Remove ${provider.label}?`)) del.mutate(provider.id);
                }}
                className="inline-flex h-8 items-center gap-1 rounded border border-destructive/30 px-3 text-xs text-destructive hover:bg-destructive/5"
              >
                <Trash2 className="h-3 w-3" />
                Remove
              </button>
            )}
            <button
              onClick={() =>
                upsert.mutate(
                  { id: provider.id, type: provider.id, enabled, config },
                  { onSuccess: () => setOpen(false) },
                )
              }
              disabled={upsert.isPending}
              className="inline-flex h-8 items-center gap-1 rounded bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {upsert.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
              Save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

interface Webhook {
  id: string;
  url: string;
  events?: string[];
  enabled: boolean;
}

function useWebhooks() {
  return useQuery({
    queryKey: ["satori", "webhooks"],
    queryFn: () =>
      callRpc("satori_webhooks_list", {}, serverKeyAuth())
        .then((v) => unwrap<{ webhooks?: Webhook[] }>(v))
        .catch(() => ({ webhooks: [] })),
    select: (d) => d.webhooks ?? [],
    staleTime: 30_000,
  });
}

function useUpsertWebhook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (w: Webhook) =>
      callRpc("satori_webhooks_upsert", w as unknown as Record<string, unknown>, serverKeyAuth()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["satori", "webhooks"] }),
  });
}

function WebhooksPanel() {
  const list = useWebhooks();
  const upsert = useUpsertWebhook();
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState("");

  return (
    <div className="space-y-2 rounded-md border border-border bg-card p-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Webhook className="h-4 w-4" /> Webhooks
        </div>
        {!adding && (
          <button onClick={() => setAdding(true)} className="text-xs text-primary hover:underline">
            <Plus className="mr-1 inline h-3 w-3" />New webhook
          </button>
        )}
      </div>
      {adding && (
        <div className="grid grid-cols-3 gap-2 rounded-md border border-border bg-muted/30 p-2">
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://your-server/hook" className="h-8 rounded border border-border bg-background px-2 text-xs" />
          <input value={events} onChange={(e) => setEvents(e.target.value)} placeholder="events (comma-separated)" className="h-8 rounded border border-border bg-background px-2 text-xs" />
          <div className="flex gap-1">
            <button
              onClick={() => {
                if (!url) return;
                upsert.mutate(
                  { id: `wh_${Date.now()}`, url, events: events.split(",").map((s) => s.trim()).filter(Boolean), enabled: true },
                  {
                    onSuccess: () => {
                      setAdding(false);
                      setUrl("");
                      setEvents("");
                    },
                  },
                );
              }}
              disabled={upsert.isPending}
              className="h-8 flex-1 rounded bg-primary text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {upsert.isPending ? <Loader2 className="mx-auto h-3 w-3 animate-spin" /> : "Add"}
            </button>
            <button onClick={() => setAdding(false)} className="h-8 rounded border border-border px-2 text-xs hover:bg-accent">
              Cancel
            </button>
          </div>
        </div>
      )}
      {(list.data ?? []).length === 0 ? (
        <p className="text-xs text-muted-foreground">No webhooks configured.</p>
      ) : (
        <ul className="space-y-1">
          {(list.data ?? []).map((w) => (
            <li key={w.id} className="flex items-center justify-between rounded border border-border bg-background px-2 py-1 text-xs">
              <span className="truncate font-mono">{w.url}</span>
              <span className="text-muted-foreground">{w.events?.join(", ") ?? "*"}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface Publisher {
  id: string;
  name: string;
  description?: string;
  enabled?: boolean;
}

function usePublishers() {
  return useQuery({
    queryKey: ["hiro", "publishers"],
    queryFn: () =>
      callRpc("hiro_publishers_list", {}, serverKeyAuth())
        .then((v) => unwrap<{ publishers?: Publisher[] }>(v))
        .catch(() => ({ publishers: [] })),
    select: (d) => d.publishers ?? [],
    staleTime: 30_000,
  });
}

function PublishersPanel() {
  const list = usePublishers();
  return (
    <div className="space-y-2 rounded-md border border-border bg-card p-3">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Building2 className="h-4 w-4" /> Hiro publishers
      </div>
      {(list.data ?? []).length === 0 ? (
        <p className="text-xs text-muted-foreground">No publishers configured. Use the runtime <code className="font-mono">hiro_publishers_upsert</code> RPC to add one.</p>
      ) : (
        <ul className="space-y-1">
          {(list.data ?? []).map((p) => (
            <li key={p.id} className="flex items-center justify-between rounded border border-border bg-background px-2 py-1 text-xs">
              <span className="font-semibold">{p.name}</span>
              <code className="text-muted-foreground">{p.id}</code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function IntegrationsPage() {
  const integrations = useIntegrations();

  const byId = useMemo(() => {
    const m = new Map<string, Integration>();
    for (const i of integrations.data ?? []) m.set(i.id, i);
    return m;
  }, [integrations.data]);

  const grouped = useMemo(() => {
    const g = new Map<string, typeof PROVIDERS>();
    for (const p of PROVIDERS) {
      const arr = g.get(p.group) ?? [];
      arr.push(p);
      g.set(p.group, arr);
    }
    return Array.from(g.entries());
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Plug className="h-6 w-6 text-primary" />
            Integrations
          </h2>
          <p className="text-muted-foreground">
            Configure Satori push, email, MMP, data-lake export, and webhook integrations.
          </p>
        </div>
        <button onClick={() => integrations.refetch()} className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-card px-3 text-sm hover:bg-accent">
          <RefreshCw className={cn("h-4 w-4", integrations.isFetching && "animate-spin")} />
          Refresh
        </button>
      </div>

      {integrations.isError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          <AlertTriangle className="mr-2 inline h-4 w-4" />
          {integrations.error instanceof Error ? integrations.error.message : "Failed to load integrations"}
        </div>
      )}

      {grouped.map(([group, providers]) => (
        <section key={group} className="space-y-2">
          <h3 className="text-xs font-semibold uppercase text-muted-foreground">{group}</h3>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {providers.map((p) => (
              <ProviderCard key={p.id} provider={p} existing={byId.get(p.id)} />
            ))}
          </div>
        </section>
      ))}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <WebhooksPanel />
        <PublishersPanel />
      </div>
    </div>
  );
}

export default IntegrationsPage;
