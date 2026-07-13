# LAP note progress RPCs

**Review this folder (`lap-progress.js`), not a regenerated `index.js`.**

This PR’s `index.js` change is a **surgical patch** on `master` (+~230 lines):
stubs, module body, and `registerRpc` for the two RPCs. The video-quiz catalog
line is **unchanged** from `master` (no postbuild catalog regen).

`npm run build` still regenerates the catalog timestamp and creates huge diffs — prefer:

```bash
node data/modules/scripts/inject-lap-progress.js
```

after checking out `master`’s `index.js`, when updating this feature.

## RPCs

| RPC | Purpose |
|-----|---------|
| `quizverse_lap_submit_progress` | Upsert per-user note learning stats (max-merge) |
| `quizverse_lap_get_progress` | Read one or many notes' progress for the caller |

## Storage

- Collection: `lap_note_progress`
- Key: `noteId`
- Owner: `ctx.userId`
- Value:

```json
{
  "quizBestScore": 0,
  "flashcardKnewIt": 0,
  "xpEarnedTotal": 0,
  "updatedAt": "ISO-8601"
}
```

## Submit payload

```json
{
  "noteId": "uuid",
  "activity": "quiz|flash|...",
  "score": 0,
  "count": 0,
  "xpEarned": 0
}
```

## Validation / behavior

- Requires authenticated `ctx.userId` (else `{ success: false, error: "unauthenticated" }`)
- `noteId` required (trim); empty → error
- `quizBestScore` clamped to 0–100; `flashcardKnewIt` / `xpEarned` clamped to ≥ 0
- Scores are **max-merged** with any existing row (never decrease)
- `quiz` / `score` updates quiz %; `flash` / `count` updates knew-it count
- Get supports `{ noteId }` or `{ noteIds: [] }` (capped at 100 ids)

## Verify after deploy

```text
rg "registerRpc\\(\"quizverse_lap_submit_progress\"" data/modules/index.js
rg "registerRpc\\(\"quizverse_lap_get_progress\"" data/modules/index.js
```

Then restart Nakama so Goja reloads modules.
