// QuizVerse KB Triad RPCs — User KB + Game KB + Exam KB grounding.
//
// RPCs:
//   quizverse_kb_get_context
//   quizverse_kb_register_seen_questions
//   quizverse_kb_filter_unseen_questions
//   quizverse_chatbox_message

namespace QvKnowledgeBaseTriad {
  var COLLECTION_USER_KB = "user_kb";
  var COLLECTION_USER_PROGRESS = "user_progress";
  var COLLECTION_CHAT_MEMORY = "chatbox_memory";
  var KEY_PROFILE = "profile";
  var KEY_SEEN_QUESTIONS = "seen_questions";
  var KEY_CHAT_SUMMARY = "summary";

  type AnyMap = { [key: string]: any };

  function parseJson(payload: string, fallback: AnyMap): AnyMap {
    if (!payload) return fallback;
    try {
      return JSON.parse(payload);
    } catch (e: any) {
      return fallback;
    }
  }

  function readObject(nk: nkruntime.Nakama, userId: string, collection: string, key: string, fallback: AnyMap): AnyMap {
    var rows = nk.storageRead([{ collection: collection, key: key, userId: userId }]);
    if (!rows || rows.length === 0 || !rows[0].value) return fallback;
    return rows[0].value as AnyMap;
  }

  function writeObject(nk: nkruntime.Nakama, userId: string, collection: string, key: string, value: AnyMap): void {
    nk.storageWrite([{
      collection: collection,
      key: key,
      userId: userId,
      value: value,
      permissionRead: 1,
      permissionWrite: 1,
    }]);
  }

  function numberOr(a: any, b?: any, c?: any): number {
    if (typeof a === "number" && isFinite(a)) return a;
    if (typeof b === "number" && isFinite(b)) return b;
    if (typeof c === "number" && isFinite(c)) return c;
    return 0;
  }

  function resolveCountry(examId: string): string {
    var id = String(examId || "").toLowerCase();
    if (id.indexOf("jee") >= 0 || id.indexOf("neet") >= 0 || id.indexOf("upsc") >= 0 ||
        id.indexOf("cat") >= 0 || id.indexOf("cbse") >= 0 || id.indexOf("icse") >= 0) return "IN";
    if (id.indexOf("sat") >= 0 || id.indexOf("act") >= 0 || id.indexOf("ap") >= 0 ||
        id.indexOf("mcat") >= 0 || id.indexOf("lsat") >= 0 || id.indexOf("gre") >= 0 ||
        id.indexOf("gmat") >= 0) return "US";
    return "";
  }

  function resolveScoreScale(examId: string): string {
    var id = String(examId || "").toLowerCase();
    if (id.indexOf("sat") >= 0) return "sat_1600";
    if (id.indexOf("act") >= 0) return "act_36";
    if (id.indexOf("jee") >= 0 || id.indexOf("neet") >= 0) return "marks_720";
    return "percentile";
  }

  function buildScorePrediction(examId: string, weakTopics: AnyMap[], accuracy: number): AnyMap {
    if (!examId) return { available: false, confidence: 0, drivers: [] };
    var normalizedAccuracy = Math.max(0, Math.min(1, accuracy > 1 ? accuracy / 100 : accuracy));
    var scale = resolveScoreScale(examId);
    var maxScore = scale === "sat_1600" ? 1600 : scale === "act_36" ? 36 : scale === "marks_720" ? 720 : 100;
    var score = Math.round(maxScore * (0.45 + normalizedAccuracy * 0.45));
    var band = Math.max(5, Math.round(maxScore * 0.06));
    var drivers: string[] = [];
    for (var i = 0; i < weakTopics.length && drivers.length < 3; i++) {
      if (weakTopics[i] && weakTopics[i].topic) drivers.push(String(weakTopics[i].topic));
    }
    return {
      available: true,
      predictedScore: score,
      lowerBound: Math.max(0, score - band),
      upperBound: Math.min(maxScore, score + band),
      scale: scale,
      confidence: weakTopics.length > 0 ? 0.62 : 0.42,
      drivers: drivers,
    };
  }

  function fact(id: string, type: string, label: string, value: string, confidence: number, refs: string[]): AnyMap {
    return { id: id, type: type, label: label, value: value, confidence: confidence, evidenceRefs: refs };
  }

  function citation(id: string, title: string, sourceType: string, sourceId: string): AnyMap {
    return {
      id: id,
      title: title,
      sourceType: sourceType,
      sourceId: sourceId,
      reviewedAtUtc: new Date().toISOString(),
      citationSafe: true,
    };
  }

  function buildRepeatPolicy(ledger: AnyMap, topicId: string, mode: string): AnyMap {
    var topic = topicId || "general";
    var topics = ledger && ledger.topics ? ledger.topics : {};
    var seenCount = topics[topic] && topics[topic].length ? topics[topic].length : 0;
    var poolSizeEstimate = 50;
    var freshCount = Math.max(0, poolSizeEstimate - seenCount);
    return {
      freshCount: freshCount,
      reviewCount: mode === "SmartReview" ? Math.min(seenCount, 10) : 0,
      poolExhausted: freshCount <= 0,
      contentGenerationQueued: freshCount < 20,
      nextRefreshEtaSeconds: freshCount < 20 ? 900 : 0,
      suppressedPrompts: freshCount <= 0 ? ["app_store_review"] : [],
    };
  }

  function buildContext(ctx: nkruntime.Context, nk: nkruntime.Nakama, req: AnyMap): AnyMap {
    var userId = ctx.userId || "";
    var profile = readObject(nk, userId, COLLECTION_USER_KB, KEY_PROFILE, {});
    var seen = readObject(nk, userId, COLLECTION_USER_PROGRESS, KEY_SEEN_QUESTIONS, { topics: {}, fingerprints: {} });
    var localUser = req.localUser || {};
    var localGame = req.localGame || {};
    var examId = req.examId || localUser.targetExamId || profile.targetExamId || "";
    var weakTopics = localUser.weakTopics || profile.weakTopics || [];
    var topic = req.topic || localGame.topic || "";
    var mode = req.gameMode || localGame.gameMode || "";

    return {
      requestId: userId + "-" + Date.now(),
      surface: req.surface || "unknown",
      generatedAtUtc: new Date().toISOString(),
      user: {
        userId: userId,
        displayName: localUser.displayName || profile.displayName || "Player",
        language: localUser.language || profile.language || "en",
        goalType: localUser.goalType || profile.goalType || (examId ? "exam_prep" : "casual_fun"),
        targetExamId: examId,
        targetDateIso: localUser.targetDateIso || profile.targetDateIso || "",
        totalGamesPlayed: numberOr(localUser.totalGamesPlayed, profile.totalGamesPlayed, 0),
        currentStreak: numberOr(localUser.currentStreak, profile.currentStreak, 0),
        overallAccuracy: numberOr(localUser.overallAccuracy, profile.overallAccuracy, 0),
        weakTopics: weakTopics,
        strongTopics: localUser.strongTopics || profile.strongTopics || [],
        interests: localUser.interests || profile.interests || [],
      },
      game: {
        gameMode: mode,
        topic: topic,
        difficulty: req.difficulty || localGame.difficulty || "medium",
        dueSmartReviewCards: numberOr(localGame.dueSmartReviewCards, 0),
        recommendedModes: localGame.recommendedModes || [],
        contentAssets: localGame.contentAssets || [],
      },
      exam: {
        examId: examId,
        country: resolveCountry(examId),
        syllabusVersion: examId ? "taxonomy-v1" : "",
        scorePrediction: buildScorePrediction(examId, weakTopics, numberOr(localUser.overallAccuracy, profile.overallAccuracy, 0)),
        conceptIds: weakTopics.map(function (t: AnyMap) { return t.conceptId || t.topic; }).filter(Boolean).slice(0, 12),
        nextBestTopics: weakTopics.map(function (t: AnyMap) { return t.topic; }).filter(Boolean).slice(0, 5),
      },
      repeatPolicy: buildRepeatPolicy(seen, topic, mode),
      facts: [
        fact("user.total_games", "direct", "Total games played", String(numberOr(localUser.totalGamesPlayed, profile.totalGamesPlayed, 0)), 1, ["nakama.user:" + userId]),
        fact("user.current_streak", "direct", "Current streak", String(numberOr(localUser.currentStreak, profile.currentStreak, 0)), 1, ["nakama.user:" + userId]),
        fact("user.accuracy", "direct", "Overall accuracy", String(numberOr(localUser.overallAccuracy, profile.overallAccuracy, 0)), 0.9, ["analytics_events.question_answered"]),
        fact("game.current_topic", "direct", "Current topic", topic || "general", 1, ["unity.game_state"]),
      ],
      citations: [
        citation("kb2.triad", "Knowledge Base Triad Plan", "policy", "docs/plans/PLAN-KNOWLEDGE_BASE_TRIAD.md"),
        citation("kb2.deducible", "Deducible Insights Contract", "policy", "docs/plans/CATALOG-DEDUCIBLE_INSIGHTS.md"),
        citation("kb2.repetition", "Repetition Fatigue Policy", "policy", "docs/plans/PLAN-REPETITION_FATIGUE_INTERVENTION.md"),
        citation("kb3.exam_taxonomy", "Exam Taxonomy Expansion", "exam_kb", "docs/plans/PLAN-EXAM_TAXONOMY_EXPANSION.md"),
      ],
      guardrails: [
        "Use only supplied facts and citations.",
        "Do not infer emotions, friend behavior, private traits, or guaranteed exam outcomes.",
        "Use score ranges and confidence bands.",
        "Suppress review prompts when repeatPolicy.poolExhausted is true.",
      ],
      isServerEnriched: true,
      citationSafe: true,
    };
  }

  function rpcGetContext(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    if (!ctx.userId) return JSON.stringify({ success: false, error: "no_user" });
    var req = parseJson(payload || "{}", {});
    return JSON.stringify({ success: true, context: buildContext(ctx, nk, req) });
  }

  function rpcRegisterSeenQuestions(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    if (!ctx.userId) return JSON.stringify({ success: false, error: "no_user" });
    var req = parseJson(payload || "{}", {});
    var questions = Array.isArray(req.questions) ? req.questions : [];
    var ledger = readObject(nk, ctx.userId, COLLECTION_USER_PROGRESS, KEY_SEEN_QUESTIONS, { topics: {}, fingerprints: {} });
    if (!ledger.topics) ledger.topics = {};
    if (!ledger.fingerprints) ledger.fingerprints = {};

    for (var i = 0; i < questions.length; i++) {
      var q = questions[i] || {};
      var topicId = q.topicId || "general";
      if (!ledger.topics[topicId]) ledger.topics[topicId] = [];
      if (q.questionId && ledger.topics[topicId].indexOf(q.questionId) < 0) ledger.topics[topicId].push(q.questionId);
      if (q.questionFingerprint) {
        ledger.fingerprints[q.questionFingerprint] = {
          topicId: topicId,
          conceptId: q.conceptId || "",
          difficulty: q.difficulty || "",
          mode: q.mode || "",
          shownAtUtc: q.shownAtUtc || new Date().toISOString(),
        };
      }
    }

    writeObject(nk, ctx.userId, COLLECTION_USER_PROGRESS, KEY_SEEN_QUESTIONS, ledger);
    var first = questions.length ? questions[0] : {};
    return JSON.stringify({
      success: true,
      repeatPolicy: buildRepeatPolicy(ledger, first.topicId || "general", first.mode || ""),
    });
  }

  function isQuestionSeen(ledger: AnyMap, q: AnyMap): boolean {
    if (!q) return false;
    if (q.questionFingerprint && ledger && ledger.fingerprints && ledger.fingerprints[q.questionFingerprint]) return true;
    var topicId = q.topicId || "general";
    var topicQuestions = ledger && ledger.topics ? ledger.topics[topicId] : null;
    return !!(q.questionId && topicQuestions && topicQuestions.indexOf(q.questionId) >= 0);
  }

  function rpcFilterUnseenQuestions(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    if (!ctx.userId) return JSON.stringify({ success: false, error: "no_user" });
    var req = parseJson(payload || "{}", {});
    var candidates = Array.isArray(req.questions) ? req.questions : [];
    var ledger = readObject(nk, ctx.userId, COLLECTION_USER_PROGRESS, KEY_SEEN_QUESTIONS, { topics: {}, fingerprints: {} });
    var unseen: AnyMap[] = [];
    var excluded: string[] = [];

    for (var i = 0; i < candidates.length; i++) {
      var q = candidates[i] || {};
      if (isQuestionSeen(ledger, q)) {
        excluded.push(String(q.questionId || q.questionFingerprint || ""));
      } else {
        unseen.push(q);
      }
    }

    var first = candidates.length ? candidates[0] : {};
    return JSON.stringify({
      success: true,
      questions: unseen,
      excludedQuestionIds: excluded.filter(Boolean),
      repeatPolicy: buildRepeatPolicy(ledger, req.topicId || first.topicId || "general", req.mode || first.mode || ""),
    });
  }

  function rpcChatboxMessage(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    if (!ctx.userId) return JSON.stringify({ success: false, error: "no_user" });
    var req = parseJson(payload || "{}", {});
    var context = req.knowledgeBaseContext || buildContext(ctx, nk, { surface: "chatbox", prompt: req.message || "" });
    var user = context.user || {};
    var game = context.game || {};
    var exam = context.exam || {};
    var weakTopic = user.weakTopics && user.weakTopics.length ? user.weakTopics[0].topic : game.topic;
    var reply = "I checked your QuizVerse facts before answering. ";
    if (exam.scorePrediction && exam.scorePrediction.available) {
      reply += "Your " + exam.examId + " forecast is " + exam.scorePrediction.lowerBound + "-" +
        exam.scorePrediction.upperBound + " on the " + exam.scorePrediction.scale +
        " scale, with the biggest next focus on " + (weakTopic || "your weakest topic") + ".";
    } else {
      reply += "You have played " + (user.totalGamesPlayed || 0) + " games, your current streak is " +
        (user.currentStreak || 0) + ", and the next useful step is " + (weakTopic || "a short smart review") + ".";
    }
    var widget = buildChatWidgetPayload(context);
    writeObject(nk, ctx.userId, COLLECTION_CHAT_MEMORY, KEY_CHAT_SUMMARY, {
      lastMessageAtUtc: new Date().toISOString(),
      lastSurface: "chatbox",
      lastTopic: game.topic || "",
    });
    return JSON.stringify({
      success: true,
      reply: reply,
      tone: "grounded_personal",
      widgetType: widget.widgetType,
      widgetPayload: widget.payload,
      citations: context.citations || [],
      facts: context.facts || [],
      repeatPolicy: context.repeatPolicy || null,
    });
  }

  function firstTopic(user: AnyMap, game: AnyMap): string {
    if (user.weakTopics && user.weakTopics.length && user.weakTopics[0].topic) return String(user.weakTopics[0].topic);
    return String(game.topic || "");
  }

  function buildChatWidgetPayload(context: AnyMap): AnyMap {
    var user = context.user || {};
    var game = context.game || {};
    var exam = context.exam || {};
    var repeatPolicy = context.repeatPolicy || {};
    if (exam.scorePrediction && exam.scorePrediction.available) {
      return {
        widgetType: "score_predictor",
        payload: {
          prefabKey: "score_predictor_card",
          title: "Your grounded score forecast",
          body: exam.examId + " estimate: " + exam.scorePrediction.lowerBound + "-" +
            exam.scorePrediction.upperBound + " (" + exam.scorePrediction.scale + ")",
          ctaLabel: "Open practice plan",
          ctaRoute: "practice_plan",
          topicId: firstTopic(user, game),
          examId: exam.examId || "",
          mode: "ScorePredictor",
          priority: 90,
        },
      };
    }

    if (repeatPolicy.poolExhausted || repeatPolicy.contentGenerationQueued) {
      return {
        widgetType: "fresh_questions",
        payload: {
          prefabKey: "fresh_question_queue",
          title: "Fresh questions are being prepared",
          body: "You have cleared most of this pool, so QuizVerse should switch to review or generate more content.",
          ctaLabel: "Open smart review",
          ctaRoute: "smart_review",
          topicId: firstTopic(user, game),
          examId: exam.examId || "",
          mode: "SmartReview",
          priority: 80,
        },
      };
    }

    return {
      widgetType: "smart_review",
      payload: {
        prefabKey: "smart_review_card",
        title: "Your next best quiz step",
        body: "Start with " + (firstTopic(user, game) || "a short smart review") + " based on your current QuizVerse facts.",
        ctaLabel: "Start review",
        ctaRoute: "smart_review",
        topicId: firstTopic(user, game),
        examId: exam.examId || "",
        mode: game.gameMode || "SmartReview",
        priority: 60,
      },
    };
  }

  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("quizverse_kb_get_context", rpcGetContext);
    initializer.registerRpc("quizverse_kb_register_seen_questions", rpcRegisterSeenQuestions);
    initializer.registerRpc("quizverse_kb_filter_unseen_questions", rpcFilterUnseenQuestions);
    initializer.registerRpc("quizverse_chatbox_message", rpcChatboxMessage);
  }
}
