# Multiplayer Performance QA - 2026-05-01

**Scope:** Production-safe server-side performance smoke on EKS  
**Cluster namespace:** `aicart`  
**Image digest:** `sha256:b3bc5a3628bea34ca5814c4357b0e94ce69533d375c7b2b6e80765bc26265f30`  
**Status:** Server-side creation-path performance smoke passed  

This report records the bounded performance smoke that was run against the
deployed Nakama server. It does not certify every client platform, device,
engine, language, browser, or game genre. Client/device performance requires the
platform harnesses described in `AGENT_SKILLS_INTEGRATION_PLAYBOOK.md`.

## Method

- Ran from inside a live Nakama pod against `http://127.0.0.1:7350`.
- Used the Nakama HTTP RPC endpoint with the cluster `http_key`.
- Ran 10 sequential requests per case.
- Covered every deployed multiplayer creation path plus QuizVerse.
- Measured `curl` total request latency in milliseconds.
- Kept request volume intentionally small to avoid a destructive production load
  test.

## Results

| Case | RPC | Count | OK | Failed | Min ms | Avg ms | P50 ms | P95 ms | Max ms |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `mp_list_templates` | `mp_list_templates` | 10 | 10 | 0 | 0 | 0 | 0 | 1 | 1 |
| `sync-turn-v1` | `mp_create_match` | 10 | 10 | 0 | 19 | 20 | 20 | 23 | 23 |
| `async-turn-v1` | `mp_create_match` | 10 | 10 | 0 | 17 | 29 | 19 | 124 | 124 |
| `lobby-handoff-v1` | `mp_create_match` | 10 | 10 | 0 | 18 | 28 | 20 | 66 | 66 |
| `conversational-party-v1` | `mp_create_match` | 10 | 10 | 0 | 17 | 17 | 17 | 19 | 19 |
| `live-event-v1` | `mp_create_match` | 10 | 10 | 0 | 19 | 26 | 20 | 66 | 66 |
| `persistent-party-v1` | `mp_create_match` | 10 | 10 | 0 | 17 | 18 | 18 | 22 | 22 |
| `mixed-reality-anchor-v1` | `mp_create_match` | 10 | 10 | 0 | 19 | 34 | 20 | 96 | 96 |
| `avatar-replication-v1` | `mp_create_match` | 10 | 10 | 0 | 1 | 1 | 1 | 1 | 1 |
| `realtime-tick-v1` | `mp_create_match` | 10 | 10 | 0 | 1 | 1 | 1 | 1 | 1 |
| `quizverse_create_match` | `quizverse_create_match` | 10 | 10 | 0 | 18 | 21 | 21 | 28 | 28 |

## Health Check

After the smoke:

- `intelliverse-nakama`: rollout healthy, `2/2` ready.
- `intelliverse-nakama-multiplayer`: rollout healthy, `3/3` ready.
- Both deployments used image digest
  `sha256:b3bc5a3628bea34ca5814c4357b0e94ce69533d375c7b2b6e80765bc26265f30`.
- No `matchCreate failed`, `registerMatch failed`, fatal, panic, or OTel errors
  were observed in the post-test multiplayer log window.
- `kubectl top` showed the active test pod at approximately `159m` CPU and
  `525Mi` memory shortly after the smoke.

## Platform Coverage

This smoke validates server-side RPC/match creation performance only.

| Platform / language | Performance status |
| --- | --- |
| Web / TypeScript / JavaScript | Blocked for client performance: no current `mp_*` browser game harness found. |
| Unity / C# | Blocked for client performance: Unity projects exist, but no current `mp_*` adapter/demo harness was found. |
| Unreal / C++ / Blueprint | Blocked: no project or harness found. |
| Godot / GDScript / C# | Blocked: no project or harness found. |
| iOS / iPadOS / Swift | Blocked: no project or harness found. |
| visionOS / Swift or Unity | Blocked: no project or harness found. |
| watchOS / Swift | Blocked: no project or harness found. |
| Android / Kotlin / Java | Blocked: no project or harness found. |
| Quest / Oculus | Blocked: no headset/client harness found. |
| Custom engines / C++ / Python tooling | Blocked: no adapter or harness found. |

## Follow-Up Required

To claim all-platform performance support, add real harnesses for each platform:

1. Adapter-level RPC latency test.
2. Socket connect/reconnect test.
3. Match join latency test.
4. Match data send/receive throughput test.
5. Agent presence and conversational avatar test.
6. Avatar/XR pose stream test where supported.
7. Device/browser/engine matrix output with p50/p95/p99, CPU, memory, and error
   rates.

## Separate Non-Multiplayer Warning

Recent logs still showed analytics tick warnings such as:

- `[EventEnricher] scanCoverage failed: expects empty or valid user id`
- `[InsightsAggregator] sample scan failed: expects empty or valid user id`
- `[PendingBundles] drain failed: expects empty or valid user id`

These did not come from the multiplayer performance smoke, but they should be
tracked separately because they indicate remaining analytics storage ownership
cleanup.
