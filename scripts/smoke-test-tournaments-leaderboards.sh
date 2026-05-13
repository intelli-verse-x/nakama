#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────
# Regression smoke for the Bracket-Tournaments + Event-Leaderboards RPCs.
# Covers:
#   • Every RPC registered with Nakama (HTTP 404 / "rpc id not found" = fail).
#   • Admin-gating actually fires for admin-only endpoints.
#   • Auth-gating actually fires for player-only endpoints.
#   • Edge-case input validation rejects bad payloads with a clear error
#     (not a 500 server crash, not a silent success).
#
# Usage:
#   ./scripts/smoke-test-tournaments-leaderboards.sh
#       Probes 127.0.0.1:7350 with the defaulthttpkey.
#   NAKAMA_HTTP_URL=http://nakama:7350 NAKAMA_HTTP_KEY=… \
#       ./scripts/smoke-test-tournaments-leaderboards.sh
#       Same script against a different Nakama (e.g. EKS port-forward).
#
# This is intentionally NOT a unit test — it asserts the contract at the
# wire boundary that clients actually hit. Adding new RPCs to either module
# requires adding a probe here so we don't ship un-tested surface area.
#
# Exit codes:
#   0 — all probes pass
#   1 — one or more RPCs failed registration or input validation
# ──────────────────────────────────────────────────────────────────────────
set -u
URL="${NAKAMA_HTTP_URL:-http://127.0.0.1:7350}/v2/rpc"
KEY="${NAKAMA_HTTP_KEY:-defaulthttpkey}"
PASS=0; FAIL=0
declare -a FAILED

probe() {
  local rpc="$1"
  local body="${2-}"
  local expected="${3-any}"   # any | auth-gated | admin-gated | error
  local error_substr="${4-}"
  if [ -z "$body" ]; then body='{}'; fi
  local encoded
  encoded=$(jq -nc --arg b "$body" '$b')   # → "{...}" (a JSON string)
  local resp
  resp=$(curl -sS --max-time 5 -o /tmp/resp.body -w "%{http_code}" \
    -X POST "${URL}/${rpc}?http_key=${KEY}" \
    -H "Content-Type: application/json" \
    --data-raw "$encoded")
  local code="$resp"
  local content="$(cat /tmp/resp.body)"

  # Hard fail: RPC not registered at all.
  if echo "$content" | grep -qi "rpc id not found"; then
    FAIL=$((FAIL+1)); FAILED+=("$rpc -> NOT REGISTERED")
    printf "  ✗ %-55s [NOT REGISTERED]\n" "$rpc"
    return
  fi

  case "$expected" in
    auth-gated)
      # http_key context has no userId — auth-gated RPC must reject.
      if echo "$content" | grep -qiE 'user ID is required|user not authenticated'; then
        PASS=$((PASS+1))
        printf "  ◐ %-55s [auth-gated ✓]\n" "$rpc"
        return
      fi
      ;;
    admin-gated)
      if echo "$content" | grep -qiE 'admin (access|authentication) required'; then
        PASS=$((PASS+1))
        printf "  ◐ %-55s [admin-gated ✓]\n" "$rpc"
        return
      fi
      ;;
    error)
      # Expect a specific error string in the response (input validation).
      if echo "$content" | grep -qiF "$error_substr"; then
        PASS=$((PASS+1))
        printf "  ✓ %-55s [rejected: %s ✓]\n" "$rpc" "$error_substr"
        return
      fi
      FAIL=$((FAIL+1)); FAILED+=("$rpc -> expected error '$error_substr' but got: ${content:0:100}")
      printf "  ✗ %-55s [expected '%s', got: %.80s]\n" "$rpc" "$error_substr" "$content"
      return
      ;;
    any)
      if [ "$code" = "200" ] || echo "$content" | grep -qiE 'success|"data"|"payload"|admin|user ID'; then
        PASS=$((PASS+1))
        printf "  ✓ %-55s [HTTP %s]\n" "$rpc" "$code"
        return
      fi
      ;;
  esac

  FAIL=$((FAIL+1)); FAILED+=("$rpc -> $code: ${content:0:100}")
  printf "  ✗ %-55s [HTTP %s] -> %.80s\n" "$rpc" "$code" "$content"
}

echo "═══ Bracket Tournaments RPCs (registration + admin-gating) ═══"
probe bracket_tournament_create  '{"game_id":"smoke","flavor":"ROUND_ROBIN","team_count":4}' admin-gated
probe bracket_tournament_seed    '{"game_id":"smoke","flavor":"ROUND_ROBIN","teams":[]}'      admin-gated
probe bracket_tournament_start   '{"game_id":"smoke","flavor":"ROUND_ROBIN"}'                  admin-gated
probe bracket_tournament_cancel  '{"game_id":"smoke","flavor":"ROUND_ROBIN"}'                  admin-gated
probe bracket_tournament_submit_result  '{"game_id":"smoke","bracket_match_id":1}'            any
probe bracket_tournament_status  '{"game_id":"smoke"}'                                          any
probe bracket_tournament_list    '{"game_id":"smoke"}'                                          any

echo
echo "═══ Bracket Tournaments — input validation edge cases ═══"
probe bracket_tournament_create  '{"flavor":"ROUND_ROBIN","team_count":4}'                      error "game_id is required"
# Admin-gated rejects BEFORE input validation runs (intentional — don't leak
# RPC contract to anonymous callers). To exercise these we'd need an admin
# session; the registration probe above is the contract bar.

echo
echo "═══ Event Leaderboards RPCs (registration + auth-gating) ═══"
probe hiro_event_lb_list                 '{}'                                                   auth-gated
probe hiro_event_lb_submit               '{"eventId":"smoke","score":100}'                       auth-gated
probe hiro_event_lb_claim                '{"eventId":"smoke"}'                                   auth-gated
probe hiro_event_lb_get                  '{"eventId":"smoke"}'                                   any
# Backward-compat alias names — same handler, same auth gate.
probe hiro_event_leaderboards_list       '{}'                                                   auth-gated
probe hiro_event_leaderboards_submit     '{"eventId":"smoke","score":100}'                       auth-gated
probe hiro_event_leaderboards_claim      '{"eventId":"smoke"}'                                   auth-gated
probe hiro_event_leaderboards_get        '{"eventId":"smoke"}'                                   any

echo
echo "═══ Event Leaderboards — input validation edge cases ═══"
# These run BEFORE the auth gate so they exercise input-validation reliably.
probe hiro_event_lb_get                  '{}'                                                   error "eventId required"
probe hiro_event_lb_get                  '{"eventId":"../etc/passwd"}'                          error "must match"
probe hiro_event_lb_get                  '{"eventId":"smoke","limit":99999}'                    any
# Note: score/range validation on hiro_event_lb_submit runs AFTER the
# auth-gate, so it's not exercisable with http_key. Covered by the
# stand-alone unit-test fixture in data/modules/src/hiro/event-leaderboards/
# (run via tsc --noEmit + Goja runtime in nakama_js_health smoke).

echo
echo "═══════════════════════════════════════════════════════════"
echo "  Passed: ${PASS}   Failed: ${FAIL}"
echo "═══════════════════════════════════════════════════════════"
if [ "$FAIL" -gt 0 ]; then
  echo
  echo "Failed probes:"
  for f in "${FAILED[@]}"; do echo "  - $f"; done
  exit 1
fi
exit 0
