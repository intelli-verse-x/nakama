// __tests__/recorder_asr.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Offline tests for the Curio recorder ASR RPCs and the audio containers.
//
// No Jest / Mocha, matching src/learner-toolbelt/__tests__/skeleton.test.ts:
// the file has to compile against the production tsconfig, which carries no
// test-runner types. `RecorderAsrTests.runAll()` returns
// { passed, failed, errors, total }; see ./run.js for the harness.
//
// The mock `nk` deliberately behaves like the real thing in the two ways that
// have teeth:
//
//   * storageRead OMITS misses rather than returning a null-valued entry, which
//     is what Nakama does and what the "session not found" paths depend on;
//   * storage is partitioned by userId with no way to address another owner's
//     rows, which is the mechanism (not a filter) that makes cross-account
//     access impossible. The auth test below proves the RPC relies on it.
//
// Coverage
//   1.  open   — happy path, unauthenticated, no provider configured
//   2.  open   — COPPA: below_threshold / unknown refused, absent + require=1
//   3.  open   — resume on client_session_id, concurrent-session cap
//   4.  push   — auth isolation, unknown session, oversized chunk, closed session
//   5.  push   — idempotency (replayed seq appends no audio), seq gaps
//   6.  push   — limits: chunk count, session bytes
//   7.  close  — transcript out, idempotent replay, audio deleted
//   8.  gc     — abandoned sessions swept; purge erases the caller's own data
//   9.  audio  — WAV header, Ogg Opus structure + CRC, packet-size probe
//   10. audio  — multipart body preserves every byte 0x00-0xFF

namespace RecorderAsrTests {

  // ── Micro test runner ─────────────────────────────────────────────────────

  interface TestCase { suite: string; name: string; fn: () => void; }

  var allTests: TestCase[] = [];
  var currentSuite = "(root)";

  function describe(suite: string, fn: () => void): void {
    var prev = currentSuite;
    currentSuite = suite;
    try { fn(); } finally { currentSuite = prev; }
  }

  function it(name: string, fn: () => void): void {
    allTests.push({ suite: currentSuite, name: name, fn: fn });
  }

  function fmt(v: any): string {
    try { return JSON.stringify(v); } catch (_e: any) { return String(v); }
  }

  function expectEq(actual: any, expected: any, msg?: string): void {
    if (actual !== expected) {
      throw new Error((msg ? msg + " — " : "") + "expected " + fmt(expected) + " got " + fmt(actual));
    }
  }

  function expectTrue(actual: any, msg?: string): void {
    if (actual !== true) throw new Error((msg ? msg + " — " : "") + "expected true, got " + fmt(actual));
  }

  function expectGt(actual: number, floor: number, msg?: string): void {
    if (!(actual > floor)) {
      throw new Error((msg ? msg + " — " : "") + "expected > " + floor + ", got " + fmt(actual));
    }
  }

  // ── Mock Nakama ───────────────────────────────────────────────────────────

  interface Row { collection: string; key: string; userId: string; value: any; }

  interface MockNk {
    storageRead(reqs: any[]): any[];
    storageWrite(reqs: any[]): any[];
    storageDelete(reqs: any[]): void;
    storageList(userId: string, collection: string, limit: number, cursor: string): any;
    uuidv4(): string;
    sha256Hash(s: string): string;
    base64Encode(b: any): string;
    base64Decode(s: string): any;
    binaryToString(b: any): string;
    stringToBinary(s: string): any;
    httpRequest(url: string, method: string, headers: any, body: string, timeoutMs: number): any;
    _rows: Row[];
    _http: any[];
    _asrSegments: any[];
    /** One scripted engine response per call; falls back to _asrSegments. */
    _asrQueue: any[][];
    _asrCode: number;
    /** Whether the recorder-asr-shim sidecar is answering and says it can
     *  reach the engine. */
    _shimUp: boolean;
    /** Total storage keys addressed by storageDelete, including keys that never
     *  existed — the real cost of walking a sparse seq range. */
    _deleteKeyCount: number;
    _count(collection: string, userId: string): number;
  }

  /** Node's Buffer, reached through the sandbox global so this file needs no
   *  @types/node. The harness injects it. */
  declare var Buffer: any;

  function bytesToArrayBuffer(u8: Uint8Array): ArrayBuffer {
    var out = new Uint8Array(u8.length);
    out.set(u8);
    return out.buffer as ArrayBuffer;
  }

  function makeMockNk(): MockNk {
    var rows: Row[] = [];
    var http: any[] = [];
    var uuidSeq = 0;

    var nk: any = {
      _rows: rows,
      _http: http,
      // Default: one segment covering 0-2 s. Tests override.
      _asrSegments: [{ start: 0, end: 2.0, text: " hello from the pen." }],
      _asrQueue: [],
      _asrCode: 200,
      _shimUp: true,
      _deleteKeyCount: 0,

      _count: function (collection: string, userId: string): number {
        var n = 0;
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].collection === collection && (!userId || rows[i].userId === userId)) n++;
        }
        return n;
      },

      storageRead: function (reqs: any[]): any[] {
        var out: any[] = [];
        for (var i = 0; i < reqs.length; i++) {
          var r = reqs[i];
          for (var j = 0; j < rows.length; j++) {
            var e = rows[j];
            if (e.collection === r.collection && e.key === r.key && e.userId === r.userId) {
              // Deep copy: Nakama hands back a fresh object each read, and a
              // shared reference would hide mutate-without-write bugs.
              out.push({
                collection: e.collection, key: e.key, userId: e.userId,
                value: JSON.parse(JSON.stringify(e.value)),
              });
              break;
            }
          }
          // Misses are omitted, as in real Nakama.
        }
        return out;
      },

      storageWrite: function (reqs: any[]): any[] {
        for (var i = 0; i < reqs.length; i++) {
          var r = reqs[i];
          var found = false;
          for (var j = 0; j < rows.length; j++) {
            var e = rows[j];
            if (e.collection === r.collection && e.key === r.key && e.userId === r.userId) {
              e.value = JSON.parse(JSON.stringify(r.value));
              found = true;
              break;
            }
          }
          if (!found) {
            rows.push({
              collection: r.collection, key: r.key, userId: r.userId,
              value: JSON.parse(JSON.stringify(r.value)),
            });
          }
        }
        return [];
      },

      storageDelete: function (reqs: any[]): void {
        // Counted, not just applied: the cost of a reclamation is the number of
        // keys addressed, most of which never existed when the seq range is
        // sparse. That count is what the bounded-walk test asserts on.
        nk._deleteKeyCount += reqs.length;
        for (var i = 0; i < reqs.length; i++) {
          var r = reqs[i];
          for (var j = rows.length - 1; j >= 0; j--) {
            var e = rows[j];
            if (e.collection === r.collection && e.key === r.key && e.userId === r.userId) {
              rows.splice(j, 1);
            }
          }
        }
      },

      // Cursors are real here, not ignored. Nakama's storage listing is a keyset
      // scan in (userId, key) order and returns a cursor whenever more objects
      // remain; a mock that always restarts at the beginning cannot tell a
      // working cursor from a discarded one, which is exactly the bug that made
      // the global sweep unable to reach anything past its first few pages.
      storageList: function (userId: string, collection: string, limit: number, cursor: string): any {
        // `null` lists every owner; "" is REJECTED, exactly as the real runtime
        // rejects it. server/runtime_javascript_nakama.go:4717 only skips the
        // uuid parse for Undefined and Null, so an empty string reaches
        // uuid.FromString and panics — despite the message naming "empty" as
        // acceptable. The sweep passed "" for a long time and therefore never
        // scanned anything; a mock that treats "" as all-owners hides that.
        if (userId === "") {
          throw new Error("expects empty or valid user id");
        }
        var matching: Row[] = [];
        for (var i = 0; i < rows.length; i++) {
          var e = rows[i];
          if (e.collection !== collection) continue;
          if (userId !== null && userId !== undefined && e.userId !== userId) continue;
          matching.push(e);
        }
        matching.sort(function (x: Row, y: Row): number {
          if (x.userId !== y.userId) return x.userId < y.userId ? -1 : 1;
          return x.key < y.key ? -1 : (x.key > y.key ? 1 : 0);
        });

        var after = "" + (cursor || "");
        if (after.length > 0) {
          var start = 0;
          while (start < matching.length &&
            (matching[start].userId + "/" + matching[start].key) <= after) {
            start++;
          }
          matching = matching.slice(start);
        }

        var objects: any[] = [];
        for (var j = 0; j < matching.length && objects.length < limit; j++) {
          objects.push({
            collection: matching[j].collection, key: matching[j].key, userId: matching[j].userId,
            value: JSON.parse(JSON.stringify(matching[j].value)),
          });
        }
        var last = objects.length > 0 ? objects[objects.length - 1] : null;
        var more = objects.length > 0 && matching.length > objects.length;
        return {
          objects: objects,
          cursor: more && last ? last.userId + "/" + last.key : "",
        };
      },

      uuidv4: function (): string {
        uuidSeq++;
        var h = "";
        for (var i = 0; i < 8; i++) h += "0123456789abcdef".charAt((uuidSeq >> (i * 4)) & 0xf);
        return h + "-0000-4000-8000-000000000000";
      },

      sha256Hash: function (s: string): string {
        var h = 5381;
        for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
        var hex = h.toString(16);
        while (hex.length < 16) hex = "0" + hex;
        return hex + hex;
      },

      base64Encode: function (b: any): string {
        var u8 = b instanceof Uint8Array ? b : new Uint8Array(b);
        return Buffer.from(u8).toString("base64");
      },

      base64Decode: function (s: string): any {
        var buf = Buffer.from(s, "base64");
        var u8 = new Uint8Array(buf.length);
        for (var i = 0; i < buf.length; i++) u8[i] = buf[i];
        return u8.buffer;
      },

      // Goja's semantics: one JS char per byte, values 0-255 preserved.
      binaryToString: function (b: any): string {
        var u8 = b instanceof Uint8Array ? b : new Uint8Array(b);
        var s = "";
        for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
        return s;
      },

      stringToBinary: function (s: string): any {
        var u8 = new Uint8Array(s.length);
        for (var i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i) & 0xff;
        return u8.buffer;
      },

      // Stands in for the recorder-asr-shim sidecar at 127.0.0.1:7359. It answers
      // /healthz and /transcribe with the same envelope deploy/recorder-asr-shim/
      // shim.py returns, so the JS side is exercised against the real contract.
      httpRequest: function (url: string, method: string, headers: any, body: string, timeoutMs: number): any {
        http.push({ url: url, method: method, headers: headers, body: body, timeoutMs: timeoutMs });

        if (("" + url).indexOf("/healthz") > 0) {
          if (!nk._shimUp) throw new Error("connection refused");
          return { code: 200, headers: {}, body: JSON.stringify({ ok: true, base_url_set: true }) };
        }
        if (!nk._shimUp) throw new Error("connection refused");

        if (nk._asrCode !== 200) {
          // The shim itself answers 200 and reports the engine's status in the
          // envelope, which is what lets the caller tell 503 from 400.
          return {
            code: 200, headers: {},
            body: JSON.stringify({ ok: false, code: nk._asrCode, body: '{"detail":"forced failure"}', provider_ms: 5 }),
          };
        }
        // _asrQueue lets a test script one response per engine call, which is how
        // multi-window behaviour is exercised.
        var segs = nk._asrQueue.length > 0 ? nk._asrQueue.shift() : nk._asrSegments;
        var duration = segs.length > 0 ? segs[segs.length - 1].end : 0;
        var text = "";
        for (var i = 0; i < segs.length; i++) text += segs[i].text;
        return {
          code: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ok: true, code: 200, provider_ms: 42,
            body: JSON.stringify({ task: "transcribe", language: "en", duration: duration, text: text, segments: segs }),
          }),
        };
      },
    };
    return nk as MockNk;
  }

  // Engine configuration (base URL, model, key) belongs to the sidecar, not to
  // this module — the module only needs to know where the sidecar is.
  var ENV_OK: any = {
    RECORDER_ASR_SHIM_URL: "http://127.0.0.1:7359",
    RECORDER_ASR_GC_TOKEN: "gc_test_token",
  };

  function ctxFor(userId: string, extraEnv?: any): any {
    var env: any = {};
    for (var k in ENV_OK) if (Object.prototype.hasOwnProperty.call(ENV_OK, k)) env[k] = ENV_OK[k];
    if (extraEnv) for (var j in extraEnv) if (Object.prototype.hasOwnProperty.call(extraEnv, j)) env[j] = extraEnv[j];
    return { userId: userId, env: env };
  }

  function logger(): any {
    return {
      info: function (_m: string): void { },
      warn: function (_m: string): void { },
      error: function (_m: string): void { },
      debug: function (_m: string): void { },
    };
  }

  // ── Fixtures ──────────────────────────────────────────────────────────────

  var USER_A = "11111111-1111-4111-8111-111111111111";
  var USER_B = "22222222-2222-4222-8222-222222222222";

  /** TOC for SILK wideband, 20 ms, mono, one frame — what a 16 kHz pen emits. */
  var OPUS_TOC_WB_20MS_MONO = (9 << 3) | 0x00;

  function fakeOpusStream(packetBytes: number, packets: number): Uint8Array {
    var out = new Uint8Array(packetBytes * packets);
    for (var p = 0; p < packets; p++) {
      var base = p * packetBytes;
      out[base] = OPUS_TOC_WB_20MS_MONO;
      for (var i = 1; i < packetBytes; i++) out[base + i] = (base + i) & 0xff;
    }
    return out;
  }

  /** PCM16 for `ms` of 16 kHz mono — a quiet ramp, so length is what matters. */
  function fakePcm16(ms: number): Uint8Array {
    var samples = Math.round(16000 * ms / 1000);
    var out = new Uint8Array(samples * 2);
    for (var i = 0; i < samples; i++) {
      var v = Math.round(Math.sin(i / 40) * 3000);
      out[i * 2] = v & 0xff;
      out[i * 2 + 1] = (v >> 8) & 0xff;
    }
    return out;
  }

  function b64(nk: MockNk, bytes: Uint8Array): string {
    return nk.base64Encode(bytes);
  }

  function openSession(nk: MockNk, userId: string, extra?: any): any {
    var body: any = {
      client_session_id: "cli_" + userId.substring(0, 4),
      contract_version: "1.0.0",
      locale: "en_US",
      audio: { codec: "pcm16", sample_rate_hz: 16000, channels: 1, frame_ms: 20 },
      age_assertion: { bracket: "at_or_above_threshold", min_age: 13, declared_at: "2026-08-28T00:00:00Z" },
    };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) body[k] = extra[k];
    var raw = RecorderAsr.rpcOpen(ctxFor(userId), logger(), nk as any, JSON.stringify(body));
    return JSON.parse(raw);
  }

  function push(nk: MockNk, userId: string, sessionId: string, seq: number, bytes: Uint8Array, isLast?: boolean): any {
    var raw = RecorderAsr.rpcPush(ctxFor(userId), logger(), nk as any, JSON.stringify({
      session_id: sessionId, seq: seq, audio_b64: b64(nk, bytes), is_last: isLast === true,
    }));
    return JSON.parse(raw);
  }

  function close(nk: MockNk, userId: string, sessionId: string): any {
    var raw = RecorderAsr.rpcClose(ctxFor(userId), logger(), nk as any, JSON.stringify({ session_id: sessionId }));
    return JSON.parse(raw);
  }

  /** The shim calls that carried audio, i.e. excluding /healthz probes. */
  function uploads(nk: MockNk): any[] {
    var out: any[] = [];
    for (var i = 0; i < nk._http.length; i++) {
      if (("" + nk._http[i].url).indexOf("/transcribe") > 0) out.push(nk._http[i]);
    }
    return out;
  }

  /** The container bytes a shim call actually carried. */
  function uploadedBytes(nk: MockNk, call: any): Uint8Array {
    return new Uint8Array(nk.base64Decode(JSON.parse(call.body).audio_b64));
  }

  // ── 1. open ───────────────────────────────────────────────────────────────

  describe("recorder_asr_open", function (): void {

    it("returns a session_id and resume_from_seq=0 on a fresh open", function (): void {
      var nk = makeMockNk();
      var resp = openSession(nk, USER_A);
      expectTrue(!resp.error, "unexpected error: " + fmt(resp.error));
      expectTrue(("" + resp.session_id).indexOf("asr_srv_") === 0, "session_id shape: " + resp.session_id);
      expectEq(resp.resume_from_seq, 0);
    });

    it("rejects an unauthenticated caller with UNAUTHENTICATED", function (): void {
      var nk = makeMockNk();
      var raw = RecorderAsr.rpcOpen(ctxFor(""), logger(), nk as any, "{}");
      var resp = JSON.parse(raw);
      expectEq(resp.error.code, "UNAUTHENTICATED");
    });

    it("reports ENDPOINT_UNAVAILABLE when device transcription is switched off", function (): void {
      var nk = makeMockNk();
      var raw = RecorderAsr.rpcOpen(
        ctxFor(USER_A, { RECORDER_ASR_ENABLED: "0" }), logger(), nk as any,
        JSON.stringify({ audio: { codec: "pcm16" } }));
      var resp = JSON.parse(raw);
      expectEq(resp.error.code, "ENDPOINT_UNAVAILABLE");
      // Nothing may be stored on the refused path.
      expectEq(nk._count("recorder_asr_sessions", USER_A), 0);
      // And nothing may be uploaded either — the switch is off before any I/O.
      expectEq(nk._http.length, 0, "a disabled provider must not talk to the shim");
    });

    it("rejects an unsupported codec", function (): void {
      var nk = makeMockNk();
      var resp = openSession(nk, USER_A, { audio: { codec: "mp3", sample_rate_hz: 16000, channels: 1, frame_ms: 20 } });
      expectEq(resp.error.code, "INTERNAL");
    });

    it("rejects an unsupported sample rate", function (): void {
      var nk = makeMockNk();
      var resp = openSession(nk, USER_A, { audio: { codec: "pcm16", sample_rate_hz: 44100, channels: 1, frame_ms: 20 } });
      expectEq(resp.error.code, "INTERNAL");
    });

    it("stores only a fingerprint of a binding token, never the token", function (): void {
      var nk = makeMockNk();
      var resp = openSession(nk, USER_A, { binding_token: "super-secret-capability" });
      var stored = JSON.stringify(nk._rows);
      expectTrue(stored.indexOf("super-secret-capability") === -1, "raw binding token was persisted");
      var rec = nk.storageRead([{
        collection: "recorder_asr_sessions", key: resp.session_id, userId: USER_A,
      }])[0].value;
      expectGt(("" + rec.binding_token_fp).length, 0, "a fingerprint should still be recorded");
    });
  });

  // ── 2. open — COPPA ───────────────────────────────────────────────────────

  describe("recorder_asr_open — COPPA age gate", function (): void {

    it("refuses a session asserted below the age threshold", function (): void {
      var nk = makeMockNk();
      var resp = openSession(nk, USER_A, {
        age_assertion: { bracket: "below_threshold", min_age: 13, declared_at: "2026-08-28T00:00:00Z" },
      });
      expectEq(resp.error.code, "UNAUTHENTICATED");
      expectEq(nk._count("recorder_asr_sessions", USER_A), 0, "a refused minor session must store nothing");
    });

    it("refuses an unanswered age gate (bracket=unknown) — fails closed", function (): void {
      var nk = makeMockNk();
      var resp = openSession(nk, USER_A, { age_assertion: { bracket: "unknown" } });
      expectEq(resp.error.code, "UNAUTHENTICATED");
      expectEq(nk._count("recorder_asr_sessions", USER_A), 0);
    });

    it("treats an unrecognised bracket as unknown and refuses it", function (): void {
      var nk = makeMockNk();
      var resp = openSession(nk, USER_A, { age_assertion: { bracket: "probably_fine" } });
      expectEq(resp.error.code, "UNAUTHENTICATED");
    });

    it("allows a missing assertion by default (no shipped client sends one yet)", function (): void {
      var nk = makeMockNk();
      var raw = RecorderAsr.rpcOpen(ctxFor(USER_A), logger(), nk as any, JSON.stringify({
        client_session_id: "cli_noage",
        audio: { codec: "pcm16", sample_rate_hz: 16000, channels: 1, frame_ms: 20 },
      }));
      var resp = JSON.parse(raw);
      expectTrue(!resp.error, "expected the default to admit an absent assertion");
      // …but it is recorded as explicitly absent, so the audit trail never
      // looks like a claim that was made.
      var rec = nk.storageRead([{ collection: "recorder_asr_sessions", key: resp.session_id, userId: USER_A }])[0].value;
      expectEq(rec.age_assertion.bracket, "absent");
      expectEq(rec.age_assertion.source, "absent");
    });

    it("refuses a missing assertion when RECORDER_ASR_REQUIRE_AGE_ASSERTION=1", function (): void {
      var nk = makeMockNk();
      var raw = RecorderAsr.rpcOpen(
        ctxFor(USER_A, { RECORDER_ASR_REQUIRE_AGE_ASSERTION: "1" }), logger(), nk as any,
        JSON.stringify({ audio: { codec: "pcm16", sample_rate_hz: 16000, channels: 1, frame_ms: 20 } }));
      var resp = JSON.parse(raw);
      expectEq(resp.error.code, "UNAUTHENTICATED");
      expectEq(nk._count("recorder_asr_sessions", USER_A), 0);
    });

    it("records an accepted assertion on the session for audit", function (): void {
      var nk = makeMockNk();
      var resp = openSession(nk, USER_A);
      var rec = nk.storageRead([{ collection: "recorder_asr_sessions", key: resp.session_id, userId: USER_A }])[0].value;
      expectEq(rec.age_assertion.bracket, "at_or_above_threshold");
      expectEq(rec.age_assertion.min_age, 13);
      expectEq(rec.age_assertion.source, "client");
    });
  });

  // ── 3. open — resume and caps ─────────────────────────────────────────────

  describe("recorder_asr_open — resume and session caps", function (): void {

    it("resumes the same server session for a repeated client_session_id", function (): void {
      var nk = makeMockNk();
      var first = openSession(nk, USER_A);
      push(nk, USER_A, first.session_id, 0, fakePcm16(200));
      push(nk, USER_A, first.session_id, 1, fakePcm16(200));

      var again = openSession(nk, USER_A);
      expectEq(again.session_id, first.session_id, "reconnect must not start a second transcript");
      expectEq(again.resume_from_seq, 2, "resume must continue after the last acked seq");
      expectEq(nk._count("recorder_asr_sessions", USER_A), 1);
    });

    it("starts a new session when the indexed one is already closed", function (): void {
      var nk = makeMockNk();
      var first = openSession(nk, USER_A);
      push(nk, USER_A, first.session_id, 0, fakePcm16(200));
      close(nk, USER_A, first.session_id);
      var second = openSession(nk, USER_A);
      expectTrue(second.session_id !== first.session_id, "a closed session must not be resumed");
    });

    it("rejects more than 3 concurrent open sessions with RATE_LIMITED", function (): void {
      var nk = makeMockNk();
      var i: number;
      for (i = 0; i < 3; i++) {
        var ok = openSession(nk, USER_A, { client_session_id: "cli_cap_" + i });
        expectTrue(!ok.error, "session " + i + " should open: " + fmt(ok.error));
      }
      var over = openSession(nk, USER_A, { client_session_id: "cli_cap_over" });
      expectEq(over.error.code, "RATE_LIMITED");
    });

    it("counts the cap per account, not globally", function (): void {
      var nk = makeMockNk();
      var i: number;
      for (i = 0; i < 3; i++) openSession(nk, USER_A, { client_session_id: "cli_a_" + i });
      var b = openSession(nk, USER_B, { client_session_id: "cli_b_0" });
      expectTrue(!b.error, "another account must not be blocked by A's sessions");
    });
  });

  // ── 4. push — auth and validation ─────────────────────────────────────────

  describe("recorder_asr_push — auth and validation", function (): void {

    it("refuses a push to another account's session", function (): void {
      var nk = makeMockNk();
      var a = openSession(nk, USER_A);
      var resp = push(nk, USER_B, a.session_id, 0, fakePcm16(200));
      expectEq(resp.error.code, "DEVICE_NOT_FOUND", "B must not reach A's session");
      // And A's session must be untouched.
      var rec = nk.storageRead([{ collection: "recorder_asr_sessions", key: a.session_id, userId: USER_A }])[0].value;
      expectEq(rec.acked_seq, -1);
      expectEq(rec.audio_bytes, 0);
    });

    it("does not reveal whether another account's session id exists", function (): void {
      var nk = makeMockNk();
      var a = openSession(nk, USER_A);
      var real = push(nk, USER_B, a.session_id, 0, fakePcm16(10));
      var fake = push(nk, USER_B, "asr_srv_doesnotexist", 0, fakePcm16(10));
      expectEq(real.error.code, fake.error.code);
      expectEq(real.error.message, fake.error.message);
    });

    it("rejects an unauthenticated push", function (): void {
      var nk = makeMockNk();
      var a = openSession(nk, USER_A);
      var raw = RecorderAsr.rpcPush(ctxFor(""), logger(), nk as any,
        JSON.stringify({ session_id: a.session_id, seq: 0, audio_b64: "" }));
      expectEq(JSON.parse(raw).error.code, "UNAUTHENTICATED");
    });

    it("rejects a push with no session_id", function (): void {
      var nk = makeMockNk();
      var raw = RecorderAsr.rpcPush(ctxFor(USER_A), logger(), nk as any, JSON.stringify({ seq: 0, audio_b64: "" }));
      expectEq(JSON.parse(raw).error.code, "INTERNAL");
    });

    it("rejects a push with a negative or missing seq", function (): void {
      var nk = makeMockNk();
      var a = openSession(nk, USER_A);
      var raw = RecorderAsr.rpcPush(ctxFor(USER_A), logger(), nk as any,
        JSON.stringify({ session_id: a.session_id, audio_b64: "" }));
      expectEq(JSON.parse(raw).error.code, "INTERNAL");
    });

    it("rejects an oversized chunk rather than storing it", function (): void {
      var nk = makeMockNk();
      var a = openSession(nk, USER_A);
      var huge = "";
      while (huge.length < 262145) huge += "AAAAAAAAAAAAAAAA";
      var raw = RecorderAsr.rpcPush(ctxFor(USER_A), logger(), nk as any,
        JSON.stringify({ session_id: a.session_id, seq: 0, audio_b64: huge }));
      var resp = JSON.parse(raw);
      expectEq(resp.error.code, "INTERNAL");
      expectTrue(("" + resp.error.message).indexOf("too large") >= 0, resp.error.message);
      expectEq(nk._count("recorder_asr_chunks", USER_A), 0);
    });

    it("refuses a push to a session that is already closed", function (): void {
      var nk = makeMockNk();
      var a = openSession(nk, USER_A);
      push(nk, USER_A, a.session_id, 0, fakePcm16(200));
      close(nk, USER_A, a.session_id);
      var late = push(nk, USER_A, a.session_id, 1, fakePcm16(200));
      expectEq(late.error.code, "INTERNAL");
      expectTrue(("" + late.error.message).indexOf("already closed") >= 0, late.error.message);
    });
  });

  // ── 5. push — idempotency ─────────────────────────────────────────────────

  describe("recorder_asr_push — idempotency", function (): void {

    it("ignores a replayed seq and appends no audio", function (): void {
      var nk = makeMockNk();
      var a = openSession(nk, USER_A);
      var chunk = fakePcm16(500);

      var first = push(nk, USER_A, a.session_id, 0, chunk);
      expectEq(first.acked_seq, 0);
      var afterFirst = nk.storageRead([{ collection: "recorder_asr_sessions", key: a.session_id, userId: USER_A }])[0].value;
      expectEq(afterFirst.audio_bytes, chunk.length);
      expectEq(afterFirst.chunk_count, 1);

      // The client retried. Same seq, same bytes.
      var replay = push(nk, USER_A, a.session_id, 0, chunk);
      expectEq(replay.acked_seq, 0, "a replay must re-ack, not fail");
      var afterReplay = nk.storageRead([{ collection: "recorder_asr_sessions", key: a.session_id, userId: USER_A }])[0].value;
      expectEq(afterReplay.audio_bytes, chunk.length, "replayed audio must not be counted twice");
      expectEq(afterReplay.chunk_count, 1, "replayed audio must not be stored twice");
      expectEq(afterReplay.next_offset, chunk.length, "the stream must not advance on a replay");
      expectEq(nk._count("recorder_asr_chunks", USER_A), 1);
    });

    it("re-acks an older seq without rewinding the ack watermark", function (): void {
      var nk = makeMockNk();
      var a = openSession(nk, USER_A);
      push(nk, USER_A, a.session_id, 0, fakePcm16(200));
      push(nk, USER_A, a.session_id, 1, fakePcm16(200));
      push(nk, USER_A, a.session_id, 2, fakePcm16(200));
      var stale = push(nk, USER_A, a.session_id, 1, fakePcm16(200));
      expectEq(stale.acked_seq, 2, "a stale retry must not rewind acked_seq");
      expectEq(nk._count("recorder_asr_chunks", USER_A), 3);
    });

    it("accepts a seq gap (the client drops on backpressure) and acks the newest", function (): void {
      var nk = makeMockNk();
      var a = openSession(nk, USER_A);
      push(nk, USER_A, a.session_id, 0, fakePcm16(200));
      var jumped = push(nk, USER_A, a.session_id, 7, fakePcm16(200));
      expectEq(jumped.acked_seq, 7, "a gap must ack so the client can free its queue");
      expectTrue(!jumped.error);
    });
  });

  // ── 6. push — limits ──────────────────────────────────────────────────────

  describe("recorder_asr_push — limits", function (): void {

    it("stops at the per-session byte ceiling with RATE_LIMITED", function (): void {
      var nk = makeMockNk();
      var a = openSession(nk, USER_A);
      // Forge the counter rather than pushing 24 MiB through the mock.
      var rows = nk._rows;
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].collection === "recorder_asr_sessions" && rows[i].key === a.session_id) {
          rows[i].value.audio_bytes = 24 * 1024 * 1024 - 8;
          rows[i].value.next_offset = 24 * 1024 * 1024 - 8;
          rows[i].value.transcribed_bytes = 24 * 1024 * 1024 - 8;
        }
      }
      var resp = push(nk, USER_A, a.session_id, 1, fakePcm16(100));
      expectEq(resp.error.code, "RATE_LIMITED");
      expectTrue(("" + resp.error.message).indexOf("audio limit") >= 0, resp.error.message);
    });

    it("stops at the per-session chunk ceiling with RATE_LIMITED", function (): void {
      var nk = makeMockNk();
      var a = openSession(nk, USER_A);
      var rows = nk._rows;
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].collection === "recorder_asr_sessions" && rows[i].key === a.session_id) {
          rows[i].value.chunk_count = 4096;
          rows[i].value.acked_seq = 4095;
        }
      }
      var resp = push(nk, USER_A, a.session_id, 4096, fakePcm16(100));
      expectEq(resp.error.code, "RATE_LIMITED");
      expectTrue(("" + resp.error.message).indexOf("chunk limit") >= 0, resp.error.message);
    });
  });

  // ── 6b. window seams: partial vs final ────────────────────────────────────
  //
  // The regression these cover was found live, not by a mock: a window boundary
  // landed mid-utterance and the engine returned "and returns a transc-", which
  // was committed as final; the next window re-transcribed the same audio in
  // full and appended "and returns a transcript." on top of it. The tail of a
  // window is therefore emitted as a replaceable partial, and the watermark
  // rewinds to the last committed utterance so the next seam falls in a pause.

  describe("window seams", function (): void {

    /**
     * Pushes 10 s in 2 s chunks, which crosses the 8 s window on the fourth,
     * and returns every segment the run emitted. Aggregated because the window
     * fires on whichever push crosses the threshold, not on the last one.
     */
    function pushAWindow(nk: MockNk, sessionId: string, startSeq: number): any {
      var all: any[] = [];
      for (var i = 0; i < 5; i++) {
        var r = push(nk, USER_A, sessionId, startSeq + i, fakePcm16(2000));
        if (r.error) throw new Error("push failed: " + fmt(r.error));
        for (var j = 0; j < (r.segments || []).length; j++) all.push(r.segments[j]);
      }
      return { segments: all };
    }

    it("emits a segment that runs to the window edge as a partial", function (): void {
      var nk = makeMockNk();
      // The window covers 0-10 s; the second segment ends right at the edge.
      nk._asrQueue = [[
        { start: 0.0, end: 4.0, text: " the phone forwards those packets to the server," },
        { start: 4.0, end: 9.98, text: " which reassembles them and returns a transc-" },
      ]];
      var a = openSession(nk, USER_A);
      var resp = pushAWindow(nk, a.session_id, 0);

      expectEq(resp.segments.length, 2, "both segments should be reported");
      expectEq(resp.segments[0].is_final, true, "a segment well clear of the edge is final");
      expectEq(resp.segments[1].is_final, false, "a segment at the edge is not committable");

      // Only the committed one is stored, so a resume cannot replay the partial.
      var rec = nk.storageRead([{ collection: "recorder_asr_sessions", key: a.session_id, userId: USER_A }])[0].value;
      expectEq(rec.segments.length, 1, "a partial must not enter the stored transcript");
      expectEq(rec.segments[0].text, "the phone forwards those packets to the server,");
    });

    it("rewinds the watermark to the last committed utterance", function (): void {
      var nk = makeMockNk();
      nk._asrQueue = [[
        { start: 0.0, end: 4.0, text: " first utterance." },
        { start: 4.0, end: 9.98, text: " second one cut sho-" },
      ]];
      var a = openSession(nk, USER_A);
      pushAWindow(nk, a.session_id, 0);
      var rec = nk.storageRead([{ collection: "recorder_asr_sessions", key: a.session_id, userId: USER_A }])[0].value;
      expectEq(rec.transcribed_ms, 4000,
        "the watermark must sit at the end of the last final segment, not the window edge");
    });

    it("re-emits the cut utterance as final on the next window, once", function (): void {
      var nk = makeMockNk();
      nk._asrQueue = [
        [
          { start: 0.0, end: 4.0, text: " first utterance." },
          { start: 4.0, end: 9.98, text: " second one cut sho-" },
        ],
        // Second window starts at the 4 s watermark (minus overlap), so the
        // engine sees the whole second utterance and finishes it.
        [
          { start: 0.0, end: 4.2, text: " second one cut short is now complete." },
          { start: 4.2, end: 8.0, text: " and a third arrives." },
        ],
      ];
      var a = openSession(nk, USER_A);
      var w1 = pushAWindow(nk, a.session_id, 0);
      var w2 = pushAWindow(nk, a.session_id, 5);

      expectEq(w1.segments[1].is_final, false);
      var texts: string[] = [];
      var rec = nk.storageRead([{ collection: "recorder_asr_sessions", key: a.session_id, userId: USER_A }])[0].value;
      for (var i = 0; i < rec.segments.length; i++) texts.push(rec.segments[i].text);

      // The truncated form must never appear in the committed transcript, and the
      // completed form must appear exactly once.
      var joined = texts.join(" | ");
      expectTrue(joined.indexOf("cut sho-") === -1, "the truncated tail was committed: " + joined);
      var completeCount = 0;
      for (var j = 0; j < texts.length; j++) {
        if (texts[j].indexOf("is now complete") >= 0) completeCount++;
      }
      expectEq(completeCount, 1, "the finished utterance must be committed once: " + joined);
      expectGt(w2.segments.length, 0);
    });

    it("commits everything on close, since nothing can supersede it", function (): void {
      var nk = makeMockNk();
      nk._asrQueue = [[
        { start: 0.0, end: 1.5, text: " the last thing said" },
        { start: 1.5, end: 2.0, text: " right up to the end." },
      ]];
      var a = openSession(nk, USER_A);
      push(nk, USER_A, a.session_id, 0, fakePcm16(2000));
      var resp = close(nk, USER_A, a.session_id);
      expectEq(resp.segments.length, 2);
      expectEq(resp.segments[0].is_final, true);
      expectEq(resp.segments[1].is_final, true, "close must not leave a dangling partial");
    });

    it("makes progress when one utterance spans the whole window", function (): void {
      var nk = makeMockNk();
      // No pause anywhere: a single segment covering the entire window. Nothing
      // is safely committable, but the session must not stall.
      nk._asrQueue = [[{ start: 0.0, end: 9.99, text: " one very long unbroken sentence" }]];
      var a = openSession(nk, USER_A);
      var resp = pushAWindow(nk, a.session_id, 0);
      expectEq(resp.segments.length, 1);
      expectEq(resp.segments[0].is_final, true, "progress must win over tail safety here");
      var rec = nk.storageRead([{ collection: "recorder_asr_sessions", key: a.session_id, userId: USER_A }])[0].value;
      expectGt(rec.transcribed_bytes, 0, "the window must be consumed");
      expectGt(rec.transcribed_ms, 0);
    });

    it("does not re-read committed audio into the next window", function (): void {
      // The regression: overlap used to be re-fed unconditionally, and the
      // engine responded with one segment straddling the watermark whose text
      // repeated what had just been committed. Measured live before the fix:
      // "…sidecar shim." committed, then "sidecar shim. 2. The audio was…"
      // committed right after it, with begin_ms moving backwards.
      //
      // The watermark already rewinds to the end of the last committed
      // utterance, so the next window must start exactly there.
      var nk = makeMockNk();
      nk._asrQueue = [
        [{ start: 0.0, end: 4.0, text: " committed already." }],
        [{ start: 0.0, end: 1.0, text: " brand new words." }],
      ];
      var a = openSession(nk, USER_A);
      pushAWindow(nk, a.session_id, 0);
      // Exactly one further push, not a whole second pushAWindow: five more 2 s
      // chunks would trigger a third engine call the queue does not script.
      var w2 = push(nk, USER_A, a.session_id, 5, fakePcm16(2000));
      expectEq(uploads(nk).length, 2, "this scenario must be exactly two engine calls");

      // 4000 ms of committed audio at 16 kHz mono PCM16 is 128,000 bytes, plus
      // the 44-byte WAV header. The second window must begin at that watermark,
      // so its container must hold only what came after it.
      var second = uploadedBytes(nk, uploads(nk)[1]);
      var rec = nk.storageRead([{ collection: "recorder_asr_sessions", key: a.session_id, userId: USER_A }])[0].value;
      var expectedBytes = rec.next_offset - 128000;
      expectEq(second.length - 44, expectedBytes,
        "the second window must start at the committed watermark, not before it");

      // And the segment it returns is timed from that watermark, so nothing
      // moves backwards.
      expectEq(w2.segments.length, 1);
      expectEq(w2.segments[0].begin_ms, 4000, "the window's offset must be the watermark");
      expectEq(rec.segments.length, 2, "each utterance stored once");
    });

    it("re-feeds overlap only when audio was consumed without producing text", function (): void {
      // Normal case: the watermark sits exactly at the end of the last
      // committed utterance, so there is nothing to recover by reaching back —
      // and reaching back is what duplicated text at every seam.
      expectEq(RecorderAsr.overlapMsFor(4000, 4000), 0);
      expectEq(RecorderAsr.overlapMsFor(0, 0), 0);
      // Degraded case: 6 s of audio consumed, only 4 s of it turned into text,
      // so the boundary is arbitrary and an utterance may be cut in half.
      expectGt(RecorderAsr.overlapMsFor(6000, 4000), 0);
    });
  });

  // ── 7. close ──────────────────────────────────────────────────────────────

  describe("recorder_asr_close", function (): void {

    it("returns the trailing transcript for the audio pushed", function (): void {
      var nk = makeMockNk();
      var a = openSession(nk, USER_A);
      push(nk, USER_A, a.session_id, 0, fakePcm16(1500));
      push(nk, USER_A, a.session_id, 1, fakePcm16(1500));

      var resp = close(nk, USER_A, a.session_id);
      expectTrue(!resp.error, fmt(resp.error));
      expectEq(resp.acked_seq, 1);
      expectGt(resp.segments.length, 0, "close must flush a transcript for the tail");
      expectEq(resp.segments[0].text, "hello from the pen.", "provider text must be trimmed and passed through");
      expectTrue(resp.segments[0].is_final);
      expectEq(uploads(nk).length, 1, "the tail should need exactly one engine call");
    });

    it("wraps a bare-opus session in a valid Ogg stream", function (): void {
      var nk = makeMockNk();
      var a = openSession(nk, USER_A, {
        client_session_id: "cli_opus",
        audio: { codec: "opus", sample_rate_hz: 16000, channels: 1, frame_ms: 20 },
      });
      // 100 packets x 40 bytes = 2 s of pen audio.
      push(nk, USER_A, a.session_id, 0, fakeOpusStream(40, 100));
      var resp = close(nk, USER_A, a.session_id);
      expectTrue(!resp.error, fmt(resp.error));

      var sent = uploadedBytes(nk, uploads(nk)[0]);
      expectEq(String.fromCharCode(sent[0], sent[1], sent[2], sent[3]), "OggS");
      // OpusHead lands in the first page's payload, at byte 28.
      var head = "";
      for (var i = 28; i < 36; i++) head += String.fromCharCode(sent[i]);
      expectEq(head, "OpusHead");
    });

    it("records the probed packet size on an opus session", function (): void {
      var nk = makeMockNk();
      var a = openSession(nk, USER_A, {
        client_session_id: "cli_opus2",
        audio: { codec: "opus", sample_rate_hz: 16000, channels: 1, frame_ms: 20 },
      });
      push(nk, USER_A, a.session_id, 0, fakeOpusStream(40, 50));
      close(nk, USER_A, a.session_id);
      var rec = nk.storageRead([{ collection: "recorder_asr_sessions", key: a.session_id, userId: USER_A }])[0].value;
      expectEq(rec.packet_bytes, 40, "the probe must persist what the bytes said");
    });

    it("is idempotent — a replayed close does not transcribe again", function (): void {
      var nk = makeMockNk();
      var a = openSession(nk, USER_A);
      push(nk, USER_A, a.session_id, 0, fakePcm16(1200));

      var first = close(nk, USER_A, a.session_id);
      var callsAfterFirst = uploads(nk).length;
      expectGt(first.segments.length, 0);

      var replay = close(nk, USER_A, a.session_id);
      expectEq(uploads(nk).length, callsAfterFirst, "a replayed close must not call the provider again");
      expectEq(JSON.stringify(replay.segments), JSON.stringify(first.segments),
        "a replayed close must return the same trailing segments");
      expectEq(replay.acked_seq, first.acked_seq);
    });

    it("deletes every audio chunk at close", function (): void {
      var nk = makeMockNk();
      var a = openSession(nk, USER_A);
      push(nk, USER_A, a.session_id, 0, fakePcm16(400));
      push(nk, USER_A, a.session_id, 1, fakePcm16(400));
      push(nk, USER_A, a.session_id, 2, fakePcm16(400));
      expectGt(nk._count("recorder_asr_chunks", USER_A), 0);

      close(nk, USER_A, a.session_id);
      expectEq(nk._count("recorder_asr_chunks", USER_A), 0, "no audio may survive a close");
    });

    it("keeps nothing at all when the transcript TTL is zero", function (): void {
      var nk = makeMockNk();
      var raw = RecorderAsr.rpcOpen(ctxFor(USER_A), logger(), nk as any, JSON.stringify({
        client_session_id: "cli_zero",
        audio: { codec: "pcm16", sample_rate_hz: 16000, channels: 1, frame_ms: 20 },
        age_assertion: { bracket: "at_or_above_threshold", min_age: 13 },
      }));
      var a = JSON.parse(raw);
      push(nk, USER_A, a.session_id, 0, fakePcm16(400));
      var zeroCtx = ctxFor(USER_A, { RECORDER_ASR_TRANSCRIPT_TTL_SECONDS: "0" });
      var resp = JSON.parse(RecorderAsr.rpcClose(zeroCtx, logger(), nk as any,
        JSON.stringify({ session_id: a.session_id })));
      expectGt(resp.segments.length, 0, "the transcript must still be returned once");
      expectEq(nk._count("recorder_asr_sessions", USER_A), 0, "zero TTL must retain no session");
      expectEq(nk._count("recorder_asr_chunks", USER_A), 0);
    });

    it("refuses to close another account's session", function (): void {
      var nk = makeMockNk();
      var a = openSession(nk, USER_A);
      push(nk, USER_A, a.session_id, 0, fakePcm16(400));
      var resp = close(nk, USER_B, a.session_id);
      expectEq(resp.error.code, "DEVICE_NOT_FOUND");
      var rec = nk.storageRead([{ collection: "recorder_asr_sessions", key: a.session_id, userId: USER_A }])[0].value;
      expectEq(rec.state, "open", "B's close must not close A's session");
    });

    it("still closes and returns an ack when the provider is failing", function (): void {
      var nk = makeMockNk();
      nk._asrCode = 503;
      var a = openSession(nk, USER_A);
      push(nk, USER_A, a.session_id, 0, fakePcm16(400));
      var resp = close(nk, USER_A, a.session_id);
      expectTrue(!resp.error, "a provider outage must not fail the close: " + fmt(resp.error));
      expectEq(resp.segments.length, 0);
      expectEq(nk._count("recorder_asr_chunks", USER_A), 0, "audio is still deleted on a failed close");
    });

    it("keeps a failing provider's audio for retry on push", function (): void {
      var nk = makeMockNk();
      nk._asrCode = 503;
      var a = openSession(nk, USER_A);
      push(nk, USER_A, a.session_id, 0, fakePcm16(1200), true);
      var rec = nk.storageRead([{ collection: "recorder_asr_sessions", key: a.session_id, userId: USER_A }])[0].value;
      expectEq(rec.transcribed_bytes, 0, "a provider failure must not advance the watermark");
      expectGt(nk._count("recorder_asr_chunks", USER_A), 0, "the audio must stay for the retry");
    });
  });

  // ── 8. cleanup ────────────────────────────────────────────────────────────

  describe("cleanup — sweep, gc, purge", function (): void {

    it("sweeps an abandoned session and its audio", function (): void {
      var nk = makeMockNk();
      var a = openSession(nk, USER_A);
      push(nk, USER_A, a.session_id, 0, fakePcm16(400));
      // Backdate past the 1 h idle TTL.
      var rows = nk._rows;
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].collection === "recorder_asr_sessions" && rows[i].key === a.session_id) {
          rows[i].value.expires_at = Math.floor(Date.now() / 1000) - 60;
        }
      }
      var result = RecorderAsr.sweep(nk as any, logger(), 100);
      expectEq(result.removed, 1);
      expectEq(nk._count("recorder_asr_sessions", USER_A), 0);
      expectEq(nk._count("recorder_asr_chunks", USER_A), 0, "abandoned audio must not leak");
      expectEq(nk._count("recorder_asr_index", USER_A), 0, "the resume index must go too");
    });

    it("leaves a live session alone", function (): void {
      var nk = makeMockNk();
      var a = openSession(nk, USER_A);
      push(nk, USER_A, a.session_id, 0, fakePcm16(400));
      expectEq(RecorderAsr.sweep(nk as any, logger(), 100).removed, 0);
      expectEq(nk._count("recorder_asr_sessions", USER_A), 1);
    });

    it("sweeps a closed session once its transcript TTL has passed", function (): void {
      var nk = makeMockNk();
      var a = openSession(nk, USER_A);
      push(nk, USER_A, a.session_id, 0, fakePcm16(400));
      close(nk, USER_A, a.session_id);
      var rows = nk._rows;
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].collection === "recorder_asr_sessions" && rows[i].key === a.session_id) {
          rows[i].value.expires_at = Math.floor(Date.now() / 1000) - 1;
        }
      }
      expectEq(RecorderAsr.sweep(nk as any, logger(), 100).removed, 1);
      expectEq(nk._count("recorder_asr_sessions", USER_A), 0, "a transcript must not be kept indefinitely");
    });

    it("reaches an expired session that sits beyond the first sweep run", function (): void {
      // The regression this pins: the sweep is bounded at 5 pages, and it used
      // to discard its cursor at the end of every run. With more records than
      // one run can page through, an expired session past that horizon was
      // unreachable no matter how many times the cron fired.
      var nk = makeMockNk();
      var stale = Math.floor(Date.now() / 1000) - 60;
      var live = Math.floor(Date.now() / 1000) + 3600;
      var PAGE = 100;
      var RUN = PAGE * 5;
      var total = RUN + 20;
      for (var i = 0; i < total; i++) {
        var key = "asr_srv_" + (1000000 + i);
        // Only the very last key in sort order is expired, so it can only be
        // found by a run that resumes where the previous one stopped.
        nk.storageWrite([{
          collection: "recorder_asr_sessions", key: key, userId: USER_A,
          value: {
            session_id: key, client_session_id: "cli_" + i, state: "closed",
            acked_seq: -1, first_chunk_seq: 0,
            expires_at: i === total - 1 ? stale : live,
          },
        }]);
      }

      var first = RecorderAsr.sweep(nk as any, logger(), PAGE);
      expectEq(first.removed, 0, "the expired record is past this run's horizon");
      expectEq(first.scanned, RUN);
      expectEq(first.wrapped, false, "a bounded run must not claim a full lap");

      var second = RecorderAsr.sweep(nk as any, logger(), PAGE);
      expectEq(second.removed, 1, "the next run must resume, not restart");
      expectEq(second.wrapped, true, "reaching the end starts a fresh lap");
      expectEq(nk._count("recorder_asr_sessions", USER_A), total - 1);

      // And the lap really did reset: a third run starts from the beginning.
      expectGt(RecorderAsr.sweep(nk as any, logger(), PAGE).scanned, 0);
    });

    it("does not scan other accounts when a user is at their session cap", function (): void {
      // `open` used to run the cross-account sweep BEFORE the per-user cap
      // check, so a user sitting at their cap triggered a 500-object global
      // scan on every rejected call.
      var nk = makeMockNk();
      var b = openSession(nk, USER_B);
      push(nk, USER_B, b.session_id, 0, fakePcm16(200));

      for (var i = 0; i < 3; i++) {
        var opened = openSession(nk, USER_A, { client_session_id: "cli_cap_" + i });
        expectEq(opened.error, undefined, "session " + i + " should open");
      }

      var listed: string[] = [];
      var realList = (nk as any).storageList;
      (nk as any).storageList = function (userId: string, collection: string, limit: number, cursor: string): any {
        listed.push(userId);
        return realList(userId, collection, limit, cursor);
      };

      var refused = openSession(nk, USER_A, { client_session_id: "cli_cap_over" });
      expectEq(refused.error.code, "RATE_LIMITED");
      expectGt(listed.length, 0, "the cap check still needs one listing");
      for (var j = 0; j < listed.length; j++) {
        expectEq(listed[j], USER_A, "a rejected open must only list the caller's own data");
      }
      expectEq(nk._count("recorder_asr_sessions", USER_B), 1, "another account is untouched");
    });

    it("reclaims the caller's own expired session to free a cap slot", function (): void {
      var nk = makeMockNk();
      var ids: string[] = [];
      for (var i = 0; i < 3; i++) {
        ids.push(openSession(nk, USER_A, { client_session_id: "cli_reclaim_" + i }).session_id);
      }
      // Abandon one without closing it.
      var rows = nk._rows;
      for (var r = 0; r < rows.length; r++) {
        if (rows[r].collection === "recorder_asr_sessions" && rows[r].key === ids[0]) {
          rows[r].value.expires_at = Math.floor(Date.now() / 1000) - 1;
        }
      }
      var opened = openSession(nk, USER_A, { client_session_id: "cli_reclaim_new" });
      expectEq(opened.error, undefined, "an abandoned session must not hold a cap slot forever");
      expectEq(nk._count("recorder_asr_index", USER_A), 3,
        "the abandoned session's resume index must be reclaimed with it");
    });

    it("requires a service token for recorder_asr_gc", function (): void {
      var nk = makeMockNk();
      var raw = RecorderAsr.rpcGc(ctxFor(""), logger(), nk as any, "{}");
      expectEq(JSON.parse(raw).error.code, "UNAUTHENTICATED");
      var wrong = RecorderAsr.rpcGc(ctxFor(""), logger(), nk as any, '{"service_token":"nope"}');
      expectEq(JSON.parse(wrong).error.code, "UNAUTHENTICATED");
      var right = RecorderAsr.rpcGc(ctxFor(""), logger(), nk as any, '{"service_token":"gc_test_token"}');
      expectEq(JSON.parse(right).error, undefined);
    });

    it("purges only the caller's own sessions and audio", function (): void {
      var nk = makeMockNk();
      var a = openSession(nk, USER_A);
      push(nk, USER_A, a.session_id, 0, fakePcm16(400));
      var b = openSession(nk, USER_B);
      push(nk, USER_B, b.session_id, 0, fakePcm16(400));

      var resp = JSON.parse(RecorderAsr.rpcPurge(ctxFor(USER_A), logger(), nk as any, "{}"));
      expectEq(resp.purged_sessions, 1);
      expectEq(nk._count("recorder_asr_sessions", USER_A), 0);
      expectEq(nk._count("recorder_asr_chunks", USER_A), 0);
      expectEq(nk._count("recorder_asr_sessions", USER_B), 1, "purge must not touch another account");
      expectEq(nk._count("recorder_asr_chunks", USER_B), 1);
    });

    it("purge is idempotent", function (): void {
      var nk = makeMockNk();
      var a = openSession(nk, USER_A);
      push(nk, USER_A, a.session_id, 0, fakePcm16(400));
      RecorderAsr.rpcPurge(ctxFor(USER_A), logger(), nk as any, "{}");
      var second = JSON.parse(RecorderAsr.rpcPurge(ctxFor(USER_A), logger(), nk as any, "{}"));
      expectEq(second.purged_sessions, 0);
    });
  });

  // ── 9. audio containers ───────────────────────────────────────────────────

  describe("RecorderAudio — WAV", function (): void {

    function u32(b: Uint8Array, off: number): number {
      return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
    }

    function ascii(b: Uint8Array, off: number, len: number): string {
      var s = "";
      for (var i = 0; i < len; i++) s += String.fromCharCode(b[off + i]);
      return s;
    }

    it("writes a canonical 44-byte header with the right rates", function (): void {
      var pcm = fakePcm16(1000);
      var wav = RecorderAudio.wavFromPcm16(pcm, 16000, 1);
      expectEq(wav.length, 44 + pcm.length);
      expectEq(ascii(wav, 0, 4), "RIFF");
      expectEq(u32(wav, 4), 36 + pcm.length);
      expectEq(ascii(wav, 8, 8), "WAVEfmt ");
      expectEq(u32(wav, 16), 16);
      expectEq(wav[20] | (wav[21] << 8), 1, "WAVE_FORMAT_PCM");
      expectEq(wav[22] | (wav[23] << 8), 1, "channels");
      expectEq(u32(wav, 24), 16000, "sample rate");
      expectEq(u32(wav, 28), 32000, "byte rate");
      expectEq(wav[32] | (wav[33] << 8), 2, "block align");
      expectEq(wav[34] | (wav[35] << 8), 16, "bits per sample");
      expectEq(ascii(wav, 36, 4), "data");
      expectEq(u32(wav, 40), pcm.length);
    });

    it("passes the PCM through byte for byte", function (): void {
      var pcm = fakePcm16(50);
      var wav = RecorderAudio.wavFromPcm16(pcm, 16000, 1);
      for (var i = 0; i < pcm.length; i++) {
        if (wav[44 + i] !== pcm[i]) throw new Error("PCM altered at byte " + i);
      }
    });
  });

  describe("RecorderAudio — Opus probing", function (): void {

    it("reads frame duration and channel count from a packet's TOC", function (): void {
      var info = RecorderAudio.inspectOpusPacket(fakeOpusStream(40, 1));
      expectEq(info.frameMicros, 20000);
      expectEq(info.frameCount, 1);
      expectEq(info.durationMicros, 20000);
      expectEq(info.isStereo, false);
    });

    it("picks 40 bytes for a 40-byte CBR stream and reports it clean", function (): void {
      var guess = RecorderAudio.guessPacketSize(fakeOpusStream(40, 200), [40, 80]);
      expectEq(guess.packetBytes, 40);
      expectEq(guess.packets, 200);
      expectEq(guess.remainder, 0);
      expectEq(guess.clean, true);
      expectEq(guess.channels, 1);
      expectEq(guess.frameMicros, 20000);
    });

    it("picks 80 bytes for an 80-byte stream that 40 cannot explain", function (): void {
      // 80-byte packets whose midpoint is NOT a valid TOC, so the 40 candidate
      // is rejected on the bitstream rather than by luck of divisibility.
      var packets = 30;
      var stream = new Uint8Array(80 * packets);
      for (var p = 0; p < packets; p++) {
        var base = p * 80;
        stream[base] = OPUS_TOC_WB_20MS_MONO;
        for (var i = 1; i < 80; i++) stream[base + i] = 0xff;
        // config 31 @ code 3 with frameCount 0 is invalid → inspect returns null
        stream[base + 40] = 0xff;
        stream[base + 41] = 0x00;
      }
      var guess = RecorderAudio.guessPacketSize(stream, [40, 80]);
      expectEq(guess.packetBytes, 80);
      expectEq(guess.clean, true);
    });

    it("slices only whole packets, ignoring a partial tail", function (): void {
      var packets = RecorderAudio.sliceBarePackets(fakeOpusStream(40, 3).subarray(0, 110), 40);
      expectEq(packets.length, 2);
      expectEq(packets[0].length, 40);
    });
  });

  describe("RecorderAudio — Ogg Opus", function (): void {

    // Independent re-implementation of the Ogg CRC, so a bug in the production
    // table cannot validate itself.
    function verifyCrc(page: Uint8Array): boolean {
      var stored = (page[22] | (page[23] << 8) | (page[24] << 16) | (page[25] << 24)) >>> 0;
      var copy = new Uint8Array(page.length);
      copy.set(page);
      copy[22] = 0; copy[23] = 0; copy[24] = 0; copy[25] = 0;
      var crc = 0;
      for (var i = 0; i < copy.length; i++) {
        crc = (crc ^ (copy[i] << 24)) >>> 0;
        for (var b = 0; b < 8; b++) {
          crc = ((crc & 0x80000000) !== 0 ? ((crc << 1) ^ 0x04c11db7) : (crc << 1)) >>> 0;
        }
      }
      return (crc >>> 0) === stored;
    }

    function pages(bytes: Uint8Array): Uint8Array[] {
      var out: Uint8Array[] = [];
      var off = 0;
      while (off + 27 <= bytes.length) {
        if (!(bytes[off] === 0x4f && bytes[off + 1] === 0x67 && bytes[off + 2] === 0x67 && bytes[off + 3] === 0x53)) {
          throw new Error("no OggS magic at offset " + off);
        }
        var segCount = bytes[off + 26];
        var payload = 0;
        for (var i = 0; i < segCount; i++) payload += bytes[off + 27 + i];
        var total = 27 + segCount + payload;
        out.push(bytes.subarray(off, off + total));
        off += total;
      }
      if (off !== bytes.length) throw new Error("trailing bytes after the last page");
      return out;
    }

    function ascii(b: Uint8Array, off: number, len: number): string {
      var s = "";
      for (var i = 0; i < len; i++) s += String.fromCharCode(b[off + i]);
      return s;
    }

    it("produces a well-formed stream: headers, pages, flags, CRCs", function (): void {
      var stream = fakeOpusStream(40, 250);   // 5 s
      var packets = RecorderAudio.sliceBarePackets(stream, 40);
      var ogg = RecorderAudio.oggOpusFromPackets(packets, 16000, 1, 20000, 0x51565253);
      expectEq(ogg.packets, 250);
      expectEq(ogg.durationMs, 5000);

      var ps = pages(ogg.bytes);
      expectGt(ps.length, 2, "expected header pages plus audio pages");

      // Page 0: BOS, OpusHead.
      expectEq(ps[0][5], 0x02, "first page must set the BOS flag");
      expectEq(ascii(ps[0], 28, 8), "OpusHead");
      expectEq(ps[0][28 + 9], 1, "channel count in OpusHead");

      // Page 1: OpusTags.
      expectEq(ascii(ps[1], 28, 8), "OpusTags");

      // Last page: EOS.
      expectEq(ps[ps.length - 1][5], 0x04, "last page must set the EOS flag");

      // Every page's CRC must verify, and page sequence must be contiguous.
      for (var i = 0; i < ps.length; i++) {
        if (!verifyCrc(ps[i])) throw new Error("bad CRC on page " + i);
        var seq = (ps[i][18] | (ps[i][19] << 8) | (ps[i][20] << 16) | (ps[i][21] << 24)) >>> 0;
        expectEq(seq, i, "page sequence number");
      }
    });

    it("advances granule position at 48 kHz regardless of the decode rate", function (): void {
      var packets = RecorderAudio.sliceBarePackets(fakeOpusStream(40, 50), 40);
      var ogg = RecorderAudio.oggOpusFromPackets(packets, 16000, 1, 20000, 1);
      var ps = pages(ogg.bytes);
      var last = ps[ps.length - 1];
      var granule = (last[6] | (last[7] << 8) | (last[8] << 16) | (last[9] << 24)) >>> 0;
      // 312 pre-skip + 50 packets x 20 ms x 48 samples/ms.
      expectEq(granule, 312 + 50 * 960);
    });

    it("refuses to mux an empty packet list rather than emitting a bad file", function (): void {
      var threw = false;
      try { RecorderAudio.oggOpusFromPackets([], 16000, 1, 20000, 1); } catch (_e: any) { threw = true; }
      expectTrue(threw);
    });
  });

  // ── 11. the sidecar upload seam ───────────────────────────────────────────
  //
  // The bytes reach the engine through the recorder-asr-shim sidecar because
  // Goja cannot put binary on an HTTP request. These cover the seam: audio must
  // be base64 (the only representation that survives nk.httpRequest), an
  // unusable shim must be reported rather than swallowed, and an engine error
  // must not be mistaken for a transcript.

  describe("sidecar upload seam", function (): void {

    it("sends audio as base64 in JSON, never as a binary body", function (): void {
      var nk = makeMockNk();
      var a = openSession(nk, USER_A);
      push(nk, USER_A, a.session_id, 0, fakePcm16(1000));
      close(nk, USER_A, a.session_id);

      // The healthz probe plus one transcribe call.
      var calls = nk._http;
      expectGt(calls.length, 1, "expected a health probe and a transcribe call");
      var upload = calls[calls.length - 1];
      expectTrue(("" + upload.url).indexOf("/transcribe") > 0, upload.url);
      expectEq(upload.headers["Content-Type"], "application/json");

      var body = JSON.parse(upload.body);
      expectEq(body.content_type, "audio/wav");
      expectEq(body.filename, "capture.wav");
      expectEq(body.language, "en", "en_US must be reduced to the bare subtag");
      // Base64 alphabet only: proof nothing binary is on the wire.
      expectTrue(/^[A-Za-z0-9+/]+={0,2}$/.test(body.audio_b64), "audio_b64 is not pure base64");
      // And it must decode back to a real WAV.
      var decoded = new Uint8Array(nk.base64Decode(body.audio_b64));
      expectEq(String.fromCharCode(decoded[0], decoded[1], decoded[2], decoded[3]), "RIFF");
    });

    it("labels a bare-opus session as Ogg for the shim", function (): void {
      var nk = makeMockNk();
      var a = openSession(nk, USER_A, {
        client_session_id: "cli_shim_opus",
        audio: { codec: "opus", sample_rate_hz: 16000, channels: 1, frame_ms: 20 },
      });
      push(nk, USER_A, a.session_id, 0, fakeOpusStream(40, 100));
      close(nk, USER_A, a.session_id);

      var body = JSON.parse(nk._http[nk._http.length - 1].body);
      expectEq(body.content_type, "audio/ogg");
      expectEq(body.filename, "capture.opus.ogg");
      var decoded = new Uint8Array(nk.base64Decode(body.audio_b64));
      expectEq(String.fromCharCode(decoded[0], decoded[1], decoded[2], decoded[3]), "OggS");
    });

    it("reports ENDPOINT_UNAVAILABLE at open when the shim is absent", function (): void {
      var nk = makeMockNk();
      nk._shimUp = false;
      var resp = openSession(nk, USER_A);
      expectEq(resp.error.code, "ENDPOINT_UNAVAILABLE");
      expectTrue(("" + resp.error.message).indexOf("recorder-asr-shim") >= 0, resp.error.message);
      expectEq(nk._count("recorder_asr_sessions", USER_A), 0,
        "no session may be opened when the audio cannot be delivered");
    });

    it("drops an engine repetition artifact but keeps short real fragments", function (): void {
      // The measured artifact: the same 95-char sentence returned three times
      // with 240/80/80 ms durations. Anything at that density is not speech.
      var loop = "6. If this is the case, the overlap prevents a sentence from being cut in half at the seam.";
      expectTrue(RecorderAsrProvider.isRepetitionArtifact(loop, 240), "240ms for 90 chars is impossible");
      expectTrue(RecorderAsrProvider.isRepetitionArtifact(loop, 80), "80ms for 90 chars is impossible");
      expectEq(RecorderAsrProvider.isRepetitionArtifact(loop, 6000), false,
        "the same sentence at a real speaking rate must survive");
      // Short fragments are exempt: a real "4." can legitimately be brief.
      expectEq(RecorderAsrProvider.isRepetitionArtifact("4.", 80), false);
      expectEq(RecorderAsrProvider.isRepetitionArtifact("Six.", 100), false);
      // A zero-duration segment carrying a sentence is always an artifact.
      expectTrue(RecorderAsrProvider.isRepetitionArtifact(loop, 0));
    });

    it("filters a repetition artifact out of the segments a push returns", function (): void {
      var nk = makeMockNk();
      var loop = "5. The overlap prevents a sentence from being cut in half at the seam.";
      nk._asrQueue = [[
        { start: 0.0, end: 4.0, text: " " + loop },
        // Two zero-width repeats, exactly as the engine produced them live.
        { start: 4.0, end: 4.08, text: " " + loop },
        { start: 4.08, end: 4.16, text: " " + loop },
      ]];
      var a = openSession(nk, USER_A);
      var resp = push(nk, USER_A, a.session_id, 0, fakePcm16(2000), true);
      expectEq(resp.segments.length, 1, "the two impossible repeats must not reach the client");
      expectEq(resp.segments[0].is_final, true);
    });

    it("refuses a seq gap wide enough to make server work unbounded", function (): void {
      // acked_seq comes from the client and feeds a dense key range in both
      // readWindowBytes (one read per seq) and deleteChunks (one delete per
      // seq). Measured on a live local server: acked_seq=91736 produced a
      // 91,737-key delete that took 42 s in one transaction, past Nakama's
      // socket write timeout. A larger seq is unbounded memory.
      var nk = makeMockNk();
      var a = openSession(nk, USER_A);
      push(nk, USER_A, a.session_id, 0, fakePcm16(200));

      var far = push(nk, USER_A, a.session_id, 2000000000, fakePcm16(200));
      expectEq(far.error && far.error.code, "RATE_LIMITED",
        "a 2-billion seq jump must be refused");

      // The record must be untouched, or the next reclaim inherits the range.
      var rec = nk.storageRead([{ collection: "recorder_asr_sessions", key: a.session_id, userId: USER_A }])[0].value;
      expectEq(rec.acked_seq, 0, "a refused push must not move acked_seq");

      // A gap the client can legitimately produce still works: backpressure
      // drops the oldest queued chunk while sequence numbers keep counting.
      var ok = push(nk, USER_A, a.session_id, 40, fakePcm16(200));
      expectTrue(!!ok, "a modest gap is normal and must be accepted");
      rec = nk.storageRead([{ collection: "recorder_asr_sessions", key: a.session_id, userId: USER_A }])[0].value;
      expectEq(rec.acked_seq, 40);
    });

    it("bounds the chunk walk for a record already poisoned in storage", function (): void {
      // Records written before the cap above are still in storage, and one of
      // them must not be able to hang a sweep.
      var nk = makeMockNk();
      var a = openSession(nk, USER_A);
      push(nk, USER_A, a.session_id, 0, fakePcm16(200));
      var key = { collection: "recorder_asr_sessions", key: a.session_id, userId: USER_A };
      var rec = nk.storageRead([key])[0].value;
      rec.acked_seq = 91736;           // exactly what was seen live
      rec.updated_at = rec.created_at - 999999;
      rec.expires_at = 1;
      nk.storageWrite([{
        collection: key.collection, key: key.key, userId: USER_A, value: rec,
        permissionRead: 0, permissionWrite: 0,
      }] as any);

      var deletesBefore = nk._deleteKeyCount;
      RecorderAsr.sweep(nk as any, logger(), 100);
      var issued = nk._deleteKeyCount - deletesBefore;
      // 4096 for the walk, +1 for the highest seq (which certainly exists), and
      // a couple for the session and index rows. Emphatically not ~91,737.
      expectTrue(issued <= 4200,
        "issued " + issued + " delete keys; the walk must be bounded, not 91,737");
      expectEq(nk.storageRead([key]).length, 0, "the session must still be reclaimed");
    });

    it("caps deletions per sweep and resumes on the same page next call", function (): void {
      // Deleting is the expensive half of the sweep — one storage delete per
      // chunk sequence number per session — and Nakama closes the connection
      // at socket.write_timeout_ms (10 s by default). Measured: 8 reclamations
      // put the RPC past 25 s, so the work completed but the answer was lost.
      var nk = makeMockNk();
      var expired: string[] = [];
      for (var u = 0; u < 12; u++) {
        var uid = "1111aaaa-0000-4000-8000-00000000" + (1000 + u);
        var s = openSession(nk, uid);
        expired.push(uid + "|" + s.session_id);
        // Age it past SESSION_IDLE_TTL_SECONDS.
        var key = { collection: "recorder_asr_sessions", key: s.session_id, userId: uid };
        var rec = nk.storageRead([key])[0].value;
        rec.updated_at = rec.created_at - 999999;
        rec.expires_at = 1;
        nk.storageWrite([{
          collection: key.collection, key: key.key, userId: uid, value: rec,
          permissionRead: 0, permissionWrite: 0,
        }] as any);
      }

      var first = RecorderAsr.sweep(nk as any, logger(), 100);
      expectEq(first.budgetExhausted, true, "12 expired sessions must not go in one call");
      expectTrue(first.removed > 0 && first.removed <= 5,
        "removed " + first.removed + " must respect the per-run cap of 5");
      expectEq(first.wrapped, false, "a budgeted stop is not a completed lap");

      // Successive calls must keep making progress, not repeat the same work.
      var totalRemoved = first.removed;
      var calls = 1;
      var last = first;
      while (last.budgetExhausted && calls < 10) {
        last = RecorderAsr.sweep(nk as any, logger(), 100);
        totalRemoved += last.removed;
        calls++;
      }
      expectEq(last.budgetExhausted, false, "the loop must terminate");
      expectEq(totalRemoved, 12, "every expired session must eventually be reclaimed");
      // And nothing is left behind.
      var remaining = RecorderAsr.sweep(nk as any, logger(), 100);
      expectEq(remaining.removed, 0);
      expectEq(remaining.wrapped, true, "a clean pass over an empty backlog wraps");
    });

    it("refuses at open when the shim is up but cannot reach the engine", function (): void {
      // The failure mode this exists to prevent: a shim that is running while
      // the engine is unreachable. Reporting available there would take away the
      // client's on-device fallback and hand the user silence, which is worse
      // than failing. `ok` comes from the shim's own engine probe, so an
      // answering-but-unusable shim must still be unavailable.
      var nk = makeMockNk();
      var real = (nk as any).httpRequest;
      (nk as any).httpRequest = function (url: string, m: string, h: any, b: string, t: number): any {
        if (("" + url).indexOf("/healthz") > 0) {
          return {
            code: 200, headers: {},
            body: JSON.stringify({
              ok: false, base_url_set: true,
              reason: "/health unreachable at http://voice-pipeline-stt:8000",
            }),
          };
        }
        return real(url, m, h, b, t);
      };
      var resp = openSession(nk, USER_A);
      expectEq(resp.error.code, "ENDPOINT_UNAVAILABLE");
      expectTrue(("" + resp.error.message).indexOf("unreachable") >= 0,
        "the shim's own reason should reach the operator: " + resp.error.message);
      expectEq(nk._count("recorder_asr_sessions", USER_A), 0);
    });

    it("treats an engine error envelope as a failure, not an empty transcript", function (): void {
      var nk = makeMockNk();
      nk._asrCode = 500;
      var a = openSession(nk, USER_A);
      push(nk, USER_A, a.session_id, 0, fakePcm16(1200), true);
      var rec = nk.storageRead([{ collection: "recorder_asr_sessions", key: a.session_id, userId: USER_A }])[0].value;
      expectEq(rec.transcribed_ms, 0, "a failed engine call must not advance the watermark");
      expectEq(rec.segments.length, 0);
    });
  });

  // ── Runner entry ──────────────────────────────────────────────────────────

  export function runAll(): { passed: number; failed: number; errors: string[]; total: number } {
    var passed = 0;
    var errors: string[] = [];
    for (var i = 0; i < allTests.length; i++) {
      var t = allTests[i];
      try {
        t.fn();
        passed++;
      } catch (e: any) {
        errors.push("[" + t.suite + "] " + t.name + " — " + (e && e.message ? e.message : String(e)));
      }
    }
    return { passed: passed, failed: errors.length, errors: errors, total: allTests.length };
  }
}
