# LAP Missions (Link & Play)

Cross-device daily / weekly mission sync for QuizVerse Link & Play.

| RPC | Purpose |
|-----|---------|
| `quizverse_lap_missions_get` | Read caller's mission store |
| `quizverse_lap_missions_upsert` | Merge client snapshot into server |

- **Collection:** `lap_missions`
- **Key:** `state`
- **Merge:** same `dailyDate` / `weekKey` → max progress, OR completed/claimed; otherwise prefer the period matching UTC today / ISO week

Client cache: `qv.lap.missions` in localStorage (Quizverse-web-frontend `lap-missions.ts`).

## Deploy

```bash
cd data/modules && npm run build
docker compose restart nakama
# Confirm in logs: [LAP-Missions] Registered RPC: quizverse_lap_missions_get
```
