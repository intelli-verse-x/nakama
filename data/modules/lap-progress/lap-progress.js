/**
 * QuizVerse Link & Play — per-note learning progress (server-authoritative).
 *
 * Collection: lap_note_progress
 * Key: noteId
 * Value: { quizBestScore, flashcardKnewIt, xpEarnedTotal, updatedAt }
 *
 * RPCs:
 *   quizverse_lap_submit_progress — upsert max scores for one note
 *   quizverse_lap_get_progress    — read one or many notes for the caller
 */

var LAP_PROGRESS_COLLECTION = "lap_note_progress";

function lapProgressClampQuiz(n) {
  var v = Math.round(Number(n) || 0);
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}

function lapProgressClampCount(n) {
  var v = Math.round(Number(n) || 0);
  return v < 0 ? 0 : v;
}

function lapProgressEmpty() {
  return {
    quizBestScore: 0,
    flashcardKnewIt: 0,
    xpEarnedTotal: 0,
    updatedAt: "",
  };
}

function lapProgressRead(nk, userId, noteId) {
  try {
    var rows = nk.storageRead([
      {
        collection: LAP_PROGRESS_COLLECTION,
        key: noteId,
        userId: userId,
      },
    ]);
    if (!rows || rows.length === 0 || !rows[0].value) {
      return lapProgressEmpty();
    }
    var v = rows[0].value;
    return {
      quizBestScore: lapProgressClampQuiz(v.quizBestScore),
      flashcardKnewIt: lapProgressClampCount(v.flashcardKnewIt),
      xpEarnedTotal: lapProgressClampCount(v.xpEarnedTotal),
      updatedAt: String(v.updatedAt || ""),
    };
  } catch (e) {
    return lapProgressEmpty();
  }
}

function lapProgressWrite(nk, userId, noteId, value) {
  nk.storageWrite([
    {
      collection: LAP_PROGRESS_COLLECTION,
      key: noteId,
      userId: userId,
      value: value,
      permissionRead: 1,
      permissionWrite: 1,
    },
  ]);
}

/**
 * Payload:
 *   {
 *     noteId: string,
 *     activity?: "quiz" | "flash" | string,
 *     score?: number,   // quiz %
 *     count?: number,   // flashcards "knew it"
 *     xpEarned?: number
 *   }
 */
var rpcQuizverseLapSubmitProgress = function (ctx, logger, nk, payload) {
  try {
    var userId = ctx.userId;
    if (!userId) {
      return JSON.stringify({ success: false, error: "unauthenticated" });
    }

    var data = JSON.parse(payload || "{}");
    var noteId = String(data.noteId || data.note_id || "").trim();
    if (!noteId) {
      return JSON.stringify({ success: false, error: "noteId is required" });
    }

    var prev = lapProgressRead(nk, userId, noteId);
    var activity = String(data.activity || "").toLowerCase();
    var nextQuiz = prev.quizBestScore;
    var nextFlash = prev.flashcardKnewIt;

    if (activity === "quiz" || activity === "quiz_done" || data.score != null) {
      nextQuiz = Math.max(nextQuiz, lapProgressClampQuiz(data.score));
    }
    if (
      activity === "flash" ||
      activity === "flashcard" ||
      activity === "flashcards" ||
      data.count != null
    ) {
      nextFlash = Math.max(nextFlash, lapProgressClampCount(data.count));
    }

    var xpAdd = lapProgressClampCount(data.xpEarned);
    var next = {
      quizBestScore: nextQuiz,
      flashcardKnewIt: nextFlash,
      xpEarnedTotal: prev.xpEarnedTotal + xpAdd,
      updatedAt: new Date().toISOString(),
    };

    lapProgressWrite(nk, userId, noteId, next);

    return JSON.stringify({
      success: true,
      noteId: noteId,
      progress: next,
    });
  } catch (err) {
    logger.error("[LAP-Progress] submit error: " + err.message);
    return JSON.stringify({ success: false, error: err.message });
  }
};

/**
 * Payload:
 *   { noteId?: string, noteIds?: string[] }
 * Response:
 *   { success, progress: { [noteId]: { quizBestScore, flashcardKnewIt, ... } } }
 */
var rpcQuizverseLapGetProgress = function (ctx, logger, nk, payload) {
  try {
    var userId = ctx.userId;
    if (!userId) {
      return JSON.stringify({ success: false, error: "unauthenticated" });
    }

    var data = JSON.parse(payload || "{}");
    var ids = [];
    if (Array.isArray(data.noteIds)) {
      for (var i = 0; i < data.noteIds.length; i++) {
        var id = String(data.noteIds[i] || "").trim();
        if (id) ids.push(id);
      }
    }
    var single = String(data.noteId || data.note_id || "").trim();
    if (single && ids.indexOf(single) < 0) ids.push(single);

    if (ids.length === 0) {
      return JSON.stringify({ success: true, progress: {} });
    }
    // Cap batch size to avoid large storageRead fanout.
    if (ids.length > 100) ids = ids.slice(0, 100);

    var keys = [];
    for (var j = 0; j < ids.length; j++) {
      keys.push({
        collection: LAP_PROGRESS_COLLECTION,
        key: ids[j],
        userId: userId,
      });
    }

    var progress = {};
    for (var k = 0; k < ids.length; k++) {
      progress[ids[k]] = lapProgressEmpty();
    }

    try {
      var rows = nk.storageRead(keys);
      for (var r = 0; r < rows.length; r++) {
        var row = rows[r];
        if (!row || !row.key) continue;
        var v = row.value || {};
        progress[row.key] = {
          quizBestScore: lapProgressClampQuiz(v.quizBestScore),
          flashcardKnewIt: lapProgressClampCount(v.flashcardKnewIt),
          xpEarnedTotal: lapProgressClampCount(v.xpEarnedTotal),
          updatedAt: String(v.updatedAt || ""),
        };
      }
    } catch (readErr) {
      logger.warn("[LAP-Progress] storageRead: " + readErr.message);
    }

    return JSON.stringify({ success: true, progress: progress });
  } catch (err) {
    logger.error("[LAP-Progress] get error: " + err.message);
    return JSON.stringify({ success: false, error: err.message });
  }
};

function InitModule(ctx, logger, nk, initializer) {
  try {
    initializer.registerRpc("quizverse_lap_submit_progress", rpcQuizverseLapSubmitProgress);
    logger.info("[LAP-Progress] Registered RPC: quizverse_lap_submit_progress");
  } catch (e) {
    logger.error("[LAP-Progress] Failed to register quizverse_lap_submit_progress: " + e.message);
  }

  try {
    initializer.registerRpc("quizverse_lap_get_progress", rpcQuizverseLapGetProgress);
    logger.info("[LAP-Progress] Registered RPC: quizverse_lap_get_progress");
  } catch (e) {
    logger.error("[LAP-Progress] Failed to register quizverse_lap_get_progress: " + e.message);
  }

  logger.info("[LAP-Progress] LAP note progress module initialized");
}
