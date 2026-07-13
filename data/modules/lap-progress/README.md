# LAP note progress RPCs

**Review this folder (`lap-progress.js`), not the bulk of `data/modules/index.js`.**

`index.js` is regenerable via `cd data/modules && npm run build`. Full builds re-embed
`__QV_VIDEO_QUIZ_CATALOG__` (large JSON), which produces noisy diffs even when catalog
content is unchanged aside from a regenerated timestamp. The +2 RPC count is the real
delta: `quizverse_lap_submit_progress` and `quizverse_lap_get_progress`.

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
