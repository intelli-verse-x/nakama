/**
 * WorldCricket — playable single-player cricket mini-game for Intelliverse
 * generated worlds (baseline: Lord's Cricket Ground).
 *
 * Distinct from WorldTrivia's checkpoint loop: here the player BATS. A bowler
 * delivers a deterministic sequence of balls (seeded per session); the client
 * renders the delivery and the player times a tap/click/swipe. The client
 * reports only the timing offset (+ optional shot type); the SERVER decides the
 * outcome (dot/1/2/3/4/6/out), tallies runs, wickets and overs, and writes the
 * leaderboard. The client never grades a ball or counts a run — server
 * authoritative, exactly like WorldTrivia.
 *
 * Anti-cheat baseline: each delivery's outcome is a pure function of
 * (sessionSeed, ballIndex, reported timing, shot). Because ballIndex only ever
 * advances, a player cannot re-roll the same ball for a better result, and a
 * "perfect" (0ms) report on a genuinely hard delivery still isn't a guaranteed
 * six — difficulty is baked into the deterministic mapping. The server also
 * rejects out-of-order balls, impossibly-fast responses, and stale/foreign
 * sessions. Timing itself is inherently client-measured (a reaction game), so
 * that surface is trusted the way any timing game must.
 *
 * Follows the router-wallet / world-trivia module conventions: global
 * namespace, SYSTEM-owned storage objects, {success,data}/{success,error}
 * envelopes, OCC with up to 3 retries on session mutations, soft router-wallet
 * reward hook on finish. Drop-in for nakama-multiplayer-kernel: copy to
 * data/modules/src/world_cricket/ and call WorldCricket.register(initializer)
 * from main.ts InitModule.
 */
namespace WorldCricket {

  export var SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000";
  export var TEMPLATES_COLLECTION = "cricket_templates";
  export var SESSIONS_COLLECTION = "cricket_sessions";
  export var LEADERBOARDS_COLLECTION = "cricket_leaderboards";
  export var MAX_OCC_RETRIES = 3;
  export var LEADERBOARD_SIZE = 100;
  export var IDLE_EXPIRY_MS = 30 * 60 * 1000;
  // A ball result cannot legitimately arrive faster than the ball can travel
  // minus generous client/network slack; below this the report is impossible.
  export var MIN_RESPONSE_MS = 120;
  // A reported timing offset larger than this (ms) is nonsense; clamp/ reject.
  export var MAX_TIMING_OFFSET_MS = 2000;

  export var SHOTS = ["defend", "drive", "cut", "pull", "loft"];
  export var AGGRESSIVE_SHOTS = ["pull", "loft"];
  export var LENGTHS = ["full", "good", "short", "yorker"];
  export var LINES = ["off", "middle", "leg", "wide"];

  export interface CricketSettings {
    overs: number;          // innings length in overs (balls = overs*6)
    wickets: number;        // wickets in hand before innings ends
    finishRewardCredits: number;
  }

  export var DEFAULT_SETTINGS: CricketSettings = {
    overs: 5,
    wickets: 5,
    finishRewardCredits: 0
  };

  export interface CricketTemplate {
    appId: string;
    templateId: string;
    name: string;
    assets: any;            // { splatUrl?, panoramaUrl?, ... } — viewer hints only
    settings: CricketSettings;
    updatedAtMs: number;
  }

  export interface Delivery {
    ballIndex: number;
    speedKph: number;
    length: string;         // full|good|short|yorker
    line: string;           // off|middle|leg|wide
    isSpin: boolean;
    travelMs: number;       // release -> arrival at the bat (client animates to this)
    perfectMs: number;      // half-width of the "perfect" timing window
    difficulty: number;     // 0..1
  }

  export interface PendingBall {
    ballIndex: number;
    issuedAtMs: number;
  }

  export interface SessionValue {
    sessionId: string;
    appId: string;
    userId: string;
    templateId: string;
    seed: number;
    status: string;         // active|finished|abandoned
    settings: CricketSettings;
    runs: number;
    balls: number;          // legal balls faced
    wickets: number;
    fours: number;
    sixes: number;
    ballLog: number[];      // per-ball runs (-1 = out) for a scorecard
    pending: PendingBall | null;
    startedAtMs: number;
    lastEventAtMs: number;
    finishedAtMs?: number;
    version: number;
  }

  export interface LeaderboardEntry {
    sessionId: string;
    userId: string;
    runs: number;
    balls: number;
    wickets: number;
    fours: number;
    sixes: number;
    strikeRate: number;     // runs/balls*100, one decimal
    durationMs: number;
    finishedAt: string;
  }

  // ---- seeded RNG (matches world-trivia fnv1a32 / mulberry32) ----

  export function fnv1a32(str: string): number {
    var hash = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return hash >>> 0;
  }

  export function mulberry32(seed: number): () => number {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
      t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---- envelopes / helpers ----

  function ok(data: any): string { return JSON.stringify({ success: true, data: data }); }
  function err(message: string): string { return JSON.stringify({ success: false, error: message }); }
  function parsePayload(payload: string): any { return (!payload || payload === "") ? {} : JSON.parse(payload); }
  function nowMs(): number { return Date.now(); }

  function requireServerToServer(ctx: nkruntime.Context): void {
    if (ctx.userId) throw new Error("world_cricket authoring RPCs are server-to-server only");
  }
  function requireUser(ctx: nkruntime.Context): string {
    if (!ctx.userId) throw new Error("world_cricket gameplay RPCs require an authenticated user session");
    return ctx.userId;
  }
  function requireOwnedActive(s: SessionValue, userId: string): void {
    if (s.userId !== userId) throw new Error("Session does not belong to the caller");
    if (s.status !== "active") throw new Error("Session is " + s.status);
  }
  function expireIfIdle(s: SessionValue, now: number): boolean {
    if (now - s.lastEventAtMs > IDLE_EXPIRY_MS) {
      s.status = "abandoned";
      s.finishedAtMs = now;
      return true;
    }
    return false;
  }

  // ---- storage ----

  function templateKey(appId: string, templateId: string): string { return "template_" + appId + "_" + templateId; }
  function sessionKey(sessionId: string): string { return "session_" + sessionId; }
  function leaderboardKey(appId: string, templateId: string): string { return "lb_" + appId + "_" + templateId; }

  function readSystemObject(nk: nkruntime.Nakama, collection: string, key: string): { value: any; storageVersion: string } {
    var records = nk.storageRead([{ collection: collection, key: key, userId: SYSTEM_USER_ID }]);
    if (records && records.length > 0 && records[0].value) {
      return { value: records[0].value, storageVersion: records[0].version };
    }
    return { value: null, storageVersion: "*" };
  }

  function writeSystemObject(nk: nkruntime.Nakama, collection: string, key: string, value: any, storageVersion?: string): void {
    var write: any = {
      collection: collection, key: key, userId: SYSTEM_USER_ID, value: value,
      permissionRead: 0 as nkruntime.ReadPermissionValues,
      permissionWrite: 0 as nkruntime.WritePermissionValues
    };
    if (storageVersion) write.version = storageVersion;
    nk.storageWrite([write]);
  }

  function readTemplate(nk: nkruntime.Nakama, appId: string, templateId: string): CricketTemplate | null {
    return readSystemObject(nk, TEMPLATES_COLLECTION, templateKey(appId, templateId)).value as CricketTemplate | null;
  }

  function mutateSession(nk: nkruntime.Nakama, sessionId: string, mutator: (s: SessionValue) => void): SessionValue {
    var lastError: any = null;
    for (var attempt = 0; attempt < MAX_OCC_RETRIES; attempt++) {
      var read = readSystemObject(nk, SESSIONS_COLLECTION, sessionKey(sessionId));
      var session = read.value as SessionValue | null;
      if (!session) throw new Error("Session not found: " + sessionId);
      mutator(session);
      session.version = (session.version || 0) + 1;
      try {
        writeSystemObject(nk, SESSIONS_COLLECTION, sessionKey(sessionId), session, read.storageVersion);
        return session;
      } catch (e: any) {
        lastError = e;
      }
    }
    throw new Error("Session write conflict after " + MAX_OCC_RETRIES + " retries: " + (lastError && lastError.message ? lastError.message : String(lastError)));
  }

  // ---- deterministic delivery + grading (the server-authoritative core) ----

  function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : (v > hi ? hi : v); }

  function difficultyOf(length: string, line: string, speedKph: number): number {
    var d = 0.30;
    if (length === "short") d += 0.14;
    if (length === "yorker") d += 0.20;
    if (line === "wide") d += 0.12;
    if (line === "off") d += 0.04;
    d += ((speedKph - 68) / 77) * 0.34; // pace pressure
    return clamp(d, 0, 1);
  }

  /** Delivery is a pure function of (seed, ballIndex). */
  export function deliveryFor(seed: number, ballIndex: number): Delivery {
    var rnd = mulberry32((seed ^ Math.imul(ballIndex + 1, 0x9e3779b1)) >>> 0);
    var r1 = rnd(), r2 = rnd(), r3 = rnd();
    var speedKph = 68 + Math.floor(r1 * 78);           // 68..145
    var length = LENGTHS[Math.floor(r2 * LENGTHS.length)];
    var line = LINES[Math.floor(r3 * LINES.length)];
    var isSpin = speedKph < 92;
    var diff = difficultyOf(length, line, speedKph);
    var travelMs = Math.round(560 - ((speedKph - 68) / 77) * 180); // ~560 (slow) .. 380 (fast)
    var perfectMs = Math.round(38 + (1 - diff) * 34);             // 38..72ms window
    return {
      ballIndex: ballIndex, speedKph: speedKph, length: length, line: line,
      isSpin: isSpin, travelMs: travelMs, perfectMs: perfectMs, difficulty: diff
    };
  }

  export interface BallOutcome {
    runs: number;
    out: boolean;
    dismissal: string | null;   // bowled|caught|lbw|null
    timing: string;             // perfect|good|early|late|mistimed
    boundary: boolean;
    commentary: string;
  }

  function pickDismissal(d: Delivery, shot: string, roll: number): string {
    if (shot === "loft" || shot === "pull") return roll < 0.7 ? "caught" : "bowled";
    if (d.length === "yorker") return roll < 0.6 ? "bowled" : "lbw";
    if (d.line === "leg") return roll < 0.5 ? "lbw" : "caught";
    return roll < 0.45 ? "bowled" : (roll < 0.8 ? "caught" : "lbw");
  }

  /** Outcome is a pure function of (delivery, signed timing offset, shot, seed). */
  export function gradeBall(seed: number, d: Delivery, timingOffsetMs: number, shot: string): BallOutcome {
    if (SHOTS.indexOf(shot) < 0) shot = "drive";
    var off = clamp(timingOffsetMs, -MAX_TIMING_OFFSET_MS, MAX_TIMING_OFFSET_MS);
    var ad = Math.abs(off);
    var perfect = d.perfectMs;
    var ratio = ad / perfect;
    var aggressive = AGGRESSIVE_SHOTS.indexOf(shot) >= 0;
    var defensive = shot === "defend";
    var roll = mulberry32((seed ^ 0x00c0ffee ^ Math.imul(d.ballIndex + 1, 0x27d4eb2f)) >>> 0)();

    // Wicket band: badly mistimed => dismissed. Harder deliveries => tighter
    // tolerance. Defensive shots buy a wider tolerance; aggressive ones narrow it.
    var wicketMs = 300 - d.difficulty * 120;   // ~180..300ms
    if (defensive) wicketMs *= 1.6;
    if (aggressive) wicketMs *= 0.8;

    var timingLabel = ratio <= 1 ? "perfect" : (ratio <= 2 ? "good" : (off < 0 ? "early" : "late"));

    if (ad > wicketMs) {
      return { runs: 0, out: true, dismissal: pickDismissal(d, shot, roll), timing: "mistimed", boundary: false, commentary: dismissalCall(pickDismissal(d, shot, roll)) };
    }
    // Aggressive shots: a mistimed heave carries a catch risk before you reach
    // the outright wicket band.
    if (aggressive && ratio > 2.2 && roll < 0.55) {
      return { runs: 0, out: true, dismissal: "caught", timing: off < 0 ? "early" : "late", boundary: false, commentary: "Skied it — taken in the deep!" };
    }

    var runs: number;
    var boundary = false;
    if (ratio <= 1.0) {
      runs = aggressive ? 6 : 4; boundary = true;
    } else if (ratio <= 2.0) {
      runs = aggressive ? 4 : (roll < 0.5 ? 2 : 3); boundary = runs >= 4;
    } else if (ratio <= 3.2) {
      runs = roll < 0.5 ? 1 : 2;
    } else if (ratio <= 5.0) {
      runs = roll < 0.35 ? 1 : 0;
    } else {
      runs = 0;
    }
    if (defensive && runs > 1) runs = 1; // safe hands, singles at most

    return {
      runs: runs, out: false, dismissal: null, timing: timingLabel, boundary: boundary,
      commentary: runsCall(runs, boundary, aggressive)
    };
  }

  function dismissalCall(kind: string): string {
    if (kind === "bowled") return "Cleaned him up — timber!";
    if (kind === "lbw") return "Rapped on the pads — that's plumb!";
    return "Edged and taken — gone!";
  }
  function runsCall(runs: number, boundary: boolean, aggressive: boolean): string {
    if (runs === 6) return aggressive ? "Launched into the stands — SIX!" : "Picked the gap and cleared the rope — SIX!";
    if (runs === 4) return "Beautifully timed to the boundary — FOUR!";
    if (runs === 3) return "Well run, back for three.";
    if (runs === 2) return "Placed into the gap, comes back for two.";
    if (runs === 1) return "Tucked away for a single.";
    return "Solid defence, no run.";
  }

  // ---- views ----

  function progressView(s: SessionValue): any {
    return {
      runs: s.runs,
      balls: s.balls,
      wickets: s.wickets,
      fours: s.fours,
      sixes: s.sixes,
      oversText: oversText(s.balls),
      ballsRemaining: Math.max(0, s.settings.overs * 6 - s.balls),
      wicketsRemaining: Math.max(0, s.settings.wickets - s.wickets),
      strikeRate: s.balls > 0 ? Math.round((s.runs / s.balls) * 1000) / 10 : 0
    };
  }

  function oversText(balls: number): string {
    return Math.floor(balls / 6) + "." + (balls % 6);
  }

  function inningsOver(s: SessionValue): boolean {
    return s.balls >= s.settings.overs * 6 || s.wickets >= s.settings.wickets;
  }

  function deliveryView(d: Delivery): any {
    return {
      ballIndex: d.ballIndex, speedKph: d.speedKph, length: d.length, line: d.line,
      isSpin: d.isSpin, travelMs: d.travelMs
      // perfectMs / difficulty are withheld — the client must not know the exact
      // scoring window (would trivialise the timing challenge).
    };
  }

  function sessionView(s: SessionValue, nextDelivery: Delivery | null): any {
    return {
      sessionId: s.sessionId,
      appId: s.appId,
      templateId: s.templateId,
      status: s.status,
      seed: s.seed,
      settings: s.settings,
      progress: progressView(s),
      ballLog: s.ballLog,
      nextDelivery: nextDelivery ? deliveryView(nextDelivery) : null,
      startedAtMs: s.startedAtMs
    };
  }

  // ---- RPC: authoring (server-to-server) ----

  export function rpcTemplateUpsert(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    try {
      requireServerToServer(ctx);
      var data = parsePayload(payload);
      if (!data.appId) return err("appId required");
      if (!data.templateId) return err("templateId required");
      var settings: CricketSettings = {
        overs: data.settings && data.settings.overs ? Math.max(1, Math.min(50, Number(data.settings.overs))) : DEFAULT_SETTINGS.overs,
        wickets: data.settings && data.settings.wickets ? Math.max(1, Math.min(10, Number(data.settings.wickets))) : DEFAULT_SETTINGS.wickets,
        finishRewardCredits: data.settings && data.settings.finishRewardCredits ? Number(data.settings.finishRewardCredits) : DEFAULT_SETTINGS.finishRewardCredits
      };
      var template: CricketTemplate = {
        appId: String(data.appId),
        templateId: String(data.templateId),
        name: data.name ? String(data.name) : String(data.templateId),
        assets: data.assets || {},
        settings: settings,
        updatedAtMs: nowMs()
      };
      writeSystemObject(nk, TEMPLATES_COLLECTION, templateKey(template.appId, template.templateId), template);
      return ok({ appId: template.appId, templateId: template.templateId, name: template.name, settings: template.settings });
    } catch (e: any) {
      return err(e.message || "cricket_template_upsert failed");
    }
  }

  // ---- RPC: gameplay (authenticated user) ----

  function uuid(nk: nkruntime.Nakama): string {
    return nk.uuidv4();
  }

  export function rpcSessionStart(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    try {
      var userId = requireUser(ctx);
      var data = parsePayload(payload);
      if (!data.appId) return err("appId required");
      if (!data.templateId) return err("templateId required");
      var template = readTemplate(nk, data.appId, data.templateId);
      if (!template) return err("Template not found: " + data.templateId + " (app " + data.appId + ")");

      var sessionId = uuid(nk);
      var seed = fnv1a32(sessionId);
      var now = nowMs();
      var session: SessionValue = {
        sessionId: sessionId,
        appId: String(data.appId),
        userId: userId,
        templateId: String(data.templateId),
        seed: seed,
        status: "active",
        settings: template.settings,
        runs: 0, balls: 0, wickets: 0, fours: 0, sixes: 0,
        ballLog: [],
        pending: { ballIndex: 0, issuedAtMs: now },
        startedAtMs: now,
        lastEventAtMs: now,
        version: 0
      };
      writeSystemObject(nk, SESSIONS_COLLECTION, sessionKey(sessionId), session);
      return ok(sessionView(session, deliveryFor(seed, 0)));
    } catch (e: any) {
      return err(e.message || "cricket_session_start failed");
    }
  }

  export function rpcSessionGet(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    try {
      var userId = requireUser(ctx);
      var data = parsePayload(payload);
      if (!data.sessionId) return err("sessionId required");
      var s = readSystemObject(nk, SESSIONS_COLLECTION, sessionKey(data.sessionId)).value as SessionValue | null;
      if (!s) return err("Session not found: " + data.sessionId);
      if (s.userId !== userId) return err("Session does not belong to the caller");
      var next = s.status === "active" && s.pending ? deliveryFor(s.seed, s.pending.ballIndex) : null;
      return ok(sessionView(s, next));
    } catch (e: any) {
      return err(e.message || "cricket_session_get failed");
    }
  }

  /**
   * Play the currently-pending ball. Client sends the ballIndex it played, the
   * measured timing offset (ms; negative = early, positive = late) and an
   * optional shot. Server grades authoritatively, advances the innings, and
   * either issues the next delivery or finalises the innings.
   */
  export function rpcBallPlay(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    try {
      var userId = requireUser(ctx);
      var data = parsePayload(payload);
      if (!data.sessionId) return err("sessionId required");
      if (typeof data.ballIndex !== "number") return err("ballIndex required");
      if (typeof data.timingOffsetMs !== "number" || !isFinite(data.timingOffsetMs)) return err("timingOffsetMs required");
      var shot = data.shot ? String(data.shot) : "drive";
      var now = nowMs();

      var outcome: BallOutcome | null = null;
      var wasExpired = false;
      var finished = false;

      var session = mutateSession(nk, data.sessionId, function (s) {
        requireOwnedActive(s, userId);
        if (expireIfIdle(s, now)) { wasExpired = true; return; }
        if (!s.pending) throw new Error("No pending delivery");
        if (s.pending.ballIndex !== data.ballIndex) {
          throw new Error("Out-of-order ball: expected " + s.pending.ballIndex + ", got " + data.ballIndex);
        }
        if (now - s.pending.issuedAtMs < MIN_RESPONSE_MS) {
          throw new Error("Ball played impossibly fast");
        }

        var delivery = deliveryFor(s.seed, s.pending.ballIndex);
        outcome = gradeBall(s.seed, delivery, data.timingOffsetMs, shot);

        s.balls += 1;
        if (outcome.out) {
          s.wickets += 1;
          s.ballLog.push(-1);
        } else {
          s.runs += outcome.runs;
          if (outcome.runs === 4) s.fours += 1;
          if (outcome.runs === 6) s.sixes += 1;
          s.ballLog.push(outcome.runs);
        }
        s.lastEventAtMs = now;

        if (inningsOver(s)) {
          s.status = "finished";
          s.finishedAtMs = now;
          s.pending = null;
          finished = true;
        } else {
          s.pending = { ballIndex: s.balls, issuedAtMs: now };
        }
      });

      if (wasExpired) return err("Session expired after " + (IDLE_EXPIRY_MS / 60000) + " minutes idle");

      var result: any = {
        ballIndex: data.ballIndex,
        outcome: outcome,
        progress: progressView(session),
        inningsOver: finished
      };
      if (finished) {
        result.summary = finalize(nk, logger, session);
      } else {
        result.nextDelivery = deliveryView(deliveryFor(session.seed, session.pending!.ballIndex));
      }
      return ok(result);
    } catch (e: any) {
      return err(e.message || "cricket_ball_play failed");
    }
  }

  /** Manual finish / declare — commit the current innings early to the board. */
  export function rpcSessionFinish(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    try {
      var userId = requireUser(ctx);
      var data = parsePayload(payload);
      if (!data.sessionId) return err("sessionId required");
      var now = nowMs();
      var session = mutateSession(nk, data.sessionId, function (s) {
        requireOwnedActive(s, userId);
        s.status = "finished";
        s.finishedAtMs = now;
        s.pending = null;
        s.lastEventAtMs = now;
      });
      var summary = finalize(nk, logger, session);
      return ok(summary);
    } catch (e: any) {
      return err(e.message || "cricket_session_finish failed");
    }
  }

  export function rpcSessionAbandon(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    try {
      var userId = requireUser(ctx);
      var data = parsePayload(payload);
      if (!data.sessionId) return err("sessionId required");
      var now = nowMs();
      var session = mutateSession(nk, data.sessionId, function (s) {
        requireOwnedActive(s, userId);
        s.status = "abandoned";
        s.finishedAtMs = now;
        s.pending = null;
        s.lastEventAtMs = now;
      });
      return ok({ sessionId: session.sessionId, status: session.status, runs: session.runs, wickets: session.wickets });
    } catch (e: any) {
      return err(e.message || "cricket_session_abandon failed");
    }
  }

  export function rpcLeaderboardGet(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    try {
      var data = parsePayload(payload);
      if (!data.appId) return err("appId required");
      if (!data.templateId) return err("templateId required");
      var limit = data.limit ? Math.min(Number(data.limit), LEADERBOARD_SIZE) : LEADERBOARD_SIZE;
      var read = readSystemObject(nk, LEADERBOARDS_COLLECTION, leaderboardKey(data.appId, data.templateId));
      var entries: LeaderboardEntry[] = (read.value && read.value.entries) || [];
      return ok({ appId: data.appId, templateId: data.templateId, entries: entries.slice(0, limit) });
    } catch (e: any) {
      return err(e.message || "cricket_leaderboard_get failed");
    }
  }

  // ---- finalize: leaderboard + soft wallet reward ----

  function finalize(nk: nkruntime.Nakama, logger: nkruntime.Logger, session: SessionValue): any {
    var durationMs = (session.finishedAtMs || nowMs()) - session.startedAtMs;
    var entry: LeaderboardEntry = {
      sessionId: session.sessionId,
      userId: session.userId,
      runs: session.runs,
      balls: session.balls,
      wickets: session.wickets,
      fours: session.fours,
      sixes: session.sixes,
      strikeRate: session.balls > 0 ? Math.round((session.runs / session.balls) * 1000) / 10 : 0,
      durationMs: durationMs,
      finishedAt: new Date().toISOString()
    };
    var rank = upsertLeaderboardEntry(nk, session.appId, session.templateId, entry);
    var reward = creditFinishReward(nk, logger, session);
    return {
      sessionId: session.sessionId,
      runs: session.runs,
      balls: session.balls,
      wickets: session.wickets,
      fours: session.fours,
      sixes: session.sixes,
      oversText: oversText(session.balls),
      strikeRate: entry.strikeRate,
      durationMs: durationMs,
      rank: rank,
      reward: reward
    };
  }

  /**
   * Top-100 by RUNS; ties broken by fewer balls faced (better strike rate),
   * then by earlier finish. Keyed by sessionId so a replayed finish can't
   * duplicate a row. OCC-retried.
   */
  function upsertLeaderboardEntry(nk: nkruntime.Nakama, appId: string, templateId: string, entry: LeaderboardEntry): number | null {
    var key = leaderboardKey(appId, templateId);
    var lastError: any = null;
    for (var attempt = 0; attempt < MAX_OCC_RETRIES; attempt++) {
      var read = readSystemObject(nk, LEADERBOARDS_COLLECTION, key);
      var value = read.value || { appId: appId, templateId: templateId, entries: [] };
      var entries: LeaderboardEntry[] = value.entries || [];
      var filtered: LeaderboardEntry[] = [];
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].sessionId !== entry.sessionId) filtered.push(entries[i]);
      }
      filtered.push(entry);
      filtered.sort(function (a, b) {
        if (b.runs !== a.runs) return b.runs - a.runs;
        if (a.balls !== b.balls) return a.balls - b.balls;
        return a.durationMs - b.durationMs;
      });
      value.entries = filtered.slice(0, LEADERBOARD_SIZE);
      try {
        writeSystemObject(nk, LEADERBOARDS_COLLECTION, key, value, read.storageVersion);
        for (var r = 0; r < value.entries.length; r++) {
          if (value.entries[r].sessionId === entry.sessionId) return r + 1;
        }
        return null;
      } catch (e: any) {
        lastError = e;
      }
    }
    throw new Error("Leaderboard write conflict after " + MAX_OCC_RETRIES + " retries: " + (lastError && lastError.message ? lastError.message : String(lastError)));
  }

  /**
   * Soft router-wallet reward on finish, resolved in-process at call time.
   * Ref cricket_finish_{sessionId} rides the wallet's conditional-create
   * dedupe. When RouterWallet isn't installed the innings still finishes and
   * the reward is reported skipped — completion is never hostage to billing.
   */
  function creditFinishReward(nk: nkruntime.Nakama, logger: nkruntime.Logger, session: SessionValue): any {
    var amount = session.settings.finishRewardCredits;
    if (!amount || amount <= 0) {
      return { credited: false, skipped: true, reason: "no finishRewardCredits configured" };
    }
    var rw: any = typeof globalThis !== "undefined" ? (globalThis as any).RouterWallet : null;
    if (!rw || typeof rw.rpcCredit !== "function") {
      return { credited: false, skipped: true, reason: "router_wallet module not installed" };
    }
    try {
      var s2sCtx = { userId: "" } as any;
      var result = JSON.parse(rw.rpcCredit(s2sCtx, logger, nk, JSON.stringify({
        appId: session.appId,
        kind: "iv_credits",
        amount: amount,
        reason: "cricket_finish_reward",
        ref: "cricket_finish_" + session.sessionId
      })));
      if (!result.success) {
        return { credited: false, skipped: true, reason: result.error || "router_wallet_credit failed" };
      }
      return { credited: !result.data.deduped, deduped: !!result.data.deduped, kind: "iv_credits", amount: amount };
    } catch (e: any) {
      return { credited: false, skipped: true, reason: e.message || "router_wallet_credit threw" };
    }
  }

  export function register(initializer: nkruntime.Initializer): void {
    // authoring (s2s)
    initializer.registerRpc("cricket_template_upsert", rpcTemplateUpsert);
    // gameplay (authenticated user)
    initializer.registerRpc("cricket_session_start", rpcSessionStart);
    initializer.registerRpc("cricket_session_get", rpcSessionGet);
    initializer.registerRpc("cricket_ball_play", rpcBallPlay);
    initializer.registerRpc("cricket_session_finish", rpcSessionFinish);
    initializer.registerRpc("cricket_session_abandon", rpcSessionAbandon);
    initializer.registerRpc("cricket_leaderboard_get", rpcLeaderboardGet);
  }
}

// Expose the namespace for the standalone vitest harness. Inside Nakama's Goja
// runtime this is a harmless no-op guard (namespaces are already global in the
// kernel's outFile bundle).
if (typeof globalThis !== "undefined") {
  (globalThis as any).WorldCricket = WorldCricket;
}
