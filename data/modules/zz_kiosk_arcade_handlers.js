/**
 * Kiosk arcade authoritative match — cluster-routable joystick relay.
 *
 * Relayed matches (socket.createMatch) live in ONE Nakama replica's memory.
 * Join from another replica returns "Match not found". This handler is
 * created with nk.matchCreate so the match id is "uuid.node" and other
 * nodes forward the join.
 *
 * Tick loop copies client match data to everyone else — same contract as
 * a relayed match (GolfX opcodes 1–8).
 *
 * postbuild.js MATCH_HANDLERS must list these global function names.
 */
function kioskArcadeMatchInit(ctx, logger, nk, params) {
  var game = (params && params.game) ? String(params.game) : "golfx";
  logger.info("[kiosk-arcade] init game=" + game);
  return {
    state: { game: game, hostUserId: (params && params.hostUserId) ? String(params.hostUserId) : "", playerCount: 0 },
    tickRate: 20,
    label: "kiosk:" + game
  };
}

function kioskArcadeMatchJoinAttempt(ctx, logger, nk, dispatcher, tick, state, presence, metadata) {
  if (state && state.playerCount >= 8) {
    return { state: state, accept: false };
  }
  return { state: state, accept: true };
}

function kioskArcadeMatchJoin(ctx, logger, nk, dispatcher, tick, state, presences) {
  state.playerCount = (state.playerCount || 0) + (presences ? presences.length : 0);
  return { state: state };
}

function kioskArcadeMatchLeave(ctx, logger, nk, dispatcher, tick, state, presences) {
  var n = presences ? presences.length : 0;
  var next = (state.playerCount || 0) - n;
  state.playerCount = next > 0 ? next : 0;
  return { state: state };
}

function kioskArcadeMatchLoop(ctx, logger, nk, dispatcher, tick, state, messages) {
  var i;
  for (i = 0; i < messages.length; i++) {
    var m = messages[i];
    dispatcher.broadcastMessage(m.opCode, m.data, null, m.sender, true);
  }
  return { state: state };
}

function kioskArcadeMatchTerminate(ctx, logger, nk, dispatcher, tick, state, graceSeconds) {
  return { state: state };
}

function kioskArcadeMatchSignal(ctx, logger, nk, dispatcher, tick, state, data) {
  return { state: state, data: data };
}

function rpcKioskArcadeCreate(ctx, logger, nk, payload) {
  var req = {};
  try { req = JSON.parse(payload || "{}"); } catch (e) { req = {}; }
  var game = String(req.game || "golfx");
  var matchId = nk.matchCreate("kiosk-arcade-v1", {
    game: game,
    hostUserId: ctx.userId || ""
  });
  logger.info("[kiosk-arcade] created " + matchId + " game=" + game);
  return JSON.stringify({ matchId: matchId, match_id: matchId, game: game });
}

function InitModule(ctx, logger, nk, initializer) {
  initializer.registerRpc("kiosk_arcade_create", rpcKioskArcadeCreate);
}
