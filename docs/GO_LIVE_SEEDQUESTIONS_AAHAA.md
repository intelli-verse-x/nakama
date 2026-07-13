# Go-Live Runbook — Seed Questions + Aahaa (Wow Moments) Engines

**Audience:** developer/devops team taking the Seed Questions staging engine,
the Aahaa engine, the no-repeat chokepoints, and the browser showcase from
this repo to production (`ai-cart-auto-cluster`, namespace `aicart`,
service `intelliverse-nakama:7350`).

**How to read this doc:** every step is tagged **AUTOMATED** (already in the
repo — apply/deploy it as-is) or **MANUAL** (a human must create a secret, DNS
record, cert, or wire a client). Do the sections in order; the final checklist
table at the bottom is the sign-off sheet.

---

## 1 · Code deploy — AUTOMATED (in repo)

### 1.1 What ships

| Area | Files | What it does |
|---|---|---|
| Seed Questions engine | `data/modules/src/seed-questions/sq_core.ts`, `sq_engine.ts`, `sq_sources.ts`, `sq_quality.ts`, `sq_rpcs.ts` | 13-connector ingest, adaptive staging (2–3 pre-built sets/user), QA gate, review loop, no-repeat via `qv_seen` |
| Aahaa engine | `data/modules/src/aahaa/aahaa_catalog.ts`, `aahaa_engine.ts`, `aahaa_facts.ts`, `aahaa_rpcs.ts`, `aahaa_validator.ts` | deducible Fact Pack, wow catalog + ranking, CTR kill switch, No-Hallucination validator |
| No-repeat backstop | `data/modules/src/legacy/quiz.ts` | `quiz_submit_result` merges seen ids into the `qv_seen` ledger at submit time |
| No-repeat chokepoint | `data/modules/src/games/quizverse/migration.ts` | `quizverse_request_questions` dedupes every served pack against `qv_seen` and stamps `repeat_policy` |
| Showcase page | `web/seedquestions/index.html` | self-contained live demo (see §3) |
| Manifests | `deploy/seedquestions/ingress.yaml`, `deploy/seedquestions/showcase.yaml`, `deploy/seedquestions/cronjob.yaml`, `deploy/aahaa/cronjob.yaml` | host routing, static showcase, cron ticks |

### 1.2 Build

```bash
cd data/modules && npm run build
```

`postbuild.js` merges everything into `data/modules/index.js` (never hand-edit
that file).

### 1.3 Verify the bundle — all 17 new RPC ids

```bash
for id in \
  quizverse_seedq_get_staged quizverse_seedq_consume_set quizverse_seedq_review \
  quizverse_seedq_focus_tracks quizverse_seedq_sources quizverse_seedq_ingest \
  quizverse_seedq_ingest_tick quizverse_seedq_pool_stats quizverse_seedq_asset_job \
  quizverse_seedq_provenance \
  quizverse_aahaa_get quizverse_aahaa_react quizverse_aahaa_fact_pack \
  quizverse_aahaa_profile_set quizverse_aahaa_generate_all quizverse_aahaa_validate \
  quizverse_aahaa_catalog ; do
  rg -q "registerRpc\(\"$id\"" data/modules/index.js && echo "OK  $id" || echo "MISSING  $id"
done
```

All 17 must print `OK`. If any prints `MISSING`, stop — do not ship.

### 1.4 Image + rollout

Follow the project's standard prod flow in
[`docs/PROD_DEPLOY_RUNBOOK_FOR_DEVOPS.md`](PROD_DEPLOY_RUNBOOK_FOR_DEVOPS.md)
(§1 "Standard rollout monitoring": `git push origin main` → CodeBuild →
`kubectl -n aicart rollout status deployment/intelliverse-nakama`). Nothing
extra is needed for these modules — they ride the normal JS bundle. Watch
startup logs for goja errors:

```bash
kubectl -n aicart logs -f deployment/intelliverse-nakama | rg -i 'goja|seedq|aahaa'
```

---

## 2 · Secrets & runtime env — **MANUAL (team must do)**

The JS runtime only sees env vars that are explicitly forwarded via
`--runtime.env` (mirror of `RUNTIME_ENV_KEYS` in `docker-compose.yml`, lines
~43–62). **In k8s this means: the var must exist in the pod env AND be in the
Nakama entrypoint's runtime-env list** (check how the prod Deployment builds
its `--runtime.env` flags — same pattern as the compose entrypoint).

### 2.1 Create the seedq service-token secret

`deploy/seedquestions/cronjob.yaml` and `deploy/aahaa/cronjob.yaml` both expect
secret `seedq-secrets` with key `service_token`:

```bash
kubectl -n aicart create secret generic seedq-secrets \
  --from-literal=service_token="$(openssl rand -hex 32)"
```

### 2.2 Forward the env vars to the JS runtime

Required / optional keys (all read via `ctx.env[...]` in `sq_sources.ts` /
`sq_rpcs.ts` / `aahaa_rpcs.ts`):

| Var | Required? | Unlocks |
|---|---|---|
| `SEEDQ_SERVICE_TOKEN` | **Required** | cron + service auth for `*_ingest_tick`, `*_generate_all`, admin RPCs (must equal the `seedq-secrets/service_token` value) |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | **Required for LLM connectors** | the `youtube_quiz` (summarize.tech) connector. ⚠️ **The local `.env` currently holds a placeholder key — production needs a REAL key or this connector is silently inert** (it fails soft and the tick skips it). |
| `WOLFRAM_APP_ID` | Optional | Wolfram Short-Answers auto-verification for math questions (template generation works without it) |
| `TINEYE_API_KEY` | Optional | TinEye reverse-image provenance (domain whitelist works without it) |
| `REMOVE_BG_API_KEY` | Optional | remove.bg asset-job descriptors |
| `SEMANTIC_SCHOLAR_API_KEY` | Optional | higher rate limits on the scholar connector (public API works without it) |
| `SUMMARIZE_TECH_URL` | Optional | summarize.tech proxy for the youtube_quiz connector |

Example (Pattern A — inline env on the Deployment; check the actual pattern
per `PROD_DEPLOY_RUNBOOK_FOR_DEVOPS.md` §2.1 first):

```bash
kubectl -n aicart patch deployment intelliverse-nakama --type=json -p '[
  {"op":"add","path":"/spec/template/spec/containers/0/env/-",
   "value":{"name":"SEEDQ_SERVICE_TOKEN","valueFrom":{"secretKeyRef":{"name":"seedq-secrets","key":"service_token"}}}}
]'
# Repeat the same patch for WOLFRAM_APP_ID, TINEYE_API_KEY, REMOVE_BG_API_KEY,
# SEMANTIC_SCHOLAR_API_KEY, SUMMARIZE_TECH_URL, OPENAI_API_KEY, ANTHROPIC_API_KEY —
# add each key to seedq-secrets (kubectl patch secret / recreate) first, e.g.:
#   kubectl -n aicart patch secret seedq-secrets -p \
#     "{\"stringData\":{\"wolfram_app_id\":\"<value>\"}}"
```

**Then confirm the entrypoint forwards them** — a var present in pod env but
missing from the runtime-env list yields `ctx.env['KEY'] === undefined` with
no error. Verify after rollout:

```bash
curl -s -X POST "https://<prod-host>/v2/rpc/quizverse_seedq_sources?http_key=$HTTP_KEY&unwrap" \
  -H 'Content-Type: application/json' -d '{}' | jq '.sources[] | {id, env_keys, env_keys_present}'
# env_keys_present must list the keys you set.
```

---

## 3 · DNS + TLS + showcase — DNS/TLS **DONE**, apply steps MANUAL

Primary host: **`seedquestions.quizverse.world`** (as pinned in
`deploy/seedquestions/ingress.yaml`). Secondary host
`seedquestions.intelli-verse-x.ai` is kept as a second rule in the same
ingress for continuity with older links.

1. **DNS — ✅ DONE (2026-07-12, via Route53 API)**. Both records exist as
   ALIAS A → `dualstack.intelliverse-apis-alb-142832205.us-east-1.elb.amazonaws.com`
   (the shared `intelliverse-apis` ALB every quizverse.world host rides):
   - `seedquestions.quizverse.world` in zone `Z07562523B3TD6EXI0N6A`
   - `seedquestions.intelli-verse-x.ai` in zone `Z0145313YX71CJ73SY5B`

   Verify anytime: `dig +short seedquestions.quizverse.world` → the ALB IPs.
2. **TLS — ✅ COVERED, no action**. The ingress references the same two ACM
   certs as `avatar-page-ingress`; cert `c2b20042-…` covers
   `quizverse.world` + `*.quizverse.world` (verified via SNI probe), and the
   ALB group already carries the `intelli-verse-x.ai` wildcard. No new cert
   or SAN needed.
3. **Ingress class note**: the cluster's only IngressClass is `alb`
   (aws-load-balancer-controller) — there is no nginx ingress controller.
   `deploy/seedquestions/ingress.yaml` uses the ALB annotation pattern
   (`group.name: intelliverse-apis`). The old nginx `limit-rps` annotations
   were removed; if rate limiting is required, attach an AWS WAF rate-based
   rule to the shared ALB.
4. **Showcase ConfigMap** (the static page is served by nginx-in-a-pod from a
   ConfigMap generated from the repo file — re-run on every page change):
   ```bash
   kubectl -n aicart create configmap seedq-showcase-html \
     --from-file=index.html=web/seedquestions/index.html \
     --dry-run=client -o yaml | kubectl apply -f -
   ```
5. **Apply the manifests** (showcase first — the ingress references its
   Service):
   ```bash
   kubectl apply -f deploy/seedquestions/showcase.yaml
   kubectl apply -f deploy/seedquestions/ingress.yaml
   ```
6. **Verify**: `https://seedquestions.quizverse.world/` renders the
   showcase; set the page's base URL to `https://seedquestions.quizverse.world`
   (same origin — `/v2/*` routes to Nakama on the same host) and run all
   sections.

---

## 4 · Cron jobs — AUTOMATED manifests, MANUAL apply

```bash
kubectl apply -f deploy/seedquestions/cronjob.yaml   # seedq-ingest-tick, */30 min
kubectl apply -f deploy/aahaa/cronjob.yaml           # aahaa-generate-all, */15 min
```

Trigger one of each manually and check logs:

```bash
kubectl -n aicart create job --from=cronjob/seedq-ingest-tick seedq-tick-manual-1
kubectl -n aicart create job --from=cronjob/aahaa-generate-all aahaa-gen-manual-1
kubectl -n aicart logs job/seedq-tick-manual-1
kubectl -n aicart logs job/aahaa-gen-manual-1
```

Expected job output (the curl pod prints the RPC response):

- seedq tick → `{"ok":true,"tick":{...,"combos":[...],"accepted":N,...}}`
- aahaa gen → `{"ok":true,"batch":{"processed":N,"errors":0,...}}`

And in Nakama logs:

```
[SeedQ] ingest source=<connector> mode=<mode> topic=<topic> fetched=N accepted=N rejected=N
[Aahaa] generate_all processed=N errors=0 exhausted=false
```

If the jobs return `{"ok":false,"code":7,...}` the `service_token` doesn't
match `SEEDQ_SERVICE_TOKEN` in the runtime env — redo §2.

---

## 5 · Smoke tests (prod host) — copy-pasteable

```bash
PROD=https://seedquestions.quizverse.world        # or the main nakama-rest host
HTTP_KEY=<prod http_key>                          # admin key, server-side only
CKEY=<prod client key>                            # socket/client key

# 0) Session for user-scope RPCs
TOK=$(curl -s -X POST "$PROD/v2/account/authenticate/device?create=true&username=smoke_golive" \
  -u "$CKEY:" -H 'Content-Type: application/json' \
  -d '{"id":"golive-smoke-0123456789abcdef0123456789"}' | jq -r .token)

# 1) Pool stats (admin) — expect pools[] incl. customtopic_math & imageguess_space
curl -s -X POST "$PROD/v2/rpc/quizverse_seedq_pool_stats?http_key=$HTTP_KEY&unwrap" \
  -H 'Content-Type: application/json' -d '{}' | jq '{ok, pools: [.pools[] | {key, size}]}'

# 2) Sources registry — expect 13 sources, env_keys_present per §2
curl -s -X POST "$PROD/v2/rpc/quizverse_seedq_sources?http_key=$HTTP_KEY&unwrap" \
  -H 'Content-Type: application/json' -d '{}' | jq '{ok, n: (.sources|length)}'

# 3) Staged sets (session) — expect ok:true, sets[], adaptive{}, repeat_policy{}
curl -s -X POST "$PROD/v2/rpc/quizverse_seedq_get_staged?unwrap" \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d '{"mode":"CustomTopic","topic":"math","set_size":6,"want_sets":3}' \
  | jq '{ok, sets: (.sets|length), adaptive, repeat_policy}'

# 4) Aahaa feed — expect ok:true; feed may be [] for a fresh user
curl -s -X POST "$PROD/v2/rpc/quizverse_aahaa_get?unwrap" \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' \
  -d '{"generate":true}' | jq '{ok, n: (.feed|length), rating_prompt_suppressed}'

# 5) Aahaa catalog + CTR stats (admin) — expect catalog_size > 0
curl -s -X POST "$PROD/v2/rpc/quizverse_aahaa_catalog?http_key=$HTTP_KEY&unwrap" \
  -H 'Content-Type: application/json' -d '{}' | jq '{ok, catalog_size, batch_state}'

# 6) No-repeat double-call — the two id lists must be DISJOINT
PAYLOAD='{"kind":"deduped_s3","mode":"Smoke","scope":"global","topic":"golive_smoke","count":5,"id_prefix":"smk","inline_questions":['
for i in $(seq 1 12); do PAYLOAD+="{\"id\":\"smk$i\",\"question\":\"Q$i?\",\"options\":[\"a\",\"b\"],\"correct_index\":0,\"category\":\"golive_smoke\"},"; done
PAYLOAD="${PAYLOAD%,}]}"
curl -s -X POST "$PROD/v2/rpc/quizverse_request_questions?unwrap" \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d "$PAYLOAD" \
  | jq '{ids: [.questions[].id], repeat_policy}'
curl -s -X POST "$PROD/v2/rpc/quizverse_request_questions?unwrap" \
  -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d "$PAYLOAD" \
  | jq '{ids: [.questions[].id], repeat_policy}'
# Expected: zero shared ids between the two outputs; both fresh_count=5, pool_exhausted=false
```

---

## 6 · Unity team — **MANUAL (client wiring)**

Reference: [`docs/AAHAA_WOW_ENGINE.md`](AAHAA_WOW_ENGINE.md) **§4** (full
`AahaaClient.cs` sample + surfaces table) and **§8.2** (per-wow integration
matrix: surface, trigger moment, UI treatment, loop event, owner).

Checklist:

1. **Staged flow**: on mode/topic select → `quizverse_seedq_get_staged`
   `{mode, topic, set_size, want_sets:3}`. Render **honest repeat copy** from
   `repeat_policy` ("8 new + 2 Smart Review repeats" — never a silent repeat;
   `questions[].recycled == true` marks the review items).
2. **After the set is played** → `quizverse_seedq_consume_set`
   `{mode, topic, set_id}` (merges ids into `qv_seen`, auto-restages).
3. **Post-quiz wow** → `quizverse_aahaa_get` `{generate:true}`; render the
   top card (tier, copy, `signal` chip, CTA) on the score screen.
4. **Reaction loop** → `quizverse_aahaa_react` with `shown` when rendered,
   `clicked`/`dismissed`/`muted` on interaction (feeds the CTR kill switch).
5. **Rating-prompt gate**: never call the App Store rating API when
   `suppress_rating_prompt` (seedq) or `rating_prompt_suppressed` (aahaa) is
   true — the pool-exhausted intercept fires instead.
6. **Remote-config flag + S3 fallback**: gate the whole staged flow behind a
   remote-config bool; on RPC failure fall back to the legacy S3 question
   path (`quizverse_request_questions` kind `deduped_s3` keeps no-repeat even
   on the fallback).

---

## 7 · Web team — **MANUAL (client wiring)**

Reference: [`docs/AAHAA_WOW_ENGINE.md`](AAHAA_WOW_ENGINE.md) **§5** (fetch
wrapper + Growth Dashboard + validator middleware) and **§8** (deliverables
D1–D4 status + the full wow→surface integration matrix).

1. **Showcase**: link/embed `https://seedquestions.quizverse.world/` from
   the QuizVerse site (it's already deployed by §3 — no build step; the page
   auto-targets its own origin when you set the base URL field, or pass
   `?host=`).
2. **Growth Dashboard**: build `/me/growth` from `quizverse_aahaa_fact_pack` —
   every group has a `lineage` entry for tap-to-trace provenance (the showcase
   §5 card shows the intended UX).
3. **Validator middleware**: any LLM-narrated surface must pass its copy
   through `quizverse_aahaa_validate` (service token) before rendering —
   No-Hallucination gate.

---

## 8 · Monitoring & rollback

**Watch:**

```bash
# Goja/runtime errors after rollout
kubectl -n aicart logs deployment/intelliverse-nakama --since=30m | rg -i 'goja|error.*(seedq|aahaa)'

# Cron health (failed jobs pile up here)
kubectl -n aicart get jobs -l component=seed-questions
kubectl -n aicart get jobs -l component=aahaa

# CTR kill switch + feed throughput (any wow with ≥20 shows and <5% CTR
# over 14d auto-pauses; verify via catalog stats)
curl -s -X POST "$PROD/v2/rpc/quizverse_aahaa_catalog?http_key=$HTTP_KEY&unwrap" \
  -H 'Content-Type: application/json' -d '{}' \
  | jq '[.catalog[] | select(.stats.shown >= 20) | {wow_id, ctr: .stats.ctr}]'

# Seen-ledger growth (qv_seen) — sizes are capped server-side, but watch pool
# health: available_unseen trending to 0 across users means ingest is starving.
curl -s -X POST "$PROD/v2/rpc/quizverse_seedq_pool_stats?http_key=$HTTP_KEY&unwrap" \
  -H 'Content-Type: application/json' -d '{}' | jq '.pools[] | {key, size, quarantined}'
```

**Rollback:**

```bash
# 1. Previous image (standard flow — see PROD_DEPLOY_RUNBOOK_FOR_DEVOPS.md)
kubectl -n aicart rollout undo deployment/intelliverse-nakama
kubectl -n aicart rollout status deployment/intelliverse-nakama --timeout=5m

# 2. Pause the crons (no data loss — they resume where the cursor stopped)
kubectl -n aicart patch cronjob seedq-ingest-tick   -p '{"spec":{"suspend":true}}'
kubectl -n aicart patch cronjob aahaa-generate-all -p '{"spec":{"suspend":true}}'

# 3. (Optional) take the showcase host offline
kubectl -n aicart delete ingress quizverse-seedquestions
```

The engines are additive — rolling back the image removes the RPCs but leaves
all storage (pools, ledgers, feeds) intact for the next attempt.

---

## 9 · Go-live checklist

| # | Step | Owner | Manual? | Done |
|---|------|-------|---------|------|
| 1 | `npm run build` + verify 17 RPC greps (§1.3) | Backend | no | ☐ |
| 2 | Image built & rolled out via prod flow (§1.4) | DevOps | no | ☐ |
| 3 | `seedq-secrets` secret created (§2.1) | DevOps | **yes** | ☐ |
| 4 | `SEEDQ_SERVICE_TOKEN` + unlock keys forwarded to JS runtime env (§2.2) | DevOps | **yes** | ☐ |
| 5 | Real `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` in prod (local .env is a placeholder) (§2.2) | DevOps | **yes** | ☐ |
| 6 | DNS records for `seedquestions.quizverse.world` (+ secondary `.intelli-verse-x.ai`) (§3) | DevOps | no (done 2026-07-12) | ☑ |
| 7 | TLS — covered by existing `*.quizverse.world` ACM cert (§3) | DevOps | no (verified) | ☑ |
| 8 | Showcase ConfigMap + `showcase.yaml` + `ingress.yaml` applied (§3) | DevOps | **yes** | ☐ |
| 9 | Cron jobs applied + one manual trigger each verified (§4) | DevOps | **yes** (apply) | ☐ |
| 10 | Smoke-test checklist §5 passes on prod host | Backend | **yes** | ☐ |
| 11 | Unity client wiring (§6) | Unity team | **yes** | ☐ |
| 12 | Web embed + Growth Dashboard + validator middleware (§7) | Web team | **yes** | ☐ |
| 13 | Monitoring queries bookmarked / alerting wired (§8) | DevOps | **yes** | ☐ |
