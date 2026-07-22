// compatibility_quiz.ts — QVBF_421
// Server-owned Compatibility quiz load from S3 + session RPCs that return quiz.
// postbuild first-wins: these RPCs override legacy_runtime.js duplicates.

namespace CompatibilityQuiz {

  var COLLECTION = "compatibility_sessions";
  var CACHE_COLLECTION = "compatibility_quiz_cache";
  var SYSTEM_USER = "00000000-0000-0000-0000-000000000000";
  var S3_BASE = "https://intelli-verse-x-media.s3.us-east-1.amazonaws.com";
  var PREFIX = "compatibility";
  var CACHE_TTL_MS = 6 * 60 * 60 * 1000;
  var LOOKBACK_WEEKS = 12;
  var LOOKFORWARD_WEEKS = 26;
  var MIN_JSON_BYTES = 100;
  var DAY_PROBE_ORDER = [1, 4, 5, 7, 3, 2, 6];

  // ---------------------------------------------------------------------------
  // Notification code registry (Compatibility Quiz)
  //
  // Nakama: codes ≤ 0 are system-reserved; game codes must be > 0.
  // Project ranges (do NOT reuse — collisions break client filtering):
  //   1–499       Friends / social (friends/notification_codes.js)
  //   500–599     Group membership sync
  //   1001/1101   Satori live events / Hermes (avoid)
  //   7000–7999   Feature inbox / push-adjacent
  //     7001        Default push (legacy/push.ts)
  //     7201/7202   League promote / demote
  //     7301/7302   Turn / countdown style
  //     7401/7402   Match / duel results
  //     7501        Feature inbox (existing)
  //     7601        Feature inbox (existing)
  //     7701        CompatibilityQuiz (this module)
  //   9101/9102   Quest reward / new quest
  //
  // Unity routes CompatibilityQuiz via content.type / eventType; this code must
  // stay outside friend lifecycle 1–6 / 100–105 so MapFriendNotificationCode
  // never rewrites the event type.
  // ---------------------------------------------------------------------------
  var NOTIF_CODE_COMPATIBILITY_QUIZ = 7701;

  function ok(message: string, data: any): string {
    return JSON.stringify({ success: true, message: message, data: data });
  }

  function fail(message: string, errorCode?: string): string {
    var out: any = { success: false, message: message, data: null };
    if (errorCode) out.errorCode = errorCode;
    return JSON.stringify(out);
  }

  function resolveUserId(ctx: nkruntime.Context, request: any): string {
    var userId = ctx.userId;
    if (!userId || typeof userId !== "string" || userId.length < 10) {
      userId = request && request.userId;
    }
    return userId && typeof userId === "string" && userId.length >= 10 ? userId : "";
  }

  function getISOWeekDate(d: Date): { year: number; week: number; day: number } {
    var u = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    var isoDay = u.getUTCDay() === 0 ? 7 : u.getUTCDay();
    u.setUTCDate(u.getUTCDate() + 4 - isoDay);
    var year = u.getUTCFullYear();
    var jan4 = new Date(Date.UTC(year, 0, 4));
    var jan4Day = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
    var w1Start = new Date(Date.UTC(year, 0, 4 - jan4Day + 1));
    var weekNum = Math.floor((u.getTime() - w1Start.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1;
    return { year: year, week: weekNum, day: isoDay };
  }

  function addWeeks(iso: { year: number; week: number; day: number }, delta: number): { year: number; week: number; day: number } {
    // Approximate via date math from ISO week Monday + offset.
    var jan4 = new Date(Date.UTC(iso.year, 0, 4));
    var jan4Day = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
    var monday = new Date(Date.UTC(iso.year, 0, 4 - jan4Day + 1));
    monday.setUTCDate(monday.getUTCDate() + (iso.week - 1 + delta) * 7);
    return getISOWeekDate(monday);
  }

  function langCandidates(locale: string): string[] {
    var l = (locale || "en").trim();
    var base = l.split("-")[0].toLowerCase();
    var out: string[] = [];
    var push = function (c: string) {
      if (out.indexOf(c) < 0) out.push(c);
    };
    if (base === "zh") push("zh-Hans");
    else if (base === "pt") push("pt-BR");
    else if (l === "es-419") {
      push("es-419");
      push("es");
    } else {
      push(l);
      push(base);
    }
    push("en");
    return out;
  }

  function tryFetchKey(nk: nkruntime.Nakama, key: string, timeoutMs: number): any {
    var url = S3_BASE + "/" + key;
    try {
      var resp: any = nk.httpRequest(url, "get", {}, "", timeoutMs);
      if (!resp || resp.code < 200 || resp.code >= 300) return null;
      if (!resp.body || resp.body.length < MIN_JSON_BYTES) return null;
      return JSON.parse(resp.body);
    } catch (_) {
      return null;
    }
  }

  function weekScore(year: number, week: number): number {
    return year * 100 + week;
  }

  function probeWeekDays(nk: nkruntime.Nakama, year: number, week: number, lang: string, days: number[]): { quiz: any; sourceKey: string; score: number } {
    for (var i = 0; i < days.length; i++) {
      var day = days[i];
      var key = "quiz-verse/weekly/" + year + "-" + week + "-" + day + "-" + PREFIX + "_" + lang + ".json";
      var quiz = tryFetchKey(nk, key, 2500);
      if (quiz && (quiz.questions || quiz.quiz_id || quiz.quizId || quiz.title)) {
        return { quiz: quiz, sourceKey: key, score: weekScore(year, week) };
      }
    }
    return null;
  }

  function readCache(nk: nkruntime.Nakama, lang: string): { quiz: any; sourceKey: string } {
    try {
      var rows: any = nk.storageRead([{ collection: CACHE_COLLECTION, key: lang, userId: SYSTEM_USER }]);
      if (!rows || rows.length === 0 || !rows[0].value) return null;
      var v = rows[0].value;
      if (!v.quiz || !v.sourceKey || !v.cachedAt) return null;
      if (Date.now() - Number(v.cachedAt) > CACHE_TTL_MS) return null;
      return { quiz: v.quiz, sourceKey: String(v.sourceKey) };
    } catch (_) {
      return null;
    }
  }

  function writeCache(nk: nkruntime.Nakama, lang: string, quiz: any, sourceKey: string): void {
    try {
      nk.storageWrite([{
        collection: CACHE_COLLECTION,
        key: lang,
        userId: SYSTEM_USER,
        value: { quiz: quiz, sourceKey: sourceKey, cachedAt: Date.now() },
        permissionRead: 0,
        permissionWrite: 0
      }]);
    } catch (_) {}
  }

  /** Discover latest compatibility quiz: cache → descending week scan → first hit is latest. */
  export function fetchLatestQuiz(nk: nkruntime.Nakama, logger: nkruntime.Logger, locale: string): { quiz: any; sourceKey: string; lang: string } {
    var langs = langCandidates(locale);
    for (var li = 0; li < langs.length; li++) {
      var lang = langs[li];
      var cached = readCache(nk, lang);
      if (cached) {
        logger.info("[CompatibilityQuiz] cache hit lang=%s key=%s", lang, cached.sourceKey);
        return { quiz: cached.quiz, sourceKey: cached.sourceKey, lang: lang };
      }

      var nowIso = getISOWeekDate(new Date());
      var highOffset = LOOKFORWARD_WEEKS;
      var lowOffset = -LOOKBACK_WEEKS;
      // Phase 1: common publish days (1/4/5). Phase 2: remaining days.
      var phases: number[][] = [[1, 4, 5], [7, 3, 2, 6]];

      for (var pi = 0; pi < phases.length; pi++) {
        for (var off = highOffset; off >= lowOffset; off--) {
          var iso = addWeeks(nowIso, off);
          var hit = probeWeekDays(nk, iso.year, iso.week, lang, phases[pi]);
          if (hit) {
            writeCache(nk, lang, hit.quiz, hit.sourceKey);
            logger.info("[CompatibilityQuiz] S3 latest lang=%s key=%s", lang, hit.sourceKey);
            return { quiz: hit.quiz, sourceKey: hit.sourceKey, lang: lang };
          }
        }
      }
    }
    return null;
  }

  function quizMeta(quiz: any): { quizId: string; quizTitle: string } {
    var quizId = (quiz && (quiz.quiz_id || quiz.quizId || quiz.weekId)) || "compatibility_quiz_v1";
    var quizTitle = (quiz && quiz.title) || "Compatibility Quiz";
    return { quizId: String(quizId), quizTitle: String(quizTitle) };
  }

  function generateShareCode(nk: nkruntime.Nakama): string {
    for (var attempt = 0; attempt < 10; attempt++) {
      var code = String(100000 + Math.floor(Math.random() * 900000));
      try {
        var existing = nk.storageRead([{
          collection: COLLECTION,
          key: "code_" + code,
          userId: SYSTEM_USER
        }]);
        if (!existing || existing.length === 0) return code;
      } catch (_) {
        return code;
      }
    }
    return String(100000 + Math.floor(Math.random() * 900000));
  }

  function sessionToUnity(session: any): any {
    var statusMap: { [k: string]: number } = {
      waiting_for_partner: 0,
      partner_joined: 1,
      creator_completed: 1,
      partner_completed: 1,
      both_completed: 2,
      completed: 2,
      expired: 3,
      cancelled: 4
    };
    var numericStatus = typeof session.status === "number" ? session.status : (statusMap[session.status] || 0);
    if (Date.now() > session.expiresAt && numericStatus < 2) numericStatus = 3;

    return {
      sessionId: session.sessionId || "",
      quizId: session.quizId || "compatibility_quiz_v1",
      quizTitle: session.quizTitle || "Compatibility Quiz",
      quizSourceKey: session.quizSourceKey || "",
      createdByUserId: session.creatorId || "",
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      playerA: {
        userId: session.creatorId || "",
        displayName: session.creatorName || "Player A",
        isComplete: !!session.creatorCompleted,
        answers: session.creatorAnswers || [],
        traitScores: session.creatorTraitScores || {},
        resultId: session.creatorResultId || "",
        personalityTitle: session.creatorPersonalityTitle || "",
        personalityEmoji: session.creatorPersonalityEmoji || "",
        completedAt: session.creatorCompletedAt || 0
      },
      playerB: session.partnerId ? {
        userId: session.partnerId || "",
        displayName: session.partnerName || "Player B",
        isComplete: !!session.partnerCompleted,
        answers: session.partnerAnswers || [],
        traitScores: session.partnerTraitScores || {},
        resultId: session.partnerResultId || "",
        personalityTitle: session.partnerPersonalityTitle || "",
        personalityEmoji: session.partnerPersonalityEmoji || "",
        completedAt: session.partnerCompletedAt || 0
      } : null,
      compatibilityScore: session.compatibilityResult ? session.compatibilityResult.score : 0,
      compatibilityLevel: session.compatibilityResult ? (session.compatibilityResult.level || "") : "",
      matchingTraits: session.compatibilityResult ? (session.compatibilityResult.matchingTraits || []) : [],
      differentTraits: session.compatibilityResult ? (session.compatibilityResult.differentTraits || []) : [],
      compatibilityInsight: session.compatibilityResult ? (session.compatibilityResult.message || "") : "",
      status: numericStatus,
      shareCode: session.shareCode || "",
      quiz: session.quizSnapshot || null
    };
  }

  function notify(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    userId: string,
    eventType: string,
    titleKey: string,
    bodyKey: string,
    vars: { [k: string]: string },
    data: { [k: string]: any }
  ): void {
    if (!userId) return;
    try {
      // Inbox fallback (ES5-safe — never use object spread).
      var content: any = {
        message: vars && vars.message ? vars.message : eventType,
        type: eventType,
        eventType: eventType
      };
      if (data) {
        for (var k in data) {
          if (Object.prototype.hasOwnProperty.call(data, k)) content[k] = data[k];
        }
      }
      nk.notificationsSend([{
        userId: userId,
        subject: vars && vars.subject ? vars.subject : eventType,
        content: content,
        code: NOTIF_CODE_COMPATIBILITY_QUIZ,
        persistent: true
      }]);
    } catch (_) {}

    try {
      if (typeof LegacyPush !== "undefined" && LegacyPush.sendLocalizedPushToUser && ctx) {
        // skipInAppNotification: inbox copy already written above — avoid duplicate.
        LegacyPush.sendLocalizedPushToUser(
          ctx, logger, nk, userId, eventType, titleKey, bodyKey, vars || {},
          { skipQuietHours: true, skipInAppNotification: true, data: data || {} }
        );
      }
    } catch (e: any) {
      if (logger && logger.warn) {
        logger.warn("[CompatibilityQuiz] LegacyPush failed: %s", e && e.message ? e.message : String(e));
      }
    }
  }

  // Ambient for compiled LegacyPush namespace from push.ts
  declare var LegacyPush: any;

  function displayNameFor(nk: nkruntime.Nakama, userId: string, fallback: string): string {
    try {
      var users = nk.usersGetId([userId]);
      if (users && users.length > 0) {
        return users[0].displayName || users[0].username || fallback;
      }
    } catch (_) {}
    return fallback;
  }

  export function rpcCreateSession(
    ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string
  ): string {
    var request: any = {};
    try { request = JSON.parse(payload || "{}"); } catch (_) {
      return fail("Invalid JSON payload");
    }

    var userId = resolveUserId(ctx, request);
    if (!userId) return fail("User authentication required. Please ensure you are logged in.", "AUTH_REQUIRED");

    try {
      var locale = request.lang || request.locale || "en";
      var loaded = fetchLatestQuiz(nk, logger, locale);
      if (!loaded) {
        return fail("No compatibility quiz available on S3. Please try again later.", "QUIZ_UNAVAILABLE");
      }

      var meta = quizMeta(loaded.quiz);
      var quizId = request.quizId || meta.quizId;
      var quizTitle = request.quizTitle || meta.quizTitle;
      var sessionId = nk.uuidv4();
      var shareCode = generateShareCode(nk);
      var now = Date.now();
      var displayName = displayNameFor(nk, userId, request.playerDisplayName || "Unknown");

      var sessionStorage: any = {
        sessionId: sessionId,
        shareCode: shareCode,
        quizId: quizId,
        quizTitle: quizTitle,
        quizSourceKey: loaded.sourceKey,
        quizSnapshot: loaded.quiz,
        creatorId: userId,
        creatorName: displayName,
        partnerId: null,
        partnerName: null,
        inviteeUserId: request.inviteeUserId || null,
        status: 0,
        createdAt: now,
        expiresAt: now + (48 * 60 * 60 * 1000),
        creatorCompleted: false,
        partnerCompleted: false,
        creatorAnswers: null,
        partnerAnswers: null,
        creatorTraitScores: null,
        partnerTraitScores: null,
        compatibilityResult: null
      };

      nk.storageWrite([{
        collection: COLLECTION,
        key: sessionId,
        userId: userId,
        value: sessionStorage,
        permissionRead: 2,
        permissionWrite: 1
      }]);

      nk.storageWrite([{
        collection: COLLECTION,
        key: "code_" + shareCode,
        userId: SYSTEM_USER,
        value: { sessionId: sessionId, creatorId: userId },
        permissionRead: 2,
        permissionWrite: 0
      }]);

      var invitee = request.inviteeUserId || request.challengeUserId || request.toUserId;
      if (invitee && typeof invitee === "string" && invitee.length >= 10 && invitee !== userId) {
        notify(
          ctx, logger, nk, invitee,
          "compatibility_invite",
          "compatibility_invite_title",
          "compatibility_invite_body",
          { name: displayName, mode: "Compatibility", subject: "Compatibility Challenge!", message: displayName + " challenged you to Compatibility Quiz!" },
          { type: "compatibility_invite", screen: "compatibility", sessionId: sessionId, shareCode: shareCode, fromUserId: userId }
        );
      }

      logger.info("[CompatibilityQuiz] Session created %s code=%s key=%s", sessionId, shareCode, loaded.sourceKey);
      return ok("Session created successfully", sessionToUnity(sessionStorage));
    } catch (err: any) {
      logger.error("[CompatibilityQuiz] Create session error: %s", err && err.message ? err.message : String(err));
      return fail(err && err.message ? err.message : "Create failed");
    }
  }

  export function rpcJoinSession(
    ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string
  ): string {
    var request: any = {};
    try { request = JSON.parse(payload || "{}"); } catch (_) {
      return fail("Invalid JSON payload");
    }

    var userId = resolveUserId(ctx, request);
    if (!userId) return fail("User authentication required. Please ensure you are logged in.", "AUTH_REQUIRED");

    try {
      var shareCode = String(request.shareCode || request.shareCodeOrSessionId || "").toUpperCase().trim();
      if (!shareCode || shareCode.length < 6) return fail("Invalid share code");

      var codeResults = nk.storageRead([{
        collection: COLLECTION,
        key: "code_" + shareCode,
        userId: SYSTEM_USER
      }]);
      if (!codeResults || codeResults.length === 0) return fail("Session not found");

      var codeRecord = codeResults[0].value;
      var sessionId = codeRecord.sessionId;
      var creatorId = codeRecord.creatorId;

      var sessionResults = nk.storageRead([{
        collection: COLLECTION,
        key: sessionId,
        userId: creatorId
      }]);
      if (!sessionResults || sessionResults.length === 0) return fail("Session data not found");

      var session = sessionResults[0].value;
      if (session.status === 3 || session.status === "expired" || Date.now() > session.expiresAt) {
        return fail("Session has expired");
      }
      if (session.partnerId !== null && session.partnerId !== userId) {
        return fail("Session already has a partner");
      }
      if (session.creatorId === userId) return fail("Cannot join your own session");

      // Ensure quiz snapshot exists (legacy sessions created before QVBF_421).
      if (!session.quizSnapshot) {
        var locale = request.lang || request.locale || "en";
        var loaded = fetchLatestQuiz(nk, logger, locale);
        if (loaded) {
          session.quizSnapshot = loaded.quiz;
          session.quizSourceKey = loaded.sourceKey;
          var meta = quizMeta(loaded.quiz);
          session.quizId = session.quizId || meta.quizId;
          session.quizTitle = session.quizTitle || meta.quizTitle;
        }
      }

      var displayName = displayNameFor(nk, userId, request.playerDisplayName || "Unknown");
      session.partnerId = userId;
      session.partnerName = displayName;
      session.status = 1;

      nk.storageWrite([{
        collection: COLLECTION,
        key: sessionId,
        userId: creatorId,
        value: session,
        permissionRead: 2,
        permissionWrite: 1
      }]);

      notify(
        ctx, logger, nk, session.creatorId,
        "partner_joined",
        "compatibility_partner_joined_title",
        "compatibility_partner_joined_body",
        { name: displayName, subject: "Partner Joined!", message: displayName + " has joined your compatibility quiz!" },
        { type: "partner_joined", screen: "compatibility", sessionId: sessionId, shareCode: session.shareCode || shareCode }
      );

      logger.info("[CompatibilityQuiz] User %s joined session %s", userId, sessionId);
      return ok("Successfully joined session", sessionToUnity(session));
    } catch (err: any) {
      logger.error("[CompatibilityQuiz] Join session error: %s", err && err.message ? err.message : String(err));
      return fail(err && err.message ? err.message : "Join failed");
    }
  }

  export function rpcGetSession(
    ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string
  ): string {
    var request: any = {};
    try { request = JSON.parse(payload || "{}"); } catch (_) {
      return fail("Invalid JSON payload");
    }

    var userId = resolveUserId(ctx, request);
    if (!userId) return fail("User authentication required. Please ensure you are logged in.", "AUTH_REQUIRED");

    try {
      var sessionId = request.sessionId;
      var creatorId: string = null;

      if (!sessionId && request.shareCode) {
        var shareCode = String(request.shareCode).toUpperCase().trim();
        var codeResults = nk.storageRead([{
          collection: COLLECTION,
          key: "code_" + shareCode,
          userId: SYSTEM_USER
        }]);
        if (!codeResults || codeResults.length === 0) return fail("Session not found");
        sessionId = codeResults[0].value.sessionId;
        creatorId = codeResults[0].value.creatorId;
      }

      var sessionResults = nk.storageRead([{
        collection: COLLECTION,
        key: sessionId,
        userId: userId
      }]);

      if ((!sessionResults || sessionResults.length === 0) && creatorId) {
        sessionResults = nk.storageRead([{
          collection: COLLECTION,
          key: sessionId,
          userId: creatorId
        }]);
      }

      // Partner may not own the object — resolve via code map if needed.
      if ((!sessionResults || sessionResults.length === 0) && sessionId) {
        // Try reading with known creator from a second code lookup is already done;
        // fall through to not found.
      }

      if (!sessionResults || sessionResults.length === 0) {
        // Last resort: if caller is partner, they need creatorId. Search code_* is hard;
        // try request.creatorId if provided.
        if (request.creatorId) {
          sessionResults = nk.storageRead([{
            collection: COLLECTION,
            key: sessionId,
            userId: request.creatorId
          }]);
        }
      }

      if (!sessionResults || sessionResults.length === 0) return fail("Session not found");

      var session = sessionResults[0].value;
      if (session.creatorId !== userId && session.partnerId !== userId) {
        return fail("Not authorized to view this session");
      }
      return ok("Session retrieved", sessionToUnity(session));
    } catch (err: any) {
      logger.error("[CompatibilityQuiz] Get session error: %s", err && err.message ? err.message : String(err));
      return fail(err && err.message ? err.message : "Get failed");
    }
  }
}

// Unique global names so legacy_runtime.js `rpcCompatibilityCreateSession`
// does not overwrite these before postbuild's first-wins `__rpc_*` assignment.
function rpcCompatibilityCreateSessionQVBF421(
  ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string
): string {
  return CompatibilityQuiz.rpcCreateSession(ctx, logger, nk, payload);
}

function rpcCompatibilityJoinSessionQVBF421(
  ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string
): string {
  return CompatibilityQuiz.rpcJoinSession(ctx, logger, nk, payload);
}

function rpcCompatibilityGetSessionQVBF421(
  ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string
): string {
  return CompatibilityQuiz.rpcGetSession(ctx, logger, nk, payload);
}

// Registration — postbuild autoInvokeRegister + NOOP at load (same pattern as remote_config.ts).
// Must NOT declare InitModule here — src/main.ts already owns the sole InitModule.
namespace CompatibilityQuizRegister {
  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("compatibility_create_session", rpcCompatibilityCreateSessionQVBF421);
    initializer.registerRpc("compatibility_join_session", rpcCompatibilityJoinSessionQVBF421);
    initializer.registerRpc("compatibility_get_session", rpcCompatibilityGetSessionQVBF421);
  }
  var _NOOP: any = { registerRpc: function () {} };
  register(_NOOP);
}
