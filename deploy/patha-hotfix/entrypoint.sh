#!/bin/sh
# Hardened PATHA_INDEX_JS_URL entrypoint wrapper for intelliverse-nakama.
#
# WHAT THIS IS
#
# The live intelliverse-nakama container overrides command/args to wrap the
# Nakama binary in a shell script that, when PATHA_INDEX_JS_URL is non-empty,
# replaces the baked module bundle at pod start. That is the only sub-minute
# lever available during a Sev-1: a full image build is ~31 minutes, so this
# path is the reason the last emergency was survivable. It is deliberately
# KEPT. This file hardens it.
#
# The version running in production as of 2026-08-29 is, in full:
#
#   set -e
#   if [ -n "$PATHA_INDEX_JS_URL" ]; then
#     echo "[patha-hotfix] downloading index.js"
#     curl -fsSL "$PATHA_INDEX_JS_URL" -o /nakama/data/modules/index.js
#     BYTES=$(wc -c </nakama/data/modules/index.js)
#     echo "[patha-hotfix] applied $BYTES bytes"
#     if [ "$BYTES" -lt 8800000 ]; then
#       echo "[patha-hotfix] file too small — abort"; exit 1
#     fi
#   fi
#   exec /nakama/nakama --config /nakama/config/config.yaml
#
# FOUR THINGS WRONG WITH IT
#
#   1. The 8.8 MB byte floor does not catch the failure it needs to. The
#      222-RPC regression measured on 2026-08-29 produced a bundle that was
#      still valid JavaScript and would comfortably have cleared 8.8 MB — the
#      stale tree's bundle was 7.05 MB, but a bundle only slightly behind
#      master sits well above the floor while still missing live RPCs. Size is
#      a truncation detector, not a content check.
#   2. No integrity check. A URL alone is sufficient authority to replace all
#      server logic. Any principal with configmap/edit in aicart can point it
#      anywhere, from an unauthenticated origin, with no audit trail beyond an
#      annotation someone remembered to write.
#   3. It curls STRAIGHT ONTO the live bundle and validates afterwards. A
#      failed check leaves a clobbered index.js behind, so the checks protect
#      the process but not the file.
#   4. It never checks the bundle parses. `node -c` is not available in this
#      image, but a truncated-mid-function download that happens to exceed the
#      floor would take the runtime down at eval time with no earlier signal.
#
# WHAT THIS VERSION DOES
#
#   * Downloads to a temp file and promotes it only after every check passes,
#     so a rejected hotfix leaves the baked bundle untouched.
#   * REQUIRES PATHA_INDEX_JS_SHA256 whenever PATHA_INDEX_JS_URL is set. A URL
#     on its own is refused. This is the main change: publishing a bundle now
#     takes two independent facts, not one.
#   * Enforces an RPC-count floor as well as a byte floor, using the same
#     literal-registerRpc extraction as scripts/rpc-superset-gate.sh so the
#     two agree.
#   * Logs every decision with a stable [patha-hotfix] prefix so a log-based
#     alert can fire on any hotfix application at all.
#
# Verified 2026-08-29 inside the running container: Debian 12, and
# sha256sum / curl / grep / sort / wc / mv / mktemp are all present, /tmp and
# /nakama/data/modules are writable.
#
# FAILURE POLICY: fail closed and CrashLoopBackOff. If a hotfix is being
# applied at all then someone is mid-incident and reaching for the most
# dangerous lever available; booting on a bundle that failed validation is
# strictly worse than not booting, because it can serve wrong answers to real
# users instead of serving none. The rollback is to blank the ConfigMap key
# and delete the pods, which restores the baked bundle in one rollout.
#
# INSTALLING THIS is a change to the live Deployment's args and is NOT done by
# this repo's CI. See README.md in this directory. It has deliberately not
# been applied.

set -e

# Overridable only so this script can be exercised by
# deploy/patha-hotfix/test-entrypoint.sh outside a container. In the pod all
# four take their defaults.
MODULES_DIR="${PATHA_MODULES_DIR:-/nakama/data/modules}"
NAKAMA_BIN="${PATHA_NAKAMA_BIN:-/nakama/nakama}"
NAKAMA_CONFIG="${PATHA_NAKAMA_CONFIG:-/nakama/config/config.yaml}"
MIN_BYTES="${PATHA_MIN_BYTES:-9100000}"
MIN_RPCS="${PATHA_MIN_RPCS:-1338}"

log()  { echo "[patha-hotfix] $*"; }
die()  { echo "[patha-hotfix] REFUSED: $*" >&2; exit 1; }

# Same extraction as scripts/rpc-superset-gate.sh: literal registerRpc("id")
# and registerRpc('id') call sites, deduplicated. Dynamic registrations are
# out of scope for both, which is fine — this is a floor, not an inventory.
count_rpcs() {
    {
        grep -oE 'registerRpc\([[:space:]]*"[^"]+"' "$1" 2>/dev/null || true
        grep -oE "registerRpc\([[:space:]]*'[^']+'" "$1" 2>/dev/null || true
    } | sed -E 's/.*["'"'"']([^"'"'"']+)["'"'"']$/\1/' | sort -u | grep -c . || true
}

if [ -n "${PATHA_INDEX_JS_URL:-}" ]; then
    log "PATHA_INDEX_JS_URL is set — a module hotfix is being applied."
    log "url=${PATHA_INDEX_JS_URL}"

    # (2) Integrity is mandatory. Refusing here is the whole point: it makes a
    # URL insufficient on its own, so an attacker or a mistake needs the
    # checksum too, and the checksum is what a reviewer can be shown.
    if [ -z "${PATHA_INDEX_JS_SHA256:-}" ]; then
        die "PATHA_INDEX_JS_URL is set but PATHA_INDEX_JS_SHA256 is empty.
       A URL alone is not sufficient authority to replace the module bundle.
       Publish the bundle, take its sha256, and set both keys on ConfigMap
       nakama-patha-hotfix:
         sha256sum index.js
         kubectl -n aicart patch cm nakama-patha-hotfix --type=merge -p \\
           '{\"data\":{\"INDEX_JS_URL\":\"<url>\",\"INDEX_JS_SHA256\":\"<sum>\"}}'"
    fi

    # (3) Stage, never overwrite in place.
    TMP="$(mktemp "${MODULES_DIR}/.index.js.patha.XXXXXX")"
    # shellcheck disable=SC2064
    trap "rm -f '$TMP'" EXIT INT TERM

    curl -fsSL --max-time 120 "$PATHA_INDEX_JS_URL" -o "$TMP" \
        || die "download failed (curl non-zero). Baked bundle left in place."

    BYTES=$(wc -c <"$TMP" | tr -d ' ')
    log "downloaded ${BYTES} bytes"

    # (1a) Byte floor. Raised from 8.8 MB: the bundle production serves is
    # 9,179,688 bytes, so 8.8 MB left ~380 KB of headroom in which a genuinely
    # broken bundle could hide. Still only a truncation detector.
    if [ "$BYTES" -lt "$MIN_BYTES" ]; then
        die "bundle is ${BYTES} bytes, floor is ${MIN_BYTES}. Truncated download or a
       bundle built from a tree that is missing modules."
    fi

    # (2) Checksum before content inspection: cheapest strong check first.
    ACTUAL_SHA="$(sha256sum "$TMP" | cut -d' ' -f1)"
    if [ "$ACTUAL_SHA" != "$PATHA_INDEX_JS_SHA256" ]; then
        die "sha256 mismatch.
       expected ${PATHA_INDEX_JS_SHA256}
       actual   ${ACTUAL_SHA}
       The bundle at that URL is not the bundle that was reviewed."
    fi
    log "sha256 OK (${ACTUAL_SHA})"

    # (1b) RPC-count floor — the check the byte floor could not do. A bundle
    # rebuilt from a stale tree is valid JavaScript of a plausible size that
    # simply stops registering RPCs production is serving. On 2026-08-29 the
    # live bundle registered 1338; the queued work branch registered 1141.
    RPCS=$(count_rpcs "$TMP")
    log "registered RPCs: ${RPCS} (floor ${MIN_RPCS})"
    if [ "$RPCS" -lt "$MIN_RPCS" ]; then
        die "bundle registers ${RPCS} RPCs, floor is ${MIN_RPCS}.
       This is the stale-tree regression: valid JS, plausible size, missing
       RPCs that production is serving. Every caller of a missing RPC would
       get 404 rpc id not found.
       If the removal is genuinely intended, lower PATHA_MIN_RPCS explicitly
       and say why in the patha.hotfix annotation."
    fi

    # (4) Cheap structural sanity. Not a parse, but catches a download that
    # ended mid-file with the byte floor still cleared.
    if ! grep -q 'InitModule' "$TMP"; then
        die "bundle does not contain InitModule — this is not a Nakama module bundle."
    fi

    # All checks passed. Promote atomically: mv within the same filesystem is
    # a rename, so no reader ever sees a half-written bundle.
    mv -f "$TMP" "${MODULES_DIR}/index.js"
    trap - EXIT INT TERM
    log "APPLIED hotfix bundle: ${BYTES} bytes, ${RPCS} RPCs, sha256 ${ACTUAL_SHA}"
    log "Reminder: a hotfix is not a deploy. Land the matching commit on master."
else
    log "inert (PATHA_INDEX_JS_URL empty) — serving the bundle baked into the image."
fi

exec "$NAKAMA_BIN" --config "$NAKAMA_CONFIG"
