#!/bin/bash
# Seed QuizVerse quest configuration into Nakama
#
# Usage:
#   ./scripts/seed_quizverse_quests.sh [nakama_url] [server_key]
#
# Defaults:
#   nakama_url = http://localhost:7350
#   server_key = defaultkey (change in production!)

set -e

NAKAMA_URL="${1:-http://localhost:7350}"
SERVER_KEY="${2:-defaultkey}"
GAME_ID="126bf539-dae2-4bcf-964d-316c0fa1f92b"  # QuizVerse game ID

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/../data/modules/src/quests/quizverse_quest_config.json"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "❌ Config file not found: $CONFIG_FILE"
  exit 1
fi

echo "📦 Loading quest config from: $CONFIG_FILE"
echo "🎮 Game ID: $GAME_ID"
echo "🔗 Nakama URL: $NAKAMA_URL"

# Build the payload: { "gameId": "...", "config": { quests config } }
CONFIG_CONTENT=$(cat "$CONFIG_FILE")
PAYLOAD=$(jq -n --arg gameId "$GAME_ID" --argjson config "$CONFIG_CONTENT" '{gameId: $gameId, config: $config}')

# Call the admin RPC via HTTP API with server key auth
RESPONSE=$(curl -s -X POST \
  "$NAKAMA_URL/v2/rpc/quest_engine_admin_save_config?unwrap=true" \
  -H "Content-Type: application/json" \
  -H "Authorization: Basic $(echo -n "$SERVER_KEY:" | base64)" \
  -d "$PAYLOAD")

echo ""
echo "📤 Response:"
echo "$RESPONSE" | jq .

# Check for success
if echo "$RESPONSE" | jq -e '.saved == true' > /dev/null 2>&1; then
  QUEST_COUNT=$(echo "$RESPONSE" | jq -r '.questCount')
  echo ""
  echo "✅ Successfully loaded $QUEST_COUNT quests!"
else
  echo ""
  echo "❌ Failed to load quests. Check the response above."
  exit 1
fi
