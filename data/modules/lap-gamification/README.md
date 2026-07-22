# LAP Gamification (XP / streak / badges)

Cross-device sync for Link & Play client gamification.

| RPC | Purpose |
|-----|---------|
| `quizverse_lap_gamification_get` | Read caller's progress |
| `quizverse_lap_gamification_upsert` | Merge client snapshot into server (max XP/counts, union badges + playedDates, recompute streak) |

- **Collection:** `lap_gamification`
- **Key:** `state`
- **Owner:** `ctx.userId` (requires `nakama_token`)

Review this file — not the generated `index.js` catalog embed.
