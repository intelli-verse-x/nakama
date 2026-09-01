# `PATHA_INDEX_JS_URL` — the emergency module-hotfix path

**Status:** the mechanism is live and currently **inert**. The hardened
entrypoint in this directory is **written, tested, and NOT applied.**

## What the lever is

The `intelliverse-nakama` container overrides `command`/`args` to wrap the
Nakama binary in a shell script. When `PATHA_INDEX_JS_URL` is non-empty, every
pod downloads a module bundle at start and overwrites the one baked into the
image. The value comes from ConfigMap `aicart/nakama-patha-hotfix`, key
`INDEX_JS_URL`.

Verified 2026-08-29: the key is `""` and the pod reports `PATHA_INDEX_JS_URL=`
(empty), annotated `patha.hotfix: disabled-use-image-bundle-streak-5c1e54e`.
**Empty is the correct steady state and it should stay empty.**

## Why it is kept

A full image build is ~31 minutes. This is the only sub-minute path to change
server logic, and it is the reason the last emergency was survivable. Deleting
it would remove the only Sev-1 lever that exists. So: keep the mechanism,
constrain it.

It is also, as written, an uncontrolled path into production. Any principal
with `configmap/edit` in `aicart` can replace all server logic from an
arbitrary URL, bypassing git, review, `tsc`, `node -c` and the RPC superset
gate, leaving no audit trail beyond an annotation someone remembered to write.

## What the production wrapper checks today, and what it misses

```sh
BYTES=$(wc -c </nakama/data/modules/index.js)
[ "$BYTES" -lt 8800000 ] && exit 1
```

One byte floor, applied *after* the download has already overwritten the live
bundle. It catches a truncated download. It does not catch the failure that
actually happened.

**Measured, 2026-08-29.** A bundle rebuilt from a stale tree is valid
JavaScript of an entirely plausible size that simply stops registering RPCs
production is serving. The live bundle registers **1338** RPCs. The queued work
branch registered **1141** — 222 live RPCs missing. `tsc` passes, `node -c`
passes, the JS-runtime smoke test passes because it only probes long-lived
RPCs, and the first symptom is `404 rpc id not found` for real users.

Demonstrated with `test-entrypoint.sh`:

| bundle | bytes | RPCs | old byte floor | new RPC floor |
|---|---|---|---|---|
| production | 9,179,688 | 1338 | accept | accept |
| synthetic stale-tree | 9,501,923 | 50 | **ACCEPT** | **REJECT** |

A 9.5 MB bundle registering 50 RPCs sails through any size check. Size is a
truncation detector; it is not a content check.

## What `entrypoint.sh` adds

1. **A mandatory checksum.** `PATHA_INDEX_JS_SHA256` is required whenever
   `PATHA_INDEX_JS_URL` is set; a URL alone is refused. Publishing a hotfix now
   needs two independent facts instead of one, and the checksum is the thing a
   reviewer can actually be shown.
2. **An RPC-count floor** (`PATHA_MIN_RPCS`, default 1338) using the same
   literal-`registerRpc` extraction as `scripts/rpc-superset-gate.sh`, so the
   gate and the hotfix path agree on what an RPC is.
3. **Stage-then-promote.** The download goes to a temp file in the same
   directory and is `mv`-ed into place only after every check passes, so a
   rejected hotfix leaves the baked bundle untouched. The current version
   curls straight onto the live file and validates afterwards.
4. **A raised byte floor**, 8.8 MB → 9.1 MB. Production is 9,179,688 bytes, so
   8.8 MB left ~380 KB of headroom for a broken bundle to hide in.
5. **A structural check** that `InitModule` is present, catching a download
   that ended mid-file while still clearing the floor.
6. **Stable `[patha-hotfix]` log lines** on every decision, including when
   inert, so a log alert can fire on any application at all.

Fails closed: a bundle that does not validate means CrashLoopBackOff, not a
boot. If a hotfix is being applied then someone is mid-incident reaching for
the most dangerous lever available, and serving wrong answers is worse than
serving none. Rollback is to blank the ConfigMap key and delete the pods.

## Tests

```bash
deploy/patha-hotfix/test-entrypoint.sh            # 7 cases, no cluster needed
```

Covers: inert when unset; refuse a URL with no checksum; refuse a checksum
mismatch; refuse below the byte floor; refuse below the RPC floor *while above
the byte floor*; refuse a non-Nakama bundle; accept the real production bundle.
Every refusal case also asserts the pre-existing bundle was not overwritten.

Verified inside the running container (2026-08-29): Debian 12, with
`sha256sum`, `curl`, `grep`, `sort`, `wc`, `mv` and `mktemp` all present, and
`/tmp` and `/nakama/data/modules` writable. The script needs nothing that is
not already in the image.

## Installing it — NOT DONE, and deliberately not done by CI

The wrapper lives in the live Deployment's `args`, and the Deployment spec's
source of truth is the cluster object, mutated by `kubectl set image` /
`kubectl set env` from `deploy-eks.yml`. It is not in this repo, and
`kube-infra/nakama/deployment.yaml` must **not** be applied (see
`docs/runbooks/NAKAMA_MODULE_DEPLOY.md` §7).

Installing therefore means replacing `args[0]` on the live Deployment with the
contents of `entrypoint.sh`. That is a pod-template change, so all pods
restart. It is a human decision and a windowed operation:

```bash
# Read the current wrapper first and keep a copy.
kubectl -n aicart get deploy intelliverse-nakama \
  -o jsonpath='{.spec.template.spec.containers[0].args[0]}' > /tmp/patha-args-before.sh

# Then replace args[0] with entrypoint.sh's body. Use a file, not an inline
# string — the script contains quotes that will not survive shell nesting.
python3 - <<'PY'
import json, subprocess, pathlib
body = pathlib.Path('deploy/patha-hotfix/entrypoint.sh').read_text()
patch = [{"op": "replace",
          "path": "/spec/template/spec/containers/0/args/0",
          "value": body}]
print(json.dumps(patch))
PY
# review, then feed to:
#   kubectl -n aicart patch deploy intelliverse-nakama --type=json -p "$(...)"
```

Confirm afterwards that the inert path still logs and the server still starts:

```bash
kubectl -n aicart rollout status deploy/intelliverse-nakama --timeout=15m
kubectl -n aicart logs deploy/intelliverse-nakama -c intelliverse-nakama --tail=20 \
  | grep patha-hotfix
# expect: [patha-hotfix] inert (PATHA_INDEX_JS_URL empty) — serving the bundle baked into the image.
```

## Still recommended, still not done

These need owners outside this change:

- **Restrict the origin.** Allow only an in-cluster or S3 URL rather than
  anything `curl` can reach.
- **Tighten RBAC** on `configmap/nakama-patha-hotfix` and alert on any write.
  The checksum requirement raises the bar but does not replace authorisation.
- **Expire hotfixes.** Require a matching commit on `master` within N hours or
  the ConfigMap is reset. The existing `patha.hotfix.previous` annotation is a
  good habit; make it mandatory.
