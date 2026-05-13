# Nakama Socket Server Key Rotation Plan

## Goal

Rotate `socket.server_key` without locking out released clients. Nakama uses this key for client authentication calls such as device/custom/email auth over the socket/API surface, so a server-side-only change is a breaking client change unless every active client already ships the new key.

## Rotation Constraints

- Nakama accepts one `socket.server_key` at a time.
- Existing sessions continue until their session and refresh token lifetimes expire, but new logins from clients using the old key fail immediately after the server key changes.
- App store rollout is not atomic. Keep the old key active until the new client build is released and adoption is high enough for the product risk tolerance.
- Treat the key as public-client shared secret material, not as a high-security credential. Rotation reduces stale build exposure, but it does not replace server-side auth, entitlement, or rate-limit checks.

## Recommended Release Sequence

1. Generate a new random key and store it only in the deployment secret manager and client release config.
2. Add the new key to Unity/client configuration in a release branch, but do not change the live Nakama secret yet.
3. Release clients with the new key to internal QA/TestFlight/Play internal testing and verify login, reconnect, wallet, analytics, and `quizverse_create_match`.
4. Roll the client release to production and monitor adoption by app version.
5. When adoption is acceptable, schedule a short maintenance window and announce that old builds may need an update.
6. Update `nakama-secret` `socket.server_key` in EKS and restart/roll Nakama deployments.
7. Verify new-client login and critical RPCs immediately after rollout.
8. Keep old-client login failure monitoring active for at least one session TTL plus one refresh TTL.

## EKS Execution Checklist

- Confirm the client version containing the new key is live and adopted.
- Snapshot the current Kubernetes secret value metadata; do not paste the secret value into tickets or logs.
- Update `nakama-secret` with the new `socket.server_key`.
- Roll `deployment/intelliverse-nakama` and any other Nakama deployments that mount the secret.
- Run the JS runtime smoke gate:

```bash
./scripts/smoke-test-js-runtime.sh cluster aicart intelliverse-nakama
```

- Run a real client login test with the released client build.
- Check recent logs for authentication spikes, runtime errors, and reconnect loops.

## Rollback

If new-client authentication fails, restore the prior `socket.server_key` in `nakama-secret` and roll the deployments back immediately. If only old clients fail after the planned cutover, do not rollback automatically; validate the adoption threshold and product decision first.

## Client Coordination Notes

- Track the key change in release notes for engineering, not public patch notes.
- Coordinate Unity, backend, QA, and release owners before changing the server secret.
- Avoid rotating during major tournaments, live events, or paid acquisition bursts.
- After rotation, remove the old key from client configuration, CI variables, and local developer docs.
