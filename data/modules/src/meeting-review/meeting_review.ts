// =============================================================================
// Meeting review — autonomous post-meeting pipeline for Curio.
//
// Flow
// ────
//   device uploads a meeting transcript
//     → meeting_review_submit (user)      creates job, forwards to AI svc
//     → AI svc builds summary, decisions, actions, bullets, email draft
//     → meeting_review_complete (server)  stores result, sends push(es)
//     → user opens the push, reviews, asks for changes
//     → meeting_review_refine (user)      same job kind, parent link
//
// Rules
// ─────
//   • Every decision, action and bullet must carry a quote. No quote, dropped.
//   • Nothing is sent anywhere. Email is a draft; the app sends it on a tap.
//   • The job record is owner-readable and server-writable only.
//   • Per-user daily quota stops a runaway client from burning AI credits.
//
// RPCs (4)
// ────────
//   meeting_review_submit   (user)   start a review job
//   meeting_review_get      (user)   read own job + result
//   meeting_review_refine   (user)   ask for a change on a finished job
//   meeting_review_complete (server) AI svc → Nakama when a job terminates
// =============================================================================

namespace MeetingReview {

  // ── Constants ──────────────────────────────────────────────────────────────
  var SERVICE_NAME = "nakama";
  var ROUTE_SUBMIT = "/meeting-review/from-nakama/jobs/submit";
  var ROUTE_REFINE = "/meeting-review/from-nakama/jobs/refine";
  var REQUEST_TIMEOUT_MS = 8000;

  var JOBS_COLLECTION = "meeting_review_jobs";
  var QUOTA_COLLECTION = "meeting_review_quota";
  var DAILY_JOB_LIMIT = 20;

  var READY_CODE = 1320;      // "Review your quick meeting"
  var EMAIL_READY_CODE = 1321; // "Email is ready, review it"

  var MAX_TRANSCRIPT_CHARS = 60000;
  var MAX_TITLE_CHARS = 120;
  var MAX_INSTRUCTION_CHARS = 500;
  var MAX_ID_CHARS = 128;
  var MAX_DECISIONS = 12;
  var MAX_ACTIONS = 12;
  var MAX_BULLETS = 5;
  var MAX_QUOTE_CHARS = 400;
  var ID_PATTERN = /^[A-Za-z0-9_-]+$/;

  // ── Helpers ────────────────────────────────────────────────────────────────

  function aiSvcBase(ctx: nkruntime.Context, logger: nkruntime.Logger): string | null {
    var base = (ctx.env && ctx.env["IVX_AI_SVC_BASE_URL"]) || "";
    if (!base) {
      logger.warn("[MeetingReview] IVX_AI_SVC_BASE_URL unset");
      return null;
    }
    return base.replace(/\/$/, "");
  }

  function extractUrlPath(absUrl: string): string {
    var schemeIdx = absUrl.indexOf("://");
    if (schemeIdx === -1) return absUrl;
    var afterScheme = absUrl.substring(schemeIdx + 3);
    var slashIdx = afterScheme.indexOf("/");
    if (slashIdx === -1) return "";
    return afterScheme.substring(slashIdx);
  }

  function sign(ctx: nkruntime.Context, nk: nkruntime.Nakama, ts: string, path: string, body: string, logger: nkruntime.Logger): string {
    var secret = (ctx.env && ctx.env["IVX_INSIGHTS_SHARED_SECRET"]) || "";
    if (!secret) {
      logger.warn("[MeetingReview] IVX_INSIGHTS_SHARED_SECRET unset");
      return "";
    }
    try {
      var raw = nk.hmacSha256Hash(ts + ":" + path + ":" + body, secret);
      return nk.base16Encode(raw, false).toLowerCase();
    } catch (e: any) {
      logger.warn("[MeetingReview] hmac failed: " + ((e && e.message) ? e.message : String(e)));
      return "";
    }
  }

  /** Signed POST to the AI svc. Returns HTTP code, or 0 on transport failure. */
  function postToAi(ctx: nkruntime.Context, nk: nkruntime.Nakama, logger: nkruntime.Logger, route: string, payload: any): number {
    var base = aiSvcBase(ctx, logger);
    if (!base) return 0;
    var bodyString = JSON.stringify(payload);
    var ts = String(Date.now());
    var sig = sign(ctx, nk, ts, extractUrlPath(base) + route, bodyString, logger);
    try {
      var resp = nk.httpRequest(base + route, "post", {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "X-IVX-Service": SERVICE_NAME,
        "X-IVX-Timestamp": ts,
        "X-IVX-Signature": sig,
      }, bodyString, REQUEST_TIMEOUT_MS);
      return resp ? resp.code : 0;
    } catch (e: any) {
      logger.warn("[MeetingReview] AI post threw: " + ((e && e.message) ? e.message : String(e)));
      return 0;
    }
  }

  function envelope(ok: boolean, data: any, error?: string, code?: number): string {
    if (ok) return JSON.stringify({ success: true, data: data });
    return JSON.stringify({ success: false, error: error || "error", code: code || 0 });
  }

  function cleanStr(v: any, max: number): string {
    if (typeof v !== "string") return "";
    var t = v.trim();
    return t.length > max ? t.substring(0, max) : t;
  }

  function isValidId(v: string): boolean {
    return v.length > 0 && v.length <= MAX_ID_CHARS && ID_PATTERN.test(v);
  }

  function dayKey(): string {
    return new Date().toISOString().substring(0, 10);
  }

  /** Reserves one job against today's quota. False when the cap is reached. */
  function reserveQuota(nk: nkruntime.Nakama, userId: string): boolean {
    var key = dayKey();
    var rows = nk.storageRead([{ collection: QUOTA_COLLECTION, key: key, userId: userId }]);
    var count = 0;
    var version = "*";
    if (rows && rows.length > 0) {
      count = (rows[0].value as any).count || 0;
      version = rows[0].version || "*";
    }
    if (count >= DAILY_JOB_LIMIT) return false;
    try {
      nk.storageWrite([{
        collection: QUOTA_COLLECTION,
        key: key,
        userId: userId,
        value: { count: count + 1 },
        version: version,
        permissionRead: 1,
        permissionWrite: 0,
      }]);
      return true;
    } catch (_) {
      return false; // lost a race: fail closed
    }
  }

  function writeJob(nk: nkruntime.Nakama, userId: string, jobId: string, record: any): void {
    nk.storageWrite([{
      collection: JOBS_COLLECTION,
      key: jobId,
      userId: userId,
      value: record,
      permissionRead: 1,
      permissionWrite: 0,
    }]);
  }

  function readJob(nk: nkruntime.Nakama, userId: string, jobId: string): any {
    var rows = nk.storageRead([{ collection: JOBS_COLLECTION, key: jobId, userId: userId }]);
    if (!rows || rows.length === 0) return null;
    return rows[0].value;
  }

  /** Keeps only items that carry a quote. Caps length and count. */
  function sourcedItems(raw: any, max: number, textKey: string): any[] {
    var out: any[] = [];
    if (!raw || typeof raw.length !== "number") return out;
    for (var i = 0; i < raw.length && out.length < max; i++) {
      var item = raw[i];
      if (!item || typeof item !== "object") continue;
      var text = cleanStr(item[textKey], 300);
      var quote = cleanStr(item.quote, MAX_QUOTE_CHARS);
      if (!text || !quote) continue; // no source line, no card
      out.push({
        text: text,
        quote: quote,
        owner: cleanStr(item.owner, 80) || null,
        why: cleanStr(item.why, 300) || null,
      });
    }
    return out;
  }

  function sanitizeResult(raw: any): any {
    if (!raw || typeof raw !== "object") return null;
    var email: any = null;
    if (raw.emailDraft && typeof raw.emailDraft === "object") {
      var to = cleanStr(raw.emailDraft.to, 200);
      var subject = cleanStr(raw.emailDraft.subject, 200);
      var body = cleanStr(raw.emailDraft.body, 8000);
      if (subject && body) email = { to: to, subject: subject, body: body };
    }
    var bullets: string[] = [];
    if (raw.bullets && typeof raw.bullets.length === "number") {
      for (var i = 0; i < raw.bullets.length && bullets.length < MAX_BULLETS; i++) {
        var b = raw.bullets[i];
        var text = cleanStr(b && b.text, 300);
        var q = cleanStr(b && b.quote, MAX_QUOTE_CHARS);
        if (text && q) bullets.push(text);
      }
    }
    return {
      summary: cleanStr(raw.summary, 1000),
      bullets: bullets,
      decisions: sourcedItems(raw.decisions, MAX_DECISIONS, "text"),
      actions: sourcedItems(raw.actions, MAX_ACTIONS, "text"),
      emailDraft: email,
    };
  }

  // ── RPC: meeting_review_submit (user) ──────────────────────────────────────
  function rpcSubmit(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    try {
      if (!ctx.userId) return envelope(false, null, "User ID is required", 401);
      var data: any;
      try { data = JSON.parse(payload || "{}"); } catch (_) {
        return envelope(false, null, "Invalid JSON", 400);
      }

      var sessionId = cleanStr(data.sessionId, MAX_ID_CHARS);
      if (!isValidId(sessionId)) return envelope(false, null, "sessionId is invalid", 400);
      var transcript = cleanStr(data.transcript, MAX_TRANSCRIPT_CHARS);
      if (!transcript) return envelope(false, null, "transcript is required", 400);
      var title = cleanStr(data.title, MAX_TITLE_CHARS);

      if (!reserveQuota(nk, ctx.userId)) {
        return envelope(false, null, "Daily meeting review limit reached", 429);
      }

      var jobId = "mr_" + nk.uuidv4();
      var now = new Date().toISOString();
      writeJob(nk, ctx.userId, jobId, {
        jobId: jobId, kind: "meeting_review", sessionId: sessionId, title: title,
        transcript: transcript, status: "queued", parentJobId: null, result: null,
        errorMessage: null, createdAt: now, updatedAt: now,
      });

      var code = postToAi(ctx, nk, logger, ROUTE_SUBMIT, {
        cognitoSub: ctx.userId,
        jobId: jobId,
        sessionId: sessionId,
        title: title,
        transcript: transcript,
      });
      if (code < 200 || code >= 300) {
        var failed = readJob(nk, ctx.userId, jobId) || {};
        failed.status = "failed";
        failed.errorMessage = code === 0 ? "ai_unreachable" : "ai_http_" + code;
        failed.updatedAt = new Date().toISOString();
        writeJob(nk, ctx.userId, jobId, failed);
        return envelope(false, { jobId: jobId }, failed.errorMessage, 503);
      }
      return envelope(true, { jobId: jobId, status: "queued" });
    } catch (err: any) {
      logger.error("[MeetingReview] submit failed: " + (err && err.message ? err.message : String(err)));
      return envelope(false, null, "meeting_review_submit failed", 500);
    }
  }

  // ── RPC: meeting_review_get (user) ─────────────────────────────────────────
  function rpcGet(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    try {
      if (!ctx.userId) return envelope(false, null, "User ID is required", 401);
      var data: any = JSON.parse(payload || "{}");
      var jobId = cleanStr(data.jobId, MAX_ID_CHARS);
      if (!isValidId(jobId)) return envelope(false, null, "jobId is invalid", 400);
      var job = readJob(nk, ctx.userId, jobId);
      if (!job) return envelope(false, null, "Not found", 404);
      return envelope(true, job);
    } catch (err: any) {
      logger.error("[MeetingReview] get failed: " + (err && err.message ? err.message : String(err)));
      return envelope(false, null, "meeting_review_get failed", 500);
    }
  }

  // ── RPC: meeting_review_refine (user) ──────────────────────────────────────
  function rpcRefine(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    try {
      if (!ctx.userId) return envelope(false, null, "User ID is required", 401);
      var data: any;
      try { data = JSON.parse(payload || "{}"); } catch (_) {
        return envelope(false, null, "Invalid JSON", 400);
      }
      var parentId = cleanStr(data.jobId, MAX_ID_CHARS);
      if (!isValidId(parentId)) return envelope(false, null, "jobId is invalid", 400);
      var instruction = cleanStr(data.instruction, MAX_INSTRUCTION_CHARS);
      if (!instruction) return envelope(false, null, "instruction is required", 400);

      var parent = readJob(nk, ctx.userId, parentId);
      if (!parent) return envelope(false, null, "Not found", 404);
      if (parent.status !== "ready") return envelope(false, null, "Job is not ready yet", 409);

      if (!reserveQuota(nk, ctx.userId)) {
        return envelope(false, null, "Daily meeting review limit reached", 429);
      }

      var jobId = "mr_" + nk.uuidv4();
      var now = new Date().toISOString();
      writeJob(nk, ctx.userId, jobId, {
        jobId: jobId, kind: "meeting_review_refine", sessionId: parent.sessionId,
        title: parent.title, transcript: parent.transcript, status: "queued",
        parentJobId: parentId, result: null, errorMessage: null,
        createdAt: now, updatedAt: now,
      });

      var code = postToAi(ctx, nk, logger, ROUTE_REFINE, {
        cognitoSub: ctx.userId,
        jobId: jobId,
        parentJobId: parentId,
        transcript: parent.transcript || "",
        previousResult: parent.result,
        instruction: instruction,
      });
      if (code < 200 || code >= 300) {
        var failed = readJob(nk, ctx.userId, jobId) || {};
        failed.status = "failed";
        failed.errorMessage = code === 0 ? "ai_unreachable" : "ai_http_" + code;
        failed.updatedAt = new Date().toISOString();
        writeJob(nk, ctx.userId, jobId, failed);
        return envelope(false, { jobId: jobId }, failed.errorMessage, 503);
      }
      return envelope(true, { jobId: jobId, status: "queued" });
    } catch (err: any) {
      logger.error("[MeetingReview] refine failed: " + (err && err.message ? err.message : String(err)));
      return envelope(false, null, "meeting_review_refine failed", 500);
    }
  }

  // ── RPC: meeting_review_complete (server only) ─────────────────────────────
  function rpcComplete(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    try {
      if (ctx.userId && ctx.userId.length > 0) {
        return envelope(false, null, "meeting_review_complete is service-only", 403);
      }
      var data: any;
      try { data = JSON.parse(payload || "{}"); } catch (_) {
        return envelope(false, null, "Invalid JSON", 400);
      }
      var userId = cleanStr(data.userId, 100);
      var jobId = cleanStr(data.jobId, MAX_ID_CHARS);
      var status = cleanStr(data.status, 20);
      if (!userId || !isValidId(jobId)) return envelope(false, null, "userId and jobId are required", 400);
      if (status !== "ready" && status !== "failed") {
        return envelope(false, null, "status must be ready or failed", 400);
      }

      // The user may have been deleted while the job ran. Nothing to deliver.
      try {
        var exists = nk.usersGetId([userId]);
        if (!exists || exists.length === 0) {
          logger.warn("[MeetingReview] user %s gone — skipping job %s", userId, jobId);
          return envelope(true, { delivered: false, skipped: "user_deleted" });
        }
      } catch (_) { /* probe failure is not proof of deletion */ }

      var job = readJob(nk, userId, jobId) || {
        jobId: jobId, kind: "meeting_review", sessionId: "", title: "",
        parentJobId: null, createdAt: new Date().toISOString(),
      };
      job.status = status;
      job.updatedAt = new Date().toISOString();
      if (status === "ready") {
        job.result = sanitizeResult(data.result);
        job.errorMessage = null;
      } else {
        job.result = null;
        job.errorMessage = cleanStr(data.errorMessage, 300) || "job_failed";
      }
      writeJob(nk, userId, jobId, job);

      if (status !== "ready") {
        return envelope(true, { delivered: false });
      }

      var pushes = 0;
      try {
        nk.notificationsSend([{
          userId: userId,
          code: READY_CODE,
          subject: "Review your quick meeting",
          content: { type: "meeting_review_ready", jobId: jobId, sessionId: job.sessionId },
          persistent: true,
        }]);
        pushes++;
      } catch (e: any) {
        logger.warn("[MeetingReview] ready push failed: " + ((e && e.message) || String(e)));
      }
      if (job.result && job.result.emailDraft) {
        try {
          nk.notificationsSend([{
            userId: userId,
            code: EMAIL_READY_CODE,
            subject: "Email is ready, review it",
            content: { type: "meeting_email_ready", jobId: jobId, sessionId: job.sessionId },
            persistent: true,
          }]);
          pushes++;
        } catch (e: any) {
          logger.warn("[MeetingReview] email push failed: " + ((e && e.message) || String(e)));
        }
      }
      return envelope(true, { delivered: pushes > 0, pushes: pushes });
    } catch (err: any) {
      logger.error("[MeetingReview] complete failed: " + (err && err.message ? err.message : String(err)));
      return envelope(false, null, "meeting_review_complete failed", 500);
    }
  }

  // ── Registration ───────────────────────────────────────────────────────────
  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("meeting_review_submit", rpcSubmit);
    initializer.registerRpc("meeting_review_get", rpcGet);
    initializer.registerRpc("meeting_review_refine", rpcRefine);
    initializer.registerRpc("meeting_review_complete", rpcComplete);
  }
}
