#!/usr/bin/env node
// =============================================================================
// quest_ab_overlay_live_rpc.mjs
// =============================================================================
// Local two-user proof for quest A/B overlay. Talks to a REAL Nakama over HTTP.
// Defaults to docker on 127.0.0.1:7350. Never points at production unless you
// set NAKAMA_EVAL_ALLOW_REMOTE=1.
//
// Usage (from data/modules):
//   node tests/quest_ab_overlay_live_rpc.mjs
//
// Env:
//   NAKAMA_EVAL_HOST        default: 127.0.0.1
//   NAKAMA_EVAL_PORT        default: 7350
//   NAKAMA_EVAL_TLS         default: false
//   NAKAMA_EVAL_SERVER_KEY  default: defaultkey   (socket / device auth)
//   NAKAMA_EVAL_HTTP_KEY    default: try defaulthttpkey then defaultkey
//
// NOTE: The shebang causes postbuild to skip this file. Do NOT remove it.
// =============================================================================

const HOST = process.env.NAKAMA_EVAL_HOST || "127.0.0.1";
const PORT = Number(process.env.NAKAMA_EVAL_PORT || 7350);
const USE_TLS = (process.env.NAKAMA_EVAL_TLS ?? "false") === "true";
const SERVER_KEY = process.env.NAKAMA_EVAL_SERVER_KEY || "defaultkey";
const HTTP_BASE = `${USE_TLS ? "https" : "http"}://${HOST}:${PORT}`;
const RUN_TAG = (process.env.NAKAMA_EVAL_RUN_TAG || Math.random().toString(36).slice(2, 10)).replace(/[^a-z0-9]/g, "").slice(0, 8);
const QUIZVERSE = "126bf539-dae2-4bcf-964d-316c0fa1f92b";
const HEX12 = Date.now().toString(16).padStart(12, "0").slice(-12);
const GAME_A = "00000000-0000-4000-a018-" + HEX12;
const GAME_B = "00000000-0000-4000-b018-" + HEX12;
const QUEST_ID = "ab_probe";
const EXP_ID = "qe_t18_" + RUN_TAG;

const isLocal = HOST === "127.0.0.1" || HOST === "localhost" || HOST === "::1";
if (!isLocal && process.env.NAKAMA_EVAL_ALLOW_REMOTE !== "1") {
  console.error("Refusing non-local host " + HOST + ". This proof is local-only. Set NAKAMA_EVAL_ALLOW_REMOTE=1 if you really mean it.");
  process.exit(2);
}

const failures = [];
function check(name, cond, detail) {
  if (cond) console.log("PASS  " + name);
  else {
    console.log("FAIL  " + name + (detail ? " — " + detail : ""));
    failures.push(name);
  }
}

function decodeUserIdFromJwt(token) {
  const parts = token.split(".");
  if (parts.length < 2) throw new Error("malformed session token");
  const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  if (!payload.uid) throw new Error("session token has no uid claim");
  return payload.uid;
}

function unwrap(body) {
  if (body && typeof body.payload === "string") {
    try { body = JSON.parse(body.payload); } catch { /* keep */ }
  }
  return body;
}

function dataOf(body) {
  const parsed = unwrap(body);
  if (parsed && parsed.success === false) {
    throw new Error(parsed.error || JSON.stringify(parsed));
  }
  if (parsed && parsed.success === true && parsed.data !== undefined) return parsed.data;
  return parsed;
}

async function authenticateDevice(deviceId, username) {
  const url = `${HTTP_BASE}/v2/account/authenticate/device?create=true&username=${encodeURIComponent(username)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(SERVER_KEY + ":").toString("base64"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id: deviceId }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`authenticate_device HTTP ${res.status}: ${JSON.stringify(body)}`);
  return { token: body.token, userId: decodeUserIdFromJwt(body.token), username };
}

async function rpcBearer(token, rpcId, payload) {
  const res = await fetch(`${HTTP_BASE}/v2/rpc/${rpcId}?unwrap=true`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { httpStatus: res.status, ok: res.ok, body: unwrap(body) };
}

async function rpcHttpKey(httpKey, rpcId, payload) {
  const res = await fetch(`${HTTP_BASE}/v2/rpc/${rpcId}?http_key=${encodeURIComponent(httpKey)}&unwrap=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {}),
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { httpStatus: res.status, ok: res.ok, body: unwrap(body) };
}

function probeQuest() {
  return {
    id: QUEST_ID,
    name: "AB Probe",
    description: "T18 local two-user proof",
    enabled: true,
    steps: [
      { id: "s1", description: "do it twice", eventType: "ab_probe_done", requiredCount: 2 },
    ],
    reward: { guaranteed: { currencies: { game: 100 } } },
  };
}

function previewAmount(quest) {
  const n = quest && quest.rewardPreview && quest.rewardPreview.currencies
    ? Number(quest.rewardPreview.currencies.game)
    : NaN;
  return n;
}

function findQuest(data, id) {
  const list = (data && data.quests) || [];
  return list.find((q) => q.id === id) || null;
}

async function pickHttpKey() {
  const candidates = [];
  if (process.env.NAKAMA_EVAL_HTTP_KEY) candidates.push(process.env.NAKAMA_EVAL_HTTP_KEY);
  candidates.push("defaulthttpkey", "defaultkey");
  const seen = new Set();
  for (const key of candidates) {
    if (seen.has(key)) continue;
    seen.add(key);
    const ping = await rpcHttpKey(key, "quest_engine_admin_get_config", { gameId: GAME_A });
    if (ping.httpStatus === 401 || ping.httpStatus === 403) continue;
    if (ping.httpStatus >= 500 && /http_key|Unauthorized|unauthor/i.test(JSON.stringify(ping.body))) continue;
    return key;
  }
  throw new Error("Could not auth admin RPCs with http_key. Is local Nakama up on " + HTTP_BASE + "?");
}

async function main() {
  console.log("Quest A/B live RPC → " + HTTP_BASE + " run=" + RUN_TAG);

  let httpKey;
  try {
    httpKey = await pickHttpKey();
  } catch (e) {
    console.error("Nakama is not reachable at " + HTTP_BASE + ".");
    console.error(String(e && e.message ? e.message : e));
    console.error("Start local stack: docker compose up -d   (from the nakama repo)");
    process.exit(2);
  }

  const saveA = await rpcHttpKey(httpKey, "quest_engine_admin_save_config", {
    gameId: GAME_A,
    silent: true,
    config: { quests: { [QUEST_ID]: probeQuest() } },
  });
  check("admin save probe quest on game A", saveA.ok && unwrap(saveA.body).success !== false, JSON.stringify(saveA.body));

  const saveB = await rpcHttpKey(httpKey, "quest_engine_admin_save_config", {
    gameId: GAME_B,
    silent: true,
    config: { quests: { [QUEST_ID]: probeQuest() } },
  });
  check("admin save probe quest on game B (isolation twin)", saveB.ok && unwrap(saveB.body).success !== false, JSON.stringify(saveB.body));

  const missingGame = await rpcHttpKey(httpKey, "satori_experiment_setup", {
    id: EXP_ID + "_nogame",
    name: "should fail",
    configSystem: "quest_engine",
    goalMetric: "quest_completed",
    status: "draft",
    variants: [
      { name: "control", weight: 50, config: {} },
      { name: "test", weight: 50, config: { quests: { [QUEST_ID]: { reward: { guaranteed: { currencies: { game: 200 } } } } } } },
    ],
  });
  const missingErr = String((unwrap(missingGame.body) && unwrap(missingGame.body).error) || JSON.stringify(missingGame.body));
  check("setup without gameId does not steal QuizVerse", /gameId required/i.test(missingErr), missingErr);

  const fakeId = await rpcHttpKey(httpKey, "satori_experiment_setup", {
    id: EXP_ID + "_fake",
    name: "fake quest",
    game_id: GAME_A,
    configSystem: "quest_engine",
    goalMetric: "quest_completed",
    status: "running",
    minSamplePerArm: 30,
    trackedQuestIds: ["no_such_quest"],
    variants: [
      { name: "control", weight: 50, config: {} },
      { name: "test", weight: 50, config: { quests: { no_such_quest: { reward: { guaranteed: { currencies: { game: 200 } } } } } } },
    ],
  });
  const fakeErr = String((unwrap(fakeId.body) && unwrap(fakeId.body).error) || JSON.stringify(fakeId.body));
  check("setup with unknown quest id fails loud", /unknown quest id/i.test(fakeErr), fakeErr);

  const setup = await rpcHttpKey(httpKey, "satori_experiment_setup", {
    id: EXP_ID,
    name: "T18 prize test " + RUN_TAG,
    game_id: GAME_A,
    configSystem: "quest_engine",
    goalMetric: "quest_completed",
    splitKey: "userId",
    status: "running",
    minSamplePerArm: 30,
    trackedQuestIds: [QUEST_ID],
    variants: [
      { name: "control", weight: 50, config: {}, data: {} },
      {
        name: "test",
        weight: 50,
        config: { quests: { [QUEST_ID]: { reward: { guaranteed: { currencies: { game: 200 } } } } } },
        data: { quests: { [QUEST_ID]: { reward: { guaranteed: { currencies: { game: 200 } } } } } },
      },
    ],
  });
  check("setup 50/50 quest_engine on game A", setup.ok && unwrap(setup.body).success !== false, JSON.stringify(setup.body));

  const randomSplit = await rpcHttpKey(httpKey, "satori_experiment_setup", {
    id: EXP_ID + "_rnd",
    name: "random banned",
    game_id: GAME_A,
    configSystem: "quest_engine",
    goalMetric: "quest_completed",
    splitKey: "random",
    status: "draft",
    variants: [
      { name: "control", weight: 50, config: {} },
      { name: "test", weight: 50, config: { quests: { [QUEST_ID]: { reward: { guaranteed: { currencies: { game: 200 } } } } } } },
    ],
  });
  const rndErr = String((unwrap(randomSplit.body) && unwrap(randomSplit.body).error) || JSON.stringify(randomSplit.body));
  check("quest_engine bans splitKey=random", /splitKey=random/i.test(rndErr), rndErr);

  let controlUser = null;
  let testUser = null;
  let leakedDebug = false;
  let getFailed = null;
  for (let i = 0; i < 40 && (!controlUser || !testUser); i++) {
    const session = await authenticateDevice(`t18_${RUN_TAG}_${i}`, `t18_${RUN_TAG}_${i}`);
    const got = await rpcBearer(session.token, "quest_engine_get", { gameId: GAME_A });
    let data;
    try { data = dataOf(got.body); } catch (e) {
      getFailed = e.message;
      break;
    }
    if (data && data.debug) leakedDebug = true;
    const q = findQuest(data, QUEST_ID);
    const amt = previewAmount(q);
    if (amt === 100 && !controlUser) controlUser = { session, amt, q };
    if (amt === 200 && !testUser) testUser = { session, amt, q };
  }
  check("player get on game A", !getFailed, getFailed);
  check("player get does not include debug.experiment", !leakedDebug);
  check("user A lands on a variant (100 or 200)", !!(controlUser || testUser), "no assigned players");
  check("user B lands on the other variant", !!(controlUser && testUser), "needed both 100 and 200; try more users or check overlay");

  if (controlUser) {
    const again = await rpcBearer(controlUser.session.token, "quest_engine_get", { gameId: GAME_A });
    const amt = previewAmount(findQuest(dataOf(again.body), QUEST_ID));
    check("control get is sticky on second get", amt === 100, String(amt));
  }
  if (testUser) {
    const again = await rpcBearer(testUser.session.token, "quest_engine_get", { gameId: GAME_A });
    const amt = previewAmount(findQuest(dataOf(again.body), QUEST_ID));
    check("test get is sticky on second get", amt === 200, String(amt));

    const iso = await rpcBearer(testUser.session.token, "quest_engine_get", { gameId: GAME_B });
    const isoAmt = previewAmount(findQuest(dataOf(iso.body), QUEST_ID));
    check("same user on game B is not overlaid (isolation)", isoAmt === 100, String(isoAmt));

    const qv = await rpcBearer(testUser.session.token, "quest_engine_get", { gameId: QUIZVERSE });
    let qvData;
    try { qvData = dataOf(qv.body); } catch (e) { qvData = { error: e.message }; }
    const qvHit = findQuest(qvData, QUEST_ID);
    check("QuizVerse get does not see probe quest", !qvHit, qvHit ? JSON.stringify(qvHit) : "");

    const miss = await rpcBearer(testUser.session.token, "quest_engine_get", {});
    const missBody = unwrap(miss.body);
    check("missing gameId errors (does not steal QuizVerse)", missBody && missBody.success === false && /gameId required/i.test(String(missBody.error)), JSON.stringify(missBody));

    await rpcBearer(testUser.session.token, "quest_engine_record_event", {
      gameId: GAME_A,
      eventType: "ab_probe_done",
    });
    const started = await rpcBearer(testUser.session.token, "quest_engine_get", { gameId: GAME_A });
    const startedQ = findQuest(dataOf(started.body), QUEST_ID);
    check("start stamps 200 preview (snapshot)", previewAmount(startedQ) === 200 && !!startedQ.startedAt, JSON.stringify(startedQ && startedQ.rewardPreview));

    const kill = await rpcHttpKey(httpKey, "satori_experiment_setup", {
      id: EXP_ID,
      name: "T18 prize test " + RUN_TAG,
      game_id: GAME_A,
      configSystem: "quest_engine",
      goalMetric: "quest_completed",
      status: "draft",
      trackedQuestIds: [QUEST_ID],
      minSamplePerArm: 30,
      variants: [
        { name: "control", weight: 50, config: {} },
        { name: "test", weight: 50, config: { quests: { [QUEST_ID]: { reward: { guaranteed: { currencies: { game: 200 } } } } } } },
      ],
    });
    check("kill switch sets status draft without promote", kill.ok && unwrap(kill.body).success !== false, JSON.stringify(kill.body));

    const afterKill = await rpcBearer(testUser.session.token, "quest_engine_get", { gameId: GAME_A });
    const afterQ = findQuest(dataOf(afterKill.body), QUEST_ID);
    check("in-flight quest still visible after kill", !!afterQ && !!afterQ.startedAt, JSON.stringify(afterQ));
    check("promised 200 survives experiment end", previewAmount(afterQ) === 200, String(previewAmount(afterQ)));

    await rpcBearer(testUser.session.token, "quest_engine_record_event", {
      gameId: GAME_A,
      eventType: "ab_probe_done",
    });
    const done = await rpcBearer(testUser.session.token, "quest_engine_get", { gameId: GAME_A });
    const doneQ = findQuest(dataOf(done.body), QUEST_ID);
    check("complete still shows snapshotted 200", previewAmount(doneQ) === 200, String(previewAmount(doneQ)));

    const fresh = await authenticateDevice(`t18_${RUN_TAG}_fresh`, `t18_${RUN_TAG}_fresh`);
    const freshGet = await rpcBearer(fresh.token, "quest_engine_get", { gameId: GAME_A });
    const freshAmt = previewAmount(findQuest(dataOf(freshGet.body), QUEST_ID));
    check("new user after kill sees base 100", freshAmt === 100, String(freshAmt));
  }

  const results = await rpcHttpKey(httpKey, "satori_experiments_results", {
    experimentId: EXP_ID,
    game_id: GAME_A,
  });
  let resultsData = null;
  try { resultsData = dataOf(results.body); } catch (e) {
    check("results RPC", false, e.message);
  }
  if (resultsData) {
    check("results include SRM", !!(resultsData.srm && typeof resultsData.srm.passed === "boolean"), JSON.stringify(resultsData.srm));
    check("results include minSample", !!(resultsData.minSample && resultsData.minSample.perArm === 30), JSON.stringify(resultsData.minSample));
    check("min-sample blocks suggestedWinner on two users", resultsData.suggestedWinner == null || resultsData.minSample.met === false, String(resultsData.suggestedWinner));
    const testRow = (resultsData.variants || []).find((v) => v.id === "test" || v.name === "test");
    check("results funnel has assigned/exposed", !!(testRow && (testRow.assigned != null || testRow.exposed != null || testRow.exposures != null)), JSON.stringify(testRow));
  }

  const promote = await rpcHttpKey(httpKey, "satori_experiments_declare_winner", {
    experimentId: EXP_ID,
    variantId: "test",
    game_id: GAME_A,
    promote: true,
  });
  const promoteBody = unwrap(promote.body);
  const promoteErr = String((promoteBody && promoteBody.error) || JSON.stringify(promoteBody));
  check(
    "promote is blocked while min-sample/SRM not met",
    promoteBody && promoteBody.success === false && /cannot promote|sample|SRM|min-sample|not enough|per variant/i.test(promoteErr),
    promoteErr,
  );

  await rpcHttpKey(httpKey, "satori_experiment_setup", {
    id: EXP_ID,
    name: "T18 prize test " + RUN_TAG,
    game_id: GAME_A,
    configSystem: "quest_engine",
    goalMetric: "quest_completed",
    status: "ended",
    trackedQuestIds: [QUEST_ID],
    minSamplePerArm: 30,
    variants: [
      { name: "control", weight: 50, config: {} },
      { name: "test", weight: 50, config: { quests: { [QUEST_ID]: { reward: { guaranteed: { currencies: { game: 200 } } } } } } },
    ],
  });

  if (failures.length > 0) {
    console.error("\nQUEST A/B LIVE RPC: FAIL — " + failures.join(" | "));
    process.exit(1);
  }
  console.log("\nQUEST A/B LIVE RPC: PASS");
}

main().catch((err) => {
  console.error("QUEST A/B LIVE RPC: ERROR — " + (err && err.stack ? err.stack : err));
  process.exit(1);
});
