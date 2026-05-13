// Satori Experiment Phases — management API for multi-phase experiments,
// matching https://heroiclabs.com/docs/satori/concepts/experiments/sequence-phases/
//
// The base SatoriExperiments runtime already understands `def.phases` at
// variant resolution time. This module manages the lifecycle:
//   - add a new phase to an existing experiment definition
//   - update an existing phase (date range, variant weights, values)
//   - remove a phase
//   - lock enrollment mid-experiment (admissionDeadline / lockParticipation)
//
// Each operation rewrites the experiment definition stored in the satori
// configs collection.
namespace SatoriExperimentPhases {

  interface PhaseDef {
    id: string;
    name?: string;
    startAt: number;            // unix seconds
    endAt: number;              // unix seconds
    variants: any[];            // ExperimentVariant[]; weights override base
    notes?: string;
  }

  function loadAll(nk: nkruntime.Nakama, gameId?: string): { [id: string]: any } {
    return ConfigLoader.loadSatoriConfigForGame<{ [id: string]: any }>(nk, "experiments", gameId, {});
  }

  function saveAll(nk: nkruntime.Nakama, all: { [id: string]: any }, gameId?: string): void {
    ConfigLoader.saveSatoriConfigForGame(nk, "experiments", gameId, all);
  }

  function getDef(nk: nkruntime.Nakama, experimentId: string, gameId?: string): any | null {
    var all = loadAll(nk, gameId);
    return all[experimentId] || null;
  }

  function ensurePhases(def: any): any {
    if (!Array.isArray(def.phases)) def.phases = [];
    return def;
  }

  function validatePhase(p: any): string | null {
    if (!p || !p.id) return "phase id required";
    if (!p.startAt || !p.endAt) return "startAt and endAt (unix seconds) required";
    if (p.endAt <= p.startAt) return "endAt must be > startAt";
    if (!Array.isArray(p.variants) || p.variants.length === 0) return "variants[] required";
    for (var i = 0; i < p.variants.length; i++) {
      if (!p.variants[i] || !p.variants[i].id) return "variants[" + i + "].id required";
    }
    return null;
  }

  // ----- RPCs -----

  function rpcListPhases(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.experimentId) return RpcHelpers.errorResponse("experimentId required");
    var def = getDef(nk, String(data.experimentId), RpcHelpers.gameId(data));
    if (!def) return RpcHelpers.errorResponse("experiment not found");
    return RpcHelpers.successResponse({ experimentId: data.experimentId, phases: def.phases || [] });
  }

  function rpcAddPhase(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.experimentId || !data.phase) return RpcHelpers.errorResponse("experimentId and phase{} required");
    var phaseErr = validatePhase(data.phase);
    if (phaseErr) return RpcHelpers.errorResponse(phaseErr);
    var gameId = RpcHelpers.gameId(data);
    var all = loadAll(nk, gameId);
    var def = all[data.experimentId];
    if (!def) return RpcHelpers.errorResponse("experiment not found");
    ensurePhases(def);
    // overwrite if same id, else append
    var found = -1;
    for (var i = 0; i < def.phases.length; i++) if (def.phases[i].id === data.phase.id) { found = i; break; }
    if (found >= 0) def.phases[found] = data.phase;
    else def.phases.push(data.phase);
    // keep sorted by startAt
    def.phases.sort(function (a: any, b: any) { return a.startAt - b.startAt; });
    def.updatedAt = Math.floor(Date.now() / 1000);
    all[data.experimentId] = def;
    saveAll(nk, all, gameId);
    return RpcHelpers.successResponse({ phases: def.phases });
  }

  function rpcRemovePhase(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.experimentId || !data.phaseId) return RpcHelpers.errorResponse("experimentId and phaseId required");
    var gameId = RpcHelpers.gameId(data);
    var all = loadAll(nk, gameId);
    var def = all[data.experimentId];
    if (!def) return RpcHelpers.errorResponse("experiment not found");
    ensurePhases(def);
    def.phases = def.phases.filter(function (p: PhaseDef) { return p.id !== data.phaseId; });
    def.updatedAt = Math.floor(Date.now() / 1000);
    all[data.experimentId] = def;
    saveAll(nk, all, gameId);
    return RpcHelpers.successResponse({ phases: def.phases });
  }

  function rpcLockEnrollment(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    RpcHelpers.requireAdmin(ctx, nk);
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.experimentId) return RpcHelpers.errorResponse("experimentId required");
    var gameId = RpcHelpers.gameId(data);
    var all = loadAll(nk, gameId);
    var def = all[data.experimentId];
    if (!def) return RpcHelpers.errorResponse("experiment not found");
    if (data.admissionDeadline !== undefined) def.admissionDeadline = parseInt(String(data.admissionDeadline), 10);
    if (data.lockParticipation !== undefined) def.lockParticipation = !!data.lockParticipation;
    if (data.maxParticipants !== undefined) def.maxParticipants = parseInt(String(data.maxParticipants), 10);
    def.updatedAt = Math.floor(Date.now() / 1000);
    all[data.experimentId] = def;
    saveAll(nk, all, gameId);
    return RpcHelpers.successResponse({
      experimentId: data.experimentId,
      admissionDeadline: def.admissionDeadline,
      lockParticipation: def.lockParticipation,
      maxParticipants: def.maxParticipants
    });
  }

  function rpcCurrentPhase(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var data = RpcHelpers.parseRpcPayload(payload);
    if (!data.experimentId) return RpcHelpers.errorResponse("experimentId required");
    var def = getDef(nk, String(data.experimentId), RpcHelpers.gameId(data));
    if (!def) return RpcHelpers.errorResponse("experiment not found");
    var nowSec = Math.floor(Date.now() / 1000);
    var current: PhaseDef | null = null;
    if (Array.isArray(def.phases)) {
      for (var i = 0; i < def.phases.length; i++) {
        if (nowSec >= def.phases[i].startAt && nowSec <= def.phases[i].endAt) {
          current = def.phases[i];
          break;
        }
      }
    }
    return RpcHelpers.successResponse({
      experimentId: data.experimentId,
      currentPhase: current,
      currentTimestampSec: nowSec
    });
  }

  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("satori_experiments_phases_list", rpcListPhases);
    initializer.registerRpc("satori_experiments_phase_add", rpcAddPhase);
    initializer.registerRpc("satori_experiments_phase_remove", rpcRemovePhase);
    initializer.registerRpc("satori_experiments_lock_enrollment", rpcLockEnrollment);
    initializer.registerRpc("satori_experiments_current_phase", rpcCurrentPhase);
  }
}
