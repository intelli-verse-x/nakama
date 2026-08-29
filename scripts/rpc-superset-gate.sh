#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# rpc-superset-gate.sh — refuse to deploy a bundle that drops live RPCs.
#
# WHY: data/modules/index.js is a merged bundle. A rebuild from a stale tree
# silently produces a *smaller* bundle: the RPCs that only exist on newer
# commits are simply not registered. Nothing in the image build notices —
# `tsc`, `node -c` and the JS-runtime smoke test all pass, because the bundle
# is still valid JS and the handful of RPCs the smoke test probes are old
# enough to survive. The first signal is a 404 "rpc id not found" in prod.
#
# This gate compares the *set* of RPC ids registered by the candidate bundle
# against the set registered by the bundle currently serving production, and
# fails when the candidate is missing any of them. Additions are always fine.
#
# Deliberate removals: set ALLOW_RPC_REMOVAL=true (or =rpc_a,rpc_b for a
# specific allowlist) to downgrade the failure to a warning.
#
# Usage:
#   rpc-superset-gate.sh extract       <bundle.js>            -> sorted rpc ids
#   rpc-superset-gate.sh extract-image <image-ref>            -> sorted rpc ids
#   rpc-superset-gate.sh compare       <baseline.txt> <candidate.txt>
#   rpc-superset-gate.sh gate          <candidate-image> [<baseline-image>]
#
# Exit codes: 0 pass · 1 candidate is missing live RPCs · 2 usage/internal
# ---------------------------------------------------------------------------
set -euo pipefail

BUNDLE_PATH_IN_IMAGE="${BUNDLE_PATH_IN_IMAGE:-/nakama/data/modules/index.js}"

log()  { echo "[rpc-gate] $*"; }
fail() { echo "[rpc-gate] FATAL: $*" >&2; exit 2; }

# --- extraction -------------------------------------------------------------
# Pull the string literal out of every `registerRpc("<id>", ...)` /
# `registerRpc('<id>', ...)` call site.
#
# Dynamic registrations (`registerRpc(rpc.id, ...)`, `registerRpc(prefix + s)`)
# are invisible to a static scan and are intentionally out of scope: they are
# driven by in-bundle tables, so a dropped table shows up as dropped literals
# elsewhere. What matters for the gate is that BOTH sides are extracted by
# this same function, so any systematic blind spot cancels out of the diff.
#
# The trailing filter drops doc/placeholder literals that appear in comments
# and help strings (`...`, `<id>`, `<prefix><suffix>`) — an id must start
# alphanumeric.
extract_from_file() {
    local f="${1:-}"
    [ -n "$f" ] && [ -r "$f" ] || fail "bundle not readable: $f"
    {
        grep -oE 'registerRpc\([[:space:]]*"[^"]+"' "$f" | sed -E 's/.*"([^"]+)"$/\1/'
        grep -oE "registerRpc\([[:space:]]*'[^']+'" "$f" | sed -E "s/.*'([^']+)'\$/\1/"
    } 2>/dev/null \
      | grep -E '^[A-Za-z0-9][A-Za-z0-9_.:-]*$' \
      | LC_ALL=C sort -u
}

# Copy the bundle out of an image without running it. `docker create` does not
# start the container, so this is safe for a prod image.
extract_from_image() {
    local image="${1:-}" cid tmp
    [ -n "$image" ] || fail "extract-image needs an image ref"
    tmp="$(mktemp -d)"
    cid="$(docker create "$image" 2>/dev/null)" || fail "cannot create container from $image"
    # shellcheck disable=SC2064
    trap "docker rm -f '$cid' >/dev/null 2>&1 || true; rm -rf '$tmp'" RETURN
    docker cp "${cid}:${BUNDLE_PATH_IN_IMAGE}" "${tmp}/index.js" >/dev/null 2>&1 \
        || fail "no ${BUNDLE_PATH_IN_IMAGE} inside $image"
    extract_from_file "${tmp}/index.js"
}

# --- comparison -------------------------------------------------------------
compare_sets() {
    local baseline="${1:-}" candidate="${2:-}"
    [ -r "$baseline" ]  || fail "baseline list not readable: $baseline"
    [ -r "$candidate" ] || fail "candidate list not readable: $candidate"

    local b_sorted c_sorted missing added
    b_sorted="$(mktemp)"; c_sorted="$(mktemp)"
    missing="$(mktemp)";  added="$(mktemp)"
    LC_ALL=C sort -u "$baseline"  > "$b_sorted"
    LC_ALL=C sort -u "$candidate" > "$c_sorted"
    LC_ALL=C comm -23 "$b_sorted" "$c_sorted" > "$missing"   # live but not candidate
    LC_ALL=C comm -13 "$b_sorted" "$c_sorted" > "$added"     # candidate only

    local n_b n_c n_missing n_added
    n_b=$(wc -l < "$b_sorted" | tr -d ' ')
    n_c=$(wc -l < "$c_sorted" | tr -d ' ')
    n_missing=$(wc -l < "$missing" | tr -d ' ')
    n_added=$(wc -l < "$added" | tr -d ' ')

    log "live/baseline RPCs : $n_b"
    log "candidate RPCs     : $n_c"
    log "added by candidate : $n_added"
    log "MISSING in candidate: $n_missing"
    if [ "$n_added" -gt 0 ]; then
        log "--- added (informational, never blocks) ---"
        sed 's/^/  + /' "$added"
    fi

    if [ "$n_missing" -eq 0 ]; then
        log "PASS: candidate registers every RPC the live bundle registers (superset)."
        rm -f "$b_sorted" "$c_sorted" "$missing" "$added"
        return 0
    fi

    echo ""
    echo "[rpc-gate] ============================================================"
    echo "[rpc-gate]  CANDIDATE BUNDLE WOULD REMOVE $n_missing LIVE RPC(s)"
    echo "[rpc-gate] ============================================================"
    sed 's/^/  - /' "$missing"
    echo ""

    local allow="${ALLOW_RPC_REMOVAL:-}"
    if [ "$allow" = "true" ] || [ "$allow" = "1" ] || [ "$allow" = "all" ]; then
        log "ALLOW_RPC_REMOVAL=$allow — downgrading to a warning. Removal is intentional."
        rm -f "$b_sorted" "$c_sorted" "$missing" "$added"
        return 0
    fi
    if [ -n "$allow" ]; then
        # Treat ALLOW_RPC_REMOVAL as a comma/space separated allowlist.
        local allowed unexpected
        allowed="$(mktemp)"; unexpected="$(mktemp)"
        echo "$allow" | tr ',' '\n' | tr ' ' '\n' | grep -v '^$' | LC_ALL=C sort -u > "$allowed"
        LC_ALL=C comm -23 "$missing" "$allowed" > "$unexpected"
        if [ ! -s "$unexpected" ]; then
            log "every removed RPC is listed in ALLOW_RPC_REMOVAL — allowing."
            rm -f "$b_sorted" "$c_sorted" "$missing" "$added" "$allowed" "$unexpected"
            return 0
        fi
        echo "[rpc-gate] these removals are NOT in ALLOW_RPC_REMOVAL:" >&2
        sed 's/^/  - /' "$unexpected" >&2
        rm -f "$allowed" "$unexpected"
    fi

    echo "[rpc-gate] Refusing to deploy. Every RPC above is registered by the bundle" >&2
    echo "[rpc-gate] currently serving production and would return 404 after this roll." >&2
    echo "[rpc-gate] If the removal is deliberate, re-run with ALLOW_RPC_REMOVAL=true" >&2
    echo "[rpc-gate] (or ALLOW_RPC_REMOVAL='rpc_a,rpc_b' to allow just these)." >&2
    rm -f "$b_sorted" "$c_sorted" "$missing" "$added"
    return 1
}

# --- full CI gate -----------------------------------------------------------
gate() {
    local candidate_image="${1:-}" baseline_image="${2:-}"
    [ -n "$candidate_image" ] || fail "gate needs a candidate image ref"

    if [ -z "$baseline_image" ]; then
        local ns dep
        ns="${K8S_NAMESPACE:-aicart}"; dep="${K8S_DEPLOYMENT:-intelliverse-nakama}"
        baseline_image="$(kubectl get deployment "$dep" -n "$ns" \
            -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || true)"
    fi

    if [ -z "$baseline_image" ]; then
        log "WARN: could not resolve the live image — no baseline to compare against."
        log "WARN: skipping the superset gate. Set RPC_GATE_REQUIRE_BASELINE=true to make this fatal."
        [ "${RPC_GATE_REQUIRE_BASELINE:-false}" = "true" ] && return 1
        return 0
    fi

    log "candidate image : $candidate_image"
    log "baseline (live) : $baseline_image"

    local cand_list base_list
    cand_list="$(mktemp)"; base_list="$(mktemp)"
    extract_from_image "$candidate_image" > "$cand_list"
    [ -s "$cand_list" ] || fail "extracted 0 RPCs from the candidate — extractor or bundle path is wrong, refusing to pass vacuously"

    # The live digest can be unpullable (ECR migration gap / lifecycle expiry).
    # That must not wedge the pipeline, but it must be loud.
    if ! docker pull --quiet "$baseline_image" >/dev/null 2>&1; then
        log "WARN: cannot pull the live image $baseline_image (expired or never replicated)."
        log "WARN: no baseline -> skipping the superset gate. THIS IS THE UNSAFE PATH."
        [ "${RPC_GATE_REQUIRE_BASELINE:-false}" = "true" ] && return 1
        return 0
    fi
    extract_from_image "$baseline_image" > "$base_list"
    [ -s "$base_list" ] || fail "extracted 0 RPCs from the live bundle — refusing to pass vacuously"

    compare_sets "$base_list" "$cand_list"
}

case "${1:-}" in
    extract)       shift; extract_from_file  "${1:-}" ;;
    extract-image) shift; extract_from_image "${1:-}" ;;
    compare)       shift; compare_sets "${1:-}" "${2:-}" ;;
    gate)          shift; gate "${1:-}" "${2:-}" ;;
    *) cat >&2 <<EOF
usage: $0 <command>
  extract       <bundle.js>                  print sorted RPC ids
  extract-image <image-ref>                  print sorted RPC ids from an image
  compare       <baseline.txt> <candidate.txt>   fail if candidate drops any
  gate          <candidate-image> [<baseline-image>]
EOF
       exit 2 ;;
esac
