#!/usr/bin/env node
// =============================================================================
// test_kiosk_arcade_match.js
// =============================================================================
// Pure-function tests for zz_kiosk_arcade_handlers.js (Goja mailbox match).
// Run with:  node data/modules/tests/test_kiosk_arcade_match.js
//
// Shebang keeps postbuild from merging this file into index.js.
// Do NOT hand-edit data/modules/index.js.
// =============================================================================

var fs = require("fs");
var path = require("path");
var vm = require("vm");
var assert = require("assert");

var ROOT = path.join(__dirname, "..");
var SRC = fs.readFileSync(path.join(ROOT, "zz_kiosk_arcade_handlers.js"), "utf8");
var INDEX = fs.readFileSync(path.join(ROOT, "index.js"), "utf8");

var g = { console: console };
vm.createContext(g);
vm.runInContext(SRC, g);

var failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log("ok  " + name);
  } catch (e) {
    failed++;
    console.log("FAIL  " + name);
    console.log("  " + (e && e.stack ? e.stack : e));
  }
}

function logger() {
  return { info: function () {}, error: function () {}, warn: function () {} };
}

function presence(userId, metadata) {
  return { userId: userId, sessionId: userId + "-s", username: userId, metadata: metadata || {} };
}

function init(game, hostUserId, machineNo) {
  return g.kioskArcadeMatchInit({}, logger(), {}, {
    game: game,
    hostUserId: hostUserId || "tv",
    machineNo: machineNo || ""
  });
}

function joinAttempt(state, user, tick, metadata) {
  return g.kioskArcadeMatchJoinAttempt({}, logger(), {}, {}, tick || 1, state, presence(user, metadata), metadata || {});
}

function join(state, users, tick) {
  var presences = users.map(function (u) {
    return typeof u === "string" ? presence(u) : presence(u.userId, u.metadata);
  });
  return g.kioskArcadeMatchJoin({}, logger(), {}, {}, tick || 1, state, presences);
}

function leave(state, users, tick) {
  var presences = users.map(function (u) { return presence(u); });
  return g.kioskArcadeMatchLeave({}, logger(), {}, {}, tick || 1, state, presences);
}

test("registerRpc is in generated index.js", function () {
  assert.ok(INDEX.indexOf('initializer.registerRpc("kiosk_arcade_create"') >= 0);
  assert.ok(INDEX.indexOf('registerMatch("kiosk-arcade-v1"') >= 0);
  assert.ok(INDEX.indexOf("function kioskArcadeJoinCap") >= 0);
  assert.ok(INDEX.indexOf("kioskArcadeJoinCap") >= 0);
});

test("create RPC uses kiosk-arcade-v1 and returns uuid.node-shaped id", function () {
  var created = [];
  var nk = {
    matchCreate: function (name, params) {
      created.push({ name: name, params: params });
      return "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.nakama";
    },
    storageRead: function () { return []; },
    storageWrite: function () {},
    walletUpdate: function () { throw new Error("wallet must not run"); }
  };
  var raw = g.rpcKioskArcadeCreate({ userId: "tv" }, logger(), nk, JSON.stringify({
    game: "platformer",
    machineNo: "866903013700011"
  }));
  var body = JSON.parse(raw);
  assert.equal(created[0].name, "kiosk-arcade-v1");
  assert.equal(created[0].params.game, "platformer");
  assert.equal(body.game, "platformer");
  assert.ok(body.matchId.indexOf(".nakama") > 0);
  assert.equal(body.titleId, "620f954b-94b5-4048-8b86-4762011ed4d7");
  assert.equal(body.machineNo, "866903013700011");
});

test("label carries machineNo + Arcadian UUID, never QuizVerse", function () {
  var started = init("platformer", "tv", "866903013700011");
  assert.ok(started.label.indexOf("620f954b-94b5-4048-8b86-4762011ed4d7") >= 0);
  assert.ok(started.label.indexOf("m=866903013700011") >= 0);
  assert.ok(started.label.indexOf("126bf539") < 0);
  var racing = init("racing", "tv", "cab1");
  assert.ok(racing.label.indexOf("91616e25-fe7b-483b-9bbb-383df7d696a5") >= 0);
});

test("mailbox broadcasts opcodes 1-8 and ignores the rest", function () {
  var started = init("platformer", "tv");
  var state = join(started.state, ["tv", "spark", "bolt"], 1).state;
  var seen = [];
  var dispatcher = {
    broadcastMessage: function (op, data, _to, sender) {
      seen.push({ op: op, data: data, sender: sender });
    }
  };
  var nk = { walletUpdate: function () { throw new Error("RESULT must not mint"); } };
  var messages = [
    { opCode: 1, data: "swing", sender: presence("spark") },
    { opCode: 4, data: "result", sender: presence("tv") },
    { opCode: 7, data: "ready", sender: presence("bolt") },
    { opCode: 8, data: "state", sender: presence("tv") },
    { opCode: 99, data: "nope", sender: presence("spark") }
  ];
  var out = g.kioskArcadeMatchLoop({}, logger(), nk, dispatcher, 2, state, messages);
  assert.ok(out.state);
  assert.equal(seen.length, 4);
  assert.equal(seen[0].op, 1);
  assert.equal(seen[1].op, 4);
  assert.equal(seen[2].op, 7);
  assert.equal(seen[3].op, 8);
});

test("platformer: host + two phones; third rejected", function () {
  var started = init("platformer", "tv");
  var state = started.state;
  assert.equal(joinAttempt(state, "tv", 1).accept, true);
  state = join(state, ["tv"], 1).state;
  assert.equal(joinAttempt(state, "spark", 2).accept, true);
  state = join(state, ["spark"], 2).state;
  assert.equal(joinAttempt(state, "bolt", 3).accept, true);
  state = join(state, ["bolt"], 3).state;
  assert.equal(joinAttempt(state, "third", 4).accept, false);
});

test("golfx: host + one phone; second phone rejected", function () {
  var started = init("golfx", "tv");
  var state = join(started.state, ["tv"], 1).state;
  assert.equal(joinAttempt(state, "p1", 2).accept, true);
  state = join(state, ["p1"], 2).state;
  assert.equal(joinAttempt(state, "p2", 3).accept, false);
});

test("host leave does not mint a new match; same user rejoins", function () {
  var started = init("platformer", "tv");
  var state = join(started.state, ["tv", "spark"], 1).state;
  var matchStill = g.kioskArcadeMatchLoop({}, logger(), {}, { broadcastMessage: function () {} }, 2, state, []);
  assert.ok(matchStill.state);
  state = leave(state, ["tv"], 10).state;
  var again = joinAttempt(state, "tv", 11);
  assert.equal(again.accept, true);
  state = join(again.state, ["tv"], 11).state;
  assert.equal(state.seats.tv.role, "host");
  assert.equal(state.seats.tv.present, true);
});

test("phone blip keeps the seat for 10s so a third cannot sneak in", function () {
  var started = init("platformer", "tv");
  var state = join(started.state, ["tv", "spark", "bolt"], 1).state;
  state = leave(state, ["bolt"], 20).state;
  assert.equal(joinAttempt(state, "sneak", 21).accept, false);
  var reclaim = joinAttempt(state, "bolt", 22);
  assert.equal(reclaim.accept, true);
  state = join(reclaim.state, ["bolt"], 22).state;
  assert.equal(state.seats.bolt.present, true);
});

test("observer join does not steal P1 / join cap", function () {
  var started = init("platformer", "tv");
  var state = join(started.state, ["tv"], 1).state;
  var obs = joinAttempt(state, "watch", 2, { observer: true });
  assert.equal(obs.accept, true);
  state = join(state, [{ userId: "watch", metadata: { observer: true } }], 2).state;
  assert.equal(joinAttempt(state, "spark", 3).accept, true);
  state = join(state, ["spark"], 3).state;
  assert.equal(joinAttempt(state, "bolt", 4).accept, true);
  state = join(state, ["bolt"], 4).state;
  assert.equal(joinAttempt(state, "third", 5).accept, false);
  assert.equal(state.seats.watch.observer, true);
  assert.equal(state.driverUserId, "");
});

test("racing pit is queue #1, not a second driver; promote after driver grace", function () {
  var started = init("racing", "tv");
  var state = join(started.state, ["tv", "driver", "pit"], 1).state;
  assert.equal(state.driverUserId, "driver");
  assert.equal(state.pitUserId, "pit");
  assert.equal(state.seats.pit.pitOrdinal, 1);
  assert.equal(state.seats.pit.role, "pit");
  state = leave(state, ["driver"], 10).state;
  assert.equal(state.driverUserId, "driver");
  g.kioskArcadeSweepSeats(state, 10 + (10 * 20) + 1);
  assert.equal(state.driverUserId, "pit");
  assert.equal(state.pitUserId, "");
  assert.equal(state.seats.pit.role, "driver");
});

test("create rate limit trips on the 9th call in a minute", function () {
  var writes = 0;
  var stamps = [];
  var nk = {
    matchCreate: function () { return "id.nakama"; },
    storageRead: function () {
      return stamps.length ? [{ value: { t: stamps.slice() } }] : [];
    },
    storageWrite: function (rows) {
      writes++;
      stamps = rows[0].value.t;
    }
  };
  var i;
  for (i = 0; i < 8; i++) {
    g.rpcKioskArcadeCreate({ userId: "tv" }, logger(), nk, '{"game":"platformer"}');
  }
  assert.equal(writes, 8);
  var threw = false;
  try {
    g.rpcKioskArcadeCreate({ userId: "tv" }, logger(), nk, '{"game":"platformer"}');
  } catch (e) {
    threw = true;
    assert.ok(String(e.message).indexOf("rate limited") >= 0);
  }
  assert.equal(threw, true);
});

test("empty room TTL ends an abandoned match", function () {
  var started = init("platformer", "tv");
  var dispatcher = { broadcastMessage: function () {} };
  var early = g.kioskArcadeMatchLoop({}, logger(), {}, dispatcher, 10, started.state, []);
  assert.ok(early.state);
  var late = g.kioskArcadeMatchLoop({}, logger(), {}, dispatcher, 10 + 30 * 20, started.state, []);
  assert.equal(late.state, null);
});

test("InitModule registers the RPC id", function () {
  var ids = [];
  g.InitModule({}, logger(), {}, {
    registerRpc: function (id, fn) {
      ids.push(id);
      assert.equal(typeof fn, "function");
    }
  });
  assert.deepEqual(ids, ["kiosk_arcade_create"]);
});

if (failed) {
  console.log("\n" + failed + " failed");
  process.exit(1);
}
console.log("\nall tests passed");
