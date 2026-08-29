// =============================================================================
// Recorder ASR — the three RPCs the QuizVerse Flutter client already calls.
//
//   recorder_asr_open   → start or resume a transcription session
//   recorder_asr_push   → upload one chunk of audio, get transcript back
//   recorder_asr_close  → end the session, get trailing transcript
//
// Contract source of truth
// ------------------------
// The client is `lib/features/recorder/data/recorder_asr_transport.dart` in the
// quiz-verse-flutter repo, and where it disagrees with
// `docs/device-pen/30-CLOUD-ENDPOINT-CONTRACTS.md` the client wins. Two
// disagreements matter and are resolved here in the client's favour:
//
//  1. The doc puts `idempotency_key` on every request (§3.1). The ASR client
//     sends no such field. Idempotency is therefore keyed on
//     (`client_session_id`, `seq`) instead, which is what the client actually
//     provides and is in fact the stronger key for a stream.
//  2. The doc says errors arrive "in the response body, not as a transport
//     failure" (§3.1). That is exactly right and is what we do — a failure is
//     HTTP 200 with `{"error":{"code":…,"message":…}}` — because
//     `nakamaRecorderRpc` distinguishes "the server said no" from "the RPC is
//     not registered" by inspecting the body. Returning a Nakama runtime error
//     instead would be classified from exception text, which is fragile.
//
// The response envelope is flat (`{"session_id":…}`), NOT the repo's usual
// `RpcHelpers.successResponse` `{success, data}` wrapper: the client parses
// `data['session_id']` off the top level. Matching the repo shape here would
// silently break every call, so the client shape wins and this is the one
// deliberate departure from house style in this module.
//
// Audio format on the wire
// ------------------------
// Read from the client, not assumed:
//
//  * `codec: "pcm16"` — 16 kHz mono signed 16-bit LE. This is the production
//    path. `opus_codec` ships prebuilt libopus for Android and iOS, so
//    `resolveDeviceAudioDecode()` returns `DeviceAudioDecode.local` on a real
//    handset and the client decodes the pen's Opus itself before uploading.
//  * `codec: "opus"` — bare, back-to-back Opus packets with no container and no
//    length prefix. This is the fallback when libopus fails to load.
//
// Chunks are base64 in `audio_b64` and are NOT packet-aligned: the client's
// `PenAudioChunker` packs whole BLE payloads into a ~4300-byte window, and a BLE
// notification is not an Opus packet boundary. So the server keeps absolute byte
// offsets and re-aligns to packet boundaries itself.
//
// No Opus decoding happens on the server, and none is possible: Goja has no FFI
// and no Node APIs. It is also not needed — the ASR backend is ffmpeg-backed and
// accepts Ogg Opus, so bare packets are *containerised*
// (`RecorderAudio.oggOpusFromPackets`) rather than decoded.
//
// The upload cannot be done from this runtime — `nk.binaryToString` rejects
// non-UTF-8 buffers, so no binary body can be built here. It goes out as base64
// to the `recorder-asr-shim` sidecar, which forwards real multipart; see the
// header of recorder_asr_provider.ts. When that sidecar is absent or cannot
// reach the engine, `open` answers ENDPOINT_UNAVAILABLE and the client keeps
// using on-device speech.
//
// Windowed transcription
// ----------------------
// The ASR engine is a batch model at ~0.38x realtime, and Nakama's HTTP write
// timeout is 10 s by default, so "transcribe everything at close" would time out
// on any recording over ~20 s. Instead each `push` transcribes at most one
// WINDOW_MS window of newly-arrived audio and returns its segments, and `close`
// transcribes the remaining tail. Cost is linear in session length and no single
// call waits more than about a window's worth of engine time.
//
// Retention, and why audio does not accumulate
// --------------------------------------------
// Audio chunks are deleted as soon as they are behind the transcription
// watermark, and every remaining chunk is deleted at close. The server keeps no
// audio after a session ends, ever. Transcripts survive only long enough for a
// retried `close` to be idempotent (RECORDER_ASR_TRANSCRIPT_TTL_SECONDS,
// default 24 h) and are then swept. See §COPPA below.
//
// COPPA
// -----
// An under-13 user's voice is personal information under 16 CFR 312.2(8) and
// there is no verifiable parental consent anywhere in this product. The client
// blocks `AgeRestrictedCapability.audioCapture` before a recording can start,
// and that remains the primary enforcement point because a self-declared age is
// not something this endpoint can verify.
//
// What the server does do, rather than leaving it unaddressed:
//
//  * accepts an explicit `age_assertion` on open and *refuses* the session when
//    it says `below_threshold` or `unknown` — fail closed, matching the client's
//    own rule that an unanswered gate is not permission;
//  * records the assertion (or its absence) on the session so there is an audit
//    trail of what was claimed;
//  * refuses sessions with no assertion at all when
//    RECORDER_ASR_REQUIRE_AGE_ASSERTION=1. This defaults to 0 only because no
//    shipped client sends the field yet; the one-line client change is written
//    up in docs/recorder/ASR_ENDPOINTS.md and flipping this to 1 afterwards is
//    the intended end state.
//  * keeps no audio and short-lived transcripts, so the blast radius of a
//    wrongly-admitted session is bounded in time.
// =============================================================================

namespace RecorderAsr {

  // ── Storage layout ────────────────────────────────────────────────────────

  /** One object per session, keyed by the server session id. */
  var COLLECTION_SESSIONS = "recorder_asr_sessions";
  /** One object per uploaded chunk, keyed `<sessionId>.<seq padded to 6>`. */
  var COLLECTION_CHUNKS = "recorder_asr_chunks";
  /** client_session_id → server session id, so a reconnect resumes. */
  var COLLECTION_INDEX = "recorder_asr_index";

  // ── Limits. Every one of these is a rejection, not a wobble. ──────────────

  /** Base64 characters accepted in one push.
   *
   *  Must stay BELOW Nakama's own `socket.max_request_size_bytes` (default
   *  262,144 — `server/config.go`), which covers the whole request including
   *  the JSON envelope. Measured against a live server the effective ceiling is
   *  ~261,900 chars, so a guard at 262,144 never fired: the request died first
   *  as HTTP 400 "request body too large", which the client's `_classify` maps
   *  to `internal` — retryable — and so an oversized chunk would be retried
   *  forever instead of being dropped.
   *
   *  160,000 sits under the transport limit with room for the envelope and
   *  still clears the client's largest real chunk (~91,700 chars: a 4300-byte
   *  Opus window expanded 16x by local PCM decode) by ~1.7x. */
  var MAX_PUSH_B64_CHARS = 160000;
  /** Decoded audio per session. 24 MiB is ~12.5 min of 16 kHz mono PCM16. */
  var MAX_SESSION_BYTES = 24 * 1024 * 1024;
  var MAX_CHUNKS_PER_SESSION = 4096;
  /**
   * Largest jump in `seq` a single push may make.
   *
   * A gap is legitimate — the client's backpressure drops the oldest queued
   * chunk while sequence numbers keep incrementing — so this cannot be "no gap
   * at all". But `acked_seq` is set from the client's `seq` with no ceiling, and
   * two hot paths derive a dense key range from it (`readWindowBytes` reads one
   * chunk key per seq, `deleteChunks` deletes one per seq). That made their cost
   * client-controlled: one push with `seq = 2_000_000_000` and every subsequent
   * window read and every reclamation walks two billion keys.
   *
   * Not hypothetical. A live local session reached `acked_seq = 91736`, and the
   * resulting 91,737-key delete took 42 s in one transaction — long enough that
   * Nakama closed the connection at its socket write timeout and the caller saw
   * a failure for work that had actually completed.
   *
   * Bounded at the chunk cap, because at most that many chunks can ever be
   * stored: a client that has dropped more than 4,096 chunks in a row has lost
   * ~13 minutes of audio and should open a new session rather than ask the
   * server to address a sparse range wider than any session can hold.
   */
  var MAX_CHUNK_SEQ_GAP = MAX_CHUNKS_PER_SESSION;
  /** Concurrent open sessions per account. One capture at a time is the product
   *  reality; 3 tolerates orphans from a crashed app without letting a loop
   *  fill storage. */
  var MAX_OPEN_SESSIONS_PER_USER = 3;
  /** An open session untouched for this long is abandoned and swept. */
  var SESSION_IDLE_TTL_SECONDS = 3600;
  /** Sessions examined per opportunistic sweep. */
  var GC_SCAN_LIMIT = 100;

  // ── Transcription windowing ───────────────────────────────────────────────

  /** Audio per transcription call. 8 s at ~0.38x realtime is ~3 s of engine
   *  time, comfortably inside Nakama's 10 s HTTP write timeout. */
  var WINDOW_MS = 8000;
  /** Re-fed to the engine at the head of each window so an utterance split
   *  across a boundary is transcribed intact. Segments ending before the
   *  previous watermark are dropped, so the overlap does not duplicate text. */
  var OVERLAP_MS = 1200;
  /** Hard ceiling on audio handed to the engine in a single RPC, so a large
   *  backlog cannot push one call past the write timeout. */
  var MAX_CALL_MS = 20000;
  /**
   * A segment ending within this much of the end of the engine's input is
   * treated as unfinished and emitted as a partial (`is_final: false`) rather
   * than committed.
   *
   * Why: the engine only saw audio up to the window edge, so an utterance still
   * in progress there comes back truncated — observed live, a window boundary
   * turned "and returns a transcript" into "and returns a transc-". The next
   * window re-transcribes it in full (that is what OVERLAP_MS is for) and emits
   * the complete version as final. The client already has exactly the right
   * semantics for this: `is_final: false` replaces its volatile `partial` string,
   * while final segments are appended
   * (quiz-verse-flutter lib/features/recorder/application/
   * recorder_session_controller.dart `_onSegment`).
   */
  var TAIL_GUARD_MS = 600;

  // ── Codec allow-list ──────────────────────────────────────────────────────

  var CODEC_PCM16 = "pcm16";
  var CODEC_OPUS = "opus";
  var LEGAL_RATES: { [k: string]: boolean } = { "8000": true, "12000": true, "16000": true, "24000": true, "48000": true };
  var LEGAL_FRAME_MS: { [k: string]: boolean } = { "2": true, "5": true, "10": true, "20": true, "40": true, "60": true };
  /** Packet sizes seen in the wild: 40 on the pnote pen (`setPacketSize(40)`),
   *  80 on the RCSP sibling family. Probed in this order. */
  var PACKET_SIZE_CANDIDATES = [40, 80];

  // ── Error codes. These strings are `RegistrationErrorCode.fromWire` in the
  //    client; anything else it does not recognise becomes INTERNAL. ─────────

  var ERR_UNAUTHENTICATED = "UNAUTHENTICATED";
  var ERR_RATE_LIMITED = "RATE_LIMITED";
  var ERR_ENDPOINT_UNAVAILABLE = "ENDPOINT_UNAVAILABLE";
  var ERR_INTERNAL = "INTERNAL";
  var ERR_NOT_FOUND = "DEVICE_NOT_FOUND";

  // ── Wire records ──────────────────────────────────────────────────────────

  interface AgeAssertion {
    bracket: string;          // at_or_above_threshold | below_threshold | unknown | absent
    min_age: number;
    declared_at: string;
    source: string;           // "client" | "absent"
  }

  interface SessionRecord {
    session_id: string;
    client_session_id: string;
    contract_version: string;
    locale: string;
    codec: string;
    sample_rate_hz: number;
    channels: number;
    frame_ms: number;
    /** Bare-Opus packet size. 0 until known; probed from the bitstream. */
    packet_bytes: number;
    device_record_id: string;
    /** Fingerprint only — a binding token is a capability and is never stored
     *  or logged in the clear. */
    binding_token_fp: string;
    age_assertion: AgeAssertion;
    state: string;            // "open" | "closed"
    acked_seq: number;
    chunk_count: number;
    audio_bytes: number;
    /** Absolute byte offset of the next chunk, i.e. the session stream length. */
    next_offset: number;
    /** Audio bytes already handed to the engine. */
    transcribed_bytes: number;
    /** Audio-timeline ms already emitted as segments. */
    transcribed_ms: number;
    /** Lowest seq still present in storage; chunks below it are deleted. */
    first_chunk_seq: number;
    segments: any[];
    created_at: number;
    updated_at: number;
    closed_at: number;
    expires_at: number;
  }

  interface ChunkRecord {
    seq: number;
    /** Absolute byte offset of this chunk within the session stream. */
    off: number;
    bytes: number;
    b64: string;
  }

  // ── Small helpers ─────────────────────────────────────────────────────────

  function nowSec(): number { return Math.floor(Date.now() / 1000); }

  function errorBody(code: string, message: string): string {
    return JSON.stringify({ error: { code: code, message: message } });
  }

  function pad6(n: number): string {
    var s = "" + n;
    while (s.length < 6) s = "0" + s;
    return s;
  }

  function chunkKey(sessionId: string, seq: number): string {
    return sessionId + "." + pad6(seq);
  }

  function intOf(v: any, dflt: number): number {
    var n = parseInt("" + v, 10);
    return isNaN(n) ? dflt : n;
  }

  function envInt(ctx: nkruntime.Context, key: string, dflt: number): number {
    var raw = ctx.env && ctx.env[key];
    if (raw === undefined || raw === null || raw === "") return dflt;
    var n = parseInt("" + raw, 10);
    return isNaN(n) || n < 0 ? dflt : n;
  }

  function transcriptTtlSeconds(ctx: nkruntime.Context): number {
    return envInt(ctx, "RECORDER_ASR_TRANSCRIPT_TTL_SECONDS", 86400);
  }

  function requireAgeAssertion(ctx: nkruntime.Context): boolean {
    return "" + ((ctx.env && ctx.env["RECORDER_ASR_REQUIRE_AGE_ASSERTION"]) || "0") === "1";
  }

  /** Short, non-reversible fingerprint for logging/audit of a capability. */
  function fingerprint(nk: nkruntime.Nakama, value: string): string {
    if (!value || value.length === 0) return "";
    try {
      return ("" + nk.sha256Hash(value)).substring(0, 12);
    } catch (_e: any) {
      return "unhashable";
    }
  }

  function readSession(nk: nkruntime.Nakama, userId: string, sessionId: string): SessionRecord {
    // Read under the caller's own userId only. Storage is partitioned by user in
    // Nakama, so a session id belonging to somebody else simply is not here —
    // cross-account access is structurally impossible rather than filtered.
    var objs = nk.storageRead([{ collection: COLLECTION_SESSIONS, key: sessionId, userId: userId }]);
    if (!objs || objs.length === 0) return null;
    return objs[0].value as any as SessionRecord;
  }

  function writeSession(nk: nkruntime.Nakama, userId: string, rec: SessionRecord): void {
    rec.updated_at = nowSec();
    nk.storageWrite([{
      collection: COLLECTION_SESSIONS,
      key: rec.session_id,
      userId: userId,
      value: rec as any,
      // Owner may read (debug screens); only the server writes.
      permissionRead: 1,
      permissionWrite: 0,
    }]);
  }

  /** Delete keys per `storageDelete` call. One call is one transaction, and a
   *  transaction of thousands of keys is what turned a single reclamation into
   *  a 42-second RPC (see `deleteChunks`). */
  var CHUNK_DELETE_BATCH = 256;

  /**
   * Deletes the chunk rows for `[fromSeq, toSeq]`.
   *
   * The range is derived from `acked_seq`, which is **client-supplied**: a seq
   * gap is legitimate (the client's backpressure drops the oldest queued chunk
   * while sequence numbers keep incrementing) so `rpcPush` accepts one. That
   * made this function's cost client-controlled — one push with a large `seq`
   * and every later reclamation walks that whole range.
   *
   * Observed on a live local server: a session with `acked_seq = 91736` built a
   * 91,737-key delete in a single transaction, which took 42 s. Nakama closed
   * the connection at its socket write timeout, so the sweep's answer was lost
   * even though the work completed. With a larger seq it is unbounded memory.
   *
   * `rpcPush` now caps the gap, so new sessions cannot reach that state. This
   * bounds the walk anyway, because records written before that cap are still
   * in storage and one of them must not be able to hang a sweep.
   */
  function deleteChunks(nk: nkruntime.Nakama, userId: string, sessionId: string, fromSeq: number, toSeq: number): number {
    if (toSeq < fromSeq) return 0;

    // At most MAX_CHUNKS_PER_SESSION chunks can ever have been stored, so a
    // range wider than that is mostly keys that were never written.
    var walkTo = toSeq;
    var capped = false;
    if (toSeq - fromSeq >= MAX_CHUNKS_PER_SESSION) {
      walkTo = fromSeq + MAX_CHUNKS_PER_SESSION - 1;
      capped = true;
    }

    var deletes: nkruntime.StorageDeleteRequest[] = [];
    for (var s = fromSeq; s <= walkTo; s++) {
      deletes.push({ collection: COLLECTION_CHUNKS, key: chunkKey(sessionId, s), userId: userId });
    }
    // The highest seq is the one chunk that certainly was written, so include
    // it explicitly rather than leaving it behind when the walk was capped.
    if (capped) {
      deletes.push({ collection: COLLECTION_CHUNKS, key: chunkKey(sessionId, toSeq), userId: userId });
    }

    var attempted = 0;
    for (var i = 0; i < deletes.length; i += CHUNK_DELETE_BATCH) {
      var batch = deletes.slice(i, i + CHUNK_DELETE_BATCH);
      try {
        nk.storageDelete(batch);
      } catch (_e: any) {
        // A missing chunk is the desired end state; a gap from a dropped upload
        // makes this normal rather than exceptional.
      }
      attempted += batch.length;
    }
    return attempted;
  }

  // ── Duration arithmetic ───────────────────────────────────────────────────

  /** Bytes → audio-timeline ms, per codec. Exact for PCM16; for bare Opus it
   *  depends on the packet size, which is why an unknown packet size falls back
   *  to the pen's documented 40 bytes rather than guessing zero. */
  function bytesToMs(rec: SessionRecord, bytes: number): number {
    if (rec.codec === CODEC_PCM16) {
      var byteRate = rec.sample_rate_hz * rec.channels * 2;
      return byteRate > 0 ? Math.round(bytes * 1000 / byteRate) : 0;
    }
    var pkt = rec.packet_bytes > 0 ? rec.packet_bytes : PACKET_SIZE_CANDIDATES[0];
    return Math.round((bytes / pkt) * rec.frame_ms);
  }

  function msToBytes(rec: SessionRecord, ms: number): number {
    if (rec.codec === CODEC_PCM16) {
      return Math.round(ms * rec.sample_rate_hz * rec.channels * 2 / 1000);
    }
    var pkt = rec.packet_bytes > 0 ? rec.packet_bytes : PACKET_SIZE_CANDIDATES[0];
    return rec.frame_ms > 0 ? Math.round(ms / rec.frame_ms) * pkt : 0;
  }

  /** Snaps a byte offset down to something the codec can start decoding at.
   *  PCM16 needs sample alignment; bare Opus needs packet alignment, because a
   *  slice that starts mid-packet decodes to plausible noise. */
  function alignDown(rec: SessionRecord, offset: number): number {
    if (rec.codec === CODEC_PCM16) {
      var block = rec.channels * 2;
      return offset - (offset % block);
    }
    var pkt = rec.packet_bytes > 0 ? rec.packet_bytes : PACKET_SIZE_CANDIDATES[0];
    return offset - (offset % pkt);
  }

  // ── Transcription ─────────────────────────────────────────────────────────

  interface WindowPlan {
    /** Absolute byte offset the engine input starts at. */
    startOffset: number;
    /** Absolute byte offset the engine input ends at (exclusive). */
    endOffset: number;
    firstSeq: number;
    lastSeq: number;
  }

  /**
   * How much already-consumed audio the next window re-reads.
   *
   * Zero in the normal case, and that is the whole point. `transcribed_bytes`
   * is rewound to the end of the last committed utterance after every window,
   * so the next window already starts on a clean utterance boundary and there
   * is nothing to recover by reaching further back. Re-feeding anyway is what
   * produced duplicated text at every seam: the engine received the tail of a
   * committed sentence, transcribed it again as part of a longer segment, and
   * that segment's timings straddled the watermark so the drop rule could not
   * catch it. Measured before the fix — "…sidecar shim." committed, then
   * "sidecar shim. 2. The audio was…" committed immediately after, with
   * `begin_ms` moving backwards.
   *
   * The overlap is for the degraded path only: audio the byte watermark passed
   * over without any text being committed for it (chunks missing, a container
   * that would not mux, a forced flush that finalised nothing). There the
   * boundary is arbitrary and an utterance really can be sliced in half, so the
   * next window reaches back to pick up its start.
   *
   * Exported for tests: this is one branch on two integers, and the degraded
   * path cannot be reached through the RPCs without racing storage.
   */
  export function overlapMsFor(consumedMs: number, committedMs: number): number {
    return consumedMs > committedMs ? OVERLAP_MS : 0;
  }

  /**
   * Chooses the next slice of audio to transcribe.
   *
   * Returns null when there is not enough new audio to be worth a round trip
   * (unless `force`, which is what `close` passes to flush the tail).
   */
  function planWindow(rec: SessionRecord, force: boolean): WindowPlan {
    var pending = rec.next_offset - rec.transcribed_bytes;
    if (pending <= 0) return null;
    var pendingMs = bytesToMs(rec, pending);
    if (!force && pendingMs < WINDOW_MS) return null;

    // Never hand the engine more than MAX_CALL_MS in one call, even on close:
    // a backlog must cost several bounded calls, not one unbounded one.
    var maxBytes = msToBytes(rec, MAX_CALL_MS);
    var endOffset = pending > maxBytes ? alignDown(rec, rec.transcribed_bytes + maxBytes) : rec.next_offset;
    if (endOffset <= rec.transcribed_bytes) endOffset = rec.next_offset;

    // Overlap only when audio was consumed WITHOUT being committed.
    //
    // Measured against a real engine (2026-08-28): re-feeding overlap
    // unconditionally duplicates text. The dedup rule drops segments that end
    // before the watermark, which was believed to make the overlap free — but
    // the engine does not re-segment the same way twice. Given overlapping
    // audio it returns one *merged* segment straddling the watermark, which
    // passes the dedup test and re-emits its already-committed prefix. Observed:
    // "…sidecar shim." committed, then "sidecar shim. 2. The audio was…"
    // committed straight after, and a `begin_ms` that moved backwards.
    //
    // The overlap is redundant in that case anyway. `transcribeWindow` rewinds
    // the byte watermark to the end of the last *committed* utterance, so the
    // next window already starts in a pause with every uncommitted byte still
    // ahead of it — an utterance cut by the window edge is re-transcribed in
    // full without re-reading anything already emitted.
    //
    // Overlap is still needed on the degraded path, where the watermark was
    // force-advanced past audio that never produced committed text (a window
    // that yielded only partials, or a missing chunk). That is exactly the case
    // where the byte watermark is ahead of the committed-text watermark, so no
    // extra session state is needed to detect it. Text can still be duplicated
    // there, and re-emitting beats dropping when audio has already been skipped.
    var overlapMs = overlapMsFor(bytesToMs(rec, rec.transcribed_bytes), rec.transcribed_ms);

    var startOffset = alignDown(rec, Math.max(0, rec.transcribed_bytes - msToBytes(rec, overlapMs)));
    return { startOffset: startOffset, endOffset: endOffset, firstSeq: -1, lastSeq: -1 };
  }

  /**
   * Reads the chunks covering [startOffset, endOffset) and returns exactly those
   * bytes.
   *
   * Chunk boundaries do not line up with the requested range — the client packs
   * BLE payloads, not codec frames — so the covering chunks are read whole and
   * then trimmed. A chunk that was already deleted (behind the watermark, or
   * dropped by the client's backpressure) simply shortens the window rather than
   * failing the call.
   */
  function readWindowBytes(
    nk: nkruntime.Nakama,
    userId: string,
    rec: SessionRecord,
    plan: WindowPlan,
  ): WindowRead {
    var empty: WindowRead = { bytes: new Uint8Array(0), chunks: [] };
    var reads: nkruntime.StorageReadRequest[] = [];
    var seq: number;
    // Bounded for the same reason as `deleteChunks`: this walks a range derived
    // from the client-supplied `acked_seq`, and no more than
    // MAX_CHUNKS_PER_SESSION chunks can exist, so a wider range is keys that
    // were never written. `rpcPush` caps the gap at the source; this keeps a
    // record written before that cap from building a multi-thousand-key read.
    var lastSeq = rec.acked_seq;
    if (lastSeq - rec.first_chunk_seq >= MAX_CHUNKS_PER_SESSION) {
      lastSeq = rec.first_chunk_seq + MAX_CHUNKS_PER_SESSION - 1;
    }
    for (seq = rec.first_chunk_seq; seq <= lastSeq; seq++) {
      reads.push({ collection: COLLECTION_CHUNKS, key: chunkKey(rec.session_id, seq), userId: userId });
    }
    if (reads.length === 0) return empty;
    var objs = nk.storageRead(reads);
    if (!objs || objs.length === 0) return empty;

    // storageRead does not guarantee order; sort by the seq we stored.
    var chunks: ChunkRecord[] = [];
    for (var i = 0; i < objs.length; i++) {
      var c = objs[i].value as any as ChunkRecord;
      if (c && typeof c.off === "number") chunks.push(c);
    }
    chunks.sort(function (a, b) { return a.seq - b.seq; });

    var parts: Uint8Array[] = [];
    for (var k = 0; k < chunks.length; k++) {
      var ch = chunks[k];
      var chEnd = ch.off + ch.bytes;
      if (chEnd <= plan.startOffset) continue;
      if (ch.off >= plan.endOffset) break;
      var bytes = new Uint8Array(nk.base64Decode(ch.b64) as ArrayBuffer);
      var from = plan.startOffset > ch.off ? plan.startOffset - ch.off : 0;
      var to = plan.endOffset < chEnd ? bytes.length - (chEnd - plan.endOffset) : bytes.length;
      if (to <= from) continue;
      parts.push(bytes.subarray(from, to));
      if (plan.firstSeq < 0) plan.firstSeq = ch.seq;
      plan.lastSeq = ch.seq;
    }
    return { bytes: RecorderAudio.concatBytes(parts), chunks: chunks };
  }

  interface WindowRead {
    bytes: Uint8Array;
    /** Exact metadata for every chunk still in storage, ascending by seq. Used
     *  to decide deletion without a second read or an interpolated offset. */
    chunks: ChunkRecord[];
  }

  interface Encoded {
    bytes: Uint8Array;
    contentType: string;
    filename: string;
  }

  /** Wraps raw session bytes in whatever container the engine can demux. */
  function encodeForProvider(nk: nkruntime.Nakama, rec: SessionRecord, raw: Uint8Array): Encoded {
    if (rec.codec === CODEC_PCM16) {
      return {
        bytes: RecorderAudio.wavFromPcm16(raw, rec.sample_rate_hz, rec.channels),
        contentType: "audio/wav",
        filename: "capture.wav",
      };
    }
    // Bare Opus. The client does not send the packet size, so probe it from the
    // bitstream and remember what the bytes said — a wrong size is the one error
    // that decodes without complaint at half the true length.
    var guess = RecorderAudio.guessPacketSize(raw, rec.packet_bytes > 0 ? [rec.packet_bytes] : PACKET_SIZE_CANDIDATES);
    if (guess === null || guess.packets === 0) {
      throw new Error("bare Opus stream did not match any known packet size");
    }
    if (rec.packet_bytes <= 0) rec.packet_bytes = guess.packetBytes;
    var frameMicros = guess.frameMicros > 0 ? guess.frameMicros : rec.frame_ms * 1000;
    var packets = RecorderAudio.sliceBarePackets(raw, guess.packetBytes);
    var ogg = RecorderAudio.oggOpusFromPackets(
      packets, rec.sample_rate_hz, guess.channels, frameMicros, 0x51565253);
    return { bytes: ogg.bytes, contentType: "audio/ogg", filename: "capture.opus.ogg" };
  }

  /**
   * Transcribes one window and folds the result into the session.
   *
   * Returns the segments that are new — segments landing entirely inside the
   * overlap have already been emitted and are dropped, which is what keeps the
   * overlap from duplicating text.
   *
   * Never throws: a provider failure leaves the watermark alone so the audio is
   * retried on the next call, and the caller still gets a valid ack.
   */
  function transcribeWindow(
    ctx: nkruntime.Context,
    logger: nkruntime.Logger,
    nk: nkruntime.Nakama,
    userId: string,
    rec: SessionRecord,
    force: boolean,
  ): any[] {
    var cfg = RecorderAsrProvider.config(ctx);
    // Config check only — no shim probe. `open` already answered that
    // honestly; a failure here is absorbed and the window is retried.
    if (!RecorderAsrProvider.isAvailable(cfg)) return [];

    var plan = planWindow(rec, force);
    if (plan === null) return [];

    var read: WindowRead;
    try {
      read = readWindowBytes(nk, userId, rec, plan);
    } catch (e: any) {
      logger.warn("[RecorderAsr] window read failed: " + (e && e.message ? e.message : String(e)));
      return [];
    }
    var raw = read.bytes;
    if (raw.length === 0) {
      // Everything in range is gone (client dropped it, or it is already behind
      // the watermark). Advance so we do not spin on it.
      rec.transcribed_bytes = plan.endOffset;
      return [];
    }

    var encoded: Encoded;
    try {
      encoded = encodeForProvider(nk, rec, raw);
    } catch (e: any) {
      logger.error("[RecorderAsr] container mux failed: " + (e && e.message ? e.message : String(e)));
      rec.transcribed_bytes = plan.endOffset;
      return [];
    }

    var offsetMs = bytesToMs(rec, plan.startOffset);
    var watermarkMs = rec.transcribed_ms;
    var result: RecorderAsrProvider.TranscribeResult;
    try {
      result = RecorderAsrProvider.transcribe(nk, logger, cfg, {
        bytes: encoded.bytes,
        contentType: encoded.contentType,
        filename: encoded.filename,
        locale: rec.locale,
        offsetMs: offsetMs,
      });
    } catch (e: any) {
      // Leave transcribed_bytes untouched: the audio is still in storage and the
      // next push (or close) retries it.
      logger.warn("[RecorderAsr] provider failed: " + (e && e.message ? e.message : String(e)));
      return [];
    }

    // Anything the previous window already committed as final is dropped: the
    // overlap re-transcribes that audio on purpose, and re-emitting it would
    // duplicate text the client has already appended.
    var candidates: RecorderAsrProvider.Segment[] = [];
    for (var i = 0; i < result.segments.length; i++) {
      if (result.segments[i].endMs > watermarkMs) candidates.push(result.segments[i]);
    }
    if (candidates.length === 0) {
      // The window held nothing new (silence, or all of it already emitted).
      // Advance anyway so we do not re-read the same audio forever.
      rec.transcribed_bytes = plan.endOffset;
      var silentMs = bytesToMs(rec, plan.endOffset);
      if (silentMs > rec.transcribed_ms) rec.transcribed_ms = silentMs;
      pruneChunks(nk, userId, rec, read);
      return [];
    }

    // Where the engine input ran out. A segment that reaches this edge was very
    // likely cut mid-utterance — the engine had no audio left to finish it — so
    // it is not safe to commit.
    var boundaryMs = bytesToMs(rec, plan.endOffset);

    var finalCount: number;
    if (force) {
      // No more audio is coming (close, or the client's is_last), so there is
      // nothing left to supersede a tail and everything is final.
      //
      // Committed unconditionally rather than by comparing against boundaryMs.
      // Engine timestamps are not bounded by the audio length — Whisper pads its
      // input to 30 s and can report an end past the real end — so a
      // `endMs <= boundaryMs` test silently excluded the last utterance. Then
      // `force` had already consumed the audio, so `close` found nothing left to
      // transcribe and the utterance was lost. Measured: a 27.4 s recording
      // committed text ending "…device audio has" and left "become text." as a
      // partial that nothing ever finalised.
      finalCount = candidates.length;
    } else {
      var stableUntilMs = boundaryMs - TAIL_GUARD_MS;
      finalCount = 0;
      for (var k = 0; k < candidates.length; k++) {
        if (candidates[k].endMs <= stableUntilMs) finalCount++;
      }
      // Guarantee forward progress. One utterance longer than a whole window (a
      // continuous speaker, no pauses) would otherwise never finalise and the
      // same audio would be re-sent on every push. Committing it costs at worst
      // one word split across a boundary.
      if (finalCount === 0) finalCount = candidates.length;
    }

    var fresh: any[] = [];
    var lastFinalEndMs = watermarkMs;
    for (var j = 0; j < candidates.length; j++) {
      var s = candidates[j];
      var isFinal = j < finalCount;
      fresh.push({
        text: s.text,
        begin_ms: s.beginMs,
        end_ms: s.endMs,
        is_final: isFinal,
      });
      if (isFinal) {
        // Only committed text goes into the stored transcript. A partial is
        // volatile by contract: the client shows it as in-progress text and
        // replaces it, so storing it would produce duplicates on resume.
        rec.segments.push(fresh[j]);
        if (s.endMs > lastFinalEndMs) lastFinalEndMs = s.endMs;
      }
    }

    // Resume from the end of the last committed utterance rather than from the
    // arbitrary byte the window happened to end on. That puts the next window's
    // seam in the pause between utterances instead of mid-word, which is what
    // stops the overlap from producing duplicated words.
    rec.transcribed_ms = lastFinalEndMs;
    if (force) {
      // Nothing further will arrive to supersede a tail, so the whole window is
      // consumed. Rewinding to the last utterance here would make `close` spend
      // another engine round trip on the trailing silence.
      rec.transcribed_bytes = plan.endOffset;
    } else {
      var finalizedOffset = alignDown(rec, msToBytes(rec, lastFinalEndMs));
      if (finalizedOffset > rec.transcribed_bytes && finalizedOffset < plan.endOffset) {
        rec.transcribed_bytes = finalizedOffset;
      } else if (finalizedOffset >= plan.endOffset) {
        rec.transcribed_bytes = plan.endOffset;
      }
      // A window that produced only partials must still consume audio, or the
      // next push replays it unchanged and never makes progress.
      if (rec.transcribed_bytes <= plan.startOffset) rec.transcribed_bytes = plan.endOffset;
    }

    pruneChunks(nk, userId, rec, read);
    return fresh;
  }

  /**
   * Deletes audio that is wholly behind the watermark, less the overlap the next
   * window still needs. Offsets come from the chunk records just read, so the
   * decision is exact rather than interpolated.
   */
  function pruneChunks(
    nk: nkruntime.Nakama,
    userId: string,
    rec: SessionRecord,
    read: WindowRead,
  ): void {
    var keepFrom = alignDown(rec, Math.max(0, rec.transcribed_bytes - msToBytes(rec, OVERLAP_MS)));
    var dropTo = rec.first_chunk_seq - 1;
    for (var c = 0; c < read.chunks.length; c++) {
      var ch = read.chunks[c];
      if (ch.off + ch.bytes > keepFrom) break;
      dropTo = ch.seq;
    }
    if (dropTo >= rec.first_chunk_seq) {
      deleteChunks(nk, userId, rec.session_id, rec.first_chunk_seq, dropTo);
      rec.first_chunk_seq = dropTo + 1;
    }
  }

  // ── Housekeeping ──────────────────────────────────────────────────────────

  /** Whether a session record has passed its deadline. */
  function isExpired(rec: SessionRecord, now: number): boolean {
    return rec.expires_at > 0
      ? now >= rec.expires_at
      : now - (rec.updated_at || rec.created_at || 0) >= SESSION_IDLE_TTL_SECONDS;
  }

  /** Deletes one expired session: its audio, its record, its resume index. */
  function reclaimSession(nk: nkruntime.Nakama, owner: string, rec: SessionRecord): void {
    deleteChunks(nk, owner, rec.session_id, rec.first_chunk_seq, rec.acked_seq);
    try {
      nk.storageDelete([
        { collection: COLLECTION_SESSIONS, key: rec.session_id, userId: owner },
        { collection: COLLECTION_INDEX, key: rec.client_session_id, userId: owner },
      ]);
    } catch (_e: any) { /* already gone */ }
  }

  export interface UserReclaim {
    /** Sessions still genuinely open after reclamation — what the cap counts. */
    openSessions: number;
    removed: number;
  }

  /**
   * One pass over the caller's OWN sessions: deletes the expired ones and counts
   * the ones still open.
   *
   * This is the reclamation that runs on the request path, and it is per-user on
   * purpose. It used to be a cross-account scan (up to 5 pages x 100 objects
   * over every account) that any authenticated user could trigger, and it ran
   * *before* the per-user cap check, so a user already at their cap paid for a
   * 500-object global scan on every rejected call.
   *
   * Combining reclaim with the count also means `open` issues one listing where
   * it used to issue up to six, and the listing it issues is the one the cap
   * check needed anyway. Reclaiming the caller's own expired sessions is also
   * the only reclamation that can free the cap slot they are asking for.
   *
   * Global reclamation lives in `sweep`, driven by the `recorder_asr_gc` cron.
   */
  function reclaimAndCountForUser(
    nk: nkruntime.Nakama,
    logger: nkruntime.Logger,
    userId: string,
  ): UserReclaim {
    var open = 0;
    var removed = 0;
    var now = nowSec();
    var cursor = "";
    var pages = 0;
    // A user holds a handful of live sessions plus whatever closed records are
    // still inside the transcript TTL. Paging (rather than reading one page of
    // 50, as this did before) is what stops a backlog of retained records from
    // hiding open sessions past the page boundary and defeating the cap.
    while (pages < 5) {
      pages++;
      var page: nkruntime.StorageObjectList;
      try {
        page = nk.storageList(userId, COLLECTION_SESSIONS, GC_SCAN_LIMIT, cursor);
      } catch (_e: any) {
        // An unreadable list must not block opening a session. Counting zero is
        // the permissive answer, and the caps below it are still enforced.
        break;
      }
      if (!page || !page.objects || page.objects.length === 0) break;
      for (var i = 0; i < page.objects.length; i++) {
        var rec = page.objects[i].value as any as SessionRecord;
        if (!rec || !rec.session_id) continue;
        if (isExpired(rec, now)) {
          reclaimSession(nk, userId, rec);
          removed++;
          continue;
        }
        if (rec.state === "open") open++;
      }
      if (!page.cursor) break;
      cursor = page.cursor;
    }
    if (removed > 0) {
      logger.info("[RecorderAsr] reclaimed " + removed +
        " expired session(s) for user=" + userId);
    }
    return { openSessions: open, removed: removed };
  }

  // ── Global sweep (cron) ───────────────────────────────────────────────────

  /** Server-owned bookkeeping for the global sweep. Written with `userId`
   *  omitted, which is how the JS runtime addresses server-owned storage —
   *  passing an empty string instead throws "expects 'userId' value to be a
   *  valid id" (`server/runtime_javascript_nakama.go`). */
  var COLLECTION_GC_STATE = "recorder_asr_gc_state";
  var KEY_SWEEP_CURSOR = "sweep_cursor";
  /** Pages per sweep run. Bounded so one cron tick has predictable cost; the
   *  persisted cursor is what makes successive ticks cover the whole keyspace. */
  var GC_PAGES_PER_RUN = 5;
  /**
   * Sessions actually deleted per sweep run.
   *
   * Scanning is a handful of listings and cheap. Deleting is not: each
   * reclamation walks the session's chunk range with a storage delete per
   * sequence number. Measured on a local CockroachDB, 8 reclamations took the
   * RPC past 25 s — and Nakama's `socket.write_timeout_ms` defaults to 10 s, so
   * the connection was closed and the caller saw a failure even though the
   * sweep had completed and persisted its cursor.
   *
   * Capping deletions per call keeps one RPC comfortably inside that window at
   * any backlog size. Throughput comes from calling it repeatedly instead —
   * `budget_exhausted` in the response tells the caller there is more to do,
   * and `k8s/recorder-asr-cronjob.yaml` loops on it.
   */
  var GC_MAX_RECLAIMS_PER_RUN = 5;

  // The `userId` key is omitted, not set to "". `nkruntime`'s types mark it
  // required, hence the casts, but at runtime an absent key is what selects
  // server-owned storage — an empty string is run through `uuid.FromString` and
  // throws "expects 'userId' value to be a valid id"
  // (server/runtime_javascript_nakama.go). Do not "fix" the casts by adding
  // `userId: ""`.
  function readSweepCursor(nk: nkruntime.Nakama): string {
    try {
      var read = { collection: COLLECTION_GC_STATE, key: KEY_SWEEP_CURSOR } as any;
      var objs = nk.storageRead([read as nkruntime.StorageReadRequest]);
      if (objs && objs.length > 0) return "" + ((objs[0].value as any).cursor || "");
    } catch (_e: any) { /* first run, or unreadable — start from the beginning */ }
    return "";
  }

  function writeSweepCursor(nk: nkruntime.Nakama, cursor: string): void {
    try {
      var write = {
        collection: COLLECTION_GC_STATE,
        key: KEY_SWEEP_CURSOR,
        value: { cursor: cursor, updated_at: nowSec() },
        permissionRead: 0,
        permissionWrite: 0,
      } as any;
      nk.storageWrite([write as nkruntime.StorageWriteRequest]);
    } catch (_e: any) { /* losing the cursor costs a restart, not correctness */ }
  }

  export interface SweepResult {
    removed: number;
    scanned: number;
    /** True when this run reached the end of key order and reset to the start. */
    wrapped: boolean;
    /** True when the run stopped on its deletion budget rather than finishing.
     *  The cursor was deliberately left where it was, so calling again resumes
     *  on the same page — the sessions already deleted are gone, so it makes
     *  progress rather than repeating work. */
    budgetExhausted: boolean;
  }

  /**
   * Deletes expired sessions and their audio, across all accounts.
   *
   * Driven by the `recorder_asr_gc` cron. NOT called from the request path —
   * see `reclaimAndCountForUser` for why.
   *
   * The cursor is persisted between runs. It previously was not, so every run
   * restarted at the beginning of key order and, bounded at 5 pages, could never
   * reach an expired session sitting beyond the first 500 objects: on a server
   * with more than that many session records, reclamation was mathematically
   * unable to make progress no matter how often it ran. Resuming where the last
   * run stopped is what makes repeated ticks cover the whole keyspace, and
   * reaching the end resets to the start so the next tick begins a fresh lap.
   */
  export function sweep(nk: nkruntime.Nakama, logger: nkruntime.Logger, limit: number): SweepResult {
    var removed = 0;
    var scanned = 0;
    var wrapped = false;
    var budgetExhausted = false;
    var now = nowSec();
    var cursor = readSweepCursor(nk);
    var pages = 0;
    while (pages < GC_PAGES_PER_RUN) {
      pages++;
      var page: nkruntime.StorageObjectList;
      try {
        // `null`, NOT "". This is the all-owners listing that makes it a
        // maintenance pass, and null is the only way to ask for it:
        //
        //   server/runtime_javascript_nakama.go:4717
        //     if f.Argument(0) != goja.Undefined() && f.Argument(0) != goja.Null() {
        //         u, err := uuid.FromString(userID)
        //         if err != nil { panic(...("expects empty or valid user id")) }
        //
        // An empty string is not Undefined and not Null, so it reaches
        // uuid.FromString, fails, and panics — despite the message naming
        // "empty" as acceptable. Verified against a live local Nakama: with ""
        // this loop threw on its first iteration every time and the sweep
        // reported scanned=0 while sessions sat in storage. The `nkruntime`
        // types declare the parameter as `string`, hence the cast.
        page = nk.storageList(null as any as string, COLLECTION_SESSIONS, limit, cursor);
      } catch (e: any) {
        // A cursor can be rejected if it was written by an older listing shape.
        // Falling back to the start is better than never sweeping again.
        if (cursor.length > 0) {
          logger.warn("[RecorderAsr] sweep cursor rejected; restarting from the beginning: " +
            (e && e.message ? e.message : String(e)));
          cursor = "";
          wrapped = true;
          continue;
        }
        // Not a cursor problem: the listing itself failed. This used to break
        // silently, which is how the "" bug above stayed invisible — the sweep
        // reported a clean scanned=0 instead of an error.
        logger.error("[RecorderAsr] sweep could not list sessions: " +
          (e && e.message ? e.message : String(e)));
        break;
      }
      if (!page || !page.objects || page.objects.length === 0) {
        // End of the keyspace with nothing left on this page: start the next lap.
        cursor = "";
        wrapped = true;
        break;
      }
      for (var i = 0; i < page.objects.length; i++) {
        var obj = page.objects[i];
        var rec = obj.value as any as SessionRecord;
        scanned++;
        if (!rec || !rec.session_id) continue;
        if (!isExpired(rec, now)) continue;
        if (removed >= GC_MAX_RECLAIMS_PER_RUN) {
          // Stop without advancing the cursor: the rest of this page has not
          // been dealt with, and re-reading it next run is correct because the
          // sessions deleted above no longer appear in it.
          budgetExhausted = true;
          break;
        }
        reclaimSession(nk, obj.userId, rec);
        removed++;
      }
      if (budgetExhausted) break;
      if (!page.cursor) {
        cursor = "";
        wrapped = true;
        break;
      }
      cursor = page.cursor;
    }
    writeSweepCursor(nk, cursor);
    logger.info("[RecorderAsr] sweep scanned=" + scanned + " removed=" + removed +
      " wrapped=" + wrapped + " budget_exhausted=" + budgetExhausted);
    return {
      removed: removed, scanned: scanned,
      wrapped: wrapped, budgetExhausted: budgetExhausted,
    };
  }

  // ── RPC: recorder_asr_open ────────────────────────────────────────────────

  export function rpcOpen(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var userId = ctx.userId;
    if (!userId) return errorBody(ERR_UNAUTHENTICATED, "a Nakama session is required to open an ASR session");

    var data: any;
    try {
      data = payload && payload.length > 0 ? JSON.parse(payload) : {};
    } catch (_e: any) {
      return errorBody(ERR_INTERNAL, "malformed JSON payload");
    }

    var cfg = RecorderAsrProvider.config(ctx);
    if (!RecorderAsrProvider.isAvailable(cfg, nk)) {
      // Honest unavailability, and it must be reported at `open`: the client
      // falls back to on-device speech only on ENDPOINT_UNAVAILABLE here. If we
      // accepted the session and then produced no text, the user would get
      // silence instead of the working fallback they have today.
      return errorBody(ERR_ENDPOINT_UNAVAILABLE, RecorderAsrProvider.unavailableReason(cfg, nk));
    }

    // ── Age gate. Fail closed. ──
    var assertion = ageAssertionOf(data);
    if (assertion.bracket === "below_threshold" || assertion.bracket === "unknown") {
      logger.warn("[RecorderAsr] open refused on age assertion bracket=" + assertion.bracket + " user=" + userId);
      return errorBody(
        ERR_UNAUTHENTICATED,
        "audio capture is not available for this account: a declared age below the policy " +
        "threshold, or an unanswered age gate, cannot be accepted for transcription " +
        "(16 CFR 312.2(8) — a child's voice recording is personal information and no " +
        "verifiable parental consent exists)");
    }
    if (assertion.bracket === "absent") {
      if (requireAgeAssertion(ctx)) {
        return errorBody(
          ERR_UNAUTHENTICATED,
          "age_assertion is required on recorder_asr_open (RECORDER_ASR_REQUIRE_AGE_ASSERTION=1)");
      }
      // The gate is OPEN by default and no shipped client sends the field, so
      // in practice every production session takes this branch. That is a
      // deliberate, and temporary, acceptance of unverified age — logged at warn
      // on every occurrence so it shows up in ops rather than only in a comment.
      // Flip RECORDER_ASR_REQUIRE_AGE_ASSERTION=1 once the client sends it.
      logger.warn("[RecorderAsr] admitting session with NO age assertion " +
        "(RECORDER_ASR_REQUIRE_AGE_ASSERTION is not 1) user=" + userId);
    }

    var audio = data.audio || {};
    var codec = ("" + (audio.codec || CODEC_OPUS)).toLowerCase();
    if (codec !== CODEC_PCM16 && codec !== CODEC_OPUS) {
      return errorBody(ERR_INTERNAL, "unsupported codec: " + codec);
    }
    var rate = intOf(audio.sample_rate_hz, 16000);
    if (!LEGAL_RATES["" + rate]) return errorBody(ERR_INTERNAL, "unsupported sample_rate_hz: " + rate);
    var channels = intOf(audio.channels, 1);
    if (channels !== 1 && channels !== 2) return errorBody(ERR_INTERNAL, "unsupported channels: " + channels);
    var frameMs = intOf(audio.frame_ms, 20);
    if (!LEGAL_FRAME_MS["" + frameMs]) return errorBody(ERR_INTERNAL, "unsupported frame_ms: " + frameMs);
    // Optional and not yet sent by any client — see the client-change note in
    // docs/recorder/ASR_ENDPOINTS.md. Honoured when present so the packet-size
    // probe can be skipped.
    var packetBytes = intOf(audio.packet_bytes, 0);

    var clientSessionId = "" + (data.client_session_id || "");

    // ── Resume. Re-opening with the same client_session_id must continue the
    //    same transcript, not start a second one.
    //
    //    This runs before any housekeeping: it is two point reads, it is the
    //    common case on a flaky connection, and a resume must not be blocked by
    //    the concurrency cap — the session it returns is already counted. ──
    if (clientSessionId.length > 0) {
      var existingId = "";
      try {
        var idx = nk.storageRead([{ collection: COLLECTION_INDEX, key: clientSessionId, userId: userId }]);
        if (idx && idx.length > 0) existingId = "" + ((idx[0].value as any).session_id || "");
      } catch (_e: any) { /* fall through to a fresh session */ }
      if (existingId.length > 0) {
        var existing = readSession(nk, userId, existingId);
        if (existing !== null && existing.state === "open") {
          logger.info("[RecorderAsr] resume session=" + existingId + " from_seq=" + (existing.acked_seq + 1));
          writeSession(nk, userId, existing);
          return JSON.stringify({
            session_id: existing.session_id,
            resume_from_seq: existing.acked_seq + 1,
          });
        }
      }
    }

    // Housekeeping and the concurrency cap in one per-user listing. Bounded to
    // the caller's own data, so a rejected open costs one page read rather than
    // a scan across every account.
    var reclaim: UserReclaim;
    try {
      reclaim = reclaimAndCountForUser(nk, logger, userId);
    } catch (_e: any) {
      // Best effort: a failing listing must not make opening a session fail.
      reclaim = { openSessions: 0, removed: 0 };
    }
    if (reclaim.openSessions >= MAX_OPEN_SESSIONS_PER_USER) {
      return errorBody(ERR_RATE_LIMITED,
        "too many concurrent ASR sessions (max " + MAX_OPEN_SESSIONS_PER_USER + ")");
    }

    var sessionId = "asr_srv_" + nk.uuidv4().replace(/-/g, "");
    var now = nowSec();
    var rec: SessionRecord = {
      session_id: sessionId,
      client_session_id: clientSessionId,
      contract_version: "" + (data.contract_version || ""),
      locale: "" + (data.locale || "en_US"),
      codec: codec,
      sample_rate_hz: rate,
      channels: channels,
      frame_ms: frameMs,
      packet_bytes: packetBytes,
      device_record_id: "" + (data.device_record_id || ""),
      binding_token_fp: fingerprint(nk, "" + (data.binding_token || "")),
      age_assertion: assertion,
      state: "open",
      acked_seq: -1,
      chunk_count: 0,
      audio_bytes: 0,
      next_offset: 0,
      transcribed_bytes: 0,
      transcribed_ms: 0,
      first_chunk_seq: 0,
      segments: [],
      created_at: now,
      updated_at: now,
      closed_at: 0,
      // An open session expires on idle; close replaces this with the
      // transcript retention deadline.
      expires_at: now + SESSION_IDLE_TTL_SECONDS,
    };
    writeSession(nk, userId, rec);
    if (clientSessionId.length > 0) {
      nk.storageWrite([{
        collection: COLLECTION_INDEX,
        key: clientSessionId,
        userId: userId,
        value: { session_id: sessionId, created_at: now },
        permissionRead: 0,
        permissionWrite: 0,
      }]);
    }

    logger.info("[RecorderAsr] open session=" + sessionId + " codec=" + codec +
      " rate=" + rate + " ch=" + channels + " age=" + assertion.bracket +
      " device=" + (rec.device_record_id.length > 0 ? "yes" : "no"));

    return JSON.stringify({ session_id: sessionId, resume_from_seq: 0 });
  }

  /** Reads the optional age assertion, defaulting to an explicit "absent" so the
   *  session record never looks like a claim that was never made. */
  function ageAssertionOf(data: any): AgeAssertion {
    var a = data && data.age_assertion;
    if (!a || !a.bracket) {
      return { bracket: "absent", min_age: 0, declared_at: "", source: "absent" };
    }
    var bracket = ("" + a.bracket).toLowerCase();
    if (bracket !== "at_or_above_threshold" && bracket !== "below_threshold") bracket = "unknown";
    return {
      bracket: bracket,
      min_age: intOf(a.min_age, 13),
      declared_at: "" + (a.declared_at || ""),
      source: "client",
    };
  }

  // ── RPC: recorder_asr_push ────────────────────────────────────────────────

  export function rpcPush(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var userId = ctx.userId;
    if (!userId) return errorBody(ERR_UNAUTHENTICATED, "a Nakama session is required to push audio");

    var data: any;
    try {
      data = payload && payload.length > 0 ? JSON.parse(payload) : {};
    } catch (_e: any) {
      return errorBody(ERR_INTERNAL, "malformed JSON payload");
    }

    var sessionId = "" + (data.session_id || "");
    if (sessionId.length === 0) return errorBody(ERR_INTERNAL, "session_id is required");

    var rec = readSession(nk, userId, sessionId);
    if (rec === null) {
      // Either it never existed, it was swept, or it belongs to another account.
      // All three are the same answer from here, and deliberately so: the reply
      // must not tell a caller whether somebody else's session id is real.
      return errorBody(ERR_NOT_FOUND, "no such ASR session for this account");
    }
    if (rec.state !== "open") {
      return errorBody(ERR_INTERNAL, "ASR session is already closed");
    }

    var seq = intOf(data.seq, -1);
    if (seq < 0) return errorBody(ERR_INTERNAL, "seq is required and must be >= 0");

    var b64 = "" + (data.audio_b64 || "");
    if (b64.length > MAX_PUSH_B64_CHARS) {
      return errorBody(ERR_INTERNAL,
        "audio chunk too large: " + b64.length + " base64 chars (max " + MAX_PUSH_B64_CHARS + ")");
    }

    // ── Idempotency. A replayed chunk is ignored, never appended. ──
    if (seq <= rec.acked_seq) {
      logger.info("[RecorderAsr] duplicate seq=" + seq + " session=" + sessionId + " (ignored)");
      return JSON.stringify({ acked_seq: rec.acked_seq, segments: [] });
    }

    if (rec.chunk_count + 1 > MAX_CHUNKS_PER_SESSION) {
      return errorBody(ERR_RATE_LIMITED,
        "session chunk limit reached (" + MAX_CHUNKS_PER_SESSION + ")");
    }

    var bytes: Uint8Array;
    try {
      bytes = new Uint8Array(nk.base64Decode(b64) as ArrayBuffer);
    } catch (_e: any) {
      return errorBody(ERR_INTERNAL, "audio_b64 is not valid base64");
    }
    if (rec.audio_bytes + bytes.length > MAX_SESSION_BYTES) {
      return errorBody(ERR_RATE_LIMITED,
        "session audio limit reached (" + MAX_SESSION_BYTES + " bytes)");
    }

    if (bytes.length > 0) {
      var chunk: ChunkRecord = { seq: seq, off: rec.next_offset, bytes: bytes.length, b64: b64 };
      nk.storageWrite([{
        collection: COLLECTION_CHUNKS,
        key: chunkKey(sessionId, seq),
        userId: userId,
        value: chunk as any,
        // Audio is never readable by the client; only the server reads it, and
        // only until it is behind the transcription watermark.
        permissionRead: 0,
        permissionWrite: 0,
      }]);
      rec.next_offset += bytes.length;
      rec.audio_bytes += bytes.length;
      rec.chunk_count++;
    }

    // A gap (seq jumping ahead) is expected, not an error: the client's
    // backpressure drops the OLDEST queued chunk on overflow while sequence
    // numbers keep incrementing, so audio can be genuinely lost upstream.
    // Acking the highest received seq is what lets the client free its queue.
    //
    // The gap is capped, though. `acked_seq` feeds a dense key range in
    // `readWindowBytes` and `deleteChunks`, so an unbounded jump here is an
    // unbounded amount of server work from one client-supplied integer — see
    // MAX_CHUNK_SEQ_GAP. RATE_LIMITED rather than INTERNAL because the client
    // retries it with backoff, and reopening is the correct recovery.
    if (seq - rec.acked_seq > MAX_CHUNK_SEQ_GAP) {
      logger.warn("[RecorderAsr] seq gap too large session=" + sessionId +
        " acked=" + rec.acked_seq + " got=" + seq + " max_gap=" + MAX_CHUNK_SEQ_GAP);
      return errorBody(ERR_RATE_LIMITED,
        "seq gap too large (" + (seq - rec.acked_seq) + " > " + MAX_CHUNK_SEQ_GAP +
        "): too much audio was dropped to continue this session, open a new one");
    }
    if (seq - rec.acked_seq > 1) {
      logger.warn("[RecorderAsr] seq gap session=" + sessionId +
        " expected=" + (rec.acked_seq + 1) + " got=" + seq + " (client-side drop)");
    }
    rec.acked_seq = seq;

    var isLast = data.is_last === true;
    var segments: any[] = [];
    try {
      segments = transcribeWindow(ctx, logger, nk, userId, rec, isLast);
    } catch (e: any) {
      logger.error("[RecorderAsr] transcription failed: " + (e && e.message ? e.message : String(e)));
    }

    rec.expires_at = nowSec() + SESSION_IDLE_TTL_SECONDS;
    writeSession(nk, userId, rec);

    return JSON.stringify({ acked_seq: rec.acked_seq, segments: segments });
  }

  // ── RPC: recorder_asr_close ───────────────────────────────────────────────

  export function rpcClose(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var userId = ctx.userId;
    if (!userId) return errorBody(ERR_UNAUTHENTICATED, "a Nakama session is required to close an ASR session");

    var data: any;
    try {
      data = payload && payload.length > 0 ? JSON.parse(payload) : {};
    } catch (_e: any) {
      return errorBody(ERR_INTERNAL, "malformed JSON payload");
    }
    var sessionId = "" + (data.session_id || "");
    if (sessionId.length === 0) return errorBody(ERR_INTERNAL, "session_id is required");

    var rec = readSession(nk, userId, sessionId);
    if (rec === null) {
      return errorBody(ERR_NOT_FOUND, "no such ASR session for this account");
    }

    // ── Idempotency. A retried close returns the same trailing segments and
    //    does NOT transcribe again or produce a second transcript. ──
    if (rec.state === "closed") {
      logger.info("[RecorderAsr] duplicate close session=" + sessionId + " (replayed)");
      return JSON.stringify({
        acked_seq: rec.acked_seq,
        segments: (rec as any).closing_segments || [],
      });
    }

    var trailing: any[] = [];
    // Flush the tail. Bounded by MAX_CALL_MS inside transcribeWindow, and by two
    // passes here, so close latency stays predictable even after a burst.
    for (var pass = 0; pass < 2; pass++) {
      var more: any[] = [];
      try {
        more = transcribeWindow(ctx, logger, nk, userId, rec, true);
      } catch (e: any) {
        logger.error("[RecorderAsr] close transcription failed: " + (e && e.message ? e.message : String(e)));
        break;
      }
      for (var i = 0; i < more.length; i++) trailing.push(more[i]);
      if (rec.transcribed_bytes >= rec.next_offset) break;
    }

    // Retention: every remaining audio chunk goes now. The server keeps no
    // audio past the end of a session.
    deleteChunks(nk, userId, sessionId, rec.first_chunk_seq, rec.acked_seq);
    rec.first_chunk_seq = rec.acked_seq + 1;

    var ttl = transcriptTtlSeconds(ctx);
    rec.state = "closed";
    rec.closed_at = nowSec();
    (rec as any).closing_segments = trailing;
    if (ttl <= 0) {
      // Zero retention: hand the transcript back once and keep nothing. A
      // retried close then returns no segments, which the client tolerates —
      // it keeps the transcript it already has.
      try {
        nk.storageDelete([
          { collection: COLLECTION_SESSIONS, key: sessionId, userId: userId },
          { collection: COLLECTION_INDEX, key: rec.client_session_id, userId: userId },
        ]);
      } catch (_e: any) { /* already gone */ }
    } else {
      rec.expires_at = rec.closed_at + ttl;
      writeSession(nk, userId, rec);
    }

    logger.info("[RecorderAsr] close session=" + sessionId +
      " segments_total=" + rec.segments.length +
      " trailing=" + trailing.length +
      " audio_bytes=" + rec.audio_bytes + " (audio deleted)");

    return JSON.stringify({ acked_seq: rec.acked_seq, segments: trailing });
  }

  // ── RPC: recorder_asr_purge ───────────────────────────────────────────────
  // Right-to-erasure for the caller's own ASR data. Idempotent.

  export function rpcPurge(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, _payload: string): string {
    var userId = ctx.userId;
    if (!userId) return errorBody(ERR_UNAUTHENTICATED, "a Nakama session is required");
    var sessions = 0;
    var cursor = "";
    var guard = 0;
    while (guard < 20) {
      guard++;
      var page = nk.storageList(userId, COLLECTION_SESSIONS, 100, cursor);
      if (!page || !page.objects || page.objects.length === 0) break;
      for (var i = 0; i < page.objects.length; i++) {
        var rec = page.objects[i].value as any as SessionRecord;
        if (!rec || !rec.session_id) continue;
        deleteChunks(nk, userId, rec.session_id, 0, rec.acked_seq);
        try {
          nk.storageDelete([
            { collection: COLLECTION_SESSIONS, key: rec.session_id, userId: userId },
            { collection: COLLECTION_INDEX, key: rec.client_session_id, userId: userId },
          ]);
        } catch (_e: any) { /* already gone */ }
        sessions++;
      }
      if (!page.cursor) break;
      cursor = page.cursor;
    }
    logger.info("[RecorderAsr] purged " + sessions + " session(s) for user=" + userId);
    return JSON.stringify({ purged_sessions: sessions });
  }

  // ── RPC: recorder_asr_gc ──────────────────────────────────────────────────
  // Service-only maintenance entry point for a cron, in addition to the
  // opportunistic sweep on open.

  export function rpcGc(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string): string {
    var expected = "" + ((ctx.env && ctx.env["RECORDER_ASR_GC_TOKEN"]) || "");
    var data: any = {};
    try { data = payload && payload.length > 0 ? JSON.parse(payload) : {}; } catch (_e: any) { data = {}; }
    if (expected.length === 0 || "" + (data.service_token || "") !== expected) {
      // Includes the unset-token case: with no token configured this RPC refuses
      // everything rather than becoming an unauthenticated global delete.
      return errorBody(ERR_UNAUTHENTICATED, "recorder_asr_gc is service-only");
    }
    var result = sweep(nk, logger, GC_SCAN_LIMIT);
    // `wrapped` tells an operator a full lap finished. `budget_exhausted` tells
    // the caller to call again immediately — the run stopped on its deletion
    // cap, not because there was nothing left. A schedule that never wraps is
    // not keeping up.
    return JSON.stringify({
      swept: result.removed,
      scanned: result.scanned,
      wrapped: result.wrapped,
      budget_exhausted: result.budgetExhausted,
    });
  }

  // ── Registration ──────────────────────────────────────────────────────────

  export function register(initializer: nkruntime.Initializer): void {
    initializer.registerRpc("recorder_asr_open", rpcOpen);
    initializer.registerRpc("recorder_asr_push", rpcPush);
    initializer.registerRpc("recorder_asr_close", rpcClose);
    initializer.registerRpc("recorder_asr_purge", rpcPurge);
    initializer.registerRpc("recorder_asr_gc", rpcGc);
  }
}
