-- Revoke owner-write on existing push_tokens rows.
--
-- PROPOSED. NOT APPLIED. Requires an owner to run it deliberately.
--
-- WHY -------------------------------------------------------------------------
-- Owner-write on this collection lets a client skip push_register_token and
-- write its own row, storing an `endpointArn` of its choosing. Notifications
-- intended for that account are then delivered to whatever device the ARN
-- points at. Owner-READ stays 1: the device legitimately reads back its own
-- endpoint state.
--
-- push.ts now writes every row with permissionWrite = 0, but that only covers
-- rows the server touches from here on. Rows written before the change keep
-- write = 1 until this migration runs.
--
-- STATE AS MEASURED 2026-08-29 ------------------------------------------------
--   SELECT collection, read, write, count(*) FROM storage
--    WHERE collection = 'push_tokens' GROUP BY 1,2,3;
--   → push_tokens | 1 | 1 | 14496       (every row owner-writable)
--
-- WHY THIS IS ASSESSED SAFE --------------------------------------------------
--  1. Nakama's server runtime bypasses storage ACLs entirely, so nothing in
--     push.ts, the cron fan-outs, or friends/friend_invites.js is affected.
--     Permissions only ever gate the client-facing storage API.
--  2. No client writes this collection. Verified by reading both shipped
--     clients:
--       - Unity  quiz-verse/Assets/_QuizVerse/Scripts/  — reaches push only
--                through the RPCs; no WriteStorageObjectsAsync to push_tokens.
--       - Flutter lib/features/push_notifications/      — syncPushToken calls
--                the push_register_token RPC; no storage write.
--  3. No foreign writer has left a trace. Every JSON key present across all
--     token entries is one push.ts itself writes:
--       token, updatedAt, platform, providerError, endpointArn,
--       providerRegisteredAt, provider, pendingRegistration, pendingRetries,
--       pendingLastAttempt, pendingFcmProjectId, pendingGameId,
--       pendingIsSandbox
--     A client-authored row would almost certainly carry something outside
--     that set; none does.
--  4. Reversible in one statement (see ROLLBACK below).
--
-- RESIDUAL RISK --------------------------------------------------------------
--   An old app build still in the wild that writes this collection directly
--   would begin getting permission errors on that write. Points 2 and 3 argue
--   against such a build existing, but they cannot prove it for versions no
--   longer in the repo. If any such client exists, its push registration is
--   already broken by the code change to server-only writes, so this migration
--   does not widen the blast radius — it only makes the state consistent.
--
-- HOW TO RUN -----------------------------------------------------------------
--   Take a snapshot of the RDS instance first. Then, against nakama_database:
--     psql "$NAKAMA_DSN" -f 2026-08-29-push-tokens-server-write-only.sql
--   Expect: UPDATE 14496 (or fewer, as newly-written rows are already 0).

BEGIN;

-- Before.
SELECT read, write, count(*) AS rows
  FROM storage WHERE collection = 'push_tokens'
 GROUP BY read, write ORDER BY write;

UPDATE storage
   SET write = 0,
       update_time = now()
 WHERE collection = 'push_tokens'
   AND write <> 0;

-- After: expect exactly one group, read=1 write=0.
SELECT read, write, count(*) AS rows
  FROM storage WHERE collection = 'push_tokens'
 GROUP BY read, write ORDER BY write;

-- Inspect both result sets, then COMMIT. ROLLBACK if the after-state is not
-- a single read=1/write=0 group.
COMMIT;

-- ROLLBACK (only if a legitimate client writer is discovered):
--   UPDATE storage SET write = 1, update_time = now()
--    WHERE collection = 'push_tokens' AND write = 0;
