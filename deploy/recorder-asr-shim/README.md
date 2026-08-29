# recorder-asr-shim — EKS deployment

The base64→multipart bridge that lets the Curio recorder RPCs reach the speech
engine. Runs as a **sidecar in the `intelliverse-nakama` pod**, bound to
loopback.

**Nothing in this directory has been applied to any cluster.** These are
prepared manifests; the ordered commands are in [Deploy](#deploy).

## Why this process exists

The recorder RPCs (`recorder_asr_open` / `_push` / `_close`) are complete and
verified. The only thing they could not do was hand the assembled WAV or Ogg
Opus to the engine, and that is a hard limit of Nakama's JavaScript runtime, not
a missing library:

- `nk.httpRequest` takes the body as a Go string built from a JS string
  (`server/runtime_javascript_nakama.go` → `strings.NewReader`), so every code
  unit ≥ 0x80 is re-encoded as multi-byte UTF-8.
- `nk.binaryToString`, the only `ArrayBuffer`→string bridge, panics unless the
  buffer is valid UTF-8 (`runtime_javascript_nakama.go:334`). A WAV header or an
  Ogg page essentially never is. Every live upload attempt logged
  `expects data to be UTF-8 encoded`.

Goja has no FFI, no sockets and no filesystem, so there is no third option
inside the runtime. And the engine takes multipart only: both audio routes
declare `file: Annotated[UploadFile, Form()]`.

> The engine's OpenAPI also advertises `application/x-www-form-urlencoded`.
> That is a FastAPI schema artefact of `Form()` with `UploadFile`, not a usable
> ASCII path — Starlette dispatches on the real `Content-Type`, and a urlencoded
> body would hand the handler a UTF-8-decoded string and mangle the audio.

So the bytes cross to the sidecar as base64 (pure ASCII, survives
`nk.httpRequest` untouched; `nk.base64Encode` takes an `ArrayBuffer` and does no
UTF-8 check) and this process turns them back into a real multipart upload.

### Why a sidecar and not a fork change

Adding a native `httpRequestBinary` to the fork is ~5 lines in one
self-contained function. But the Nakama image is built from vendored Go source
via `Dockerfile.production` through CodeBuild, so every future ASR tweak would
ride a full server release. This is stdlib-only Python on a stock `python`
image, shipped as a ConfigMap: a tweak is a ConfigMap update and a pod restart.

Overhead is a rounding error. The engine runs ~2.7× realtime on one CPU pod, so
at saturation it ingests ~85 kB/s and base64 adds ~28 kB/s on a loopback hop.
`MAX_CALL_MS` caps one call at 20 s of audio ≈ 640 kB, so ~213 kB added.

### Why loopback

It binds `127.0.0.1`, so it is in no Service, no Ingress and declares no
`containerPort`. It is unreachable from outside the pod by construction. That is
what lets it carry no credential of its own and what stops it from becoming an
open transcription proxy.

## Layout

| File                        | Purpose                                                                       |
|-----------------------------|-------------------------------------------------------------------------------|
| `shim.py`                   | The whole service. Python stdlib only — no requirements file, no image build.  |
| `kustomization.yaml`        | Generates the `recorder-asr-shim` ConfigMap from `shim.py`, unhashed name.     |
| `nakama-sidecar-patch.yaml` | Strategic-merge patch adding the sidecar + env to the existing Deployment.     |
| `../../k8s/recorder-asr-cronjob.yaml` | The `recorder_asr_gc` retention CronJob.                            |

There is no `apply.sh` here, unlike `deploy/admin-dashboard`: that script exists
because of a fiddly Ingress JSON patch. These steps are plain `kubectl` and are
better read than wrapped.

## Contract

`POST /transcribe`

```json
{ "audio_b64": "...", "content_type": "audio/ogg", "filename": "capture.opus.ogg", "language": "en" }
```

Answers HTTP 200 with an envelope, always — the engine's own status is *inside*
it, so the JS side can tell a transient 503 from a permanent 4xx and decide
whether to retry the window:

```json
{ "ok": true, "code": 200, "body": "<engine JSON verbatim>", "provider_ms": 1073 }
```

Transport failures answer 502 and malformed input 400/413, each with a `reason`.
Nothing collapses into a bare 500.

`GET /healthz` → `{"ok": bool, "base_url_set": bool, "model": "...", "reason": "..."}`

`ok` means **the engine is reachable**, not that the shim is up. That is
deliberate and load-bearing — see below.

## Availability, and why a false "available" is impossible

The Flutter client falls back to on-device speech *only* on
`ENDPOINT_UNAVAILABLE` from `recorder_asr_open`. So reporting availability while
being unable to transcribe is strictly worse than failing: it produces silence
instead of a working local transcript.

`RecorderAsrProvider.isAvailable()` therefore probes `/healthz` and requires
`ok === true`, and the shim only answers `ok` after a live `GET` against the
engine's `/health` (falling back to `/v1/models`) succeeded within the last 5 s.
The chain is: engine reachable → shim says ok → open succeeds. Break any link
and `open` returns `ENDPOINT_UNAVAILABLE` with a reason naming which link broke.

`canSendBinary()` is gone. It probed a capability the runtime does not have and
would have failed permanently in sidecar mode, and it never measured whether
transcription could actually happen.

## Deploy

> Requires `kubectl` against `ai-cart-auto-cluster`, namespace `aicart`.
> Steps 1–4 are cluster-side and independent of the image; step 5 is the normal
> push-to-`master` → `.github/workflows/deploy-eks.yml` → `kubectl set image`
> path for the module bundle (CodeBuild and CodePipeline no longer exist).
> **Do step 5 last** — the new bundle reads `RECORDER_ASR_SHIM_URL`, and
> if the sidecar is not there yet, `open` correctly answers
> `ENDPOINT_UNAVAILABLE` and every client falls back to on-device speech.
> Nothing breaks, it just does not improve.

### 0. Preconditions — VERIFIED 2026-08-29

All three were checked against the live cluster on 2026-08-29. Re-run them if
more than a few days have passed or if the Deployment has been replaced.

```bash
aws eks update-kubeconfig --region us-east-1 --name ai-cart-auto-cluster
kubectl config current-context   # expect .../ai-cart-auto-cluster

# (a) Container names. RESOLVED — the patch previously guessed `nakama`, which
#     was WRONG for this Deployment and would have appended an imageless third
#     container that the API server rejects. The patch now says
#     `intelliverse-nakama`.
kubectl -n aicart get deploy intelliverse-nakama \
  -o jsonpath='{.spec.template.spec.containers[*].name}'; echo
#   → intelliverse-nakama              ← patched here
kubectl -n aicart get deploy intelliverse-nakama-multiplayer \
  -o jsonpath='{.spec.template.spec.containers[*].name}'; echo
#   → nakama                           ← where the bad guess came from

# (b) The engine is where the shim expects it. VERIFIED: deploy 1/1, 11 days
#     old, svc ClusterIP 172.20.199.134:8000. Note voice-pipeline-tts (0/0) and
#     voice-pipeline-vllm (0/1) are scaled down — the ASR path does not use
#     them.
kubectl -n aicart get svc voice-pipeline-stt
kubectl -n aicart get deploy voice-pipeline-stt

# (c) How env reaches the container. VERIFIED Pattern A: 48 inline `env:`
#     entries and NO `envFrom`, so the strategic-merge patch below is correct.
kubectl -n aicart get deploy intelliverse-nakama \
  -o jsonpath='{.spec.template.spec.containers[0].envFrom}'; echo
#   → (empty)
```

Note for whoever reads the JS side: the Goja runtime reads `ctx.env`, which
Nakama populates from `runtime.env` in `secret/nakama-secret`'s `config.yaml`
— **not** from the Deployment's `env:`. Container env alone does not reach an
RPC. That is why step 3 has a separate `--runtime.env` JSON patch.

### 1. The Secret — owned by the secret-rotation workstream, NOT required first

**Secret `recorder-asr-secrets` does not exist in `aicart`
(verified 2026-08-29: `NotFound`), and the sidecar patch no longer requires
it.** `RECORDER_ASR_GC_TOKEN` is marked `optional: true`.

This is deliberate. A non-optional `secretKeyRef` to a missing Secret does not
degrade the feature — kubelet cannot build the container environment, so every
`intelliverse-nakama` pod goes `CreateContainerConfigError` and **all of Nakama
goes down**. That is a total outage traded for a GC sweep that is inert in
every environment today.

Degrading is safe because `recorder_asr.ts::rpcGc` fails closed on exactly this
case: with no token configured it returns `UNAUTHENTICATED` for every call
rather than becoming an unauthenticated global delete. The four user-facing
RPCs (`_open`, `_push`, `_close`, `_purge`) never read this value.

Consequence: **steps 2–5 can proceed with no Secret at all.** `recorder_asr_gc`
and the step-4 CronJob stay inert until the Secret lands. This removes an
ordering dependency on the secret rotation.

When the owner is ready (this is the only step that creates a credential; do
not run it as part of shipping the module):

```bash
# Generate and set the GC token. Do not echo it; do not put it in a file that
# gets committed. This is the only new credential the feature needs.
kubectl -n aicart create secret generic recorder-asr-secrets \
  --from-literal=gc-token="$(openssl rand -hex 32)" \
  --from-literal=engine-api-key=""

# Verify the keys exist without printing values.
kubectl -n aicart get secret recorder-asr-secrets -o json | jq -r '.data | keys[]'
# expect: engine-api-key, gc-token

# The Secret alone is not enough — RECORDER_ASR_GC_TOKEN must also be in a
# --runtime.env flag (step 3), then:
kubectl -n aicart rollout restart deploy/intelliverse-nakama
```

`engine-api-key` is intentionally empty: the engine declares no security
schemes, reads no API-key env var, and is ClusterIP with no ingress. The stanza
exists (marked `optional: true`) so that an authenticating engine later is a
Secret update rather than a manifest change.

The step-4 CronJob keeps its `secretKeyRef` **non**-optional on purpose. Its
blast radius is one isolated Job pod, and a GC job that cannot authenticate
should fail visibly rather than silently sweep nothing.

### 2. ConfigMap with the shim source

```bash
kubectl kustomize deploy/recorder-asr-shim              # review the output first
kubectl apply -k deploy/recorder-asr-shim
```

### 3. Sidecar + env on the Nakama Deployment

```bash
kubectl -n aicart patch deployment intelliverse-nakama \
  --patch-file deploy/recorder-asr-shim/nakama-sidecar-patch.yaml
```

**Do NOT run the `--runtime.env` JSON patch this README used to recommend.**
It was wrong twice over, and both were verified against the live cluster on
2026-08-29.

*Wrong 1 — `args` is not a flag list here.* The live container is:

```yaml
command: ["/bin/sh", "-c"]
args:
  - |
    set -e; if [ -n "$PATHA_INDEX_JS_URL" ]; then echo "[patha-hotfix] downloading index.js";
    curl -fsSL "$PATHA_INDEX_JS_URL" -o /nakama/data/modules/index.js;
    BYTES=$(wc -c </nakama/data/modules/index.js); echo "[patha-hotfix] applied $BYTES bytes";
    if [ "$BYTES" -lt 8800000 ]; then echo "[patha-hotfix] file too small — abort"; exit 1; fi;
    fi; exec /nakama/nakama --config /nakama/config/config.yaml
```

`args` is a **single-element list holding one shell script** — the
`PATHA_INDEX_JS_URL` hotfix wrapper. Appending `--runtime.env` to it does not
pass a flag to the Nakama binary; it passes positional parameters to `sh -c`,
which the script never reads. The flags are **silently ignored**. No error, no
outage, and the feature stays inert while looking configured. Anything that
must reach the binary has to go *inside* that script string, ahead of the
`exec` — and rewriting args[0] risks destroying the hotfix wrapper, which is
the only sub-minute lever available during a Sev-1.

*Wrong 2 — that is not how this cluster passes runtime env anyway.* The live
container carries **no** `--runtime.env` flags at all. `ctx.env` is populated
from `runtime.env` in `secret/nakama-secret`'s `config.yaml`, which currently
holds 41 entries including `PUSH_REGISTER_URL` and `PUSH_SEND_URL`.

**Good news: the four user-facing RPCs need none of it.** The provider's
defaults already match the sidecar exactly
(`recorder_asr_provider.ts::config`):

| var | default | matches sidecar? |
|---|---|---|
| `RECORDER_ASR_SHIM_URL` | `http://127.0.0.1:7359` | yes — `DEFAULT_SHIM_URL`, same as `shim.py`'s `DEFAULT_LISTEN` |
| `RECORDER_ASR_ENABLED` | `"1"` (on) | yes |
| `RECORDER_ASR_TIMEOUT_MS` | `9000` | yes |
| `RECORDER_ASR_GC_TOKEN` | unset → RPC refuses all | fail-closed, see step 1 |

So `_open`, `_push`, `_close` and `_purge` are fully functional with the
sidecar and **no runtime-env change of any kind**. The container `env:` added
by the patch is still worth having as documentation and as the override point,
but it is not what makes the feature work.

The only var that genuinely needs `ctx.env` is `RECORDER_ASR_GC_TOKEN`, and the
correct way to set it is a `runtime.env` entry in `secret/nakama-secret` —
**not** an args patch:

```bash
# Owned by the secret-rotation workstream. Adds one line to runtime.env in
# secret/nakama-secret's config.yaml, in the same style as PUSH_SEND_URL:
#   - "RECORDER_ASR_GC_TOKEN=<the gc-token value>"
# then:
kubectl -n aicart rollout restart deploy/intelliverse-nakama
```

Until that happens `recorder_asr_gc` returns `UNAUTHENTICATED`, the step-4
CronJob is inert, and nothing else is affected.

```bash
kubectl -n aicart rollout status deployment/intelliverse-nakama --timeout=5m
```

Verify the sidecar came up and can see the engine:

```bash
kubectl -n aicart logs deployment/intelliverse-nakama -c recorder-asr-shim --tail=20
# expect: [recorder-asr-shim] listening on 127.0.0.1:7359 -> http://voice-pipeline-stt... model=Systran/faster-whisper-small.en

kubectl -n aicart exec deployment/intelliverse-nakama -c recorder-asr-shim -- \
  python3 -c "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:7359/healthz').read().decode())"
# expect: {"ok": true, "base_url_set": true, "model": "...", "reason": ""}
# ok:false means the ENGINE is unreachable — `reason` says which probe failed.
```

### 4. The GC CronJob

```bash
kubectl apply -f k8s/recorder-asr-cronjob.yaml -n aicart

# Run it once immediately rather than waiting 15 minutes.
kubectl -n aicart create job --from=cronjob/recorder-asr-gc recorder-asr-gc-manual-1
kubectl -n aicart logs job/recorder-asr-gc-manual-1
# expect: status=200 then {"swept":N,"scanned":N,"wrapped":true}
# `{"error":...}` means the token in the Nakama container does not match the
# Secret, or step 3's --runtime.env flag is missing.
```

It reads the Nakama `http_key` from `secret/nakama-secret` key `http_key`, which
is where `buildspec.yml` reads it from and therefore the source of truth.
(`k8s/analytics-cronjob.yaml` uses a separate `analytics-cron-secrets/http-key`
copy; that may hold the same value, but it can drift, so this does not depend on
it.) Confirm the key exists before applying:

```bash
kubectl -n aicart get secret nakama-secret -o json | jq -r '.data | keys[]' | rg http_key
# Absent → the Job will start but every call answers 401 "HTTP key invalid".
```

### 5. The module bundle

Normal path, no special handling:

```bash
git push origin main      # → CodeBuild → kubectl set image
kubectl -n aicart rollout status deployment/intelliverse-nakama --timeout=10m
kubectl -n aicart logs deployment/intelliverse-nakama -c nakama --tail=200 | rg -i 'recorder_asr'
```

> **Both bundles.** Nakama loads `data/modules/index.js` *and*
> `data/modules/build/index.js`. `npm run build` in `data/modules` writes both;
> shipping only one leaves the old code live and costs a debugging cycle.

### Smoke test after step 5

```bash
# Any authenticated client opening a session is the real test. From outside,
# the useful signal is that `open` stops answering ENDPOINT_UNAVAILABLE:
kubectl -n aicart logs deployment/intelliverse-nakama -c nakama --tail=500 \
  | rg 'RecorderAsr.*(provider ok|ENDPOINT_UNAVAILABLE|shim)'
# `provider ok bytes=... segments=N` is a recording that became text.
```

### Rollback

```bash
# Removes the sidecar and the env, leaves the ConfigMap and Secret (both inert).
kubectl -n aicart rollout undo deployment/intelliverse-nakama

# Or leave the sidecar in place and just turn the feature off — clients then
# fall back to on-device speech, which is today's behaviour.
kubectl -n aicart set env deployment/intelliverse-nakama RECORDER_ASR_ENABLED=0

kubectl -n aicart delete cronjob recorder-asr-gc     # stops the sweep only
```

## The GC token

`recorder_asr_gc` reads `RECORDER_ASR_GC_TOKEN` and refuses every call when it
is empty. That is the correct default — with no token the RPC would be an
unauthenticated global delete — but the variable is set in no environment, so
the RPC has never run anywhere. Retention has therefore never been enforced.

Three things must all be true:

1. `recorder-asr-secrets/gc-token` exists (step 1).
2. The Nakama container gets it as `RECORDER_ASR_GC_TOKEN` via `secretKeyRef`
   (step 3's patch). **Never inline the value into a manifest or `.env`.**
3. It is listed in a `--runtime.env` flag (step 3's JSON patch), or `ctx.env`
   never sees it.

For local development put it in `.env` as `RECORDER_ASR_GC_TOKEN=...`; it is
already wired through `docker-compose.yml` and `RUNTIME_ENV_KEYS`.

## Configuration

Read by the **shim** container:

| Variable                            | Default                          | Notes                                              |
|-------------------------------------|----------------------------------|----------------------------------------------------|
| `RECORDER_ASR_SHIM_LISTEN`          | `127.0.0.1:7359`                 | Loopback in the pod. `0.0.0.0` only for compose.   |
| `RECORDER_ASR_BASE_URL`             | `…voice-pipeline-stt…:8000`      | **Explicitly empty turns the cloud path off.**     |
| `RECORDER_ASR_MODEL`                | `Systran/faster-whisper-small.en`|                                                     |
| `RECORDER_ASR_API_KEY`              | empty                            | Engine needs none.                                 |
| `RECORDER_ASR_TIMEOUT_MS`           | `9000`                           | Keep under Nakama's HTTP write timeout.            |
| `RECORDER_ASR_SHIM_MAX_AUDIO_BYTES` | 24 MiB                           | Matches `MAX_SESSION_BYTES`; a real window is ≪.   |
| `RECORDER_ASR_SHIM_HEALTH_TTL_MS`   | `5000`                           | Collapses a burst of `open` probes.                |
| `RECORDER_ASR_SHIM_DUMP_DIR`        | unset                            | **Dev only** — writes every recording to disk.     |

Read by the **Nakama** container (each also needs `--runtime.env`):

| Variable                              | Default                 | Notes                                    |
|---------------------------------------|-------------------------|------------------------------------------|
| `RECORDER_ASR_SHIM_URL`               | `http://127.0.0.1:7359` |                                          |
| `RECORDER_ASR_ENABLED`                | `1`                     | `0` is the kill switch.                  |
| `RECORDER_ASR_TIMEOUT_MS`             | `9000`                  |                                          |
| `RECORDER_ASR_GC_TOKEN`               | empty → GC refuses all  | `secretKeyRef` only.                     |
| `RECORDER_ASR_REQUIRE_AGE_ASSERTION`  | `0`                     | `1` once the client sends the field.     |
| `RECORDER_ASR_TRANSCRIPT_TTL_SECONDS` | see `recorder_asr.ts`   |                                          |

## Local development

```bash
# Terminal 1 — a real engine on the host.
docker run --rm -p 8799:8000 fedirz/faster-whisper-server:latest-cpu

# Terminal 2 — Nakama + the shim as a separate compose service.
RECORDER_ASR_BASE_URL=http://host.docker.internal:8799 docker compose up -d
```

In compose the shim binds `0.0.0.0:7359` and Nakama reaches it at
`http://recorder_asr_shim:7359`, because compose services are separate
containers with no shared loopback. In the cluster it is `127.0.0.1`. That is
the one structural difference between the two environments.
