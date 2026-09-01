#!/usr/bin/env bash
# Exercises deploy/patha-hotfix/entrypoint.sh without a cluster.
#
# Uses file:// URLs (curl handles them) and a stub `nakama` binary, so the
# whole accept/reject matrix runs locally in about a second.
#
# The case that matters most is [5]: a bundle that is valid JavaScript, clears
# the byte floor, and has a correct checksum, but registers fewer RPCs than
# production serves. That is the regression the old 8.8 MB byte floor could not
# see, and it is the reason the RPC floor exists.
#
# usage: deploy/patha-hotfix/test-entrypoint.sh [good-bundle.js] [stale-bundle.js]

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ENTRYPOINT="$HERE/entrypoint.sh"
REPO="$(cd "$HERE/../.." && pwd)"

GOOD="${1:-$REPO/data/modules/index.js}"
STALE="${2:-}"

passed=0; failed=0
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/modules" "$WORK/bin"
cat >"$WORK/bin/nakama" <<'STUB'
#!/bin/sh
echo "STUB-NAKAMA-STARTED args=$*"
STUB
chmod +x "$WORK/bin/nakama"

run_case() {
    # run_case <label> <expect: apply|refuse|inert> [env assignments...]
    local label="$1" expect="$2"; shift 2
    rm -f "$WORK/modules/index.js"
    echo "BAKED" >"$WORK/modules/index.js"

    local out rc
    out=$(env "$@" \
        PATHA_MODULES_DIR="$WORK/modules" \
        PATHA_NAKAMA_BIN="$WORK/bin/nakama" \
        PATHA_NAKAMA_CONFIG="/dev/null" \
        sh "$ENTRYPOINT" 2>&1)
    rc=$?

    local verdict
    if [ "$rc" -ne 0 ]; then
        verdict=refuse
    elif grep -q 'APPLIED hotfix bundle' <<<"$out"; then
        verdict=apply
    else
        verdict=inert
    fi

    local baked_intact=no
    grep -qx 'BAKED' "$WORK/modules/index.js" 2>/dev/null && baked_intact=yes

    if [ "$verdict" = "$expect" ]; then
        echo "  PASS  $label  (verdict=$verdict rc=$rc, baked-bundle-intact=$baked_intact)"
        passed=$((passed+1))
    else
        echo "  FAIL  $label  expected=$expect got=$verdict rc=$rc"
        echo "$out" | sed 's/^/          /'
        failed=$((failed+1))
    fi

    # A refused hotfix must never have clobbered the bundle already in place.
    if [ "$expect" = refuse ] && [ "$baked_intact" != yes ]; then
        echo "  FAIL  $label  refused BUT overwrote the baked bundle"
        failed=$((failed+1))
    fi

    # Any accepted or inert run must actually start the server.
    if [ "$expect" != refuse ] && ! grep -q 'STUB-NAKAMA-STARTED' <<<"$out"; then
        echo "  FAIL  $label  did not exec the server"
        failed=$((failed+1))
    fi
}

sha_of() { sha256sum "$1" | cut -d' ' -f1; }

echo "== patha-hotfix entrypoint tests =="
echo "good bundle : $GOOD ($(wc -c <"$GOOD" | tr -d ' ') bytes)"

echo
echo "[1] no URL -> inert, serves the baked bundle"
run_case "inert when URL empty" inert PATHA_INDEX_JS_URL=""

echo
echo "[2] URL but no checksum -> refuse (a URL alone is not enough authority)"
run_case "URL without SHA256" refuse \
    PATHA_INDEX_JS_URL="file://$GOOD"

echo
echo "[3] URL with WRONG checksum -> refuse"
run_case "SHA256 mismatch" refuse \
    PATHA_INDEX_JS_URL="file://$GOOD" \
    PATHA_INDEX_JS_SHA256="0000000000000000000000000000000000000000000000000000000000000000"

echo
echo "[4] correct checksum but below the byte floor -> refuse (truncation)"
TRUNC="$WORK/trunc.js"
head -c 1000000 "$GOOD" >"$TRUNC"
run_case "byte floor" refuse \
    PATHA_INDEX_JS_URL="file://$TRUNC" \
    PATHA_INDEX_JS_SHA256="$(sha_of "$TRUNC")"

echo
echo "[5] valid JS, correct checksum, ABOVE the byte floor, but too few RPCs"
echo "    -> refuse. This is the 222-RPC regression the byte floor could not see."
if [ -n "$STALE" ] && [ -f "$STALE" ]; then
    STALE_BUNDLE="$STALE"
else
    # Synthesise the shape: a bundle that clears the 9.1 MB floor but registers
    # far fewer RPCs than production. Padding is a JS comment, so it stays
    # valid JavaScript — exactly like a real stale-tree build.
    STALE_BUNDLE="$WORK/stale.js"
    {
        echo "function InitModule() {}"
        for i in $(seq 1 50); do echo "initializer.registerRpc(\"rpc_$i\", h);"; done
        printf '/* '
        head -c 9500000 /dev/zero | tr '\0' 'x'
        printf ' */\n'
    } >"$STALE_BUNDLE"
fi
echo "    stale bundle: $(wc -c <"$STALE_BUNDLE" | tr -d ' ') bytes"
run_case "RPC-count floor" refuse \
    PATHA_INDEX_JS_URL="file://$STALE_BUNDLE" \
    PATHA_INDEX_JS_SHA256="$(sha_of "$STALE_BUNDLE")"

echo
echo "[6] not a Nakama bundle (no InitModule) -> refuse"
NOTBUNDLE="$WORK/notbundle.js"
{ printf '/* '; head -c 9500000 /dev/zero | tr '\0' 'x'; printf ' */\n'
  for i in $(seq 1 1400); do echo "initializer.registerRpc(\"rpc_$i\", h);"; done; } >"$NOTBUNDLE"
run_case "InitModule sanity" refuse \
    PATHA_INDEX_JS_URL="file://$NOTBUNDLE" \
    PATHA_INDEX_JS_SHA256="$(sha_of "$NOTBUNDLE")"

echo
echo "[7] the real production bundle with a correct checksum -> APPLY"
run_case "good bundle applies" apply \
    PATHA_INDEX_JS_URL="file://$GOOD" \
    PATHA_INDEX_JS_SHA256="$(sha_of "$GOOD")"

echo
echo "passed=$passed failed=$failed"
[ "$failed" -eq 0 ]
