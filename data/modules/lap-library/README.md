# LAP Saved Artifacts (Nakama)

Per-user Saved shelf for Link & Play learn modes.

## Review here (not `index.js`)

**Source of truth:** [`lap-library.js`](./lap-library.js)

| RPC | Purpose |
|-----|---------|
| `quizverse_lap_library_save` | Upsert artifact + snapshot (auth: `ctx.userId`) |
| `quizverse_lap_library_list` | List caller's saves (filter/sort/cursor) |
| `quizverse_lap_library_get` | Get one by `savedId` (owner-only) |
| `quizverse_lap_library_delete` | Delete own save |
| `quizverse_lap_library_pin` | Pin / unpin |
| `quizverse_lap_library_recall` | Bump recall stats when opened from Library |
| `quizverse_lap_library_stats` | Counts by type / pin / recent recall |

Guards: requires authenticated `ctx.userId`; validates `type` against allow-list; rejects snapshots over ~200KB; free cap 20 via `qv_entitlements` (Pro bypass).

- **Collection:** `lap_saved_artifacts`
- **Owner:** Nakama `ctx.userId` from session token

`data/modules/index.js` is the **postbuild merge output** — do not review RPC logic there. After a full rebuild, prefer `node data/modules/scripts/inject-lap-library-into-index.js` against `origin/master` if you need a reviewable `index.js` diff (avoids churning the pre-existing video-quiz catalog embed).

## Note on `__QV_VIDEO_QUIZ_CATALOG__`

That ~350KB embed is **pre-existing on `master`** (seed → storage bootstrap for Video Quiz). It is not introduced by this LAP library change. Moving it to pure external storage is a separate infra epic; do not block LAP RPCs on that refactor.
