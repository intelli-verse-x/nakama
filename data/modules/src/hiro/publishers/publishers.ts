// Hiro Publishers — multi-tenant publisher / studio configuration so a
// single Nakama deployment can serve many publishers with separate config
// roots, app secrets, and operational metadata. Mirrors the
// `Publishers` concept in https://heroiclabs.com/docs/hiro/concepts/publishers/.
//
// Storage layout: a single system blob keyed by publisher id under the
// hiro configs collection.
namespace HiroPublishers {

  interface PublisherDef {
    id: string;
    name: string;
    contactEmail?: string;
    appKeys?: { [appId: string]: string };  // publisher-scoped app secrets
    metadata?: { [k: string]: string };
    enabled: boolean;
    createdAt: number;
    updatedAt: number;
  }

  interface State {
    publishers: { [id: string]: PublisherDef };
  }

  function load(nk: nkruntime.Nakama): State {
    return ConfigLoader.loadConfig<State>(nk, "publishers", { publishers: {} });
  }

  function save(nk: nkruntime.Nakama, st: State): void {
    ConfigLoader.saveConfig(nk, "publishers", st);
  }

  // Public helper used by other Hiro/Satori modules for tenant resolution.
  export function get(nk: nkruntime.Nakama, publisherId: string): PublisherDef | null {
    var st = load(nk);
    return st.publishers[publisherId] || null;
  }

  export function list(nk: nkruntime.Nakama): PublisherDef[] {
    var st = load(nk);
    var out: PublisherDef[] = [];
    for (var id in st.publishers) if (st.publishers.hasOwnProperty(id)) out.push(st.publishers[id]);
    return out;
  }

  export function isAppOwnedBy(nk: nkruntime.Nakama, publisherId: string, appId: string): boolean {
    var p = get(nk, publisherId);
    return !!(p && p.enabled && p.appKeys && p.appKeys[appId]);
  }

  // ----- RPCs -----

  function rpcList(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var pubs = list(nk);
    // strip secrets when surfacing to ops
    return RpcHelpers.successResponse({
      publishers: pubs.map(function (p) {
        return {
          id: p.id, name: p.name, contactEmail: p.contactEmail,
          appIds: p.appKeys ? Object.keys(p.appKeys) : [],
          metadata: p.metadata, enabled: p.enabled,
          createdAt: p.createdAt, updatedAt: p.updatedAt
        };
      })
    });
  }

  function rpcUpsert(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.id || !data.name) return RpcHelpers.errorResponse("id and name required");
    var st = load(nk);
    var now = Math.floor(Date.now() / 1000);
    var existing = st.publishers[data.id];
    st.publishers[data.id] = {
      id: String(data.id),
      name: String(data.name),
      contactEmail: data.contactEmail,
      appKeys: existing && existing.appKeys ? existing.appKeys : (data.appKeys || {}),
      metadata: data.metadata || (existing ? existing.metadata : {}),
      enabled: data.enabled !== false,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now
    };
    save(nk, st);
    var out = st.publishers[data.id];
    return RpcHelpers.successResponse({
      publisher: { id: out.id, name: out.name, enabled: out.enabled, appIds: Object.keys(out.appKeys || {}) }
    });
  }

  function rpcAddAppKey(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.id || !data.appId) return RpcHelpers.errorResponse("id and appId required");
    var st = load(nk);
    var p = st.publishers[data.id];
    if (!p) return RpcHelpers.errorResponse("publisher not found");
    if (!p.appKeys) p.appKeys = {};
    var key = data.appKey || nk.uuidv4();
    p.appKeys[String(data.appId)] = String(key);
    p.updatedAt = Math.floor(Date.now() / 1000);
    save(nk, st);
    return RpcHelpers.successResponse({ publisherId: p.id, appId: data.appId, appKey: key });
  }

  function rpcRevokeAppKey(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.id || !data.appId) return RpcHelpers.errorResponse("id and appId required");
    var st = load(nk);
    var p = st.publishers[data.id];
    if (!p || !p.appKeys) return RpcHelpers.errorResponse("publisher not found");
    delete p.appKeys[data.appId];
    p.updatedAt = Math.floor(Date.now() / 1000);
    save(nk, st);
    return RpcHelpers.successResponse({ revoked: data.appId });
  }

  function rpcDelete(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.id) return RpcHelpers.errorResponse("id required");
    var st = load(nk);
    delete st.publishers[data.id];
    save(nk, st);
    return RpcHelpers.successResponse({ deleted: data.id });
  }

  function rpcGet(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.id) return RpcHelpers.errorResponse("id required");
    var p = get(nk, String(data.id));
    if (!p) return RpcHelpers.errorResponse("not found");
    return RpcHelpers.successResponse({
      publisher: { id: p.id, name: p.name, contactEmail: p.contactEmail, enabled: p.enabled, appIds: Object.keys(p.appKeys || {}), metadata: p.metadata }
    });
  }

  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("hiro_publishers_list", rpcList);
    initializer.registerRpc("hiro_publishers_get", rpcGet);
    initializer.registerRpc("hiro_publishers_upsert", rpcUpsert);
    initializer.registerRpc("hiro_publishers_add_app_key", rpcAddAppKey);
    initializer.registerRpc("hiro_publishers_revoke_app_key", rpcRevokeAppKey);
    initializer.registerRpc("hiro_publishers_delete", rpcDelete);
  }
}
