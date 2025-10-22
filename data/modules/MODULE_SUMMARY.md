# Nakama Leaderboard & Social Features Module

## Quick Start

This module provides a comprehensive leaderboard and social features system for the Nakama game server, specifically designed for the IntelliVerse ecosystem.

### Features at a Glance

✅ **10 RPC Endpoints** for leaderboards, scoring, and social features  
✅ **Friend Leaderboards** with automatic friend-list filtering  
✅ **Score Aggregation** across multiple games for global rankings  
✅ **Social Features** including friend invites and notifications  
✅ **Persistent Storage** with automatic leaderboard registry  
✅ **Security-First** design with comprehensive input validation  

---

## Files in This Module

| File | Purpose | Lines |
|------|---------|-------|
| `leaderboard_rpc.ts` | Main implementation with all RPC endpoints | 770 |
| `README_LEADERBOARD_RPC.md` | Comprehensive feature guide and usage documentation | 487 |
| `RPC_API_REFERENCE.md` | Quick API reference for all endpoints | 394 |
| `SECURITY_ANALYSIS.md` | Security audit report and compliance review | 297 |
| `test_rpcs.sh` | Test script for all RPC endpoints | 146 |
| `MODULE_SUMMARY.md` | This file - Quick overview and navigation | - |

---

## Available RPC Endpoints

### Leaderboard Management
1. `create_all_leaderboards_persistent` - Create standard leaderboards
2. `create_all_leaderboards_with_friends` - Create leaderboards with friend support

### Score Submission
3. `submit_score_sync` - Sync score to game and global leaderboards
4. `submit_score_with_aggregate` - Submit score with cross-game aggregation
5. `submit_score_with_friends_sync` - Sync to normal and friend leaderboards

### Queries
6. `get_friend_leaderboard` - Get friend-only leaderboard rankings

### Social Features
7. `send_friend_invite` - Send friend request
8. `accept_friend_invite` - Accept friend request
9. `decline_friend_invite` - Decline/block friend request

### Notifications
10. `get_notifications` - Retrieve user notifications

---

## Quick Examples

### Create Leaderboards (Admin)
```bash
curl -X POST "http://127.0.0.1:7350/v2/rpc/create_all_leaderboards_with_friends" \
  -H "Authorization: Bearer <admin_token>"
```

### Submit Score (Player)
```bash
curl -X POST "http://127.0.0.1:7350/v2/rpc/submit_score_with_aggregate" \
  -H "Authorization: Bearer <player_token>" \
  -H "Content-Type: application/json" \
  -d '{"gameId":"game1","score":5000}'
```

### Get Friend Leaderboard (Player)
```bash
curl -X POST "http://127.0.0.1:7350/v2/rpc/get_friend_leaderboard" \
  -H "Authorization: Bearer <player_token>" \
  -H "Content-Type: application/json" \
  -d '{"gameId":"game1","limit":10}'
```

---

## Documentation Guide

### For Developers
Start here: **`RPC_API_REFERENCE.md`**
- Quick endpoint reference
- Request/response formats
- Error codes
- Copy-paste examples

### For System Architects
Read: **`README_LEADERBOARD_RPC.md`**
- Architecture overview
- Technical flow diagrams
- Integration patterns
- Client library examples (JavaScript, Unity C#)
- Real-time features guide

### For Security Teams
Review: **`SECURITY_ANALYSIS.md`**
- Security audit results
- OWASP Top 10 compliance
- Best practices verification
- Production deployment checklist

### For QA/Testing
Use: **`test_rpcs.sh`**
- Automated test script
- All endpoints covered
- Easy customization

---

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Game Clients                             │
│  (Unity, JavaScript, Unreal, etc.)                          │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   │ RPC Calls (HTTP/gRPC)
                   │
┌──────────────────▼──────────────────────────────────────────┐
│              Nakama Server (Port 7350)                       │
│  ┌────────────────────────────────────────────────────┐    │
│  │     leaderboard_rpc.ts Module                       │    │
│  │  • Score Synchronization                            │    │
│  │  • Friend Leaderboards                              │    │
│  │  • Social Features                                  │    │
│  │  • Notifications                                    │    │
│  └──────────────┬─────────────────────────────────────┘    │
│                 │                                             │
│  ┌──────────────▼─────────────────────────────────────┐    │
│  │     Nakama Storage & APIs                           │    │
│  │  • Leaderboards (persistent)                        │    │
│  │  • Storage (leaderboards_registry)                  │    │
│  │  • Social Graph (friends)                           │    │
│  │  • Notifications                                    │    │
│  └────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                   │
                   │
┌──────────────────▼──────────────────────────────────────────┐
│         IntelliVerse API (games.intelli-verse-x.ai)         │
│  • OAuth Authentication                                      │
│  • Game Discovery                                           │
└─────────────────────────────────────────────────────────────┘
```

---

## Data Flow Examples

### Score Submission with Aggregation

```
Player → submit_score_with_aggregate → Nakama
                                          │
                    ┌─────────────────────┼─────────────────────┐
                    ▼                     ▼                     ▼
            Game Leaderboard      Global Leaderboard    Friend Leaderboards
            (individual score)    (individual score)     (individual score)
                                          │
                                          ▼
                                  Query All Games
                                  Calculate Total
                                          │
                                          ▼
                                  Global Leaderboard
                                  (aggregate score)
```

### Friend Leaderboard Query

```
Player → get_friend_leaderboard → Nakama
                                     │
                    ┌────────────────┼────────────────┐
                    ▼                ▼                ▼
              Get Friends    Read Leaderboard   Filter Results
              (Social API)   (Storage API)      (Friend IDs)
                                     │
                                     ▼
                              Return Ranked List
                              (Friends Only)
```

---

## Deployment Checklist

- [ ] Copy `leaderboard_rpc.ts` to `/data/modules/` directory
- [ ] Ensure Nakama server has TypeScript runtime enabled
- [ ] Configure OAuth credentials (if different from defaults)
- [ ] Restart Nakama server
- [ ] Verify module loaded in Nakama console logs
- [ ] Run `test_rpcs.sh` to verify all endpoints
- [ ] Configure rate limiting for production
- [ ] Set up monitoring for RPC calls
- [ ] Review security recommendations in SECURITY_ANALYSIS.md
- [ ] Update client applications with new RPC endpoints

---

## Configuration

### Default Settings
- **Reset Schedule:** Weekly (Sunday midnight UTC)
- **Sort Order:** Descending (highest scores first)
- **Operator:** Best (keeps best score per user)
- **Friend List Limit:** 100 users
- **Notification Limit:** 30 most recent

### Customization
To customize these settings, edit `leaderboard_rpc.ts`:
- Line 29-31: Leaderboard configuration
- Line 622: Friend list limit
- Line 735: Notification limit

---

## Troubleshooting

### Common Issues

**Issue:** "Module not loaded"
- Solution: Check Nakama logs, ensure TypeScript runtime is enabled

**Issue:** "Auth required" error
- Solution: Provide valid session token in Authorization header

**Issue:** "Leaderboard does not exist"
- Solution: Run leaderboard creation RPC first

**Issue:** "Failed to retrieve friends"
- Solution: Verify user has friends, check Nakama social graph

**Issue:** OAuth authentication fails
- Solution: Verify client credentials, check IntelliVerse API availability

---

## Performance Considerations

- **Leaderboard Registry:** Cached on first read, updated on creation
- **Friend List:** Limited to 100 to prevent performance issues
- **Score Aggregation:** Queries all game leaderboards (scales with game count)
- **Notifications:** Limited to 30 most recent

For high-traffic scenarios:
- Consider Redis caching for leaderboard registry
- Implement background jobs for aggregation
- Use Nakama's built-in rate limiting

---

## Support & Resources

### Documentation
- [Nakama Documentation](https://heroiclabs.com/docs)
- [Nakama TypeScript Runtime](https://heroiclabs.com/docs/nakama/runtime/typescript-runtime)
- [IntelliVerse API Documentation](https://api.intelli-verse-x.ai/docs)

### Module Documentation
- Feature Guide: `README_LEADERBOARD_RPC.md`
- API Reference: `RPC_API_REFERENCE.md`
- Security Report: `SECURITY_ANALYSIS.md`

### Testing
- Test Script: `test_rpcs.sh`
- Example Payloads: See `RPC_API_REFERENCE.md`

---

## Version History

### v1.0.0 (2025-10-22)
- Initial release
- 10 RPC endpoints
- Friend leaderboard support
- Score aggregation
- Social features
- Comprehensive documentation

---

## License

Copyright 2025 The Nakama Authors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
