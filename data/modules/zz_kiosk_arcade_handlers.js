/**
 * Kiosk arcade authoritative match — cluster-routable joystick mailbox.
 *
 * Relayed matches (socket.createMatch) live in ONE Nakama replica's memory.
 * Join from another replica returns "Match not found". This handler is
 * created with nk.matchCreate so the match id is "uuid.node" and other
 * nodes forward the join.
 *
 * The TV is still the referee: READY, Spark/Bolt split, 10s reconnect, pay
 * freeze. This match only broadcasts opcodes 1–8. It does not simulate
 * Arcadian, mint coins, or vend KX- from RESULT / score.
 *
 * postbuild.js MATCH_HANDLERS must list these global function names.
 * Do not hand-edit data/modules/index.js.
 */
var KIOSK_ARCADE_TICK_HZ = 20;
var KIOSK_ARCADE_HOST_GRACE_TICKS = 90 * KIOSK_ARCADE_TICK_HZ;
var KIOSK_ARCADE_PHONE_GRACE_TICKS = 10 * KIOSK_ARCADE_TICK_HZ;
var KIOSK_ARCADE_EMPTY_TTL_TICKS = 30 * KIOSK_ARCADE_TICK_HZ;
var KIOSK_ARCADE_CREATE_WINDOW_MS = 60000;
var KIOSK_ARCADE_CREATE_MAX = 8;
var KIOSK_ARCADE_QUIZVERSE_ID = "126bf539";

function kioskArcadeTitleId(game) {
  if (game === "platformer") return "620f954b-94b5-4048-8b86-4762011ed4d7";
  if (game === "racing") return "91616e25-fe7b-483b-9bbb-383df7d696a5";
  if (game === "golfx") return "9bbd1886-d779-4543-ba75-d8ef0113bf99";
  if (game === "chess") return "279e154b-0549-470e-ad41-76dddd78b99e";
  if (game === "snakewars") return "ba003fe4-8888-48bc-8c2a-d27c17b93b39";
  return "";
}

function kioskArcadeJoinCap(game) {
  if (game === "platformer") return 3;
  if (game === "racing") return 3;
  if (game === "golfx") return 2;
  return 3;
}

function kioskArcadeOpcodeOk(op) {
  var n = Number(op);
  return n >= 1 && n <= 8;
}

function kioskArcadeMeta(metadata, presence) {
  var meta = metadata;
  if (!meta && presence) meta = presence.metadata;
  if (!meta || typeof meta !== "object") return {};
  return meta;
}

function kioskArcadeIsObserver(metadata, presence) {
  var meta = kioskArcadeMeta(metadata, presence);
  if (meta.observer === true || meta.observer === "true" || meta.observer === 1) return true;
  if (meta.integrity === true || meta.integrity === "true") return true;
  return String(meta.role || "") === "observer";
}

function kioskArcadeGraceTicks(role) {
  return role === "host" ? KIOSK_ARCADE_HOST_GRACE_TICKS : KIOSK_ARCADE_PHONE_GRACE_TICKS;
}

function kioskArcadeSeatHeld(seat, tick) {
  if (!seat || seat.observer) return false;
  if (seat.present) return true;
  var left = seat.leftTick || 0;
  if (!left) return false;
  return tick - left < kioskArcadeGraceTicks(seat.role);
}

function kioskArcadeOccupied(state, tick) {
  var seats = (state && state.seats) ? state.seats : {};
  var n = 0;
  var id;
  for (id in seats) {
    if (!seats.hasOwnProperty(id)) continue;
    if (kioskArcadeSeatHeld(seats[id], tick)) n++;
  }
  return n;
}

function kioskArcadeEnsureSeats(state) {
  if (!state.seats) state.seats = {};
  return state.seats;
}

function kioskArcadeSweepSeats(state, tick) {
  var seats = kioskArcadeEnsureSeats(state);
  var id;
  for (id in seats) {
    if (!seats.hasOwnProperty(id)) continue;
    var seat = seats[id];
    if (seat.present || kioskArcadeSeatHeld(seat, tick)) continue;
    if (state.driverUserId === id) state.driverUserId = "";
    if (state.pitUserId === id) state.pitUserId = "";
    delete seats[id];
  }
  if (state.game === "racing" && !state.driverUserId && state.pitUserId) {
    var pit = seats[state.pitUserId];
    if (pit && kioskArcadeSeatHeld(pit, tick)) {
      pit.role = "driver";
      pit.pitOrdinal = 0;
      state.driverUserId = state.pitUserId;
      state.pitUserId = "";
    }
  }
}

function kioskArcadeSanitizeMachine(raw) {
  var s = String(raw || "");
  var out = "";
  var i;
  for (i = 0; i < s.length && out.length < 32; i++) {
    var c = s.charAt(i);
    if ((c >= "0" && c <= "9") || (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "-" || c === "_") {
      out += c;
    }
  }
  return out;
}

function kioskArcadeMatchLabel(game, titleId, machineNo) {
  var title = titleId || kioskArcadeTitleId(game);
  if (title.indexOf(KIOSK_ARCADE_QUIZVERSE_ID) === 0) title = kioskArcadeTitleId(game);
  var machine = kioskArcadeSanitizeMachine(machineNo);
  var label = "kiosk:" + game + ":t=" + title;
  if (machine) label += ":m=" + machine;
  if (label.length > 256) label = label.substring(0, 256);
  return label;
}

function kioskArcadeAssignPhone(state, userId) {
  var seats = kioskArcadeEnsureSeats(state);
  var seat = seats[userId];
  if (state.game === "racing") {
    if (!state.driverUserId || state.driverUserId === userId) {
      state.driverUserId = userId;
      seat.role = "driver";
      seat.pitOrdinal = 0;
      return;
    }
    if (!state.pitUserId || state.pitUserId === userId) {
      state.pitUserId = userId;
      seat.role = "pit";
      seat.pitOrdinal = 1;
      return;
    }
  }
  seat.role = "phone";
  seat.pitOrdinal = 0;
}

function kioskArcadeRateLimited(nk, userId) {
  if (!nk || !userId) return false;
  var now = Date.now();
  var objects = [];
  try {
    objects = nk.storageRead([{ collection: "kiosk_arcade", key: "create_" + userId, userId: userId }]) || [];
  } catch (e) {
    return false;
  }
  var stamps = [];
  if (objects.length && objects[0] && objects[0].value && objects[0].value.t) {
    stamps = objects[0].value.t;
  }
  var fresh = [];
  var i;
  for (i = 0; i < stamps.length; i++) {
    if (now - stamps[i] < KIOSK_ARCADE_CREATE_WINDOW_MS) fresh.push(stamps[i]);
  }
  if (fresh.length >= KIOSK_ARCADE_CREATE_MAX) return true;
  fresh.push(now);
  try {
    nk.storageWrite([{
      collection: "kiosk_arcade",
      key: "create_" + userId,
      userId: userId,
      value: { t: fresh },
      permissionRead: 0,
      permissionWrite: 0
    }]);
  } catch (e2) { /* keep the create; storage is best-effort */ }
  return false;
}

function kioskArcadeMatchInit(ctx, logger, nk, params) {
  var game = (params && params.game) ? String(params.game) : "golfx";
  var titleId = kioskArcadeTitleId(game);
  var machineNo = kioskArcadeSanitizeMachine(params && params.machineNo);
  logger.info("[kiosk-arcade] init game=" + game + " title=" + titleId + " machine=" + machineNo);
  return {
    state: {
      game: game,
      titleId: titleId,
      machineNo: machineNo,
      hostUserId: (params && params.hostUserId) ? String(params.hostUserId) : "",
      seats: {},
      driverUserId: "",
      pitUserId: "",
      createdTick: 0
    },
    tickRate: KIOSK_ARCADE_TICK_HZ,
    label: kioskArcadeMatchLabel(game, titleId, machineNo)
  };
}

function kioskArcadeMatchJoinAttempt(ctx, logger, nk, dispatcher, tick, state, presence, metadata) {
  kioskArcadeSweepSeats(state, tick);
  var userId = presence && presence.userId ? String(presence.userId) : "";
  if (kioskArcadeIsObserver(metadata, presence)) {
    return { state: state, accept: true };
  }
  var seats = kioskArcadeEnsureSeats(state);
  if (userId && kioskArcadeSeatHeld(seats[userId], tick)) {
    return { state: state, accept: true };
  }
  var cap = kioskArcadeJoinCap(state.game);
  if (kioskArcadeOccupied(state, tick) >= cap) {
    logger.info("[kiosk-arcade] reject join game=" + state.game + " cap=" + cap + " user=" + userId);
    return { state: state, accept: false };
  }
  return { state: state, accept: true };
}

function kioskArcadeMatchJoin(ctx, logger, nk, dispatcher, tick, state, presences) {
  var seats = kioskArcadeEnsureSeats(state);
  var i;
  for (i = 0; i < (presences ? presences.length : 0); i++) {
    var p = presences[i];
    var userId = p && p.userId ? String(p.userId) : "";
    if (!userId) continue;
    if (kioskArcadeIsObserver(p.metadata, p)) {
      seats[userId] = { role: "observer", present: true, leftTick: 0, observer: true, pitOrdinal: 0 };
      continue;
    }
    var existing = seats[userId];
    var isHost = userId === state.hostUserId || (existing && existing.role === "host") || (!state.hostUserId && kioskArcadeOccupied(state, tick) === 0);
    if (!existing) {
      seats[userId] = { role: isHost ? "host" : "phone", present: true, leftTick: 0, observer: false, pitOrdinal: 0 };
      if (isHost) {
        if (!state.hostUserId) state.hostUserId = userId;
      } else {
        kioskArcadeAssignPhone(state, userId);
      }
    } else {
      existing.present = true;
      existing.leftTick = 0;
      if (isHost) existing.role = "host";
    }
  }
  state.lastPresentTick = tick;
  if (!state.createdTick) state.createdTick = tick;
  return { state: state };
}

function kioskArcadeMatchLeave(ctx, logger, nk, dispatcher, tick, state, presences) {
  var seats = kioskArcadeEnsureSeats(state);
  var i;
  for (i = 0; i < (presences ? presences.length : 0); i++) {
    var p = presences[i];
    var userId = p && p.userId ? String(p.userId) : "";
    if (!userId || !seats[userId]) continue;
    if (seats[userId].observer) {
      delete seats[userId];
      continue;
    }
    seats[userId].present = false;
    seats[userId].leftTick = tick;
  }
  return { state: state };
}

function kioskArcadeMatchLoop(ctx, logger, nk, dispatcher, tick, state, messages) {
  kioskArcadeSweepSeats(state, tick);
  if (!state.createdTick) state.createdTick = tick;
  if (kioskArcadeOccupied(state, tick) === 0 && tick - state.createdTick >= KIOSK_ARCADE_EMPTY_TTL_TICKS) {
    return { state: null };
  }
  var i;
  for (i = 0; i < messages.length; i++) {
    var m = messages[i];
    if (!kioskArcadeOpcodeOk(m.opCode)) continue;
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
  if (!kioskArcadeTitleId(game)) game = "golfx";
  if (kioskArcadeRateLimited(nk, ctx.userId || "")) {
    throw new Error("kiosk arcade create rate limited");
  }
  var machineNo = kioskArcadeSanitizeMachine(req.machineNo || req.machine || "");
  var matchId = nk.matchCreate("kiosk-arcade-v1", {
    game: game,
    hostUserId: ctx.userId || "",
    machineNo: machineNo,
    titleId: kioskArcadeTitleId(game)
  });
  logger.info("[kiosk-arcade] created " + matchId + " game=" + game + " machine=" + machineNo);
  return JSON.stringify({
    matchId: matchId,
    match_id: matchId,
    game: game,
    titleId: kioskArcadeTitleId(game),
    machineNo: machineNo
  });
}

function InitModule(ctx, logger, nk, initializer) {
  initializer.registerRpc("kiosk_arcade_create", rpcKioskArcadeCreate);
}
