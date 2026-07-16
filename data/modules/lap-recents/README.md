# LAP Recents

Cross-surface recent-notes index for Link & Play → TutorX.

| RPC | Purpose |
|-----|---------|
| `quizverse_lap_recents_get` | Read caller's recent note metadata |
| `quizverse_lap_recents_touch` | Upsert one note to the front |
| `quizverse_lap_recents_replace` | Replace full list (LAP Home backfill) |

## Storage

- **Collection:** `lap_recents`
- **Key:** `list`
- **Max items:** 20
- **Value shape:** `{ items: [{ noteId, noteTitle, sourceType, thumbnailUrl, ts }], updatedAt }`
- **Permissions:** `permissionRead: 1`, `permissionWrite: 0` (server-only writes via RPC)

Note bodies remain in the AI notes API; this is an index only.

## Auth & validation

All three RPCs call `lapRecentsRequireUser(ctx)` first — missing `ctx.userId` returns
`{ success: false, error: "UNAUTHENTICATED" }`. Storage is always scoped to
`ctx.userId` (no cross-user read/write).

| RPC | Input validation |
|-----|------------------|
| `get` | No payload required |
| `touch` | Requires `noteId` (aliases: `id`, `note_id`); rejects otherwise |
| `replace` | Requires `items` array; normalizes/dedupes/caps to 20 |

Errors are caught and returned as `{ success: false, error }` JSON (no throw to client).

## Deploy note

Source of truth for review is `lap-recents.js`. Production `Dockerfile.production`
runs `tsc` + `postbuild.js`, which merges this module into `index.js` and registers
the three RPCs in `InitModule`. After merge, run `npm run build` locally (or rely
on the image build) so volume-mounted / committed `index.js` stays in sync.
