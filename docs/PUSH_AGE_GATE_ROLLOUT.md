# Push age gate — why it does not fail closed yet, and how to close it

Status as of 2026-08-29. Concerns the server-side age check added to
`push_register_token` in `data/modules/src/legacy/push.ts`.

## The problem the check solves

Before this change the server had no age logic of any kind, and the deployed
bundle registered no `registerBeforeRpc` hooks (`grep -c registerBeforeRpc` on
the running `index.js` returns 0). The only protection was the Flutter client
declining to fetch an FCM token. The Unity client has no such guard, and any
caller can reach the RPC directly, so the protection was advisory.

## Why it does not fail closed on missing age

Failing closed on unknown age is the compliance-correct default. It is not
deployable here yet, because there is no age data to fail closed *against*:

| Measured 2026-08-29 (`nakama_database`) | Count |
| --- | --- |
| Accounts total | 61,911 |
| Accounts with `metadata.dob_iso` | **0** |
| Push-token owners | 14,496 |
| Push-token owners with `dob_iso` | **0** |
| Accounts with any `age`/`dob`/`birth`/`coppa`-like metadata key | **0** |

Failing closed today would therefore reject **100% of push registrations** —
every one of the 14,496 existing token owners and every new device — which is a
full push outage, not a compliance improvement.

`qv_onboarding_profiles` is the only age-ish data that exists and it cannot
substitute:

- 11,805 rows carry `snapshot.age`, but only **34** of those users own a push
  token.
- The values are coarse buckets: `u18` (9,459), `18-24` (1,215), `25-34` (471),
  `35+` (660). `u18` spans 13–17 *and* under-13, so it cannot answer the only
  question COPPA asks.

## What the check does instead

Three-tier, in precedence order, in `resolveAgeClearance`:

1. **`metadata.dob_iso` present** → compute age, enforce the threshold, reject
   below it. Fails closed. Matches `tournaments/rpcs.ts`. Applies to 0 accounts
   today and becomes effective the moment onboarding starts writing DOB — no
   further code change needed.
2. **Client sends an explicit `age_assertion`** → honour it, reject if it
   asserts under-threshold. Matches the `recorder_asr.ts` assertion gate.
3. **Neither** → admit, and record `ageSource` on the token row so the
   population registering without a declaration is measurable rather than
   invisible.

Tier 3 is the deliberate, temporary compromise. It is gated by config so
flipping it needs no deploy:

- `PUSH_REQUIRE_AGE_ASSERTION=1` → tier 3 becomes a rejection (full fail-closed).
- `PUSH_AGE_THRESHOLD=<n>` → threshold, default 13.

Neither is currently set in `nakama-secret` `config.yaml`, so the default —
admit-on-absent — is live.

## Closing the gate

1. **Ship DOB or an age assertion from both clients.** Flutter already knows the
   user's age locally (that is what its existing guard uses); it needs to send
   it. Unity needs the guard added.
2. **Backfill `metadata.dob_iso`** at onboarding for new accounts, and prompt
   existing accounts on next launch. Do not backfill from
   `qv_onboarding_profiles.snapshot.age` — `u18` is not decisive, and treating
   it as ≥13 would be a false clearance for genuine under-13 users.
3. **Watch coverage** using `ageSource` on the token rows:

   ```sql
   SELECT tok->>'ageSource' AS source, count(*)
     FROM storage s, jsonb_array_elements((s.value::jsonb)->'tokens') tok
    WHERE s.collection = 'push_tokens'
    GROUP BY 1 ORDER BY 2 DESC;
   ```

4. **Set `PUSH_REQUIRE_AGE_ASSERTION=1`** once the `absent` bucket is small
   enough to accept as breakage. This is a config edit to `nakama-secret` plus a
   rollout; no code change.

Until step 4, this is a real server-side gate for anyone who declares an age and
an honest no-op for anyone who does not. That is strictly better than the
client-only state it replaces, and it is not a compliance sign-off.
