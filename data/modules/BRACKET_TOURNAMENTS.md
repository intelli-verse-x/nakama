# Nakama-Orchestrated Bracket Tournaments

Nakama owns game-specific tournament orchestration and result submission. Bracket owns tournament structure, scheduling, public dashboards, and score presentation. The shared key is `game_id`; every Bracket tournament created through Nakama is stored in Nakama system storage under `bracket_tournaments` with key:

```text
{game_id}:{tournament_slug}
```

## Runtime Configuration

The Nakama deployment must expose these values through `--runtime.env`:

- `BRACKET_BASE_URL`: Bracket API base URL, for example `http://bracket.aicart.svc.cluster.local:8400/api`.
- `BRACKET_DASHBOARD_BASE_URL`: public dashboard base URL, for example `https://bracket.intelli-verse-x.ai`.
- `BRACKET_ADMIN_EMAIL` and `BRACKET_ADMIN_PASSWORD`: Bracket integration user credentials.
- `BRACKET_CLUB_ID`: Bracket club that owns synced tournaments.

## Supported Flavors

`ROUND_ROBIN`: creates every pairing up front. Nakama seeds teams, exposes the generated Bracket match IDs through status, and submits one result per match. Use this for weekly leagues, group play, and small recurring tournaments where every entrant should play every other entrant.

`SINGLE_ELIMINATION`: creates bracket rounds up front. Nakama submits match scores; Bracket advances winners through downstream rounds. Use this for finals, knockout cups, playoffs, and top-N leaderboard events.

`SWISS`: creates entrants first, then `bracket_tournament_start` calls Bracket `start_next_round`. Nakama must fetch status after every round, run only generated matches, submit their results, and call start again when the current round is complete. Use this for live tournaments where players should continue playing without the full round-robin match volume.

Weekly and monthly tournaments are recurrence wrappers, not separate Bracket flavors. If no `tournament_slug` is supplied, Nakama derives one from `game_id`, flavor, recurrence period, and current weekly/monthly window.

## RPCs

### `bracket_tournament_create`

Admin/server RPC. Creates the Bracket tournament, stage, stage item, optional teams, and storage mapping. Duplicate create requests with the same `game_id` and slug return the existing mapping.

```json
{
  "game_id": "126bf539-dae2-4bcf-964d-316c0fa1f92b",
  "flavor": "ROUND_ROBIN",
  "name": "QuizVerse Weekly League",
  "tournament_slug": "quizverse-weekly-2026-05-04",
  "team_count": 4,
  "starts_at": "2026-05-04T19:00:00Z",
  "recurrence": { "period": "weekly" },
  "teams": [
    { "external_id": "u1", "name": "Player One", "players": [{ "external_id": "u1", "name": "Player One" }] },
    { "external_id": "u2", "name": "Player Two", "players": [{ "external_id": "u2", "name": "Player Two" }] }
  ]
}
```

### `bracket_tournament_seed`

Admin/server RPC. Seeds or resumes seeding for an existing mapping.

```json
{
  "game_id": "126bf539-dae2-4bcf-964d-316c0fa1f92b",
  "tournament_slug": "quizverse-weekly-2026-05-04",
  "teams": []
}
```

### `bracket_tournament_start`

Admin/server RPC. For Swiss tournaments it starts the next round. For round robin and single elimination it schedules unscheduled matches unless `schedule_matches` is `false`.

```json
{
  "game_id": "126bf539-dae2-4bcf-964d-316c0fa1f92b",
  "tournament_slug": "quizverse-monthly-swiss-2026-05",
  "flavor": "SWISS"
}
```

### `bracket_tournament_status`

Client-safe lookup. Returns lifecycle state, Bracket IDs, dashboard URL, team mappings, match mappings, and submitted result records. By default it refreshes from Bracket before returning so the Nakama mapping mirrors all Bracket workspace tabs.

```json
{
  "game_id": "126bf539-dae2-4bcf-964d-316c0fa1f92b",
  "tournament_slug": "quizverse-weekly-2026-05-04",
  "flavor": "ROUND_ROBIN"
}
```

The response includes `sync`, a tab-shaped snapshot for:

- `players`: Bracket Players page records and count.
- `teams`: Bracket Teams page records and count.
- `stages`: Bracket Stages page with stage items, inputs, rounds, and matches.
- `planning`: Bracket Planning/Schedule data derived from courts plus all staged matches.
- `results`: every staged match split into pending and scored/completed buckets.
- `rankings`: ranking definitions plus next-stage ranking input projections.

Pass `sync: false` only for a storage-only diagnostic read.

### `bracket_tournament_submit_result`

Client/server RPC. Idempotent by Bracket `match_id` and result hash. Repeating the same score returns `duplicate: true`; changing a prior score fails unless `force: true`.

```json
{
  "game_id": "126bf539-dae2-4bcf-964d-316c0fa1f92b",
  "tournament_slug": "quizverse-weekly-2026-05-04",
  "bracket_match_id": 123,
  "score1": 8,
  "score2": 6,
  "player_user_id": "nakama-user-id",
  "source_match_id": "photon-room-or-nakama-match-id",
  "quiz_result": {
    "correctAnswers": 8,
    "totalQuestions": 10,
    "timeTaken": 91.4
  }
}
```

## Lifecycle

`missing`: no Nakama mapping exists for the requested `{game_id}:{tournament_slug}`.

`created`: Bracket tournament, stage, and stage item exist.

`seeded`: teams are created and assigned to stage item inputs.

`active`: scheduling/round start has happened or at least one result was submitted.

`completed`: all currently mapped Bracket matches have submitted results.

`error`: reserved for recovery tooling; failed RPCs return errors without overwriting the last good mapping.

## Failure Modes

Duplicate creation is prevented by the storage key. Partial Bracket creation before storage write can still leave orphaned Bracket objects; use the dashboard endpoint slug to find and clean them up.

Bracket auth/API failures return RPC errors. Verify runtime env, the `bracket-secrets` values, and Bracket pod readiness.

Result conflicts are rejected unless `force: true`. This keeps gameplay retries idempotent while preserving a clear audit point for manual correction.

Swiss clients must not assume future matches. Fetch status after each `start` call and only launch matches returned by the current snapshot.

Pagination is intentionally capped at Bracket's supported `limit=100` for players and teams. Larger tournament pages should use follow-up pagination support before increasing entrant counts beyond the current MVP size.

## Quiz-Verse Client Wiring

Quiz-Verse uses `IntelliVerseXConfig.QUIZVERSE_GAME_ID` for every tournament payload. The client wrapper lives in:

```text
Assets/_QuizVerse/Scripts/SDK/QuizVerseSDK.Tournaments.cs
```

The wrapper exposes:

- `Tournaments.CreateBracketTournamentAsync(...)`
- `Tournaments.GetBracketTournamentStatusAsync(...)`
- `Tournaments.SubmitBracketTournamentResultAsync(...)`

Scene/UI entrypoints live in:

```text
Assets/_QuizVerse/Scripts/Tournaments/BracketTournamentPanel.cs
Assets/_QuizVerse/Scripts/Tournaments/BracketTournamentEntryButton.cs
```

`BracketTournamentPanel` is a scene-wirable controller. Attach it to a panel GameObject and wire optional `TextMeshProUGUI` labels plus buttons for refresh, open dashboard, launch match, and close. The panel fetches `bracket_tournament_status`, renders counts for players/teams/stages/matches/results/rankings, opens the Bracket dashboard URL, and can create a multiplayer room for the first playable Bracket match.

`BracketTournamentEntryButton` is a lightweight button adapter. Attach it to any Unity `Button`, assign a `BracketTournamentPanel`, `tournamentSlug`, and `flavor`, and it opens the panel with those values.

Result-submit wiring is in:

```text
Assets/_QuizVerse/Scripts/MultiPlayer/Unified/UnifiedMultiplayerManager.cs
Assets/_QuizVerse/Scripts/MultiPlayer/Unified/MultiplayerModels.cs
Assets/_QuizVerse/Scripts/MultiPlayer/Unified/SyncMultiplayerProvider.cs
```

`CreateRoomRequest`, `UnifiedRoom`, and `QuizResultSubmission` carry `TournamentSlug`, `BracketTournamentId`, and `BracketMatchId`. When `UnifiedMultiplayerManager.SubmitResultsAsync(...)` succeeds locally and those fields are present, it calls `bracket_tournament_submit_result` through the SDK wrapper.

### Unity Setup Checklist

1. Add a tournament button to the target menu scene.
2. Add `BracketTournamentEntryButton` to that button.
3. Add or reuse a panel GameObject and attach `BracketTournamentPanel`.
4. Wire title/status/details/dashboard labels and refresh/open/launch/close buttons in the inspector.
5. Set the button slug and flavor, for example `ivx-demo-round-robin` and `ROUND_ROBIN`.
6. Press the button in Play Mode; verify the panel loads counts and opens the Bracket dashboard.
7. Use `LaunchFirstAvailableMatchAsync` or the launch button to create a room carrying `TournamentSlug` and `BracketMatchId`.
8. Complete the match and verify `SubmitResultsAsync` calls `bracket_tournament_submit_result`.

## QA Playbook

1. Build Nakama modules with `npm run build` in `data/modules`.
2. Deploy Bracket with the API return-shape patch and deploy Nakama with the new runtime env.
3. Call `bracket_tournament_create` for `ROUND_ROBIN`, `SINGLE_ELIMINATION`, and `SWISS` using the QuizVerse `game_id`.
4. Call `bracket_tournament_status` and verify `bracket.dashboard_url`, `stage_item_id`, input mappings, and generated matches.
5. Submit a result with `bracket_tournament_submit_result`, then verify Bracket dashboard scores changed.
6. Repeat the same submit payload and verify `duplicate: true`.
7. Repeat create with the same slug and verify no new Bracket tournament is created.
8. For Swiss, call `bracket_tournament_start` after seeding, submit all current round results, then call start again for the next round.
9. In Quiz-Verse Play Mode, open a `BracketTournamentPanel`, verify counts match Bracket, open the dashboard, launch a match room, and submit a result with tournament context.

### Live Demo Slugs

- `ivx-demo-round-robin`: `ROUND_ROBIN`
- `ivx-demo-single-elim`: `SINGLE_ELIMINATION`
- `ivx-demo-swiss`: `SWISS`
