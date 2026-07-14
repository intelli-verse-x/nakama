# LAP Saved Artifacts (Nakama)

Per-user Saved shelf for Link & Play learn modes.

- **Collection:** `lap_saved_artifacts`
- **Owner:** Nakama `ctx.userId` from session token
- **RPCs:** `quizverse_lap_library_{save,list,get,delete,pin,recall,stats}`

Free users are capped at 20 items server-side (Pro via `qv_entitlements` bypasses).
