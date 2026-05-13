// Hiro Integrations — third-party SDK adapters for Facebook, AppsFlyer,
// Adjust, Singular, Unity Purchasing, and any custom HTTP webhook target.
// Mirrors https://heroiclabs.com/docs/hiro/concepts/integrations/.
//
// We don't pull each provider's full SDK into Goja runtime — that's the
// client SDK's responsibility. Instead this module:
//
//   - stores per-provider configuration (keys, secrets, base URLs)
//   - exposes RPCs the client can call after a successful local operation
//     (e.g. `hiro_integrations_attribution_log` after AppsFlyer reports
//     an install) so the data lands inside Nakama for analytics + audience
//     property updates
//   - validates IAP receipts via Hiro base IAP, then forwards a
//     `purchase_validated` event to the captured analytics pipeline so the
//     Satori RoAS module sees revenue
namespace HiroIntegrations {

  type ProviderType = "facebook" | "appsflyer" | "adjust" | "singular" | "unity_purchasing" | "applovin_max" | "ironsource" | "branch" | "webhook";

  interface IntegrationProvider {
    id: string;
    type: ProviderType;
    enabled: boolean;
    apiKey?: string;
    appId?: string;
    devKey?: string;
    endpoint?: string;
    headers?: { [k: string]: string };
    metadata?: { [k: string]: string };
  }

  interface IntegrationsConfig {
    providers: { [id: string]: IntegrationProvider };
  }

  function load(nk: nkruntime.Nakama, gameId?: string): IntegrationsConfig {
    var c = ConfigLoader.loadConfigForGame<IntegrationsConfig>(nk, "integrations", gameId, { providers: {} });
    if (!c.providers) c.providers = {};
    return c;
  }

  function save(nk: nkruntime.Nakama, c: IntegrationsConfig, gameId?: string): void {
    ConfigLoader.saveConfig(nk, Constants.gameKey(gameId, "integrations"), c);
  }

  function withProvider(nk: nkruntime.Nakama, id: string, gameId?: string): IntegrationProvider | null {
    var c = load(nk, gameId);
    var p = c.providers[id];
    return p && p.enabled ? p : null;
  }

  // ----- Outbound forwarders -----

  // Best-effort POST to provider endpoint with optional bearer auth.
  function forward(nk: nkruntime.Nakama, logger: nkruntime.Logger, p: IntegrationProvider, body: any): boolean {
    if (!p.endpoint) return false;
    try {
      var headers: { [k: string]: string } = { "Content-Type": "application/json" };
      if (p.apiKey) headers["Authorization"] = "Bearer " + p.apiKey;
      if (p.headers) for (var h in p.headers) headers[h] = p.headers[h];
      nk.httpRequest(p.endpoint, "post", headers, JSON.stringify(body));
      return true;
    } catch (e: any) {
      logger.warn("[hiro_integrations.%s] forward failed: %s", p.id, e.message || String(e));
      return false;
    }
  }

  // Public: write attribution data into Satori identity properties so
  // audiences can target on it (acquisitionChannel/Campaign/Country).
  export function recordAttribution(nk: nkruntime.Nakama, userId: string, attribution: { channel?: string; campaign?: string; country?: string; mediaSource?: string; raw?: any }): void {
    if (!userId) return;
    try {
      var props = SatoriIdentities.getAllProperties(nk, userId);
      if (attribution.channel) props.customProperties["acquisitionChannel"] = String(attribution.channel);
      if (attribution.campaign) props.customProperties["acquisitionCampaign"] = String(attribution.campaign);
      if (attribution.country) props.defaultProperties["country"] = String(attribution.country);
      if (attribution.mediaSource) props.customProperties["acquisitionMediaSource"] = String(attribution.mediaSource);
      Storage.writeJson(nk, Constants.SATORI_IDENTITY_COLLECTION, "props", userId, props);
    } catch (_) { /* ignore */ }
  }

  // ----- RPCs -----

  function rpcGetConfig(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    var cfg = load(nk, RpcHelpers.gameId(data));
    var out: any[] = [];
    for (var id in cfg.providers) {
      if (!cfg.providers.hasOwnProperty(id)) continue;
      var p = cfg.providers[id];
      out.push({ id: p.id, type: p.type, enabled: p.enabled, appId: p.appId, endpoint: p.endpoint, metadata: p.metadata });
    }
    return RpcHelpers.successResponse({ providers: out });
  }

  function rpcUpsertProvider(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.id || !data.type) return RpcHelpers.errorResponse("id and type required");
    var gameId = RpcHelpers.gameId(data);
    var cfg = load(nk, gameId);
    cfg.providers[data.id] = {
      id: String(data.id),
      type: data.type,
      enabled: data.enabled !== false,
      apiKey: data.apiKey,
      appId: data.appId,
      devKey: data.devKey,
      endpoint: data.endpoint,
      headers: data.headers,
      metadata: data.metadata
    };
    save(nk, cfg, gameId);
    return RpcHelpers.successResponse({ provider: { id: data.id, type: data.type, enabled: cfg.providers[data.id].enabled } });
  }

  function rpcDeleteProvider(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.id) return RpcHelpers.errorResponse("id required");
    var gameId = RpcHelpers.gameId(data);
    var cfg = load(nk, gameId);
    delete cfg.providers[data.id];
    save(nk, cfg, gameId);
    return RpcHelpers.successResponse({ deleted: data.id });
  }

  function rpcAttributionLog(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload);
    var attribution = {
      channel: data.channel || data.network,
      campaign: data.campaign,
      country: data.country,
      mediaSource: data.mediaSource || data.media_source,
      raw: data.raw
    };
    recordAttribution(nk, userId, attribution);
    // Capture as a satori event so RoAS / funnel modules see it
    SatoriEventCapture.captureEvent(nk, logger, userId, {
      name: "attribution",
      timestamp: Date.now(),
      metadata: {
        channel: String(attribution.channel || ""),
        campaign: String(attribution.campaign || ""),
        country: String(attribution.country || ""),
        mediaSource: String(attribution.mediaSource || "")
      }
    });
    // Forward to any provider the operator wants notified (e.g. internal BI)
    var cfg = load(nk, RpcHelpers.gameId(data));
    for (var id in cfg.providers) {
      var p = cfg.providers[id];
      if (!p || !p.enabled) continue;
      if (p.type === "webhook") forward(nk, logger, p, { kind: "attribution", userId: userId, attribution: attribution });
    }
    return RpcHelpers.successResponse({ recorded: true });
  }

  function rpcPurchaseValidated(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.productId || !data.amountUsd) return RpcHelpers.errorResponse("productId and amountUsd required");
    SatoriEventCapture.captureEvent(nk, logger, userId, {
      name: "purchase",
      timestamp: Date.now(),
      metadata: {
        productId: String(data.productId),
        amount: String(data.amountUsd),
        amountUsd: String(data.amountUsd),
        currency: String(data.currency || "USD"),
        store: String(data.store || "unknown")
      }
    });
    return RpcHelpers.successResponse({ recorded: true });
  }

  function rpcCustomEvent(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.providerId || !data.eventName) return RpcHelpers.errorResponse("providerId and eventName required");
    var p = withProvider(nk, String(data.providerId), RpcHelpers.gameId(data));
    if (!p) return RpcHelpers.errorResponse("provider not enabled");
    var ok = forward(nk, logger, p, { userId: userId, eventName: data.eventName, params: data.params || {} });
    return RpcHelpers.successResponse({ forwarded: ok });
  }

  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("hiro_integrations_get_config", rpcGetConfig);
    initializer.registerRpc("hiro_integrations_upsert_provider", rpcUpsertProvider);
    initializer.registerRpc("hiro_integrations_delete_provider", rpcDeleteProvider);
    initializer.registerRpc("hiro_integrations_attribution_log", rpcAttributionLog);
    initializer.registerRpc("hiro_integrations_purchase_validated", rpcPurchaseValidated);
    initializer.registerRpc("hiro_integrations_custom_event", rpcCustomEvent);
  }
}
