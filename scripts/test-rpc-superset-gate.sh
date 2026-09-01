#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Regression tests for scripts/rpc-superset-gate.sh, run against the REAL
# production bundles archived during the 2026-08-28 incident. Synthetic input
# is deliberately avoided: a gate that only works on toy data is worthless.
#
#   index.js.57b7669cc5 — the bundle prod ran during the incident
#   index.js.0fde6b25   — the bundle prod runs now (a strict superset of it)
#
# Archive location is overridable: RPC_GATE_FIXTURES=/path ./test-...sh
# The tests skip (exit 0) when the archive is absent, so CI without the
# fixtures does not go red.
# ---------------------------------------------------------------------------
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
GATE="${HERE}/rpc-superset-gate.sh"
FIX="${RPC_GATE_FIXTURES:-$HOME/dev/prod-bundle-archive-20260828}"
OLD="${FIX}/index.js.57b7669cc5"
NEW="${FIX}/index.js.0fde6b25"
ASR_SRC="${RPC_GATE_ASR_SRC:-${HERE}/../data/modules/src/recorder/recorder_asr.ts}"
# recorder_asr is not on master yet (it is the pending additive change this
# gate must not block), so fall back to a checkout that does have it.
[ -r "$ASR_SRC" ] || ASR_SRC="$HOME/dev/nakama/data/modules/src/recorder/recorder_asr.ts"

if [ ! -r "$OLD" ] || [ ! -r "$NEW" ]; then
    echo "SKIP: bundle archive not found at $FIX"
    exit 0
fi

PASS=0; FAIL=0
check() { # check <label> <expected-rc> <actual-rc>
    if [ "$2" = "$3" ]; then echo "  PASS  $1 (rc=$3)"; PASS=$((PASS+1))
    else echo "  FAIL  $1 (expected rc=$2, got rc=$3)"; FAIL=$((FAIL+1)); fi
}

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
"$GATE" extract "$OLD" > "$TMP/old.txt"
"$GATE" extract "$NEW" > "$TMP/new.txt"
echo "fixtures: old=$(wc -l < "$TMP/old.txt" | tr -d ' ') rpcs  new=$(wc -l < "$TMP/new.txt" | tr -d ' ') rpcs"

echo "[1] forward: new vs old must PASS (legitimate superset)"
"$GATE" compare "$TMP/old.txt" "$TMP/new.txt" >/dev/null 2>&1; check "forward superset" 0 $?

echo "[2] reverse: old vs new must FAIL and name every dropped RPC"
OUT="$("$GATE" compare "$TMP/new.txt" "$TMP/old.txt" 2>&1)"; RC=$?
check "reverse regression blocked" 1 "$RC"
MISSING="$(printf '%s\n' "$OUT" | grep -cE '^  - ')"
check "reverse names 11 dropped RPCs (got $MISSING)" 11 "$MISSING"

echo "[3] reverse + ALLOW_RPC_REMOVAL=true must PASS (deliberate removal)"
ALLOW_RPC_REMOVAL=true "$GATE" compare "$TMP/new.txt" "$TMP/old.txt" >/dev/null 2>&1; check "escape hatch" 0 $?

echo "[4] reverse + partial allowlist must still FAIL"
ALLOW_RPC_REMOVAL='reward_joke,reward_quote,reward_yoda' \
    "$GATE" compare "$TMP/new.txt" "$TMP/old.txt" >/dev/null 2>&1; check "partial allowlist" 1 $?

echo "[5] purely additive (live bundle + real recorder_asr module) must PASS"
if [ -r "$ASR_SRC" ]; then
    cat "$NEW" "$ASR_SRC" > "$TMP/plus_asr.js"
    "$GATE" extract "$TMP/plus_asr.js" > "$TMP/plus_asr.txt"
    "$GATE" compare "$TMP/new.txt" "$TMP/plus_asr.txt" >/dev/null 2>&1; check "additive not blocked" 0 $?
    ADDED=$("$GATE" compare "$TMP/new.txt" "$TMP/plus_asr.txt" 2>&1 | grep -cE '^  \+ recorder_asr_')
    check "additive adds 5 recorder_asr RPCs (got $ADDED)" 5 "$ADDED"
else
    echo "  SKIP  recorder_asr source not present at $ASR_SRC"
fi

echo "[6] extractor must never return an empty set for a real bundle"
[ "$(wc -l < "$TMP/new.txt" | tr -d ' ')" -gt 1000 ]; check "extractor sanity" 0 $?

echo ""
echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
