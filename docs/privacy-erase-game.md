# Player-scoped QuizVerse erasure

`POST https://nakama-rest.intelli-verse-x.ai/v2/rpc/privacy_erase_game`
uses a normal Nakama player Bearer session. The HTTP body is a JSON-encoded
string containing `{gameId, confirmUserId, reason?}`. No service key is needed.

```sh
curl --request POST \
  'https://nakama-rest.intelli-verse-x.ai/v2/rpc/privacy_erase_game' \
  --header "Authorization: Bearer ${NAKAMA_SESSION_TOKEN}" \
  --header 'Content-Type: application/json' \
  --data '"{\"gameId\":\"126bf539-dae2-4bcf-964d-316c0fa1f92b\",\"confirmUserId\":\"YOUR_SESSION_USER_ID\",\"reason\":\"user_request\"}"'
```

SDK equivalent: `client.rpc(session, "privacy_erase_game", JSON.stringify({
gameId: "126bf539-dae2-4bcf-964d-316c0fa1f92b", confirmUserId: session.user_id
}))`. Use the SDK's actual session user-ID property. The server never uses a
payload subject to select a user. `quizverse` and `quiz-verse` are aliases.
Other games fail before storage writes or downstream calls.

Decode the HTTP response's `payload` string. Check `ok`, `status`, `subsystems`,
`scope`, and `retained`; HTTP 200 alone is not erasure success. `completed`
means the enumerated audited adapters completed, **not full account deletion**.
`partial` is retryable; `in_progress` or `receipt_unavailable` asks the client
to wait 120 seconds. Do not tell a player their wallet/account was deleted.

## Audited adapter boundaries

- AI: HMAC POST `/api/ai/privacy/erase`, canonical AI game `quizverse`, session
  user ID. Requires both `ok:true` and `cacheErasureVerified:true`. HTTP errors,
  invalid responses and cache failures remain visible as `ai:failed`.
- Hiro: owner rows in achievements, inventory, progression, energy, stats,
  streaks, tutorials, unlockables and mailbox, only keys beginning with an
  explicit QuizVerse alias plus `:`. Writers use `Constants.gameKey` in
  `src/hiro/{domain}/{domain}.ts`. Unprefixed default keys are preserved.
- Quests and inventory: exact alias + `_` + session user ID keys, from
  `src/quests/quest_engine.ts` and `src/legacy/multi-game.ts`.
- Quiz depth: owner rows in each alias's `_quiz_history`, `_streak_quizzes`,
  `_adaptive_difficulty`, `_daily_puzzles`, `_study_progress` collections;
  writers are in `quizverse_depth/quizverse_depth.js`.
- Profile: owner rows in `qv_onboarding_profiles`, written by the dedicated
  QuizVerse web onboarding flow in `src/onboarding/onboarding-analytics.ts`.
  System-owned analytics copies remain outside this adapter.
- Leaderboards: current owner record in existing `quizverse_leaderboard` and
  the three alias-specific `_daily_puzzle_leaderboard` boards. Writers are in
  `src/legacy/multi-game.ts` and `quizverse_depth/quizverse_depth.js`.

Shared Nakama identity, Cognito, wallet/financial records, Discord, shared
profile metadata, unscoped legacy progress/seen-question records, social and
multiplayer records, historical leaderboard records, and system-owned
onboarding analytics remain. There is no accountDeleteId, Cognito call,
Discord erase, or wallet mutation in this cascade. No new configuration toggle.
Existing `IVX_AI_SVC_BASE_URL` (including `/api/ai`) and
`IVX_INSIGHTS_SHARED_SECRET` must be configured.

A server-only CAS storage lease in `privacy_game_erasure` is acquired before
side effects. The receipt contains no reason or credentials. Expiry permits
crash recovery; all repeated deletes are idempotent. A repeated completed
request runs cleanup again so newly created game data can be erased too.
Concurrent gameplay is not frozen: clients should stop game writes during
cleanup. Versioned storage deletes surface concurrent modification as partial.
Large collections stop after 100 pages and are retryable. This is not a
cross-service transaction or a complete legal data-retention policy.

`privacy_erase_user` remains an AI-only compatibility RPC for QuizVerse; it
maps the UUID to the AI slug and requires `user_id` to equal the session user.
Unauthenticated service callers no longer authorize that destructive path.

Validation: `node --test data/modules/tests/privacy_erasure_test.cjs`.
