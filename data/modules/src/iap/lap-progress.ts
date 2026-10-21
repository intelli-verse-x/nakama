// ---------------------------------------------------------------------------
// lap-progress.ts — per-note Link & Play learning progress.
//
//   quizverse_lap_submit_progress  { noteId, activity, score?, count?, xpEarned?, event? }
//   quizverse_lap_get_progress     { noteId } | { noteIds: [...] }
//   quizverse_lap_note_leaderboard { noteId, limit? }
//
// One storage object per (user, note). Scores only ever go up. `event` adds a
// quiz / chat / card line to the note's memory (newest first, capped).
// Owner-read, server-write: clients never write the collection directly.
// The response carries `progress` at the top level (web lap-api.ts reads it
// there) and mirrors it under `data` like other RpcHelpers responses.
//
// Per-note class board: a quiz score also writes the caller's BEST score to
// the `lap_note_<note>` leaderboard (weekly, Monday 00:00 UTC). The board is
// created lazily on first submit; board ids are sanitised because note ids may
// carry characters Nakama's leaderboard id grammar rejects. A leaderboard
// failure never fails the progress write.
// ---------------------------------------------------------------------------

namespace QvLapProgress {
  var COLLECTION = "qv_lap_progress";
  var OCC_MAX_RETRIES = 4;
  var MAX_NOTE_IDS = 100;
  var MAX_ID_CHARS = 128;
  var MAX_LINE_CHARS = 120;
  var MAX_MEMORY = 40;
  var ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;
  var EVENT_KINDS: { [k: string]: boolean } = { quiz: true, chat: true, card: true };

  // Per-note class board.
  var NOTE_BOARD_PREFIX = "lap_note_";
  var BOARD_RESET = "0 0 * * 1"; // weekly, Monday 00:00 UTC
  var DEFAULT_BOARD_LIMIT = 5;
  var MAX_BOARD_LIMIT = 25;
  var MAX_BOARD_ID_CHARS = 120;
  // Nakama leaderboard ids accept only [A-Za-z0-9_.-].
  var BOARD_ID_SAFE = /[A-Za-z0-9_.-]/;
  var ensuredBoards: { [k: string]: boolean } = {};

  interface MemoryEvent {
    kind: string;
    line: string;
    at: string;
  }

  interface Progress {
    quizBestScore: number;
    flashcardKnewIt: number;
    memory: MemoryEvent[];
    updatedAt: string;
  }

  function validNoteId(raw: any): string {
    var id = typeof raw === "string" ? raw.trim() : "";
    if (!id || id.length > MAX_ID_CHARS || !ID_PATTERN.test(id)) return "";
    return id;
  }

  function clampScore(raw: any): number {
    var n = Number(raw);
    if (isNaN(n)) return -1;
    return Math.max(0, Math.min(100, Math.round(n)));
  }

  function clampCount(raw: any): number {
    var n = Number(raw);
    if (isNaN(n)) return -1;
    return Math.max(0, Math.min(10000, Math.round(n)));
  }

  function readEvent(raw: any): MemoryEvent | null {
    if (!raw || typeof raw !== "object") return null;
    var kind = String(raw.kind || "").toLowerCase();
    if (!EVENT_KINDS[kind]) return null;
    var line = String(raw.line || "").trim();
    if (!line) return null;
    if (line.length > MAX_LINE_CHARS) line = line.slice(0, MAX_LINE_CHARS);
    var atMs = new Date(String(raw.at || "")).getTime();
    var at = isNaN(atMs) ? new Date().toISOString() : new Date(atMs).toISOString();
    return { kind: kind, line: line, at: at };
  }

  function toProgress(value: any): Progress {
    var v = value || {};
    var memory: MemoryEvent[] = [];
    if (Array.isArray(v.memory)) {
      for (var i = 0; i < v.memory.length && memory.length < MAX_MEMORY; i++) {
        var e = readEvent(v.memory[i]);
        if (e) memory.push(e);
      }
    }
    return {
      quizBestScore: Math.max(0, clampScore(v.quizBestScore)),
      flashcardKnewIt: Math.max(0, clampCount(v.flashcardKnewIt)),
      memory: memory,
      updatedAt: String(v.updatedAt || ""),
    };
  }

  function reply(progress: any): string {
    return JSON.stringify({ success: true, progress: progress, data: { progress: progress } });
  }

  // ── Per-note class board ──────────────────────────────────────────────────

  /** FNV-1a, 8 hex chars — keeps sanitised board ids collision-free. */
  function fnv1a(raw: string): string {
    var h = 2166136261;
    for (var i = 0; i < raw.length; i++) {
      h ^= raw.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    var hex = h.toString(16);
    while (hex.length < 8) hex = "0" + hex;
    return hex;
  }

  /**
   * `echo:pack-1` is a legal note id but `:` is not legal in a leaderboard id.
   * Sanitising alone would collapse `a:b` and `a_b` onto one board, so any
   * rewritten id carries a hash of the original.
   */
  function boardIdForNote(noteId: string): string {
    var safe = "";
    var clean = true;
    for (var i = 0; i < noteId.length; i++) {
      var ch = noteId.charAt(i);
      if (BOARD_ID_SAFE.test(ch)) {
        safe += ch;
      } else {
        safe += "_";
        clean = false;
      }
    }
    var id = NOTE_BOARD_PREFIX + safe;
    if (!clean) id += "-" + fnv1a(noteId);
    if (id.length > MAX_BOARD_ID_CHARS) {
      id = id.slice(0, MAX_BOARD_ID_CHARS - 9) + "-" + fnv1a(noteId);
    }
    return id;
  }

  /** Idempotent create: "already exists" is the expected failure. */
  function ensureNoteBoard(nk: nkruntime.Nakama, logger: nkruntime.Logger, noteId: string): string {
    var id = boardIdForNote(noteId);
    if (ensuredBoards[id]) return id;
    try {
      nk.leaderboardCreate(
        id,
        false,
        nkruntime.SortOrder.DESCENDING,
        nkruntime.Operator.BEST,
        BOARD_RESET,
        { kind: "lap_note", noteId: noteId }
      );
    } catch (err: any) {
      // Already created, or a concurrent submit won the race.
      logger.debug("[QvLapProgress] board ensure %s: %s", id,
        (err && err.message ? err.message : String(err)));
    }
    ensuredBoards[id] = true;
    return id;
  }

  /** BEST-operator write; `score` is the 0-100 quiz percentage. */
  function writeNoteBoard(
    nk: nkruntime.Nakama,
    logger: nkruntime.Logger,
    noteId: string,
    userId: string,
    username: string,
    score: number
  ): void {
    try {
      var boardId = ensureNoteBoard(nk, logger, noteId);
      nk.leaderboardRecordWrite(boardId, userId, username || "", score, 0, { noteId: noteId });
    } catch (err: any) {
      // The progress object is already durable — the board must not undo it.
      logger.warn("[QvLapProgress] board write failed note=%s user=%s err=%s", noteId, userId,
        (err && err.message ? err.message : String(err)));
    }
  }

  function boardRows(list: any, myId: string): any[] {
    var out: any[] = [];
    var records = (list && list.records) || [];
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      var owner = String(r.ownerId || "");
      if (!owner) continue;
      var score = Number(r.score || 0);
      out.push({
        userId: owner,
        displayName: String(r.username || ""),
        rank: r.rank ? Number(r.rank) : i + 1,
        xp: score,
        score: score,
        isMe: owner === myId,
      });
    }
    return out;
  }

  /**
   * Top `limit` classmates plus the caller's own row when it falls outside
   * that window (so the UI can always say "you are #N").
   */
  function rpcNoteLeaderboard(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string
  ): string {
    if (!ctx.userId) return RpcHelpers.errorResponse("User ID is required", 401);
    var data = RpcHelpers.parseRpcPayload(payload) || {};
    var noteId = validNoteId(data.noteId);
    if (!noteId) return RpcHelpers.errorResponse("noteId must be 1-128 id characters", 400);

    var limit = Number(data.limit);
    if (isNaN(limit)) limit = DEFAULT_BOARD_LIMIT;
    limit = Math.max(1, Math.min(MAX_BOARD_LIMIT, Math.round(limit)));

    var boardId = boardIdForNote(noteId);
    var top: any[] = [];
    var mine: any[] = [];
    try {
      top = boardRows(nk.leaderboardRecordsList(boardId, [], limit, ""), ctx.userId);
      var ownList = nk.leaderboardRecordsList(boardId, [ctx.userId], 1, "");
      mine = boardRows(ownList, ctx.userId);
    } catch (err: any) {
      // No board yet = nobody in this class has scored here.
      logger.debug("[QvLapProgress] board read %s: %s", boardId,
        (err && err.message ? err.message : String(err)));
      return JSON.stringify({ success: true, records: [], data: { records: [] } });
    }

    var merged = top.concat(mine);
    merged.sort(function (a: any, b: any) { return a.rank - b.rank; });
    var rows: any[] = [];
    var seen: { [k: string]: boolean } = {};
    for (var i = 0; i < merged.length; i++) {
      var row = merged[i];
      if (seen[row.userId]) continue;
      seen[row.userId] = true;
      rows.push(row);
    }
    if (rows.length > limit + 1) rows.length = limit + 1;

    return JSON.stringify({ success: true, records: rows, data: { records: rows } });
  }

  function rpcSubmitProgress(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string
  ): string {
    if (!ctx.userId) return RpcHelpers.errorResponse("User ID is required", 401);
    var userId = ctx.userId;
    var data = RpcHelpers.parseRpcPayload(payload) || {};
    var noteId = validNoteId(data.noteId);
    if (!noteId) return RpcHelpers.errorResponse("noteId must be 1-128 id characters", 400);

    var activity = String(data.activity || "").toLowerCase();
    var score = activity === "quiz" ? clampScore(data.score) : -1;
    var isFlash = activity === "flash" || activity === "flashcard" || activity === "flashcards";
    var count = isFlash ? clampCount(data.count) : -1;
    var event = readEvent(data.event);
    if (score < 0 && count < 0 && !event) {
      return RpcHelpers.errorResponse("nothing to record: send a quiz score, a flashcard count, or an event", 400);
    }

    var lastErr: any = null;
    for (var attempt = 0; attempt < OCC_MAX_RETRIES; attempt++) {
      var rows = nk.storageRead([{ collection: COLLECTION, key: noteId, userId: userId }]);
      var exists = !!(rows && rows.length > 0);
      var progress = toProgress(exists ? rows[0].value : null);
      if (score >= 0) progress.quizBestScore = Math.max(progress.quizBestScore, score);
      if (count >= 0) progress.flashcardKnewIt = Math.max(progress.flashcardKnewIt, count);
      if (event) {
        progress.memory.unshift(event);
        if (progress.memory.length > MAX_MEMORY) progress.memory.length = MAX_MEMORY;
      }
      progress.updatedAt = new Date().toISOString();
      try {
        nk.storageWrite([{
          collection: COLLECTION,
          key: noteId,
          userId: userId,
          value: progress as any,
          version: exists ? rows[0].version : "*",
          permissionRead: 1,
          permissionWrite: 0,
        }]);
        if (score >= 0) {
          writeNoteBoard(nk, logger, noteId, userId, ctx.username || "", score);
        }
        return reply(progress);
      } catch (err: any) {
        lastErr = err;
      }
    }
    logger.error("[QvLapProgress] OCC exhausted user=" + userId + " note=" + noteId +
      " err=" + (lastErr && lastErr.message ? lastErr.message : String(lastErr)));
    return RpcHelpers.errorResponse("progress changed on another device; retry", 409);
  }

  function rpcGetProgress(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    payload: string
  ): string {
    if (!ctx.userId) return RpcHelpers.errorResponse("User ID is required", 401);
    var userId = ctx.userId;
    var data = RpcHelpers.parseRpcPayload(payload) || {};
    var raw: any[] = Array.isArray(data.noteIds) ? data.noteIds : [data.noteId];
    if (raw.length > MAX_NOTE_IDS) {
      return RpcHelpers.errorResponse("at most " + MAX_NOTE_IDS + " noteIds", 400);
    }
    var reads: nkruntime.StorageReadRequest[] = [];
    var seen: { [k: string]: boolean } = {};
    for (var i = 0; i < raw.length; i++) {
      var id = validNoteId(raw[i]);
      if (!id || seen[id]) continue;
      seen[id] = true;
      reads.push({ collection: COLLECTION, key: id, userId: userId });
    }
    if (reads.length === 0) return RpcHelpers.errorResponse("noteId or noteIds required", 400);

    var map: { [k: string]: Progress } = {};
    var rows = nk.storageRead(reads);
    for (var r = 0; r < (rows ? rows.length : 0); r++) {
      map[rows[r].key] = toProgress(rows[r].value);
    }
    return reply(map);
  }

  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("quizverse_lap_submit_progress", rpcSubmitProgress);
    initializer.registerRpc("quizverse_lap_get_progress", rpcGetProgress);
    initializer.registerRpc("quizverse_lap_note_leaderboard", rpcNoteLeaderboard);
  }
}
