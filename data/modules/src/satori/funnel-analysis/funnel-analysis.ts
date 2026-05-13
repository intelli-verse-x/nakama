// Satori Funnel Analysis — multi-step conversion funnels built from captured
// analytic events. Mirrors
// https://heroiclabs.com/docs/satori/concepts/performance-monitoring/build-funnel-analysis/
//
// Each funnel definition is a list of steps where each step is an event name
// (and optional metadata predicate). For a query window, we count the number
// of distinct users who completed up to step N in order. Step counts and
// drop-off percentages are returned per step.
//
// Backed by `satori_events` storage scanned per game window. For prod scale
// you'd index into a column store; this in-runtime evaluation works for
// debug/console use and small/medium volumes.
namespace SatoriFunnelAnalysis {

  interface FunnelStep {
    name: string;            // human label
    eventName: string;       // taxonomy event
    metadataMatches?: { [key: string]: string }; // require these metadata k/v
  }

  interface FunnelDef {
    id: string;
    name: string;
    description?: string;
    steps: FunnelStep[];
    audienceId?: string;
    timeWindowSec?: number;  // max gap between consecutive steps for a user (default = none)
    createdAt: number;
    updatedAt: number;
  }

  interface FunnelStateConfig {
    funnels: { [id: string]: FunnelDef };
  }

  interface StepResult {
    name: string;
    eventName: string;
    count: number;
    conversionFromPreviousPct: number;
    conversionFromStartPct: number;
  }

  interface FunnelReport {
    funnelId: string;
    funnelName: string;
    rangeStartMs: number;
    rangeEndMs: number;
    totalUsersEntered: number;
    steps: StepResult[];
    dropoffStepIndex: number; // step with largest drop-off
  }

  function loadFunnels(nk: nkruntime.Nakama, gameId?: string): FunnelStateConfig {
    return ConfigLoader.loadSatoriConfigForGame<FunnelStateConfig>(nk, "funnels", gameId, { funnels: {} });
  }

  function saveFunnels(nk: nkruntime.Nakama, cfg: FunnelStateConfig, gameId?: string): void {
    ConfigLoader.saveSatoriConfigForGame(nk, "funnels", gameId, cfg);
  }

  // Read at most `limit` event records via storageList. The scan is bounded
  // to `MAX_EVENTS_SCANNED` per call so a single funnel query can't pin the
  // runtime; production would back-fill from data lake exports.
  var MAX_EVENTS_SCANNED = 10000;

  function scanEvents(nk: nkruntime.Nakama, fromMs: number, toMs: number): any[] {
    var collected: any[] = [];
    var cursor: string | undefined = undefined;
    var pages = 0;
    while (collected.length < MAX_EVENTS_SCANNED && pages < 50) {
      var page = nk.storageList(
        Constants.SYSTEM_USER_ID,
        Constants.SATORI_EVENTS_COLLECTION,
        200,
        cursor || ""
      );
      pages++;
      if (!page.objects || page.objects.length === 0) break;
      for (var i = 0; i < page.objects.length; i++) {
        var v = page.objects[i].value as any;
        if (!v || !v.timestamp) continue;
        if (v.timestamp >= fromMs && v.timestamp <= toMs) collected.push(v);
      }
      if (!page.cursor) break;
      cursor = page.cursor;
    }
    return collected;
  }

  function metadataMatches(eventMeta: any, required?: { [key: string]: string }): boolean {
    if (!required) return true;
    if (!eventMeta) return false;
    for (var k in required) {
      if (!required.hasOwnProperty(k)) continue;
      if (String(eventMeta[k]) !== String(required[k])) return false;
    }
    return true;
  }

  // Build the funnel report from a set of events. For each user, we walk
  // their event timeline (sorted by ts) and progress their stepIndex when
  // the current step is satisfied. If `timeWindowSec` is set, the next step
  // must arrive within that window of the previous step.
  function computeReport(funnel: FunnelDef, events: any[]): { perStep: { [step: number]: { [userId: string]: boolean } }; entered: { [userId: string]: boolean } } {
    var byUser: { [user: string]: any[] } = {};
    for (var i = 0; i < events.length; i++) {
      var ev = events[i];
      var uid = String(ev.userId || ev.identityId || "anon");
      if (!byUser[uid]) byUser[uid] = [];
      byUser[uid].push(ev);
    }

    var entered: { [u: string]: boolean } = {};
    var perStep: { [step: number]: { [u: string]: boolean } } = {};
    for (var s = 0; s < funnel.steps.length; s++) perStep[s] = {};

    var windowMs = (funnel.timeWindowSec || 0) * 1000;

    for (var uid2 in byUser) {
      if (!byUser.hasOwnProperty(uid2)) continue;
      var stream = byUser[uid2];
      stream.sort(function (a, b) { return a.timestamp - b.timestamp; });
      var stepIdx = 0;
      var lastTs = 0;
      for (var k = 0; k < stream.length && stepIdx < funnel.steps.length; k++) {
        var e = stream[k];
        var step = funnel.steps[stepIdx];
        if (e.name !== step.eventName) continue;
        if (!metadataMatches(e.metadata, step.metadataMatches)) continue;
        if (stepIdx > 0 && windowMs > 0 && (e.timestamp - lastTs) > windowMs) {
          // window expired — restart from step 0 and re-test current event
          stepIdx = 0;
          lastTs = 0;
          if (e.name === funnel.steps[0].eventName && metadataMatches(e.metadata, funnel.steps[0].metadataMatches)) {
            entered[uid2] = true;
            perStep[0][uid2] = true;
            stepIdx = 1;
            lastTs = e.timestamp;
          }
          continue;
        }
        if (stepIdx === 0) entered[uid2] = true;
        perStep[stepIdx][uid2] = true;
        stepIdx++;
        lastTs = e.timestamp;
      }
    }
    return { perStep: perStep, entered: entered };
  }

  export function runFunnel(nk: nkruntime.Nakama, funnel: FunnelDef, fromMs: number, toMs: number): FunnelReport {
    var events = scanEvents(nk, fromMs, toMs);
    var report = computeReport(funnel, events);
    var stepResults: StepResult[] = [];
    var counts: number[] = [];
    for (var s = 0; s < funnel.steps.length; s++) {
      var n = 0;
      for (var u in report.perStep[s]) if (report.perStep[s].hasOwnProperty(u)) n++;
      counts.push(n);
    }
    var firstCount = counts[0] || 0;
    var biggestDrop = -1;
    var dropIdx = 0;
    for (var s2 = 0; s2 < funnel.steps.length; s2++) {
      var prev = s2 === 0 ? counts[0] : counts[s2 - 1];
      var fromPrevPct = prev > 0 ? Math.round((counts[s2] / prev) * 10000) / 100 : 0;
      var fromStartPct = firstCount > 0 ? Math.round((counts[s2] / firstCount) * 10000) / 100 : 0;
      var drop = (s2 === 0) ? 0 : (prev - counts[s2]);
      if (drop > biggestDrop) { biggestDrop = drop; dropIdx = s2; }
      stepResults.push({
        name: funnel.steps[s2].name,
        eventName: funnel.steps[s2].eventName,
        count: counts[s2],
        conversionFromPreviousPct: fromPrevPct,
        conversionFromStartPct: fromStartPct
      });
    }
    return {
      funnelId: funnel.id,
      funnelName: funnel.name,
      rangeStartMs: fromMs,
      rangeEndMs: toMs,
      totalUsersEntered: firstCount,
      steps: stepResults,
      dropoffStepIndex: dropIdx
    };
  }

  // ----- RPCs -----

  function rpcList(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = RpcHelpers.parseRpcPayload(payload);
    var state = loadFunnels(nk, RpcHelpers.gameId(data));
    var out: FunnelDef[] = [];
    for (var id in state.funnels) if (state.funnels.hasOwnProperty(id)) out.push(state.funnels[id]);
    return RpcHelpers.successResponse({ funnels: out });
  }

  function rpcUpsert(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.id || !data.name || !Array.isArray(data.steps) || data.steps.length < 2) {
      return RpcHelpers.errorResponse("id, name, and steps[>=2] required");
    }
    for (var i = 0; i < data.steps.length; i++) {
      if (!data.steps[i] || !data.steps[i].eventName) {
        return RpcHelpers.errorResponse("steps[" + i + "] missing eventName");
      }
    }
    var gameId = RpcHelpers.gameId(data);
    var state = loadFunnels(nk, gameId);
    var now = Math.floor(Date.now() / 1000);
    var existing = state.funnels[data.id];
    state.funnels[data.id] = {
      id: String(data.id),
      name: String(data.name),
      description: data.description,
      steps: data.steps,
      audienceId: data.audienceId,
      timeWindowSec: data.timeWindowSec,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now
    };
    saveFunnels(nk, state, gameId);
    return RpcHelpers.successResponse({ funnel: state.funnels[data.id] });
  }

  function rpcDelete(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.id) return RpcHelpers.errorResponse("id required");
    var gameId = RpcHelpers.gameId(data);
    var state = loadFunnels(nk, gameId);
    delete state.funnels[data.id];
    saveFunnels(nk, state, gameId);
    return RpcHelpers.successResponse({ deleted: data.id });
  }

  function rpcRun(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.funnelId) return RpcHelpers.errorResponse("funnelId required");
    var gameId = RpcHelpers.gameId(data);
    var state = loadFunnels(nk, gameId);
    var funnel = state.funnels[data.funnelId];
    if (!funnel) return RpcHelpers.errorResponse("funnel not found");
    var nowMs = Date.now();
    var fromMs = data.fromMs || (nowMs - 7 * 86400000);
    var toMs = data.toMs || nowMs;
    var report = runFunnel(nk, funnel, fromMs, toMs);
    return RpcHelpers.successResponse(report);
  }

  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("satori_funnel_list", rpcList);
    initializer.registerRpc("satori_funnel_upsert", rpcUpsert);
    initializer.registerRpc("satori_funnel_delete", rpcDelete);
    initializer.registerRpc("satori_funnel_run", rpcRun);
  }
}
