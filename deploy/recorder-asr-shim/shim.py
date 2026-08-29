#!/usr/bin/env python3
# =============================================================================
# recorder-asr-shim — base64 JSON in, multipart/form-data out.
#
# Why this process exists
# ----------------------
# The Curio recorder RPCs (recorder_asr_open / _push / _close) live in Nakama's
# JavaScript runtime — data/modules/src/recorder/. Everything there works except
# the last hop: handing the assembled WAV or Ogg Opus to the speech engine.
# That is a hard limit of the runtime, not a missing library:
#
#   * nk.httpRequest takes the body as a Go string built from a JS string
#     (server/runtime_javascript_nakama.go → strings.NewReader), so every code
#     unit >= 0x80 is re-encoded as multi-byte UTF-8.
#   * nk.binaryToString, the only ArrayBuffer→string bridge, panics unless the
#     buffer is valid UTF-8 (runtime_javascript_nakama.go:334
#     `if !utf8.Valid(...)`). A WAV header or an Ogg page never is.
#
# Goja has no FFI, no sockets and no filesystem, so there is no third option
# inside the runtime. And the engine takes multipart only: both audio routes
# declare `file: Annotated[UploadFile, Form()]`. The OpenAPI document also
# advertises application/x-www-form-urlencoded, but that is a FastAPI schema
# artefact of Form() with UploadFile — Starlette dispatches on the real
# Content-Type and a urlencoded body would hand the handler a UTF-8-decoded
# string, mangling the audio.
#
# So the bytes cross as base64 (pure ASCII, survives nk.httpRequest untouched;
# nk.base64Encode takes an ArrayBuffer and does no UTF-8 check) and this process
# turns them back into a real multipart upload.
#
# Why a separate process rather than a Nakama plugin
# -------------------------------------------------
# A Go plugin under data/modules/ is picked up by Dockerfile.production stage 3
# and baked into the server image, so every future ASR tweak would ride a full
# Nakama release through CodeBuild. This is stdlib-only Python on a stock
# python image, shipped as a ConfigMap, so a tweak is a ConfigMap update and a
# pod restart. Cost of ownership, not cost of writing.
#
# Why loopback
# ------------
# It runs as a sidecar in the Nakama pod and binds 127.0.0.1, so it is not in
# any Service, Ingress or containerPort and is unreachable from outside the pod
# by construction. That is what lets it need no credential of its own and what
# stops it from becoming an open transcription proxy.
#
# Deliberately dumb: decode base64, build one multipart body, forward it, return
# the engine's status and body verbatim. All session state, windowing, container
# muxing, idempotency, limits, retention and the COPPA age gate stay in
# recorder_asr.ts where they are unit-tested.
# =============================================================================

import base64
import binascii
import hashlib
import json
import os
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DEFAULT_LISTEN = "127.0.0.1:7359"
DEFAULT_BASE_URL = "http://voice-pipeline-stt.aicart.svc.cluster.local:8000"
DEFAULT_MODEL = "Systran/faster-whisper-small.en"
DEFAULT_TIMEOUT_MS = 9000

# Ceiling on one upload. MAX_SESSION_BYTES in recorder_asr.ts is 24 MiB, and a
# single window is far smaller (MAX_CALL_MS of 16 kHz mono PCM16 is ~640 kB), so
# anything near this is a bug rather than a big recording.
DEFAULT_MAX_AUDIO_BYTES = 24 * 1024 * 1024

# How long a health verdict is reused. The probe runs once per recorder_asr_open,
# so this only matters under a burst of opens; long enough to collapse those,
# short enough that a recovered engine is picked up on the next recording.
DEFAULT_HEALTH_TTL_MS = 5000


def _env_int(key, default):
    raw = os.environ.get(key, "").strip()
    if not raw:
        return default
    try:
        n = int(raw)
    except ValueError:
        return default
    return n if n > 0 else default


class Config:
    def __init__(self, env):
        self.listen = (env.get("RECORDER_ASR_SHIM_LISTEN") or DEFAULT_LISTEN).strip()
        # An explicitly empty RECORDER_ASR_BASE_URL is how an operator turns the
        # cloud ASR path off; only an absent key falls back to the default.
        if "RECORDER_ASR_BASE_URL" in env:
            base = (env.get("RECORDER_ASR_BASE_URL") or "").strip()
        else:
            base = DEFAULT_BASE_URL
        self.base_url = base.rstrip("/")
        self.model = (env.get("RECORDER_ASR_MODEL") or "").strip() or DEFAULT_MODEL
        self.api_key = (env.get("RECORDER_ASR_API_KEY") or "").strip()
        self.timeout_ms = _env_int("RECORDER_ASR_TIMEOUT_MS", DEFAULT_TIMEOUT_MS)
        self.max_audio_bytes = _env_int(
            "RECORDER_ASR_SHIM_MAX_AUDIO_BYTES", DEFAULT_MAX_AUDIO_BYTES
        )
        self.health_ttl_ms = _env_int(
            "RECORDER_ASR_SHIM_HEALTH_TTL_MS", DEFAULT_HEALTH_TTL_MS
        )
        # Dev-only. Writes every forwarded container to disk so the Ogg/WAV bytes
        # Nakama actually produced can be run through ffprobe. Leave unset
        # everywhere else: these are voice recordings.
        self.dump_dir = (env.get("RECORDER_ASR_SHIM_DUMP_DIR") or "").strip()

    @property
    def timeout_s(self):
        return self.timeout_ms / 1000.0


def log(level, msg):
    sys.stderr.write(
        "%s %s [recorder-asr-shim] %s\n"
        % (time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), level, msg)
    )
    sys.stderr.flush()


# ── Engine health ───────────────────────────────────────────────────────────
#
# This is the availability signal for the whole feature, so it has to mean
# "a recording can become text", not "the shim is running". recorder_asr_open
# reports ENDPOINT_UNAVAILABLE when this says no, and that is the only thing
# that makes the Flutter client fall back to on-device speech. A health check
# that answers ok while the engine is unreachable would hand the user silence
# instead of a working local transcript, which is strictly worse than failing.


class HealthCache:
    def __init__(self, cfg):
        self._cfg = cfg
        self._lock = threading.Lock()
        self._at_ms = 0.0
        self._verdict = None

    def _probe(self):
        cfg = self._cfg
        if not cfg.base_url:
            return False, "no ASR backend configured (RECORDER_ASR_BASE_URL is empty)"
        # /health on faster-whisper-server (Speaches). /v1/models is the
        # OpenAI-compatible fallback for any other engine behind the same URL.
        for path in ("/health", "/v1/models"):
            req = urllib.request.Request(cfg.base_url + path, method="GET")
            if cfg.api_key:
                req.add_header("Authorization", "Bearer " + cfg.api_key)
            try:
                with urllib.request.urlopen(req, timeout=2.0) as resp:
                    if 200 <= resp.status < 300:
                        return True, ""
                    last = "%s answered HTTP %d" % (path, resp.status)
            except urllib.error.HTTPError as exc:
                # A 404 means this engine does not have that route; try the next.
                last = "%s answered HTTP %d" % (path, exc.code)
            except Exception as exc:  # URLError, socket.timeout, ...
                return False, "%s unreachable at %s: %s" % (
                    path,
                    cfg.base_url,
                    exc,
                )
        return False, last

    def get(self):
        now = time.monotonic() * 1000.0
        with self._lock:
            if self._verdict is not None and now - self._at_ms < self._cfg.health_ttl_ms:
                return self._verdict
        verdict = self._probe()
        with self._lock:
            self._verdict = verdict
            self._at_ms = time.monotonic() * 1000.0
        return verdict


# ── Multipart ───────────────────────────────────────────────────────────────


def build_multipart(audio, filename, content_type, language, model):
    """Assembles the OpenAI-shaped transcription request.

    `file` is declared UploadFile on the engine, which only a real multipart
    part satisfies — a urlencoded body gets it a str and it answers 422.
    """
    boundary = "----recorder-asr-shim-" + uuid.uuid4().hex
    body = bytearray()

    def part(headers, payload):
        body.extend(("--%s\r\n" % boundary).encode("ascii"))
        for header in headers:
            body.extend((header + "\r\n").encode("ascii"))
        body.extend(b"\r\n")
        body.extend(payload)
        body.extend(b"\r\n")

    fields = [
        ("model", model),
        ("response_format", "verbose_json"),
        ("temperature", "0"),
    ]
    if language:
        fields.append(("language", language))
    for name, value in fields:
        part(
            ['Content-Disposition: form-data; name="%s"' % name],
            str(value).encode("utf-8"),
        )

    part(
        [
            'Content-Disposition: form-data; name="file"; filename="%s"' % filename,
            "Content-Type: %s" % content_type,
        ],
        audio,
    )
    body.extend(("--%s--\r\n" % boundary).encode("ascii"))
    return "multipart/form-data; boundary=" + boundary, bytes(body)


# ── Request handling ────────────────────────────────────────────────────────


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "recorder-asr-shim/1.0"

    # BaseHTTPRequestHandler logs every request to stderr with its own format;
    # route it through log() so pod logs stay one shape.
    def log_message(self, fmt, *args):
        log("DEBUG", "%s %s" % (self.address_string(), fmt % args))

    def _send_json(self, status, payload):
        blob = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(blob)))
        self.end_headers()
        self.wfile.write(blob)

    def do_GET(self):
        if self.path.split("?")[0] != "/healthz":
            self._send_json(404, {"ok": False, "error": "not found"})
            return
        cfg = self.server.cfg
        ok, reason = self.server.health.get()
        self._send_json(
            200,
            {
                "ok": ok,
                "base_url_set": bool(cfg.base_url),
                "model": cfg.model,
                "reason": reason,
            },
        )

    def do_POST(self):
        if self.path.split("?")[0] != "/transcribe":
            self._send_json(404, {"ok": False, "error": "not found"})
            return

        cfg = self.server.cfg
        if not cfg.base_url:
            self._send_json(
                503,
                {
                    "ok": False,
                    "error": "no ASR backend configured (RECORDER_ASR_BASE_URL)",
                },
            )
            return

        try:
            length = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            length = 0
        if length <= 0:
            self._send_json(400, {"ok": False, "error": "Content-Length is required"})
            return
        # base64 is 4/3 of the audio, plus the JSON envelope.
        if length > cfg.max_audio_bytes * 2:
            self._send_json(
                413, {"ok": False, "error": "request body too large: %d" % length}
            )
            return

        raw = self.rfile.read(length)
        try:
            req = json.loads(raw)
        except Exception as exc:
            self._send_json(400, {"ok": False, "error": "bad JSON: %s" % exc})
            return

        try:
            # validate=True so stray characters are an error rather than being
            # silently dropped into corrupt audio.
            audio = base64.b64decode(req.get("audio_b64") or "", validate=True)
        except (binascii.Error, ValueError) as exc:
            self._send_json(
                400, {"ok": False, "error": "audio_b64 is not valid base64: %s" % exc}
            )
            return
        if not audio:
            self._send_json(400, {"ok": False, "error": "audio_b64 is empty"})
            return
        if len(audio) > cfg.max_audio_bytes:
            self._send_json(
                413,
                {
                    "ok": False,
                    "error": "audio too large: %d bytes (max %d)"
                    % (len(audio), cfg.max_audio_bytes),
                },
            )
            return

        filename = (req.get("filename") or "capture.wav").replace('"', "")
        content_type = req.get("content_type") or "application/octet-stream"
        language = (req.get("language") or "").strip()
        model = (req.get("model") or "").strip() or cfg.model

        if cfg.dump_dir:
            self._dump(cfg, audio, filename)

        ctype, body = build_multipart(audio, filename, content_type, language, model)
        url = cfg.base_url + "/v1/audio/transcriptions"
        http_req = urllib.request.Request(url, data=body, method="POST")
        http_req.add_header("Content-Type", ctype)
        http_req.add_header("Content-Length", str(len(body)))
        if cfg.api_key:
            http_req.add_header("Authorization", "Bearer " + cfg.api_key)

        started = time.monotonic()
        try:
            with urllib.request.urlopen(http_req, timeout=cfg.timeout_s) as resp:
                status = resp.status
                engine_body = resp.read(16 << 20).decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            # The engine said no. That is a real answer, not a transport
            # failure: pass the status and body through so the JS side can tell
            # a transient 503 from a permanent 4xx and decide whether to retry
            # the window.
            status = exc.code
            try:
                engine_body = exc.read(16 << 20).decode("utf-8", "replace")
            except Exception:
                engine_body = ""
        except Exception as exc:
            elapsed = int((time.monotonic() - started) * 1000)
            log("WARN", "engine request failed after %dms: %s" % (elapsed, exc))
            self._send_json(
                502,
                {
                    "ok": False,
                    "error": "engine request failed: %s" % exc,
                    "provider_ms": elapsed,
                },
            )
            return

        elapsed = int((time.monotonic() - started) * 1000)
        ok = 200 <= status < 300
        if not ok:
            log(
                "WARN",
                "engine %s -> HTTP %d in %dms: %s"
                % (url, status, elapsed, engine_body[:300]),
            )
        else:
            log(
                "DEBUG",
                "engine %s -> HTTP %d in %dms (audio %d bytes, %s)"
                % (url, status, elapsed, len(audio), content_type),
            )
        self._send_json(
            200,
            {
                "ok": ok,
                "code": status,
                "body": engine_body,
                "provider_ms": elapsed,
            },
        )

    def _dump(self, cfg, audio, filename):
        try:
            os.makedirs(cfg.dump_dir, exist_ok=True)
            digest = hashlib.sha256(audio).hexdigest()
            path = os.path.join(
                cfg.dump_dir, "%d-%s-%s" % (time.time_ns(), digest[:12], filename)
            )
            with open(path, "wb") as fh:
                fh.write(audio)
            log("INFO", "dumped %d bytes sha256=%s -> %s" % (len(audio), digest, path))
        except Exception as exc:
            log("WARN", "dump failed: %s" % exc)


def main():
    cfg = Config(os.environ)
    host, _, port = cfg.listen.rpartition(":")
    host = host or "127.0.0.1"
    try:
        port = int(port)
    except ValueError:
        log("ERROR", "bad RECORDER_ASR_SHIM_LISTEN %r" % cfg.listen)
        return 2

    if cfg.dump_dir:
        log(
            "WARN",
            "RECORDER_ASR_SHIM_DUMP_DIR=%s — every forwarded recording is being "
            "written to disk. Development only." % cfg.dump_dir,
        )

    httpd = ThreadingHTTPServer((host, port), Handler)
    httpd.daemon_threads = True
    httpd.cfg = cfg
    httpd.health = HealthCache(cfg)

    target = cfg.base_url or "(disabled — RECORDER_ASR_BASE_URL is empty)"
    log(
        "INFO",
        "listening on %s:%d -> %s model=%s timeout=%dms"
        % (host, port, target, cfg.model, cfg.timeout_ms),
    )
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
