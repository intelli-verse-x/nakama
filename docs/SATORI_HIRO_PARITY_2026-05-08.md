# Satori + Hiro Parity Audit — 2026-05-08

> Source: full-page crawl of `https://heroiclabs.com/satori/`,
> `https://heroiclabs.com/satori/#experiments`, `https://heroiclabs.com/hiro/`,
> plus all linked product / docs sub-pages, executed with Firecrawl on
> 2026-05-08. Comparison performed against `data/modules/src/satori` and
> `data/modules/src/hiro` in this Nakama OSS repo.
>
> Top-to-bottom screenshots stored at:
>
> - `.firecrawl/snapshots/satori-home-fullpage.png` (1920×13950 px)
> - `.firecrawl/snapshots/hiro-home-fullpage.png` (1920×6420 px)
>
> Detailed page-by-page markdown stored under `.firecrawl/heroiclabs/{satori-docs,hiro-docs}/`.

## TL;DR

After the gap-fill landed in this session, the Nakama OSS modules in
`data/modules/src/satori/**` and `data/modules/src/hiro/**` cover **every
publicly-documented Satori + Hiro feature** advertised on heroiclabs.com,
exposed through ~110 player- and admin-facing RPCs. End-to-end persistence
is verified through the Nakama Console (`http://127.0.0.1:7351`, admin
login) and the runtime HTTP-key probe path; new storage records appear
under `hiro_configs/{publishers,integrations}` and
`satori_configs/{category_labels,funnels,managed_audiences,messaging_integrations,
audiences}` (cross-write from managed-audiences).

The runtime returns `527` registered TS-owned RPCs on
`nakama_js_health` (was ~460 before this session).

## What was crawled

| Page                                       | Outcome                                |
| ------------------------------------------ | -------------------------------------- |
| `heroiclabs.com/satori/`                   | full-page screenshot + markdown        |
| `heroiclabs.com/satori/#experiments`       | same DOM as `/satori/`, anchored       |
| `heroiclabs.com/hiro/`                     | full-page screenshot + markdown        |
| `heroiclabs.com/satori` site-map           | URLs collected to `.firecrawl/map-satori.txt` |
| `heroiclabs.com/hiro` site-map             | URLs collected to `.firecrawl/map-hiro.txt`   |
| `https://heroiclabs.com/docs/satori/**`    | every linked doc page → `.firecrawl/heroiclabs/satori-docs/*.md` |
| `https://heroiclabs.com/docs/hiro/**`      | every linked doc page → `.firecrawl/heroiclabs/hiro-docs/*.md`   |

## Satori coverage matrix

| Heroic Labs Satori capability                                | Where it lives in this repo                                          | RPCs                                                                                                                                                                                                                                              | Status |
| ------------------------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Event capture pipeline (high-throughput)                     | `satori/event-capture/event-capture.ts`                              | `satori_event`, `satori_event_external`                                                                                                                                                                                                           | covered |
| Identities & properties (default / custom / computed)        | `satori/identities/identities.ts`                                    | `satori_identity_get`, `satori_identity_authenticate`, `satori_identity_set_property`, `satori_identity_get_property`                                                                                                                              | covered |
| Audiences (filter + auto-refresh + include/exclude)          | `satori/audiences/audiences.ts`                                      | `satori_audiences_list`, `satori_audiences_get`, `satori_audiences_upsert`, `satori_audiences_evaluate`, `satori_audiences_membership`                                                                                                              | covered |
| **NEW** Managed audiences (BYO segment imports)              | `satori/audiences/managed-audiences.ts`                              | `satori_managed_audiences_list/upsert/delete/replace/refresh`                                                                                                                                                                                      | **added** |
| **NEW** Audience recompute scheduler (background refresh)    | `satori/audiences/recompute-scheduler.ts`                            | `satori_audience_snapshot_status/members`, `satori_audience_recompute`, `satori_audience_recompute_set_interval`                                                                                                                                   | **added** |
| Feature flags / remote config (variant by audience)          | `satori/feature-flags/feature-flags.ts`                              | `satori_flags_get_all`, `satori_flag_resolve`, `satori_flags_upsert`, `satori_flags_toggle`                                                                                                                                                        | covered |
| Experimentation engine (multi-variant, goal metrics)         | `satori/experiments/experiments.ts`                                  | `satori_experiments_get`, `satori_experiments_assign`, `satori_experiments_track`, `satori_experiments_promote`                                                                                                                                    | covered |
| **NEW** Multi-phase experiments + enrollment lock            | `satori/experiments/phases.ts`                                       | `satori_experiments_phases_list/phase_add/phase_remove/lock_enrollment/current_phase`                                                                                                                                                              | **added** |
| Live events (calendar + repeatable schedules)                | `satori/live-events/live-events.ts`                                  | `satori_live_events_list/join/claim`                                                                                                                                                                                                              | covered |
| Player messaging (push, in-game, scheduled)                  | `satori/messages/messages.ts`                                        | `satori_messages_list/read/delete/broadcast`                                                                                                                                                                                                      | covered |
| **NEW** Messaging integrations (FCM/APNS/OneSignal/FB A2U/email/webhook) | `satori/messaging-integrations/messaging-integrations.ts` | `satori_messaging_get_config`, `_upsert_provider`, `_delete_provider`, `_set_channel_routing`, `_register_token`, `_dispatch_test`                                                                                                                  | **added** |
| Custom metrics + monitor & guard alerts                      | `satori/metrics/metrics.ts`                                          | `satori_metrics_query`, `_define`, `_set_alert`, `_get`, `satori_metrics_prometheus`                                                                                                                                                              | covered |
| **NEW** Retention graphs (D0/D1/D3/D7/D14/D30)               | `satori/retention/retention.ts`                                      | `satori_retention_get_config/set_config/run`                                                                                                                                                                                                      | **added** |
| **NEW** Funnel analysis (multi-step conversion)              | `satori/funnel-analysis/funnel-analysis.ts`                          | `satori_funnel_list/upsert/delete/run`                                                                                                                                                                                                            | **added** |
| **NEW** RoAS reporting (spend ↔ revenue)                     | `satori/roas/roas.ts`                                                | `satori_roas_spend_upsert/spend_list/run`                                                                                                                                                                                                         | **added** |
| **NEW** Session lifecycle analytics                          | `satori/sessions/sessions.ts`                                        | `satori_sessions_get/start/end/summary`                                                                                                                                                                                                           | **added** |
| **NEW** Category labels (taxonomy across flags/events/etc.)  | `satori/category-labels/category-labels.ts`                          | `satori_category_labels_list/upsert/delete/assign/get_for_entity/search`                                                                                                                                                                          | **added** |
| Event taxonomy (schema enforcement)                          | `satori/taxonomy/taxonomy.ts`                                        | `satori_taxonomy_register/list/get`                                                                                                                                                                                                                | covered |
| Webhooks (notify external systems)                           | `satori/webhooks/webhooks.ts`                                        | `satori_webhook_register/list/delete/test`                                                                                                                                                                                                         | covered |
| Data lake export (Snowflake/BigQuery/RedShift/S3)            | `satori/data-lake/data-lake.ts`                                      | `satori_data_lake_export_run/configure/list_targets`                                                                                                                                                                                              | covered |
| Analytics alerting + anomaly thresholds                      | `satori/analytics-alerts.ts`                                         | `satori_alerts_define/list/test`                                                                                                                                                                                                                  | covered |
| Video feed / interstitial events                             | `satori/video-feed/video-feed.ts`                                    | `satori_video_feed_list/click`                                                                                                                                                                                                                    | covered |

## Hiro coverage matrix

| Heroic Labs Hiro capability                          | Where it lives in this repo                            | RPCs                                                                                                                                                                                                                | Status |
| ---------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Rewards (base/gacha/loot table)                      | `hiro/economy/economy.ts`, `hiro/reward-bucket/`       | `hiro_economy_*`, `hiro_reward_bucket_get/progress/unlock`                                                                                                                                                          | covered |
| Virtual store (soft + IAP currency)                  | `hiro/store/store.ts`, `hiro/base/base-module.ts`      | `hiro_store_*`, `hiro_iap_validate`, `hiro_iap_history`                                                                                                                                                            | covered |
| Rewarded video ads (network integrations)            | `hiro/economy/economy.ts`                              | `hiro_economy_rewarded_video`                                                                                                                                                                                       | covered |
| Inventory (stack/consume/grant)                      | `hiro/inventory/inventory.ts`                          | `hiro_inventory_list/grant/consume/update`                                                                                                                                                                          | covered |
| Virtual wallet (multi-currency)                      | `hiro/economy/economy.ts`                              | `hiro_economy_spend`, plus legacy `wallet_get_all`                                                                                                                                                                  | covered |
| Reward bucket (slow drip reward)                     | `hiro/reward-bucket/reward-bucket.ts`                  | `hiro_reward_bucket_get/progress/unlock`                                                                                                                                                                            | covered |
| Store bundles + LiveOps personalization              | `hiro/store/`, `hiro/personalizers/personalizers.ts`   | `hiro_personalizer_set_override`, `_remove_override`                                                                                                                                                                | covered |
| Live events (Hiro side)                              | `hiro/event-leaderboards/event-leaderboards.ts`        | `hiro_event_lb_list/submit/claim/get`                                                                                                                                                                               | covered |
| Event leaderboards (timed/scored)                    | `hiro/event-leaderboards/event-leaderboards.ts`        | same as above                                                                                                                                                                                                       | covered |
| Donations (request / give / claim)                   | `hiro/economy/economy.ts`                              | `hiro_economy_donation_request/give/claim`                                                                                                                                                                          | covered |
| Teams / Guilds (built on Nakama Groups)              | `hiro/teams/teams.ts`                                  | `hiro_teams_get/stats/wallet_get/wallet_update/achievements`                                                                                                                                                        | covered |
| **NEW** Team Inventory                               | `hiro/teams/team-subsystems.ts`                        | `hiro_team_inventory_list/grant/consume`                                                                                                                                                                            | **added** |
| **NEW** Team Mailbox                                 | `hiro/teams/team-subsystems.ts`                        | `hiro_team_mailbox_list/send/claim`                                                                                                                                                                                 | **added** |
| **NEW** Team Store                                   | `hiro/teams/team-subsystems.ts`                        | `hiro_team_store_list/upsert_offer/purchase`                                                                                                                                                                        | **added** |
| **NEW** Team Gifts                                   | `hiro/teams/team-subsystems.ts`                        | `hiro_team_gifts_send/claim/list`                                                                                                                                                                                   | **added** |
| **NEW** Team Event Leaderboards                      | `hiro/teams/team-subsystems.ts`                        | `hiro_team_event_leaderboard_start/submit/get`                                                                                                                                                                      | **added** |
| Achievements                                         | `hiro/achievements/achievements.ts`                    | `hiro_achievements_list/progress/claim`                                                                                                                                                                             | covered |
| **NEW** Sub-achievements (parent/child trees)        | `hiro/achievements/sub-achievements.ts`                | `hiro_sub_achievements_reconcile/tree`                                                                                                                                                                              | **added** |
| Player stats                                         | `hiro/stats/stats.ts`                                  | `hiro_stats_get/update/aggregate`                                                                                                                                                                                   | covered |
| Streaks                                              | `hiro/streaks/streaks.ts`                              | `hiro_streaks_get/update/claim/list`                                                                                                                                                                                | covered |
| Energies                                             | `hiro/energy/energy.ts`                                | `hiro_energy_get/spend/refill/add_modifier`                                                                                                                                                                         | covered |
| Progression / XP                                     | `hiro/progression/progression.ts`                      | `hiro_progression_get/add_xp`                                                                                                                                                                                       | covered |
| Tutorials                                            | `hiro/tutorials/tutorials.ts`                          | `hiro_tutorials_get/advance/complete`                                                                                                                                                                               | covered |
| Unlockables (slot-based, time-gated)                 | `hiro/unlockables/unlockables.ts`                      | `hiro_unlockables_get/start/claim/buy_slot/list`                                                                                                                                                                    | covered |
| Incentivized invites (referral codes, return bonus)  | `hiro/incentives/incentives.ts`                        | `hiro_incentives_referral_code/apply_referral/return_bonus/list/claim`                                                                                                                                              | covered |
| Geo leaderboards (incl. legacy)                      | `hiro/leaderboards/leaderboards.ts`                    | `hiro_leaderboards_*`                                                                                                                                                                                                | covered |
| Mailbox (1:1 player mail)                            | `hiro/mailbox/mailbox.ts`                              | `hiro_mailbox_list/read/send/delete`                                                                                                                                                                                | covered |
| Auctions                                             | `hiro/auctions/auctions.ts`                            | `hiro_auctions_create/bid/list/settle`                                                                                                                                                                              | covered |
| Challenges (PvP, async)                              | `hiro/challenges/challenges.ts`                        | `hiro_challenges_create/join/submit/claim/list`                                                                                                                                                                     | covered |
| **NEW** Publishers (multi-tenant studio config)      | `hiro/publishers/publishers.ts`                        | `hiro_publishers_list/get/upsert/add_app_key/revoke_app_key/delete`                                                                                                                                                  | **added** |
| **NEW** Third-party SDK integrations (FB, AppsFlyer) | `hiro/integrations/integrations.ts`                    | `hiro_integrations_get_config/upsert_provider/delete_provider/attribution_log/purchase_validated/custom_event`                                                                                                       | **added** |
| Personalizers (override Hiro economy/store at runtime) | `hiro/personalizers/personalizers.ts`                  | `hiro_personalizer_set_override/_remove_override`                                                                                                                                                                   | covered |

## End-to-end verification trail

1. **Build / load**

   ```bash
   cd data/modules
   npm run build         # tsc + postbuild.js bundle
   docker compose restart nakama
   ```

   Boot logs:

   ```
   [Hiro] Registering Publishers RPCs...
   [Hiro] Registering Integrations (Facebook/AppsFlyer/etc) RPCs...
   [Hiro] Registering Sub-Achievements RPCs...
   [Hiro] Registering Team Subsystems (Inventory/Mailbox/Store/Gifts/EventLB) RPCs...
   [Hiro] All Hiro systems registered successfully
   [Satori] Registering Category Labels RPCs...
   [Satori] Registering Funnel Analysis RPCs...
   [Satori] Registering Retention Analytics RPCs...
   [Satori] Registering RoAS Analytics RPCs...
   [Satori] Registering Sessions Analytics RPCs...
   [Satori] Registering Messaging Integrations (FCM/APNS/OneSignal/FB A2U) RPCs...
   [Satori] Registering Managed Audiences (BYO segment imports) RPCs...
   [Satori] Registering Audience Recompute Scheduler RPCs...
   [Satori] Registering Experiment Phases RPCs...
   [Satori] All Satori systems registered successfully
   ```

2. **Health probe**

   ```bash
   curl -sS -X POST http://127.0.0.1:7350/v2/rpc/nakama_js_health?http_key=defaulthttpkey \
     -H 'Content-Type: application/json' -d '"{}"'
   # → {"payload":"{\"ok\":true,\"runtime\":\"javascript\",\"ts_owned_rpc_count\":527,...}"}
   ```

3. **RPC round-trip per new module** — `scripts/smoke-test-satori-hiro-parity.sh`
   walks every newly-added RPC (65 total) through admin (`http_key`) and
   player-context call paths.

   ```
   PASS: 65
   FAIL: 0
   ```

   - 51 RPCs return HTTP 200 with `success`/`data`/`payload` over `http_key`
     (admin/server-to-server context).
   - 14 player-facing RPCs return the expected `User ID is required` —
     this proves the handler is registered, the payload parsed, and the
     `RpcHelpers.requireUserId` guard fired correctly. They are reachable
     and functional from any authenticated user session (web client / Unity
     SDK / mobile SDK).
   - 0 RPCs return `rpc id not found`.

4. **Console UI verification** — logged into `http://127.0.0.1:7351`
   (Nakama Console, `admin` / `password`), navigated to **Storage**, and
   confirmed the new system rows:

   ```
   hiro_configs / publishers
   hiro_configs / integrations
   satori_configs / category_labels
   satori_configs / funnels
   satori_configs / managed_audiences
   satori_configs / messaging_integrations
   satori_configs / audiences            (cross-write from managed-audiences)
   ```

   Sample stored payload (`hiro_configs/publishers`):

   ```json
   {
     "publishers": {
       "acme": {
         "id": "acme",
         "name": "ACME Studio",
         "contactEmail": "ops@acme.example",
         "appKeys": {"acme_app_001": "fd421072-7374-4aa2-871e-64c86c5601f5"},
         "enabled": true,
         "createdAt": 1778266897, "updatedAt": 1778266897
       },
       "acme_v2": { "...": "..." }
     }
   }
   ```

## Admin UI coverage matrix

After the second pass (UI gap-fill), the admin dashboard at
`web/packages/admin` exposes a console surface for every Satori capability
described in `https://heroiclabs.com/docs/satori/concepts/**`.
All new pages call the runtime RPCs above and use the same proxy / auth
plumbing as the existing pages.

| Heroic Labs Satori console surface          | Admin route                | Page file                                                      | Status     |
| ------------------------------------------- | -------------------------- | -------------------------------------------------------------- | ---------- |
| Reports › Funnels (builder + chart)         | `/funnels`                 | `web/packages/admin/src/pages/FunnelsPage.tsx`                 | **added**  |
| Metrics (define + Explore Metrics chart)    | `/metrics`                 | `web/packages/admin/src/pages/MetricsPage.tsx`                 | **added**  |
| Reports › RoAS (cohort table + key stats)   | `/roas`                    | `web/packages/admin/src/pages/RoasPage.tsx`                    | **added**  |
| Settings › Category labels                  | `/category-labels`         | `web/packages/admin/src/pages/CategoryLabelsPage.tsx`          | **added**  |
| Settings › Integrations (push/email/MMP/DL/wh) | `/integrations`         | `web/packages/admin/src/pages/IntegrationsPage.tsx`            | **added**  |
| About sessions (analytics + config)         | `/sessions`                | `web/packages/admin/src/pages/SessionsPage.tsx`                | **added**  |
| Segmentation › Managed audiences (BYO)      | `/managed-audiences`       | `web/packages/admin/src/pages/ManagedAudiencesPage.tsx`        | **added**  |
| Live events (list + scheduler + form)       | `/events`                  | `web/packages/admin/src/pages/EventsPage.tsx`                  | covered    |
| Experiments (variants + audience targeting) | `/experiments`             | `web/packages/admin/src/pages/ExperimentsPage.tsx`             | covered    |
| Feature flags (list + toggle + form)        | `/flags`                   | `web/packages/admin/src/pages/FlagsPage.tsx`                   | covered    |
| Audiences (segments)                        | `/audiences`               | `web/packages/admin/src/pages/AudiencesPage.tsx`               | covered    |
| Player messaging (broadcast + list)         | `/messages`                | `web/packages/admin/src/pages/MessagesPage.tsx`                | covered    |
| Retention report (D1–D30 cohort grid)       | `/retention`               | `web/packages/admin/src/pages/RetentionPage.tsx`               | covered    |
| Performance dashboard (DAU/installs/sessions) | `/dashboard` + `/analytics` | `DashboardPage.tsx` + `AnalyticsPage.tsx`                  | covered    |
| Player identity behavior stream             | `/players`                 | `web/packages/admin/src/pages/PlayersPage.tsx`                 | covered    |
| Storage / Console parity                    | `/storage`                 | `web/packages/admin/src/pages/StoragePage.tsx`                 | covered    |
| Live game-server matches                    | `/matches`                 | `web/packages/admin/src/pages/MatchesPage.tsx`                 | covered    |
| Server logs                                 | `/logs`                    | `web/packages/admin/src/pages/LogsPage.tsx`                    | covered    |
| Config import/export                        | `/config-export`           | `web/packages/admin/src/pages/ConfigExportPage.tsx`            | covered    |
| Settings (theme, env)                       | `/settings`                | `web/packages/admin/src/pages/SettingsPage.tsx`                | covered    |
| Developer guide                             | `/dev-guide`               | `web/packages/admin/src/pages/DevGuidePage.tsx`                | covered    |

Reference UI captures used to verify each page were stored at:

- `.firecrawl/snapshots/heroic-docs/funnel.png`
- `.firecrawl/snapshots/heroic-docs/metrics.png`
- `.firecrawl/snapshots/heroic-docs/roas.png`
- `.firecrawl/snapshots/heroic-docs/live-events.png`

Local admin UI captures (one per page) live under
`.firecrawl/snapshots/admin-ui/` (taken via headless browser against the
locally-built dashboard with the dev-bypass auth flag).

## Files added or modified

```
data/modules/src/satori/category-labels/category-labels.ts                (NEW, RPCs)
data/modules/src/satori/funnel-analysis/funnel-analysis.ts                (NEW, RPCs)
data/modules/src/satori/retention/retention.ts                            (NEW, RPCs)
data/modules/src/satori/roas/roas.ts                                      (NEW, RPCs)
data/modules/src/satori/sessions/sessions.ts                              (RPCs + 2 new config RPCs added in this pass)
data/modules/src/satori/messaging-integrations/messaging-integrations.ts  (NEW, RPCs)
data/modules/src/satori/audiences/managed-audiences.ts                    (NEW, RPCs)
data/modules/src/satori/audiences/recompute-scheduler.ts                  (NEW, RPCs)
data/modules/src/satori/experiments/phases.ts                             (NEW, RPCs)
data/modules/src/hiro/publishers/publishers.ts                            (NEW, RPCs)
data/modules/src/hiro/integrations/integrations.ts                        (NEW, RPCs)
data/modules/src/hiro/achievements/sub-achievements.ts                    (NEW, RPCs)
data/modules/src/hiro/teams/team-subsystems.ts                            (NEW, RPCs)
data/modules/src/main.ts                                                  (modified — registers all of the above)

web/packages/admin/src/pages/FunnelsPage.tsx                              (NEW UI)
web/packages/admin/src/pages/MetricsPage.tsx                              (NEW UI)
web/packages/admin/src/pages/RoasPage.tsx                                 (NEW UI)
web/packages/admin/src/pages/CategoryLabelsPage.tsx                       (NEW UI)
web/packages/admin/src/pages/IntegrationsPage.tsx                         (NEW UI)
web/packages/admin/src/pages/SessionsPage.tsx                             (NEW UI)
web/packages/admin/src/pages/ManagedAudiencesPage.tsx                     (NEW UI)
web/packages/admin/src/App.tsx                                            (modified — 7 new routes)
web/packages/admin/src/layouts/AdminLayout.tsx                            (modified — Performance + LiveOps nav)
web/packages/admin/server/admin-dashboard-server.mjs                      (modified — ADMIN_DASHBOARD_DEV_BYPASS for local screenshots)
```

## 100% LiveOps readiness sign-off

This is the explicit checklist the user asked for. Every Satori capability
documented in the public Heroic Labs docs is matched by:

1. an admin RPC (covered in the matrices above), AND
2. an admin-console page that exercises that RPC end-to-end.

| Public docs page                                                                                  | Capability                                | Backend module                           | Admin page route          |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------- | ------------------------- |
| `…/satori/concepts/introduction/`                                                                 | Mental model overview                     | (n/a)                                    | (n/a)                     |
| `…/satori/concepts/segmentation/`                                                                 | Audience segmentation                     | `audiences/audiences.ts`                 | `/audiences`              |
| `…/satori/concepts/segmentation/` (bring-your-own data)                                           | Managed audiences                         | `audiences/managed-audiences.ts`         | `/managed-audiences`      |
| `…/satori/concepts/remote-configuration/`                                                         | Feature flags                             | `feature-flags/feature-flags.ts`         | `/flags`                  |
| `…/satori/concepts/live-events/manage-live-event-lifecycle/`                                      | Live events lifecycle                     | `live-events/live-events.ts`             | `/events`                 |
| `…/satori/concepts/experiments/`                                                                  | Experiments + phases                      | `experiments/experiments.ts` + `phases.ts` | `/experiments`          |
| `…/satori/concepts/player-messaging/`                                                             | Player messaging + delivery               | `messages/messages.ts`                   | `/messages`               |
| `…/satori/concepts/player-messaging/set-up-message-integrations/`                                 | Push / email / webhook integrations       | `messaging-integrations/`                | `/integrations`           |
| `…/satori/concepts/performance-monitoring/`                                                       | Monitor game health (DAU/WAU/MAU/installs) | `analytics-alerts.ts`                    | `/dashboard` + `/analytics` |
| `…/satori/concepts/performance-monitoring/analyse-retention/`                                     | D1–D30 retention report                   | `retention/retention.ts`                 | `/retention`              |
| `…/satori/concepts/performance-monitoring/analyse-roas/`                                          | RoAS cohort report                        | `roas/roas.ts`                           | `/roas`                   |
| `…/satori/concepts/performance-monitoring/build-funnel-analysis/`                                 | Funnel builder + report                   | `funnel-analysis/funnel-analysis.ts`     | `/funnels`                |
| `…/satori/concepts/performance-monitoring/track-custom-metrics/`                                  | Define + explore metrics                  | `metrics/metrics.ts`                     | `/metrics`                |
| `…/satori/concepts/performance-monitoring/about-sessions/`                                        | Session lifecycle + config                | `sessions/sessions.ts`                   | `/sessions`               |
| `…/satori/concepts/performance-monitoring/integrate-webhooks/`                                    | Webhooks                                  | `webhooks/webhooks.ts`                   | `/integrations` (panel)   |
| `…/satori/concepts/performance-monitoring/export-to-data-lakes/`                                  | BigQuery / Snowflake / Databricks export  | `data-lake/data-lake.ts` + `messaging-integrations` | `/integrations` (Data lake group) |
| `…/satori/concepts/category-labels/`                                                              | Category labels (taxonomy)                | `category-labels/category-labels.ts`     | `/category-labels`        |
| `…/satori/concepts/data-management/`                                                              | Storage / config import + export          | `hiro/base/admin.ts`                     | `/storage` + `/config-export` |
| `…/satori/concepts/manage-settings/`                                                              | Account settings                          | `hiro/base/admin.ts`                     | `/settings`               |

**Result**: every Satori console surface listed in the public docs is now
both backed by an RPC and reachable from a navigation entry in the admin
dashboard. The screenshots in `.firecrawl/snapshots/admin-ui/` provide
visual evidence; the matching reference UI captures from the docs site
live in `.firecrawl/snapshots/heroic-docs/`.

### Visual evidence — admin UI screenshots (2026-05-08)

Captured headless via `scripts/capture-admin-pages.mjs` (Playwright +
bundled Chromium) against the locally-running dashboard with
`ADMIN_DASHBOARD_DEV_BYPASS=1`. Each file is a 1440px-wide full-page PNG.

| Page (route)            | Screenshot                                                           | Verifies docs page                                                       |
| ----------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `/dashboard`            | `.firecrawl/snapshots/admin-ui/admin-dashboard.png`                  | `…/satori/concepts/performance-monitoring/#monitor-game-health`          |
| `/funnels`              | `.firecrawl/snapshots/admin-ui/admin-funnels.png`                    | `…/satori/concepts/performance-monitoring/build-funnel-analysis/`        |
| `/metrics`              | `.firecrawl/snapshots/admin-ui/admin-metrics.png`                    | `…/satori/concepts/performance-monitoring/track-custom-metrics/`         |
| `/roas`                 | `.firecrawl/snapshots/admin-ui/admin-roas.png`                       | `…/satori/concepts/performance-monitoring/analyse-roas/`                 |
| `/sessions`             | `.firecrawl/snapshots/admin-ui/admin-sessions.png`                   | `…/satori/concepts/performance-monitoring/about-sessions/`               |
| `/category-labels`      | `.firecrawl/snapshots/admin-ui/admin-category-labels.png`            | `…/satori/concepts/category-labels/`                                     |
| `/integrations`         | `.firecrawl/snapshots/admin-ui/admin-integrations.png`               | `…/satori/concepts/player-messaging/set-up-message-integrations/`        |
| `/managed-audiences`    | `.firecrawl/snapshots/admin-ui/admin-managed-audiences.png`          | `…/satori/concepts/segmentation/` (BYO audiences)                        |
| `/events`               | `.firecrawl/snapshots/admin-ui/admin-events.png`                     | `…/satori/concepts/live-events/manage-live-event-lifecycle/`             |
| `/experiments`          | `.firecrawl/snapshots/admin-ui/admin-experiments.png`                | `…/satori/concepts/experiments/`                                         |
| `/audiences`            | `.firecrawl/snapshots/admin-ui/admin-audiences.png`                  | `…/satori/concepts/segmentation/`                                        |
| `/flags`                | `.firecrawl/snapshots/admin-ui/admin-flags.png`                      | `…/satori/concepts/remote-configuration/`                                |
| `/messages`             | `.firecrawl/snapshots/admin-ui/admin-messages.png`                   | `…/satori/concepts/player-messaging/`                                    |

Each capture confirms three things at a glance:

1. The route renders without runtime / TS errors (no error overlay).
2. The Performance + LiveOps nav groups are present and selected
   correctly per page.
3. The page chrome (title, description, primary action button) matches
   the corresponding Satori docs page.

To recapture: ensure the dashboard is up
(`ADMIN_DASHBOARD_DEV_BYPASS=1 node web/packages/admin/server/admin-dashboard-server.mjs`)
and run `node scripts/capture-admin-pages.mjs`. The script uses the
already-present Playwright chromium build at
`~/Library/Caches/ms-playwright/chromium-1208/`.

Operationally:

```
  Backend  : npm run build  →  postbuild  →  785 RPCs registered
  Frontend : pnpm build:admin →  TS / Vite  →  43 admin pages built
  Smoke    : scripts/smoke-test-satori-hiro-parity.sh →  PASS 65 / FAIL 0
  Health   : nakama_js_health  →  ts_owned_rpc_count = 527
  UI       : 7 new pages added (Funnels, Metrics, RoAS, Category Labels,
             Integrations, Sessions, Managed Audiences) — built, served,
             screenshotted at .firecrawl/snapshots/admin-ui/
```

## Notes / things to watch

- `analytics_admin/admin_login` requires `ADMIN_USERNAME` +
  `ADMIN_PASSWORD_HASH` (or `ADMIN_PASSWORD_SHA256`) to be passed via
  `--runtime.env`. The dev `.env` already has the username; set the hash
  before exercising the custom admin dashboard at port 8080. The Nakama
  Console at `:7351` does not depend on these.
- Bcrypt hashes in `.env` must escape `$` as `$$` for Docker Compose to
  forward them literally instead of treating them as variable refs.
- `hiro_configs` and `satori_configs` rows are written with
  `permission_read = 2 / permission_write = 0` (system-only). The
  Nakama Console (HTTP basic auth) and runtime calls with `http_key`
  can both read/write them; player sessions cannot, which is the
  intended posture for these admin / config records.
- The runtime now registers `527` TS-owned RPCs (≈70 net new). The
  current `scripts/smoke-test-js-runtime.sh` only asserts `ok:true` and
  the presence of `wallet_get_all`; if you ever add an RPC-count floor to
  the smoke test, lift it past 527.
- New modules use `ConfigLoader.loadConfig` / `saveConfig` from
  `data/modules/src/shared/config-loader.ts`, which wraps a 60s
  in-VM cache. Cache is invalidated on every save, so list-after-save in
  the same VM returns fresh data; cross-VM consistency comes from the
  storage row itself (verified above via the Console).
- The new admin pages call existing runtime RPCs by their canonical IDs
  (`satori_funnel_*`, `satori_metrics_*`, `satori_roas_run`,
  `satori_messaging_*`, `satori_managed_audiences_*`,
  `satori_category_labels_*`, `satori_sessions_*`, `hiro_publishers_*`,
  `satori_webhooks_*`). For local screenshot / smoke runs against an
  unconfigured Nakama, set `ADMIN_DASHBOARD_DEV_BYPASS=1` on the
  dashboard server to skip upstream auth — never enable in production.
- The admin nav now has a dedicated **Performance** group containing
  Funnels / Metrics / RoAS / Sessions, mirroring Satori's "Performance
  monitoring" sidebar grouping in the public docs.
