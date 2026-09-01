// =============================================================================
// Recorder ASR provider — speech recognition behind one seam.
//
// The engine
// ----------
// The provider in use is the organisation's own in-cluster faster-whisper
// deployment (`voice-pipeline-stt` in namespace `aicart`, image
// `fedirz/faster-whisper-server`, model `Systran/faster-whisper-small.en`). It
// speaks the OpenAI `/v1/audio/transcriptions` shape, so the same path works
// against OpenAI or any OpenAI-compatible endpoint — only the shim's
// `RECORDER_ASR_BASE_URL` changes.
//
// No new vendor and no new credential: the service is already deployed, already
// paid for (self-hosted CPU), and reachable from Nakama over cluster DNS.
//
// Measured throughput (2026-08-28, one CPU pod, small.en int8, 4 threads,
// arm64): 22.4 s wall for 59.5 s of 16 kHz mono audio, i.e. ~0.38x realtime,
// warm. That number is why transcription is windowed rather than done in one
// shot at close — see `RecorderAsr.WINDOW_MS`. Nakama's HTTP write timeout
// defaults to 10 s (`server/config.go` `socket.write_timeout_ms`), so any single
// RPC that waits on ASR has to stay well inside that.
//
// Why the upload goes through a sidecar
// ------------------------------------
// The engine needs a multipart body containing raw audio bytes, and this
// runtime cannot produce one. That is a hard limit, not a missing library:
//
//   * `nk.httpRequest` takes the body as a Go string built from a JS string
//     (`server/runtime_javascript_nakama.go:818` → `strings.NewReader`), so any
//     code unit >= 0x80 is re-encoded as multi-byte UTF-8. Measured: a
//     122,998-byte WAV left as 252,532 bytes.
//   * `nk.binaryToString`, the only ArrayBuffer→string bridge, panics unless
//     the buffer is valid UTF-8 (`runtime_javascript_nakama.go:334`
//     `if !utf8.Valid(...)`). Audio never is. Observed live before the shim
//     existed: every push logged `provider failed: expects data to be UTF-8
//     encoded`, for both WAV and Ogg.
//
// Goja has no FFI, sockets or filesystem, so there is no third option inside
// the runtime. The upload therefore happens in a sidecar —
// `deploy/recorder-asr-shim/shim.py`, a stdlib-only process in this pod
// listening on loopback — which takes the audio as base64 and forwards real
// multipart. Base64 is ASCII, so it survives `nk.httpRequest` untouched, and
// `nk.base64Encode` accepts an ArrayBuffer with no UTF-8 check
// (`runtime_javascript_nakama.go:915`).
//
// A sidecar rather than a Go plugin because a plugin under `data/modules/` is
// baked into the server image by `Dockerfile.production` stage 3, so every ASR
// tweak would ride a full Nakama release through CodeBuild.
//
// Everything else stays here: container muxing, windowing, segment timing.
// The shim only moves bytes.
//
// Engine configuration — base URL, model, API key — belongs to the shim, not to
// this module. There is exactly one place to set it and no pair of values that
// can disagree. What this module needs to know is only *where the shim is* and
// *whether transcription can actually happen*, and it asks the shim the latter
// rather than inferring it.
//
// If the shim is absent, or present but unable to reach the engine, this reports
// itself unavailable and the RPCs answer ENDPOINT_UNAVAILABLE — the signal the
// Flutter client uses to fall back to on-device speech. A misconfigured server
// degrades to an honest failure instead of accepting audio it cannot transcribe.
// =============================================================================

namespace RecorderAsrProvider {

  export interface Config {
    /** Loopback address of the base64→multipart sidecar. */
    shimUrl: string;
    timeoutMs: number;
    /** Operator kill switch, `RECORDER_ASR_ENABLED=0`. */
    enabled: boolean;
  }

  export interface Segment {
    text: string;
    beginMs: number;
    endMs: number;
    isFinal: boolean;
  }

  export interface TranscribeRequest {
    bytes: Uint8Array;
    contentType: string;
    filename: string;
    /** BCP-47-ish locale from the client (`en_US`); reduced to `en` for the API. */
    locale: string;
    /** Added to every returned segment's timings so a window's transcript lands
     *  at the right place in the session timeline. */
    offsetMs: number;
  }

  export interface TranscribeResult {
    segments: Segment[];
    /** Audio duration the engine reported, in ms. */
    durationMs: number;
    providerMs: number;
  }

  /** Must match `DEFAULT_LISTEN` in deploy/recorder-asr-shim/shim.py. */
  var DEFAULT_SHIM_URL = "http://127.0.0.1:7359";

  export function config(ctx: nkruntime.Context): Config {
    var env = ctx.env || {};
    var timeout = parseInt("" + (env["RECORDER_ASR_TIMEOUT_MS"] || "9000"), 10);
    var shim = "" + (env["RECORDER_ASR_SHIM_URL"] || DEFAULT_SHIM_URL);
    // Defaults on. `RECORDER_ASR_ENABLED=0` is the off switch, and it is a
    // non-empty value on purpose: both the compose entrypoint and the k8s args
    // skip empty values when building `--runtime.env`, so a flag whose "off"
    // state is the empty string can never actually be set.
    var enabled = "" + (env["RECORDER_ASR_ENABLED"] || "1") !== "0";
    return {
      shimUrl: shim.replace(/\/$/, ""),
      timeoutMs: isNaN(timeout) || timeout <= 0 ? 9000 : timeout,
      enabled: enabled,
    };
  }

  /**
   * Per-probe budget for `/healthz`.
   *
   * The refusal path probes twice: `isAvailable` decides, then
   * `unavailableReason` probes again to say *why*. When the shim is unreachable
   * both probes run to their full timeout, so the ceiling is twice this — and it
   * has to stay comfortably under Nakama's `socket.write_timeout_ms` (10 s
   * default) or `open` fails to answer at all instead of answering
   * ENDPOINT_UNAVAILABLE, which is precisely the outcome that costs the client
   * its on-device fallback. Measured with a hung shim: 6.1 s at 3,000 ms each,
   * which was inside the budget but not by much. 2,000 ms puts the worst case
   * near 4 s. It is still far above a healthy loopback GET (single-digit ms).
   */
  var HEALTH_PROBE_TIMEOUT_MS = 2000;

  /**
   * Whether the shim is answering AND says it can reach the engine.
   *
   * Both halves are the shim's `ok`: it probes the engine itself (`/health`,
   * falling back to `/v1/models`) and reports false when the engine is
   * unreachable, so this is a measurement of "a recording can become text",
   * not of "the sidecar process is alive". That distinction is the whole point
   * — see `isAvailable`.
   *
   * Not cached here. The probe is one loopback GET inside this pod and only
   * runs on `open` — once per recording, not per chunk — so the cost is noise,
   * and caching in a pooled Goja VM would turn a momentary hiccup into ASR
   * being dead for the lifetime of that VM. The shim does hold a short-lived
   * verdict of its own so a burst of opens does not hammer the engine.
   */
  export function shimReady(nk: nkruntime.Nakama, cfg: Config): boolean {
    try {
      var resp = nk.httpRequest(cfg.shimUrl + "/healthz", "get", {}, null, HEALTH_PROBE_TIMEOUT_MS);
      if (resp.code < 200 || resp.code >= 300) return false;
      var parsed = JSON.parse(resp.body);
      return !!(parsed && parsed.ok === true);
    } catch (_e: any) {
      return false;
    }
  }

  /**
   * A provider is available only if the bytes can actually be delivered and
   * turned into text.
   *
   * This is load-bearing, not defensive. The client falls back to on-device
   * speech when `open` answers ENDPOINT_UNAVAILABLE and does NOT fall back when
   * `open` succeeds, so reporting available while unable to transcribe produces
   * silence for the user — strictly worse than failing. There is deliberately
   * no path to `true` that does not involve the shim confirming it reached the
   * engine.
   *
   * `nk` is optional on purpose. Pass it at `open`, where being honest is the
   * whole point. Omit it on the per-chunk path, which is best-effort anyway —
   * a failed upload there is absorbed and retried on the next window, so paying
   * for a probe every chunk would buy nothing.
   */
  export function isAvailable(cfg: Config, nk?: nkruntime.Nakama): boolean {
    if (!cfg.enabled) return false;
    if (nk && !shimReady(nk, cfg)) return false;
    return true;
  }

  /** Operator-facing reason, surfaced in the RPC error so a misconfiguration is
   *  diagnosable from a client log rather than only from server logs. */
  export function unavailableReason(cfg: Config, nk: nkruntime.Nakama): string {
    if (!cfg.enabled) return "device transcription is disabled (RECORDER_ASR_ENABLED=0)";
    var detail = "";
    try {
      var resp = nk.httpRequest(cfg.shimUrl + "/healthz", "get", {}, null, HEALTH_PROBE_TIMEOUT_MS);
      if (resp.code >= 200 && resp.code < 300) {
        var parsed = JSON.parse(resp.body);
        if (parsed && parsed.ok === true) return "ASR backend unavailable";
        detail = " — the shim is running but reports: " +
          ("" + ((parsed && parsed.reason) || "no reason given"));
      } else {
        detail = " — /healthz answered HTTP " + resp.code;
      }
    } catch (e: any) {
      detail = " — /healthz is not answering (" +
        (e && e.message ? e.message : String(e)) + ")";
    }
    return "the recorder-asr-shim sidecar cannot deliver audio to the speech " +
      "engine via " + cfg.shimUrl + detail +
      " (see deploy/recorder-asr-shim/README.md)";
  }

  /**
   * Whether a segment claims more text than its own duration could contain.
   *
   * Whisper's known failure mode at the end of a window is to loop, emitting the
   * previous sentence several times over with near-zero durations. Measured live
   * on the Ogg Opus path (2026-08-28): three consecutive segments of 240 ms,
   * 80 ms and 80 ms, each carrying the same 95-character sentence — an implied
   * ~1,190 characters per second. Left in, that sentence appears three extra
   * times in the user's transcript.
   *
   * The test is a speaking rate, not a duration: a genuinely short segment
   * carrying short text ("4.") is fine, and only a physically impossible density
   * is rejected. Conversational English runs ~15-17 characters per second and
   * very fast speech ~25, so 60 is roughly 2.5x beyond any real speaker while
   * still an order of magnitude below the artifact. Short fragments are exempt
   * entirely, because a two-character segment at a plausible rate can trip a
   * rate test on rounding alone.
   */
  var MAX_CHARS_PER_SECOND = 60;
  var MIN_LENGTH_FOR_RATE_CHECK = 24;

  export function isRepetitionArtifact(text: string, durationMs: number): boolean {
    if (text.length < MIN_LENGTH_FOR_RATE_CHECK) return false;
    if (durationMs <= 0) return true;
    return (text.length * 1000 / durationMs) > MAX_CHARS_PER_SECOND;
  }

  /** `en_US` / `en-GB` → `en`. Whisper wants the bare language subtag, and an
   *  unknown value makes it auto-detect, which is worse than not asking. */
  function languageOf(locale: string): string {
    var l = ("" + (locale || "")).replace("_", "-");
    var dash = l.indexOf("-");
    var tag = (dash > 0 ? l.substring(0, dash) : l).toLowerCase();
    return /^[a-z]{2,3}$/.test(tag) ? tag : "";
  }

  /**
   * One transcription round trip.
   *
   * Throws on transport failure or a non-2xx engine response; the caller decides
   * whether that fails the RPC or is absorbed (a failed `close` must not lose a
   * transcript the client already has).
   */
  export function transcribe(
    nk: nkruntime.Nakama,
    logger: nkruntime.Logger,
    cfg: Config,
    req: TranscribeRequest,
  ): TranscribeResult {
    if (!cfg.enabled) throw new Error("device transcription is disabled");

    // The audio crosses to the shim as base64 inside JSON. base64Encode takes
    // the ArrayBuffer directly and does no UTF-8 validation, so the bytes are
    // never routed through a JS string.
    //
    // `req.bytes` is passed as a whole-buffer Uint8Array by every caller, but
    // `subarray` views are cheap to create by accident and `.buffer` on one of
    // those is the entire backing store — which would upload the wrong bytes,
    // silently and plausibly. Assert instead of trusting.
    if (req.bytes.byteOffset !== 0 || req.bytes.byteLength !== req.bytes.buffer.byteLength) {
      throw new Error("transcribe: req.bytes must own its buffer (got a view at offset " +
        req.bytes.byteOffset + " of " + req.bytes.buffer.byteLength + " bytes)");
    }
    var payload = JSON.stringify({
      audio_b64: nk.base64Encode(req.bytes.buffer as ArrayBuffer),
      content_type: req.contentType,
      filename: req.filename,
      language: languageOf(req.locale),
    });

    var started = Date.now();
    // Shim timeout is a little longer than the engine's so the engine's own
    // deadline is what fires first and we get its status rather than a hangup.
    var resp = nk.httpRequest(
      cfg.shimUrl + "/transcribe", "post",
      { "Content-Type": "application/json" },
      payload, cfg.timeoutMs + 2000);
    var elapsed = Date.now() - started;

    if (resp.code < 200 || resp.code >= 300) {
      throw new Error("ASR shim HTTP " + resp.code + ": " + ("" + resp.body).substring(0, 300));
    }

    var envelope: any;
    try {
      envelope = JSON.parse(resp.body);
    } catch (_e: any) {
      throw new Error("ASR shim returned non-JSON");
    }
    if (!envelope.ok) {
      throw new Error("ASR engine " + (envelope.code || 0) + ": " +
        ("" + (envelope.error || envelope.body || "unknown")).substring(0, 300));
    }

    var parsed: any;
    try {
      parsed = JSON.parse(envelope.body);
    } catch (_e2: any) {
      throw new Error("ASR engine returned non-JSON body");
    }

    var segments: Segment[] = [];
    var dropped = 0;
    var raw = parsed && parsed.segments;
    if (raw && raw.length) {
      for (var i = 0; i < raw.length; i++) {
        var s = raw[i];
        var text = ("" + (s.text || "")).replace(/^\s+|\s+$/g, "");
        if (text.length === 0) continue;
        var beginMs = req.offsetMs + Math.round((s.start || 0) * 1000);
        var endMs = req.offsetMs + Math.round((s.end || 0) * 1000);
        if (isRepetitionArtifact(text, endMs - beginMs)) {
          dropped++;
          continue;
        }
        segments.push({
          text: text,
          beginMs: beginMs,
          endMs: endMs,
          isFinal: true,
        });
      }
    } else if (parsed && parsed.text) {
      // `verbose_json` should always carry segments; this is the degenerate
      // single-utterance shape some OpenAI-compatible servers return.
      var whole = ("" + parsed.text).replace(/^\s+|\s+$/g, "");
      if (whole.length > 0) {
        segments.push({
          text: whole,
          beginMs: req.offsetMs,
          endMs: req.offsetMs + Math.round((parsed.duration || 0) * 1000),
          isFinal: true,
        });
      }
    }

    logger.info("[RecorderAsr] provider ok bytes=" + req.bytes.length +
      " segments=" + segments.length +
      (dropped > 0 ? " dropped_repetitions=" + dropped : "") +
      " engine_ms=" + (envelope.provider_ms || 0) +
      " total_ms=" + elapsed);

    return {
      segments: segments,
      durationMs: Math.round((parsed && parsed.duration ? parsed.duration : 0) * 1000),
      providerMs: elapsed,
    };
  }
}
