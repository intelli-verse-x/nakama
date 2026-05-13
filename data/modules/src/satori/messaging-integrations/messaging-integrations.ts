// Satori Messaging Integrations — outbound delivery to push notification
// providers (FCM, APNS, OneSignal), email (generic SMTP webhook), Facebook
// App-to-User, and a generic Webhook adapter. Mirrors
// https://heroiclabs.com/docs/satori/concepts/player-messaging/message-integrations/
//
// Each provider is configured via the satori configs collection. When a
// message is delivered to a user, callers invoke `dispatch(...)` which fans
// out to every enabled provider for which we have a player token.
namespace SatoriMessagingIntegrations {

  type Provider = "fcm" | "apns" | "onesignal" | "facebook_a2u" | "webhook" | "email";

  interface ProviderConfig {
    id: string;
    type: Provider;
    enabled: boolean;
    apiKey?: string;
    appId?: string;
    teamId?: string;
    keyId?: string;
    privateKey?: string;
    endpoint?: string;
    fromAddress?: string;
    headers?: { [k: string]: string };
  }

  interface IntegrationsConfig {
    providers: { [id: string]: ProviderConfig };
    routing: {
      // map message metadata.channel -> ordered list of provider ids
      channels: { [channel: string]: string[] };
    };
  }

  interface UserDeviceTokens {
    fcm?: string[];
    apns?: string[];
    oneSignalPlayerIds?: string[];
    fbA2U?: string;          // user PSID
    email?: string;
  }

  var DEFAULT_CONFIG: IntegrationsConfig = { providers: {}, routing: { channels: {} } };

  function loadConfig(nk: nkruntime.Nakama, gameId?: string): IntegrationsConfig {
    var cfg = ConfigLoader.loadSatoriConfigForGame<IntegrationsConfig>(nk, "messaging_integrations", gameId, DEFAULT_CONFIG);
    if (!cfg.providers) cfg.providers = {};
    if (!cfg.routing) cfg.routing = { channels: {} };
    if (!cfg.routing.channels) cfg.routing.channels = {};
    return cfg;
  }

  function saveConfig(nk: nkruntime.Nakama, cfg: IntegrationsConfig, gameId?: string): void {
    ConfigLoader.saveSatoriConfigForGame(nk, "messaging_integrations", gameId, cfg);
  }

  function loadTokens(nk: nkruntime.Nakama, userId: string): UserDeviceTokens {
    return Storage.readJson<UserDeviceTokens>(nk, Constants.PUSH_TOKENS_COLLECTION, "tokens", userId) || {};
  }

  function saveTokens(nk: nkruntime.Nakama, userId: string, tokens: UserDeviceTokens): void {
    Storage.writeJson(nk, Constants.PUSH_TOKENS_COLLECTION, "tokens", userId, tokens);
  }

  function uniquePush(arr: string[] | undefined, val: string): string[] {
    var out = arr ? arr.slice() : [];
    if (out.indexOf(val) === -1) out.push(val);
    return out;
  }

  // ----- Provider dispatchers -----

  function dispatchFcm(nk: nkruntime.Nakama, logger: nkruntime.Logger, p: ProviderConfig, tokens: string[], title: string, body: string, data?: any): boolean {
    if (!p.apiKey || tokens.length === 0) return false;
    try {
      var payload = JSON.stringify({
        registration_ids: tokens,
        notification: { title: title, body: body },
        data: data || {}
      });
      nk.httpRequest("https://fcm.googleapis.com/fcm/send", "post", {
        "Authorization": "key=" + p.apiKey,
        "Content-Type": "application/json"
      }, payload);
      return true;
    } catch (e: any) { logger.warn("[fcm] dispatch failed: %s", e.message || String(e)); return false; }
  }

  function dispatchApns(nk: nkruntime.Nakama, logger: nkruntime.Logger, p: ProviderConfig, tokens: string[], title: string, body: string, data?: any): boolean {
    if (!p.endpoint || !p.appId || tokens.length === 0) return false;
    var ok = true;
    for (var i = 0; i < tokens.length; i++) {
      try {
        var payload = JSON.stringify({ aps: { alert: { title: title, body: body } }, data: data || {} });
        nk.httpRequest(p.endpoint + "/3/device/" + tokens[i], "post", {
          "apns-topic": p.appId,
          "Content-Type": "application/json"
        }, payload);
      } catch (e: any) { ok = false; logger.warn("[apns] dispatch failed: %s", e.message || String(e)); }
    }
    return ok;
  }

  function dispatchOneSignal(nk: nkruntime.Nakama, logger: nkruntime.Logger, p: ProviderConfig, playerIds: string[], title: string, body: string, data?: any): boolean {
    if (!p.appId || !p.apiKey || playerIds.length === 0) return false;
    try {
      var payload = JSON.stringify({
        app_id: p.appId,
        include_player_ids: playerIds,
        headings: { en: title },
        contents: { en: body },
        data: data || {}
      });
      nk.httpRequest("https://onesignal.com/api/v1/notifications", "post", {
        "Authorization": "Basic " + p.apiKey,
        "Content-Type": "application/json"
      }, payload);
      return true;
    } catch (e: any) { logger.warn("[onesignal] dispatch failed: %s", e.message || String(e)); return false; }
  }

  function dispatchFacebookA2U(nk: nkruntime.Nakama, logger: nkruntime.Logger, p: ProviderConfig, psid: string, body: string): boolean {
    if (!p.apiKey || !psid) return false;
    try {
      var payload = JSON.stringify({ recipient: { id: psid }, message: { text: body }, messaging_type: "MESSAGE_TAG", tag: "GAME_EVENT" });
      var url = (p.endpoint || "https://graph.facebook.com/v18.0/me/messages") + "?access_token=" + encodeURIComponent(p.apiKey);
      nk.httpRequest(url, "post", { "Content-Type": "application/json" }, payload);
      return true;
    } catch (e: any) { logger.warn("[fb-a2u] dispatch failed: %s", e.message || String(e)); return false; }
  }

  function dispatchWebhook(nk: nkruntime.Nakama, logger: nkruntime.Logger, p: ProviderConfig, userId: string, title: string, body: string, data?: any): boolean {
    if (!p.endpoint) return false;
    try {
      var payload = JSON.stringify({ userId: userId, title: title, body: body, data: data || {} });
      var headers: { [k: string]: string } = { "Content-Type": "application/json" };
      if (p.headers) for (var h in p.headers) headers[h] = p.headers[h];
      nk.httpRequest(p.endpoint, "post", headers, payload);
      return true;
    } catch (e: any) { logger.warn("[webhook] dispatch failed: %s", e.message || String(e)); return false; }
  }

  function dispatchEmail(nk: nkruntime.Nakama, logger: nkruntime.Logger, p: ProviderConfig, to: string, title: string, body: string): boolean {
    if (!p.endpoint || !to) return false;
    try {
      var payload = JSON.stringify({ from: p.fromAddress || "noreply@example.com", to: to, subject: title, text: body });
      var headers: { [k: string]: string } = { "Content-Type": "application/json" };
      if (p.apiKey) headers["Authorization"] = "Bearer " + p.apiKey;
      if (p.headers) for (var h in p.headers) headers[h] = p.headers[h];
      nk.httpRequest(p.endpoint, "post", headers, payload);
      return true;
    } catch (e: any) { logger.warn("[email] dispatch failed: %s", e.message || String(e)); return false; }
  }

  // Fan-out to every enabled provider in the channel ordering. Returns the
  // count of successful provider dispatches.
  export function dispatch(nk: nkruntime.Nakama, logger: nkruntime.Logger, userId: string, title: string, body: string, channel: string, data?: any, gameId?: string): number {
    var cfg = loadConfig(nk, gameId);
    var providerIds = cfg.routing.channels[channel] || [];
    if (providerIds.length === 0) {
      // fall back to all enabled providers
      for (var pid in cfg.providers) if (cfg.providers.hasOwnProperty(pid)) providerIds.push(pid);
    }
    var tokens = loadTokens(nk, userId);
    var ok = 0;
    for (var i = 0; i < providerIds.length; i++) {
      var p = cfg.providers[providerIds[i]];
      if (!p || !p.enabled) continue;
      switch (p.type) {
        case "fcm": if (dispatchFcm(nk, logger, p, tokens.fcm || [], title, body, data)) ok++; break;
        case "apns": if (dispatchApns(nk, logger, p, tokens.apns || [], title, body, data)) ok++; break;
        case "onesignal": if (dispatchOneSignal(nk, logger, p, tokens.oneSignalPlayerIds || [], title, body, data)) ok++; break;
        case "facebook_a2u": if (tokens.fbA2U && dispatchFacebookA2U(nk, logger, p, tokens.fbA2U, body)) ok++; break;
        case "webhook": if (dispatchWebhook(nk, logger, p, userId, title, body, data)) ok++; break;
        case "email": if (tokens.email && dispatchEmail(nk, logger, p, tokens.email, title, body)) ok++; break;
      }
    }
    return ok;
  }

  // ----- RPCs -----

  function rpcGetConfig(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    return RpcHelpers.successResponse({ config: loadConfig(nk, RpcHelpers.gameId(data)) });
  }

  function rpcUpsertProvider(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.id || !data.type) return RpcHelpers.errorResponse("id and type required");
    var gameId = RpcHelpers.gameId(data);
    var cfg = loadConfig(nk, gameId);
    cfg.providers[data.id] = {
      id: String(data.id),
      type: data.type,
      enabled: data.enabled !== false,
      apiKey: data.apiKey,
      appId: data.appId,
      teamId: data.teamId,
      keyId: data.keyId,
      privateKey: data.privateKey,
      endpoint: data.endpoint,
      fromAddress: data.fromAddress,
      headers: data.headers
    };
    saveConfig(nk, cfg, gameId);
    return RpcHelpers.successResponse({ provider: cfg.providers[data.id] });
  }

  function rpcDeleteProvider(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.id) return RpcHelpers.errorResponse("id required");
    var gameId = RpcHelpers.gameId(data);
    var cfg = loadConfig(nk, gameId);
    delete cfg.providers[data.id];
    saveConfig(nk, cfg, gameId);
    return RpcHelpers.successResponse({ deleted: data.id });
  }

  function rpcSetChannelRouting(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.channel || !Array.isArray(data.providerIds)) return RpcHelpers.errorResponse("channel and providerIds[] required");
    var gameId = RpcHelpers.gameId(data);
    var cfg = loadConfig(nk, gameId);
    cfg.routing.channels[String(data.channel)] = data.providerIds.map(String);
    saveConfig(nk, cfg, gameId);
    return RpcHelpers.successResponse({ channel: data.channel, providerIds: cfg.routing.channels[String(data.channel)] });
  }

  function rpcRegisterToken(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var userId = RpcHelpers.requireUserId(ctx);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.kind || !data.value) return RpcHelpers.errorResponse("kind and value required");
    var tokens = loadTokens(nk, userId);
    switch (String(data.kind)) {
      case "fcm": tokens.fcm = uniquePush(tokens.fcm, String(data.value)); break;
      case "apns": tokens.apns = uniquePush(tokens.apns, String(data.value)); break;
      case "onesignal": tokens.oneSignalPlayerIds = uniquePush(tokens.oneSignalPlayerIds, String(data.value)); break;
      case "fb_a2u": tokens.fbA2U = String(data.value); break;
      case "email": tokens.email = String(data.value); break;
      default: return RpcHelpers.errorResponse("unknown token kind");
    }
    saveTokens(nk, userId, tokens);
    return RpcHelpers.successResponse({ tokens: tokens });
  }

  function rpcDispatchTest(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.userId || !data.title || !data.body) return RpcHelpers.errorResponse("userId, title, body required");
    var n = dispatch(nk, logger, String(data.userId), String(data.title), String(data.body), String(data.channel || "default"), data.data, RpcHelpers.gameId(data));
    return RpcHelpers.successResponse({ delivered: n });
  }

  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("satori_messaging_get_config", rpcGetConfig);
    initializer.registerRpc("satori_messaging_upsert_provider", rpcUpsertProvider);
    initializer.registerRpc("satori_messaging_delete_provider", rpcDeleteProvider);
    initializer.registerRpc("satori_messaging_set_channel_routing", rpcSetChannelRouting);
    initializer.registerRpc("satori_messaging_register_token", rpcRegisterToken);
    initializer.registerRpc("satori_messaging_dispatch_test", rpcDispatchTest);
  }
}
