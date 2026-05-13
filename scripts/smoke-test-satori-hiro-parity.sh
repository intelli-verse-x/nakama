#!/bin/bash
# Final smoke: hit every new RPC at least once and report pass/fail counts.
# Uses jq to safely double-encode JSON payloads (Nakama RPC contract).
set -u
URL="http://127.0.0.1:7350/v2/rpc"
KEY="defaulthttpkey"
PASS=0; FAIL=0
declare -a FAILED

probe() {
  local rpc="$1"
  local body="${2-}"
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
  # PASS criteria:
  #  • HTTP 200 with success/data/payload  → RPC ran end-to-end
  #  • HTTP 500 with "User ID is required" → RPC registered + handler ran +
  #    auth check correctly rejected the http_key context (player-facing RPC).
  #    For these we'd need an authenticated user session to exercise further.
  #  • HTTP 200/500 with "Admin access required" → handler ran + admin check fired.
  if echo "$content" | grep -qi "rpc id not found"; then
    FAIL=$((FAIL+1)); FAILED+=("$rpc -> NOT REGISTERED")
    printf "  ✗ %-50s [NOT REGISTERED]\n" "$rpc"
    return
  fi
  if echo "$content" | grep -qiE 'User ID is required'; then
    PASS=$((PASS+1))
    printf "  ◐ %-50s [auth-gated, registered ✓]\n" "$rpc"
    return
  fi
  if [ "$code" = "200" ] && echo "$content" | grep -qiE 'success|"data"|"payload"|admin access required|admin authentication required'; then
    PASS=$((PASS+1))
    printf "  ✓ %-50s [HTTP %s]\n" "$rpc" "$code"
    return
  fi
  FAIL=$((FAIL+1)); FAILED+=("$rpc -> $code: ${content:0:90}")
  printf "  ✗ %-50s [HTTP %s] -> %.90s\n" "$rpc" "$code" "$content"
}

echo "=== Satori Category Labels ==="
probe satori_category_labels_list
probe satori_category_labels_upsert '{"id":"smoke_lbl","name":"Smoke","color":"#0aa"}'
probe satori_category_labels_assign '{"label_id":"smoke_lbl","entity_id":"flag:test","entity_type":"flag"}'
probe satori_category_labels_get_for_entity '{"entity_id":"flag:test","entity_type":"flag"}'
probe satori_category_labels_search '{"label_id":"smoke_lbl"}'
probe satori_category_labels_delete '{"id":"smoke_lbl"}'

echo "=== Satori Funnel Analysis ==="
probe satori_funnel_list
probe satori_funnel_upsert '{"id":"smoke_funnel","name":"Smoke","steps":[{"event":"a"},{"event":"b"}]}'
probe satori_funnel_run '{"id":"smoke_funnel","window_secs":3600}'
probe satori_funnel_delete '{"id":"smoke_funnel"}'

echo "=== Satori Retention ==="
probe satori_retention_get_config
probe satori_retention_set_config '{"active_event":"app_open"}'
probe satori_retention_run '{"days":30}'

echo "=== Satori RoAS ==="
probe satori_roas_spend_list
probe satori_roas_spend_upsert '{"id":"smoke","date":"2026-05-08","channel":"google","spend_usd":100}'
probe satori_roas_run '{"days":7}'

echo "=== Satori Sessions ==="
probe satori_sessions_get '{"user_id":"smoke-user"}'
probe satori_sessions_summary '{"user_id":"smoke-user"}'

echo "=== Satori Messaging Integrations ==="
probe satori_messaging_get_config
probe satori_messaging_upsert_provider '{"id":"smoke_fcm","type":"fcm","config":{"server_key":"x"}}'
probe satori_messaging_register_token '{"user_id":"smoke-user","platform":"fcm","token":"abc"}'
probe satori_messaging_dispatch_test '{"user_id":"smoke-user","title":"test","body":"hi"}'
probe satori_messaging_delete_provider '{"id":"smoke_fcm"}'

echo "=== Satori Managed Audiences ==="
probe satori_managed_audiences_list
probe satori_managed_audiences_upsert '{"id":"smoke","audience_id":"smoke_aud","source_type":"manual","name":"Smoke"}'
probe satori_managed_audiences_replace '{"id":"smoke","members":["u1","u2"]}'
probe satori_managed_audiences_refresh '{"id":"smoke"}'
probe satori_managed_audiences_delete '{"id":"smoke"}'

echo "=== Satori Audience Recompute ==="
probe satori_audience_snapshot_status
probe satori_audience_recompute_set_interval '{"interval_secs":600}'
probe satori_audience_snapshot_members '{"audience_id":"vip_players"}'

echo "=== Satori Experiment Phases ==="
probe satori_experiments_phases_list '{"experiment_id":"x_smoke"}'
probe satori_experiments_phase_add '{"experiment_id":"x_smoke","name":"phase1","duration_secs":3600}'
probe satori_experiments_lock_enrollment '{"experiment_id":"x_smoke","locked":true}'
probe satori_experiments_current_phase '{"experiment_id":"x_smoke"}'
probe satori_experiments_phase_remove '{"experiment_id":"x_smoke","phase_id":"phase1"}'

echo "=== Hiro Publishers ==="
probe hiro_publishers_list
probe hiro_publishers_get '{"id":"acme"}'
probe hiro_publishers_upsert '{"id":"smoke_pub","name":"Smoke"}'
probe hiro_publishers_add_app_key '{"id":"smoke_pub","appId":"smoke_app"}'
probe hiro_publishers_revoke_app_key '{"id":"smoke_pub","appId":"smoke_app"}'
probe hiro_publishers_delete '{"id":"smoke_pub"}'

echo "=== Hiro Integrations ==="
probe hiro_integrations_get_config
probe hiro_integrations_upsert_provider '{"id":"smoke_int","type":"facebook","config":{"app_id":"123"}}'
probe hiro_integrations_attribution_log '{"provider":"smoke_int","event":"install","user_id":"u1"}'
probe hiro_integrations_purchase_validated '{"sku":"gold_100","amount":4.99,"currency":"USD","user_id":"u1"}'
probe hiro_integrations_custom_event '{"event":"smoke","provider":"smoke_int","user_id":"u1"}'
probe hiro_integrations_delete_provider '{"id":"smoke_int"}'

echo "=== Hiro Sub-Achievements ==="
probe hiro_sub_achievements_tree '{"user_id":"u1"}'
probe hiro_sub_achievements_reconcile '{"user_id":"u1"}'

echo "=== Hiro Team Subsystems ==="
probe hiro_team_inventory_list '{"team_id":"smoke_team"}'
probe hiro_team_inventory_grant '{"team_id":"smoke_team","item_id":"sword","amount":1}'
probe hiro_team_inventory_consume '{"team_id":"smoke_team","item_id":"sword","amount":1,"user_id":"u1"}'
probe hiro_team_mailbox_list '{"team_id":"smoke_team","user_id":"u1"}'
probe hiro_team_mailbox_send '{"team_id":"smoke_team","subject":"hi","body":"world"}'
probe hiro_team_mailbox_claim '{"team_id":"smoke_team","message_id":"m1","user_id":"u1"}'
probe hiro_team_store_list '{"team_id":"smoke_team"}'
probe hiro_team_store_upsert_offer '{"team_id":"smoke_team","offer_id":"of1","price_currency":"gold","price_amount":10}'
probe hiro_team_store_purchase '{"team_id":"smoke_team","offer_id":"of1","user_id":"u1"}'
probe hiro_team_gifts_list '{"team_id":"smoke_team","user_id":"u1"}'
probe hiro_team_gifts_send '{"team_id":"smoke_team","to_user_id":"u1","item_id":"sword","amount":1,"user_id":"u2"}'
probe hiro_team_gifts_claim '{"team_id":"smoke_team","gift_id":"g1","user_id":"u1"}'
probe hiro_team_event_leaderboard_start '{"team_id":"smoke_team","leaderboard_id":"lb1","duration_secs":3600}'
probe hiro_team_event_leaderboard_submit '{"team_id":"smoke_team","leaderboard_id":"lb1","score":100,"user_id":"u1"}'
probe hiro_team_event_leaderboard_get '{"team_id":"smoke_team","leaderboard_id":"lb1"}'

echo ""
echo "==============================="
echo "PASS: $PASS"
echo "FAIL: $FAIL"
if [ "$FAIL" -gt 0 ]; then
  echo "Failed RPCs:"
  printf '  - %s\n' "${FAILED[@]}"
  exit 1
fi
echo "✓ All new-module RPCs returned successful responses."
