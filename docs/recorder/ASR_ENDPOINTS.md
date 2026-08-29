# Curio Recorder ASR endpoints

`recorder_asr_open` / `recorder_asr_push` / `recorder_asr_close`, plus
`recorder_asr_purge` and `recorder_asr_gc`.

Source: `data/modules/src/recorder/recorder_asr.ts`,
`recorder_asr_provider.ts`, `recorder_audio.ts`.
Registered from `data/modules/src/main.ts` and present in the built
`data/modules/index.js`.

The caller is the QuizVerse Flutter app,
`lib/features/recorder/data/recorder_asr_transport.dart`. **That client is the
contract.** Where `docs/device-pen/30-CLOUD-ENDPOINT-CONTRACTS.md` in the Flutter
repo disagrees with it, the client wins — that document predates the finished
client.

---

## Status — read this first

The three RPCs are built, registered, and answer the client's call shape, and
**transcription works.** A recording becomes text end to end.

Proven 2026-08-28 against a real engine — `fedirz/faster-whisper-server:latest-cpu`
running `Systran/faster-whisper-small.en`, not a stub — for both codecs:

- `pcm16` → WAV and bare `opus` → Ogg Opus both returned complete, correctly
  ordered transcripts of a 30 s six-sentence script, no text lost and none
  duplicated at a window seam.
- Every container Nakama produced was verified independently of ffmpeg: all WAV
  header fields recomputed from the payload, and every Ogg page CRC, lacing
  value and granule recomputed and matched exactly.

Harness, exact commands and full results: `scripts/recorder-asr-e2e/README.md`.

**Nothing is transcribed in production yet** — the sidecar the transport depends
on has not been deployed. Until it is, `recorder_asr_open` answers
`ENDPOINT_UNAVAILABLE` and clients fall back to on-device speech, which is the
current behaviour and is correct. Deployment steps:
`deploy/recorder-asr-shim/README.md`.

---

## Transport: why there is a sidecar

Transcription requires POSTing `multipart/form-data` containing an audio
container to the engine, and the Nakama JavaScript runtime cannot send a binary
body at all.

`nk.httpRequest` accepts only a string body, and the only route from bytes to a
string is `nk.binaryToString`, which refuses anything that is not valid UTF-8:

```go
// server/runtime_javascript_nakama.go:334
if !utf8.Valid(data.Bytes()) {
    panic(r.NewTypeError("expects data to be UTF-8 encoded"))
}
```

Audio containers fail that check essentially always. Verified against a live
local Nakama: **every** upload attempt, for both codecs, logged
`[RecorderAsr] provider failed: expects data to be UTF-8 encoded`.

The engine takes multipart only — both audio routes declare
`file: Annotated[UploadFile, Form()]`. Its OpenAPI also advertises
`application/x-www-form-urlencoded`, but that is a FastAPI schema artefact of
`Form()` with `UploadFile`: Starlette dispatches on the real `Content-Type`, and
a urlencoded body hands the handler a UTF-8-decoded string and mangles the
audio. There is no ASCII path to the engine.

So the audio crosses to a **loopback sidecar** as base64 inside JSON — pure
ASCII, which survives the Go string conversion byte for byte, and
`nk.base64Encode` takes an `ArrayBuffer` directly with no UTF-8 check — and the
sidecar rebuilds a real multipart upload. Shape, rationale and the alternative
that was rejected: `deploy/recorder-asr-shim/README.md`.

### The base64 round trip is not avoidable

The client already sends base64 and the engine only accepts binary multipart, so
it is worth asking whether the bytes could pass straight through. They cannot,
for either codec, because the server has to **containerise** between the two:

- `pcm16` needs a 44-byte WAV header prepended. Headerless PCM is the one format
  the engine's PyAV/ffmpeg path rejects.
- bare `opus` packets need wrapping in Ogg — pages, lacing, CRCs and granules
  computed over the packet bytes.

Both require real bytes, and both change them, so `base64Decode` → mux →
`base64Encode` is the minimal path. The only round trip that *was* removed is
the one inside the provider: it no longer decodes the muxed container back to a
string.

### Availability, and why a false "available" is impossible

The client falls back to on-device speech *only* on `ENDPOINT_UNAVAILABLE` from
`open`. Reporting availability while unable to transcribe is therefore worse
than failing — it yields silence instead of a working local transcript.

`isAvailable()` probes the sidecar's `/healthz` and requires `ok === true`. The
sidecar answers `ok` only after a live request to the engine's `/health` (or
`/v1/models`) succeeded within the last 5 s, so the signal means "a recording
can become text", not "the shim process is up". `unavailableReason()` names
which link broke.

Measured against each broken topology (2026-08-28) — all four refuse, none
hangs:

| Topology | `open` answers | Latency |
|---|---|---|
| shim up, engine up | accepts | 0.1 s |
| engine stopped, shim up | `ENDPOINT_UNAVAILABLE` | 0.2 s |
| shim stopped | `ENDPOINT_UNAVAILABLE` | 0.2 s |
| shim accepts TCP but never replies | `ENDPOINT_UNAVAILABLE` | 4.1 s |

The last row is why `HEALTH_PROBE_TIMEOUT_MS` is 2,000 and not more: the refusal
path probes twice (once to decide, once to explain), and the total has to stay
well under Nakama's 10 s socket write timeout. An `open` that never answers
costs the client its fallback exactly as a false "available" does.

`canSendBinary()` has been removed. It probed a capability the runtime does not
have — it would have failed permanently in sidecar mode — and it never measured
whether transcription could actually happen.

---

## RPCs

All five are authenticated Nakama RPCs. `ctx.userId` must be present; there is
no HTTP-key path.

Errors are returned **in the response body with HTTP 200**, as
`{"error":{"code":"…","message":"…"}}`. This is what the client expects: it
distinguishes "the server said no" from "the RPC is not registered" by
inspecting the body, and a Nakama runtime error would instead be classified from
exception text.

Success responses are **flat** — `{"session_id": …}`, not the repo's usual
`{success, data}` wrapper — because the client reads `data['session_id']` off
the top level.

### `recorder_asr_open`

Starts or resumes a session.

```jsonc
{
  "contract_version": "2026-08-27",
  "locale": "en_US",
  "audio": { "codec": "opus", "sample_rate_hz": 16000, "channels": 1, "frame_ms": 20 },
  "binding_token": "…",        // optional; stored only as a 12-char SHA-256 prefix
  "device_record_id": "…",     // optional
  "client_session_id": "…",    // optional but strongly recommended — enables resume
  "age_assertion": {           // optional today; see Age assertion below
    "bracket": "at_or_above_threshold",
    "min_age": 13,
    "declared_at": "2026-08-28T00:00:00Z"
  }
}
```

Response: `{"session_id": "asr_srv_…", "resume_from_seq": 0}`

Re-opening with a `client_session_id` that maps to a still-open session returns
that same `session_id` and `resume_from_seq = acked_seq + 1`, so a reconnect
continues one transcript instead of starting a second.

Validation: `codec` ∈ {`pcm16`, `opus`}; `sample_rate_hz` ∈ {8000, 12000, 16000,
24000, 48000}; `channels` ∈ {1, 2}; `frame_ms` ∈ {2, 5, 10, 20, 40, 60}.

### `recorder_asr_push`

```jsonc
{ "contract_version": "…", "session_id": "…", "seq": 0, "is_last": false, "audio_b64": "…" }
```

Response: `{"acked_seq": 0, "segments": [ … ]}`

Segments are `{text, begin_ms, end_ms, is_final}`; the client also reads an
optional `speaker_id`, which this server does not emit.

`seq` is a per-session counter from 0. A `seq` at or below `acked_seq` is a
replay and is **ignored** — the audio is not appended twice. A forward jump in
`seq` is expected, not an error: the client's backpressure drops the oldest
queued chunk on overflow while sequence numbers keep incrementing.

### `recorder_asr_close`

```jsonc
{ "contract_version": "…", "session_id": "…" }
```

Response: `{"acked_seq": 11, "segments": [ … ]}` — trailing segments only.

Idempotent: a repeated close returns the same trailing segments and does not
re-transcribe or create a second transcript. All remaining audio is deleted.

### `recorder_asr_purge`

No payload. Deletes every ASR session, chunk and index entry owned by the
caller. Idempotent. Returns `{"purged_sessions": n}`.

### `recorder_asr_gc`

Service-only maintenance sweep across all accounts. Requires
`{"service_token": "<RECORDER_ASR_GC_TOKEN>"}`. Returns
`{"swept": n, "scanned": n, "wrapped": bool}`.

**If `RECORDER_ASR_GC_TOKEN` is unset, this RPC refuses every call**, which is
the safe default — with no token it would be an unauthenticated global delete.
The variable was set in no environment, so this RPC had never run anywhere and
retention had never been enforced. Nakama's JS runtime has no scheduler, so it
needs an external trigger: `k8s/recorder-asr-cronjob.yaml` (every 15 minutes,
same shape as `k8s/analytics-cronjob.yaml`). The token must be a `secretKeyRef`
*and* be named in a `--runtime.env` flag — see
`deploy/recorder-asr-shim/README.md` § The GC token.

`wrapped` is the operational signal. The sweep pages `GC_SCAN_LIMIT` sessions at
a time for `GC_PAGES_PER_RUN` pages and **persists its cursor**, so successive
ticks cover the whole keyspace and `wrapped: true` means a full lap finished. If
it is `false` on every run, the schedule is not keeping up.

The cursor previously was not persisted: every run restarted at the beginning of
key order, and bounded at 5 pages it could never reach an expired session beyond
the first 500 objects. On a server with more session records than that,
reclamation was mathematically unable to make progress no matter how often it
ran.

`open` no longer triggers a global sweep. It reclaims only the **caller's own**
expired sessions, in the same listing that counts them for the concurrency cap,
and that now runs *after* the cheap checks — a user at their cap used to pay for
a 500-object cross-account scan on every rejected call.

### Error codes

Only these are recognised by the client's `RegistrationErrorCode.fromWire`;
anything else becomes `internal`, which the client treats as **retryable**.

| Code | Meaning | Client behaviour |
|---|---|---|
| `ENDPOINT_UNAVAILABLE` | No ASR backend, or the runtime cannot upload audio | Permanent for the run; falls back to on-device speech |
| `UNAUTHENTICATED` | No Nakama session, or the age gate refused | Not retried |
| `DEVICE_NOT_FOUND` | No such session for this account | Not retried |
| `RATE_LIMITED` | Session/chunk/byte cap hit | Retried with backoff |
| `INTERNAL` | Malformed payload, bad codec, oversized chunk, closed session | Retried with backoff |

`DEVICE_NOT_FOUND` for a missing *ASR session* is a slight misnomer, but it is
the only non-retryable "not there" code the client has, and non-retryable is the
correct classification.

---

## Audio wire format

Established from the client, not assumed. `DeviceAudioDecode` picks the route at
startup by probing for libopus:

- **`pcm16`** — 16 kHz mono signed 16-bit LE. Sent when `FfiPenOpusDecoder`
  loads, i.e. the handset decoded the pen's Opus itself. Muxed here into WAV.
- **`opus`** — bare, back-to-back Opus packets, no container, no length prefix.
  Sent when libopus is unavailable, and also the format used before the probe
  resolves. Muxed here into Ogg Opus.

The server never receives Ogg Opus from the client, and it never *decodes* Opus
— only containerises it. That is the right call regardless of the blocker above:
Goja has no FFI and no Node APIs, so server-side Opus decode is impossible at
any price.

Chunks are **not packet-aligned**: the client packs whole BLE payloads into a
~4300-byte window and a BLE notification is not an Opus packet boundary. The
server therefore tracks absolute byte offsets and re-aligns to packet boundaries
itself. The bare-Opus packet size (40 bytes on the pnote pen, 80 on the RCSP
family) is not sent by the client and is probed from the bitstream's TOC bytes.

### Client gap (report only — no client change was made)

`AsrSessionRequest.toJson()` sends no `audio.packet_bytes` and no
`age_assertion`. Both are optional here. Adding `packet_bytes` would let the
server skip the probe; adding `age_assertion` is what allows the age gate to be
switched to fail-closed.

---

## Limits

| Limit | Value | Notes |
|---|---|---|
| `MAX_PUSH_B64_CHARS` | 160,000 | Must stay below Nakama's `socket.max_request_size_bytes` (default 262,144, covering the whole request). Measured effective ceiling ~261,900; the client's largest real chunk is ~91,700. |
| `MAX_SESSION_BYTES` | 24 MiB | ~12.5 min of 16 kHz mono PCM16. Stored base64, so ~32 MiB of storage. |
| `MAX_CHUNKS_PER_SESSION` | 4,096 | |
| `MAX_OPEN_SESSIONS_PER_USER` | 3 | Counted over the first storage page only (50 objects); see Known limitations. |
| `SESSION_IDLE_TTL_SECONDS` | 3,600 | An untouched open session is swept. |
| `WINDOW_MS` / `OVERLAP_MS` / `MAX_CALL_MS` | 8,000 / 1,200 / 20,000 | Keeps any single RPC inside Nakama's 10 s write timeout. |

Exceeding the push size returns `INTERNAL` in-band. Do not raise the limit above
the transport ceiling: Nakama then rejects the request as HTTP 400 "request body
too large", which the client classifies as `internal` — *retryable* — and would
retry an oversized chunk forever.

---

## Retention

- **Audio is deleted as it is consumed.** Chunks behind the transcription
  watermark (minus the overlap the next window needs) are deleted on every
  push; every remaining chunk is deleted at close. No audio survives a session.
- **Transcripts** live on the session record for
  `RECORDER_ASR_TRANSCRIPT_TTL_SECONDS`, **default 86,400 (24 h)**, so a retried
  close stays idempotent. Set to `0` to keep nothing at all: close then deletes
  the session immediately and a retried close returns no segments, which the
  client tolerates.
- **Abandoned sessions** expire after `SESSION_IDLE_TTL_SECONDS` and are removed
  by the sweep — which requires either traffic on `recorder_asr_open` or the
  `recorder_asr_gc` cron. Without the cron, retention is best-effort.
- Session records are written with `permissionRead: 1`, so the owning user can
  read their own session — including its transcript — through Nakama's storage
  API. Audio chunks are `permissionRead: 0` and are never client-readable.

---

## Age assertion (COPPA)

A child's voice recording is personal information under 16 CFR 312.2(8), and
there is no verifiable parental consent anywhere in this product.

The client is the primary enforcement point: it blocks
`AgeRestrictedCapability.audioCapture` before a recording can start. This
endpoint is the backstop.

Behaviour of `recorder_asr_open`:

| `age_assertion.bracket` | Result |
|---|---|
| `at_or_above_threshold` | Accepted |
| `below_threshold` | **Refused** — `UNAUTHENTICATED` |
| anything unrecognised → `unknown` | **Refused** — `UNAUTHENTICATED` |
| absent, with `RECORDER_ASR_REQUIRE_AGE_ASSERTION=1` | **Refused** |
| absent, otherwise | **Accepted**, logged at `warn` |

### This gate currently fails OPEN, and that is a real exposure

`RECORDER_ASR_REQUIRE_AGE_ASSERTION` **defaults to `0`**, and the shipped client
sends no `age_assertion` field at all. So in production *every* session takes
the last row: admitted with unverified age. Confirmed against a live server —
an open with the exact shipped client payload succeeded and logged
`age=absent`.

Every such admission is now logged at `warn` so it is visible in ops rather than
only in a comment, but logging is not enforcement.

To close it — an owner decision, because it is a coordinated change:

1. Add `age_assertion` to `AsrSessionRequest.toJson()` in the Flutter client.
2. Ship that client.
3. Set `RECORDER_ASR_REQUIRE_AGE_ASSERTION=1`.

Setting the flag to `1` before step 2 refuses **all** ASR sessions. The default
was left at `0` rather than flipped unilaterally for that reason; flipping it is
the intended end state.

---

## Provider configuration

The engine-facing settings moved to the sidecar with the multipart request that
uses them. Nakama itself now knows only where the sidecar is.

Read by the **Nakama** container:

| Env var | Default | Purpose |
|---|---|---|
| `RECORDER_ASR_SHIM_URL` | `http://127.0.0.1:7359` | The loopback sidecar. |
| `RECORDER_ASR_ENABLED` | `1` | `0` is the operator kill switch; `open` then reports it by name. |
| `RECORDER_ASR_TIMEOUT_MS` | `9000` | Must stay under Nakama's 10 s write timeout. |
| `RECORDER_ASR_TRANSCRIPT_TTL_SECONDS` | `86400` | `0` = keep nothing. |
| `RECORDER_ASR_REQUIRE_AGE_ASSERTION` | `0` | See above. |
| `RECORDER_ASR_GC_TOKEN` | *(empty)* | Required for `recorder_asr_gc`. `secretKeyRef` only. |

Read by the **sidecar** — `RECORDER_ASR_BASE_URL`, `_MODEL`, `_API_KEY`,
`_TIMEOUT_MS`, `_SHIM_LISTEN`, `_SHIM_MAX_AUDIO_BYTES`, `_SHIM_HEALTH_TTL_MS`,
`_SHIM_DUMP_DIR`. Documented in `deploy/recorder-asr-shim/README.md`.

Configuration traps:

- **Nakama's JS runtime only sees variables passed as `--runtime.env`.** Setting
  an OS environment variable on the pod is **not** enough — `ctx.env` will be
  empty and every default applies, including the empty GC token.
  `docker-compose.yml` whitelists the `RECORDER_ASR_*` keys in
  `RUNTIME_ENV_KEYS`; the k8s Deployment needs the equivalent args, which is
  step 3 of the shim README.
- **The shim URL default is non-empty**, so the provider always has somewhere to
  point. That is safe now only because availability is measured by probing it:
  if nothing is listening, `isAvailable()` is false and `open` says so.
- **`RECORDER_ASR_BASE_URL=""` still cannot disable the provider through
  compose**, because compose skips empty values when building `--runtime.env`
  flags. It reaches the *sidecar* as a plain env var, though, where an
  explicitly empty value does turn the engine path off — so the switch works
  there. On the Nakama side use `RECORDER_ASR_ENABLED=0` instead.

No new credential is needed for the engine: it declares no security schemes and
is ClusterIP with no ingress. The one new credential the feature needs is
`RECORDER_ASR_GC_TOKEN`.

---

## Known limitations

- **Not deployed.** The sidecar is prepared but has not been applied to any
  cluster, so production still answers `ENDPOINT_UNAVAILABLE`.
- **The engine hallucinates on window boundaries.** Observed live on the Ogg
  path: the same 95-character sentence returned three times with 240/80/80 ms
  durations. `RecorderAsrProvider.isRepetitionArtifact` drops segments implying
  more than 60 characters per second (conversational English is ~15-17, very
  fast speech ~25) and logs `dropped_repetitions=N`. This is a rate test, so a
  short real fragment is unaffected, but it is a heuristic against engine
  behaviour rather than a fix for it.
- A crash between `deleteChunks` and `writeSession` inside a push loses that
  audio (the next window finds it missing and advances past it). It cannot
  duplicate transcript text, only drop it.
- `readWindowBytes` issues one storage read per sequence number from
  `first_chunk_seq` to `acked_seq`, and `deleteChunks` one delete per sequence
  number. Both ranges are now bounded at `MAX_CHUNKS_PER_SESSION`, and
  `recorder_asr_push` refuses a seq gap wider than that, because `acked_seq` is
  client-supplied and previously had no ceiling — one push with a large `seq`
  made both loops arbitrarily expensive. Found live: a session reached
  `acked_seq = 91736` and the resulting 91,737-key delete took 42 s in a single
  transaction, past Nakama's socket write timeout. Records already in storage
  with a wide range are reclaimed by the bounded walk plus the highest seq, so
  a chunk row sitting in the sparse middle of such a range can be missed.

---

## Verifying locally

```bash
cd data/modules && npm run build          # npx tsc + postbuild
grep -c '"recorder_asr_open"' index.js    # must be > 0
node src/recorder/__tests__/run.js        # 69 unit tests

cd ../..
# A real engine on the host. The stub proves the transport, not the muxing.
docker run --rm -d -p 8799:8000 fedirz/faster-whisper-server:latest-cpu

RECORDER_ASR_BASE_URL=http://host.docker.internal:8799 \
RECORDER_ASR_GC_TOKEN=local-dev-gc-token \
RECORDER_ASR_SHIM_DUMP_DIR=/tmp/asr-dump \
  docker compose up -d

docker compose logs nakama | grep RecorderAsr             # expect "registered"
docker compose logs recorder_asr_shim | grep listening    # expect the engine URL
```

For an actual transcript, and for the muxer verifiers, see
`scripts/recorder-asr-e2e/README.md`.

Note that Nakama loads **both** `data/modules/index.js` and
`data/modules/build/index.js`; editing one built artifact by hand and not the
other will not change behaviour.
