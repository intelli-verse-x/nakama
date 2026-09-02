#!/usr/bin/env bash
# Regression test for INC-2026-08-29: a successful deploy reported exit 1.
#
# pause_hpa/restore_hpa run from a `trap ... EXIT` inside the deploy step. Under
# `set -e` the handler's exit status becomes the step's exit status, so
# restore_hpa returning non-zero turns a completed, smoke-tested rollout into a
# red run — and skips every step after the deploy (multiplayer tier, analytics
# backfill, admin console). Runs 162-167 all failed this way.
#
# The invariant under test: restore_hpa must never fail its caller, for any
# state of /tmp/hpa-<name>-minmax. Needs no AWS or cluster access — kubectl is
# stubbed on PATH.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
stub="$(mktemp -d)"
trap 'rm -rf "$stub"' EXIT

# Stub kubectl so the test never touches a cluster. `patched` mimics success;
# the exit-1 variant proves `|| true` on the patch still keeps restore_hpa at 0.
make_kubectl() {
  cat > "$stub/kubectl" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = "get" ] && [ "\${2:-}" = "hpa" ]; then
  # No trailing newline — exactly what -o jsonpath emits.
  printf '2 10'
  exit 0
fi
exit ${1:-0}
EOF
  chmod +x "$stub/kubectl"
}
make_kubectl 0
export PATH="$stub:$PATH"

# shellcheck disable=SC1091
. "$here/ecr-digest.sh"

fails=0
check() {
  local name="$1" rc="$2"
  if [ "$rc" -eq 0 ]; then
    echo "  ok   $name"
  else
    echo "  FAIL $name (exit $rc)"
    fails=$((fails + 1))
  fi
}

# Each case runs restore_hpa as the EXIT-trap handler of a `set -e` subshell
# whose body succeeds, then asserts the subshell still exits 0. This reproduces
# the deploy step's exact structure rather than just calling the function.
run_case() {
  local name="$1" rc=0
  ( set -euo pipefail
    trap 'restore_hpa aicart testhpa' EXIT
    true
  ) || rc=$?
  check "$name" "$rc"
}

echo "restore_hpa must not fail a successful deploy:"

rm -f /tmp/hpa-testhpa-minmax
pause_hpa aicart testhpa 4 >/dev/null
run_case "after pause_hpa (file written by kubectl jsonpath)"

printf '2 10' > /tmp/hpa-testhpa-minmax
run_case "unterminated file (no trailing newline)"

rm -f /tmp/hpa-testhpa-minmax
run_case "no saved min/max file at all"

: > /tmp/hpa-testhpa-minmax
run_case "empty file"

printf '2 10\n' > /tmp/hpa-testhpa-minmax
make_kubectl 1  # kubectl patch itself fails
run_case "kubectl patch fails"
make_kubectl 0

# The other half of the contract: cleanup must not SWALLOW a real failure.
rm -f /tmp/hpa-testhpa-minmax
pause_hpa aicart testhpa 4 >/dev/null
rc=0
( set -euo pipefail
  trap 'restore_hpa aicart testhpa' EXIT
  false
) || rc=$?
if [ "$rc" -ne 0 ]; then
  echo "  ok   a genuinely failing deploy body still fails the step"
else
  echo "  FAIL cleanup masked a failing deploy body"
  fails=$((fails + 1))
fi

rm -f /tmp/hpa-testhpa-minmax
if [ "$fails" -ne 0 ]; then
  echo "$fails check(s) failed."
  exit 1
fi
echo "All restore_hpa trap checks passed."
