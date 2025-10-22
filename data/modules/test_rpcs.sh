#!/bin/bash
# Test script for Nakama Leaderboard & Social Features RPCs
# This script demonstrates how to call each RPC endpoint

# Configuration
NAKAMA_HOST="${NAKAMA_HOST:-127.0.0.1}"
NAKAMA_PORT="${NAKAMA_PORT:-7350}"
BASE_URL="http://${NAKAMA_HOST}:${NAKAMA_PORT}/v2/rpc"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Admin token (replace with actual token)
ADMIN_TOKEN="${ADMIN_TOKEN:-admin_token_here}"

# Player token (replace with actual token)
PLAYER_TOKEN="${PLAYER_TOKEN:-player_token_here}"

echo "========================================="
echo "Nakama Leaderboard & Social Features Test"
echo "========================================="
echo ""
echo "Target: ${BASE_URL}"
echo ""

# Test function
test_rpc() {
    local name=$1
    local endpoint=$2
    local token=$3
    local payload=$4
    
    echo -e "${YELLOW}Testing: ${name}${NC}"
    echo "Endpoint: ${endpoint}"
    echo "Payload: ${payload}"
    
    response=$(curl -s -X POST "${BASE_URL}/${endpoint}" \
        -H "Authorization: Bearer ${token}" \
        -H "Content-Type: application/json" \
        -d "${payload}")
    
    if echo "$response" | grep -q '"success":true'; then
        echo -e "${GREEN}✓ Success${NC}"
        echo "Response: ${response}" | jq '.' 2>/dev/null || echo "${response}"
    else
        echo -e "${RED}✗ Failed${NC}"
        echo "Response: ${response}" | jq '.' 2>/dev/null || echo "${response}"
    fi
    echo ""
}

echo "========================================="
echo "1. LEADERBOARD MANAGEMENT TESTS"
echo "========================================="
echo ""

# Test 1: Create standard leaderboards
test_rpc \
    "Create Standard Leaderboards" \
    "create_all_leaderboards_persistent" \
    "${ADMIN_TOKEN}" \
    '{}'

# Test 2: Create leaderboards with friends
test_rpc \
    "Create Leaderboards with Friends" \
    "create_all_leaderboards_with_friends" \
    "${ADMIN_TOKEN}" \
    '{}'

echo "========================================="
echo "2. SCORE SUBMISSION TESTS"
echo "========================================="
echo ""

# Test 3: Submit score sync
test_rpc \
    "Submit Score Sync" \
    "submit_score_sync" \
    "${PLAYER_TOKEN}" \
    '{"gameId":"test-game-1","score":1000}'

# Test 4: Submit score with aggregate
test_rpc \
    "Submit Score with Aggregate" \
    "submit_score_with_aggregate" \
    "${PLAYER_TOKEN}" \
    '{"gameId":"test-game-2","score":2000}'

# Test 5: Submit score with friends sync
test_rpc \
    "Submit Score with Friends Sync" \
    "submit_score_with_friends_sync" \
    "${PLAYER_TOKEN}" \
    '{"gameId":"test-game-3","score":3000}'

echo "========================================="
echo "3. LEADERBOARD QUERY TESTS"
echo "========================================="
echo ""

# Test 6: Get friend leaderboard (game)
test_rpc \
    "Get Friend Leaderboard (Game)" \
    "get_friend_leaderboard" \
    "${PLAYER_TOKEN}" \
    '{"gameId":"test-game-1","limit":10}'

# Test 7: Get friend leaderboard (global)
test_rpc \
    "Get Friend Leaderboard (Global)" \
    "get_friend_leaderboard" \
    "${PLAYER_TOKEN}" \
    '{"limit":20}'

echo "========================================="
echo "4. SOCIAL FEATURES TESTS"
echo "========================================="
echo ""

# Test 8: Send friend invite
test_rpc \
    "Send Friend Invite" \
    "send_friend_invite" \
    "${PLAYER_TOKEN}" \
    '{"targetUserId":"test-user-123"}'

# Test 9: Accept friend invite
test_rpc \
    "Accept Friend Invite" \
    "accept_friend_invite" \
    "${PLAYER_TOKEN}" \
    '{"requesterUserId":"test-user-456"}'

# Test 10: Decline friend invite
test_rpc \
    "Decline Friend Invite" \
    "decline_friend_invite" \
    "${PLAYER_TOKEN}" \
    '{"requesterUserId":"test-user-789"}'

echo "========================================="
echo "5. NOTIFICATION TESTS"
echo "========================================="
echo ""

# Test 11: Get notifications
test_rpc \
    "Get Notifications" \
    "get_notifications" \
    "${PLAYER_TOKEN}" \
    '{}'

echo "========================================="
echo "TEST SUMMARY"
echo "========================================="
echo ""
echo "All RPC endpoints have been tested."
echo ""
echo -e "${YELLOW}Note:${NC} Actual results depend on:"
echo "  - Valid authentication tokens"
echo "  - Nakama server running and accessible"
echo "  - Leaderboards created"
echo "  - Valid user IDs for social features"
echo ""
echo "For interactive testing, use the examples in:"
echo "  - README_LEADERBOARD_RPC.md"
echo "  - RPC_API_REFERENCE.md"
echo ""
