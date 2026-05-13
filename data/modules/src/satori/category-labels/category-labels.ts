// Satori Category Labels — organisational tags applied across feature flags,
// live events, messages, and experiments so the LiveOps team can search and
// filter related items quickly.
//
// Mirrors https://heroiclabs.com/docs/satori/concepts/category-labels/.
//
// Storage layout: a single `category_labels` system blob under the satori
// configs collection that is game-scoped via Constants.gameKey().
namespace SatoriCategoryLabels {

  type LabelTarget = "flag" | "live_event" | "message" | "experiment" | "audience";

  interface LabelDef {
    id: string;          // slug, e.g. "monetization"
    name: string;        // display, e.g. "Monetization"
    color?: string;      // optional hex e.g. "#ff5733"
    description?: string;
    createdAt: number;
    updatedAt: number;
  }

  interface AssignmentMap {
    // key = `${target}:${entityId}` → array of label ids
    [key: string]: string[];
  }

  interface CategoryLabelsState {
    labels: { [id: string]: LabelDef };
    assignments: AssignmentMap;
  }

  var EMPTY_STATE: CategoryLabelsState = { labels: {}, assignments: {} };

  function load(nk: nkruntime.Nakama, gameId?: string): CategoryLabelsState {
    var raw = ConfigLoader.loadSatoriConfigForGame<CategoryLabelsState>(nk, "category_labels", gameId, EMPTY_STATE);
    if (!raw.labels) raw.labels = {};
    if (!raw.assignments) raw.assignments = {};
    return raw;
  }

  function save(nk: nkruntime.Nakama, state: CategoryLabelsState, gameId?: string): void {
    ConfigLoader.saveSatoriConfigForGame(nk, "category_labels", gameId, state);
  }

  function assignmentKey(target: LabelTarget, entityId: string): string {
    return target + ":" + entityId;
  }

  function isValidTarget(t: any): boolean {
    return t === "flag" || t === "live_event" || t === "message" || t === "experiment" || t === "audience";
  }

  // ----- Public helpers -----

  export function labelsForEntity(nk: nkruntime.Nakama, target: LabelTarget, entityId: string, gameId?: string): LabelDef[] {
    var state = load(nk, gameId);
    var ids = state.assignments[assignmentKey(target, entityId)] || [];
    var out: LabelDef[] = [];
    for (var i = 0; i < ids.length; i++) {
      var def = state.labels[ids[i]];
      if (def) out.push(def);
    }
    return out;
  }

  export function entitiesForLabel(nk: nkruntime.Nakama, target: LabelTarget, labelId: string, gameId?: string): string[] {
    var state = load(nk, gameId);
    var prefix = target + ":";
    var matches: string[] = [];
    for (var key in state.assignments) {
      if (!state.assignments.hasOwnProperty(key)) continue;
      if (key.indexOf(prefix) !== 0) continue;
      var ids = state.assignments[key];
      if (ids.indexOf(labelId) >= 0) matches.push(key.substr(prefix.length));
    }
    return matches;
  }

  // ----- RPCs -----

  function rpcList(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = RpcHelpers.parseRpcPayload(payload);
    var state = load(nk, RpcHelpers.gameId(data));
    var out: LabelDef[] = [];
    for (var id in state.labels) {
      if (state.labels.hasOwnProperty(id)) out.push(state.labels[id]);
    }
    return RpcHelpers.successResponse({ labels: out });
  }

  function rpcUpsert(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.id || !data.name) return RpcHelpers.errorResponse("id and name required");
    var gameId = RpcHelpers.gameId(data);
    var state = load(nk, gameId);
    var now = Math.floor(Date.now() / 1000);
    var existing = state.labels[data.id];
    state.labels[data.id] = {
      id: String(data.id),
      name: String(data.name),
      color: data.color,
      description: data.description,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now
    };
    save(nk, state, gameId);
    return RpcHelpers.successResponse({ label: state.labels[data.id] });
  }

  function rpcDelete(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.id) return RpcHelpers.errorResponse("id required");
    var gameId = RpcHelpers.gameId(data);
    var state = load(nk, gameId);
    delete state.labels[data.id];
    // detach from all assignments too
    for (var key in state.assignments) {
      if (!state.assignments.hasOwnProperty(key)) continue;
      state.assignments[key] = state.assignments[key].filter(function (lid) { return lid !== data.id; });
    }
    save(nk, state, gameId);
    return RpcHelpers.successResponse({ deleted: data.id });
  }

  function rpcAssign(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.target || !data.entityId || !data.labelIds) {
      return RpcHelpers.errorResponse("target, entityId, labelIds[] required");
    }
    if (!isValidTarget(data.target)) return RpcHelpers.errorResponse("target must be flag|live_event|message|experiment|audience");
    var gameId = RpcHelpers.gameId(data);
    var state = load(nk, gameId);
    var key = assignmentKey(data.target, String(data.entityId));
    var labelIds: string[] = Array.isArray(data.labelIds) ? data.labelIds.map(function (l: any) { return String(l); }) : [];
    // Validate every label exists; ignore unknowns rather than fail loudly.
    var resolved: string[] = [];
    for (var i = 0; i < labelIds.length; i++) {
      if (state.labels[labelIds[i]]) resolved.push(labelIds[i]);
    }
    state.assignments[key] = resolved;
    save(nk, state, gameId);
    return RpcHelpers.successResponse({ target: data.target, entityId: data.entityId, labels: resolved });
  }

  function rpcGetForEntity(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.target || !data.entityId) return RpcHelpers.errorResponse("target and entityId required");
    if (!isValidTarget(data.target)) return RpcHelpers.errorResponse("invalid target");
    var labels = labelsForEntity(nk, data.target, String(data.entityId), RpcHelpers.gameId(data));
    return RpcHelpers.successResponse({ target: data.target, entityId: data.entityId, labels: labels });
  }

  function rpcSearchByLabel(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.target || !data.labelId) return RpcHelpers.errorResponse("target and labelId required");
    if (!isValidTarget(data.target)) return RpcHelpers.errorResponse("invalid target");
    var entityIds = entitiesForLabel(nk, data.target, String(data.labelId), RpcHelpers.gameId(data));
    return RpcHelpers.successResponse({ target: data.target, labelId: data.labelId, entityIds: entityIds });
  }

  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("satori_category_labels_list", rpcList);
    initializer.registerRpc("satori_category_labels_upsert", rpcUpsert);
    initializer.registerRpc("satori_category_labels_delete", rpcDelete);
    initializer.registerRpc("satori_category_labels_assign", rpcAssign);
    initializer.registerRpc("satori_category_labels_get_for_entity", rpcGetForEntity);
    initializer.registerRpc("satori_category_labels_search", rpcSearchByLabel);
  }
}
