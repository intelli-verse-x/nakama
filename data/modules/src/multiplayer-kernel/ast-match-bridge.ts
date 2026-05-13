// AST-compatible MatchHandler bridge.
//
// Nakama extracts JS match hook names from direct object literals inside
// InitModule. The kernel still builds handlers from templates, but these
// global hook functions give Nakama stable names to register.

function __mpTemplateIdFromParams(params: { [key: string]: any }): string {
  return (params && (params.template_id || params.templateId)) ? String(params.template_id || params.templateId) : "";
}

function __mpMatchInit(templateId: string, ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, params: { [key: string]: any }) {
  MpKernelModule.prepareTemplates(logger);
  if (typeof QuizVersePlugin !== "undefined") {
    QuizVersePlugin.prepareGenerators(nk, logger);
  }
  return MpKernelMatch.handlerFor(templateId).matchInit(ctx, logger, nk, params);
}

function __mpMatchJoinAttempt(templateId: string, ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: any, presence: nkruntime.Presence, metadata: { [key: string]: string }) {
  return MpKernelMatch.handlerFor(templateId).matchJoinAttempt(ctx, logger, nk, dispatcher, tick, state, presence, metadata);
}

function __mpMatchJoin(templateId: string, ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: any, presences: nkruntime.Presence[]) {
  return MpKernelMatch.handlerFor(templateId).matchJoin(ctx, logger, nk, dispatcher, tick, state, presences);
}

function __mpMatchLeave(templateId: string, ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: any, presences: nkruntime.Presence[]) {
  return MpKernelMatch.handlerFor(templateId).matchLeave(ctx, logger, nk, dispatcher, tick, state, presences);
}

function __mpMatchLoop(templateId: string, ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: any, messages: nkruntime.MatchMessage[]) {
  return MpKernelMatch.handlerFor(templateId).matchLoop(ctx, logger, nk, dispatcher, tick, state, messages);
}

function __mpMatchTerminate(templateId: string, ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: any, graceSeconds: number) {
  return MpKernelMatch.handlerFor(templateId).matchTerminate(ctx, logger, nk, dispatcher, tick, state, graceSeconds);
}

function __mpMatchSignal(templateId: string, ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: any, data: string) {
  return MpKernelMatch.handlerFor(templateId).matchSignal(ctx, logger, nk, dispatcher, tick, state, data);
}

function matchInit(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, params: { [key: string]: any }) { return __mpMatchInit(__mpTemplateIdFromParams(params), ctx, logger, nk, params); }
function matchJoinAttempt(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: any, presence: nkruntime.Presence, metadata: { [key: string]: string }) { return __mpMatchJoinAttempt(state.template_id, ctx, logger, nk, dispatcher, tick, state, presence, metadata); }
function matchJoin(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: any, presences: nkruntime.Presence[]) { return __mpMatchJoin(state.template_id, ctx, logger, nk, dispatcher, tick, state, presences); }
function matchLeave(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: any, presences: nkruntime.Presence[]) { return __mpMatchLeave(state.template_id, ctx, logger, nk, dispatcher, tick, state, presences); }
function matchLoop(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: any, messages: nkruntime.MatchMessage[]) { return __mpMatchLoop(state.template_id, ctx, logger, nk, dispatcher, tick, state, messages); }
function matchTerminate(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: any, graceSeconds: number) { return __mpMatchTerminate(state.template_id, ctx, logger, nk, dispatcher, tick, state, graceSeconds); }
function matchSignal(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: any, data: string) { return __mpMatchSignal(state.template_id, ctx, logger, nk, dispatcher, tick, state, data); }

function __mpSyncTurnMatchInit(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, params: { [key: string]: any }) { return __mpMatchInit("sync-turn-v1", ctx, logger, nk, params); }
function __mpSyncTurnMatchJoinAttempt(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: any, presence: nkruntime.Presence, metadata: { [key: string]: string }) { return __mpMatchJoinAttempt("sync-turn-v1", ctx, logger, nk, dispatcher, tick, state, presence, metadata); }
function __mpSyncTurnMatchJoin(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: any, presences: nkruntime.Presence[]) { return __mpMatchJoin("sync-turn-v1", ctx, logger, nk, dispatcher, tick, state, presences); }
function __mpSyncTurnMatchLeave(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: any, presences: nkruntime.Presence[]) { return __mpMatchLeave("sync-turn-v1", ctx, logger, nk, dispatcher, tick, state, presences); }
function __mpSyncTurnMatchLoop(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: any, messages: nkruntime.MatchMessage[]) { return __mpMatchLoop("sync-turn-v1", ctx, logger, nk, dispatcher, tick, state, messages); }
function __mpSyncTurnMatchTerminate(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: any, graceSeconds: number) { return __mpMatchTerminate("sync-turn-v1", ctx, logger, nk, dispatcher, tick, state, graceSeconds); }
function __mpSyncTurnMatchSignal(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: any, data: string) { return __mpMatchSignal("sync-turn-v1", ctx, logger, nk, dispatcher, tick, state, data); }

function __mpAsyncTurnMatchInit(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, params: { [key: string]: any }) { return __mpMatchInit("async-turn-v1", ctx, logger, nk, params); }
function __mpAsyncTurnMatchJoinAttempt(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: any, presence: nkruntime.Presence, metadata: { [key: string]: string }) { return __mpMatchJoinAttempt("async-turn-v1", ctx, logger, nk, dispatcher, tick, state, presence, metadata); }
function __mpAsyncTurnMatchJoin(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: any, presences: nkruntime.Presence[]) { return __mpMatchJoin("async-turn-v1", ctx, logger, nk, dispatcher, tick, state, presences); }
function __mpAsyncTurnMatchLeave(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: any, presences: nkruntime.Presence[]) { return __mpMatchLeave("async-turn-v1", ctx, logger, nk, dispatcher, tick, state, presences); }
function __mpAsyncTurnMatchLoop(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: any, messages: nkruntime.MatchMessage[]) { return __mpMatchLoop("async-turn-v1", ctx, logger, nk, dispatcher, tick, state, messages); }
function __mpAsyncTurnMatchTerminate(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: any, graceSeconds: number) { return __mpMatchTerminate("async-turn-v1", ctx, logger, nk, dispatcher, tick, state, graceSeconds); }
function __mpAsyncTurnMatchSignal(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, dispatcher: nkruntime.MatchDispatcher, tick: number, state: any, data: string) { return __mpMatchSignal("async-turn-v1", ctx, logger, nk, dispatcher, tick, state, data); }
