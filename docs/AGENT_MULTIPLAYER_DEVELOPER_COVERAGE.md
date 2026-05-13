# Agent, Avatar, and Multiplayer Developer Coverage

**Status:** Server implementation documented and QA-emulated  
**Last verified:** 2026-05-01  
**Audience:** Game developers, client SDK authors, multiplayer engineers, QA, DevOps
**Agent Skills process:** `docs/AGENT_SKILLS_INTEGRATION_PLAYBOOK.md`

This document is the GitHub-facing source of truth for the current
Intelliverse Nakama multiplayer surface: AI agents, avatar interaction,
sync/async game sessions, lobby handoff, live events, persistent parties,
conversational rooms, and XR anchors.

It also documents the gaps honestly. "100% coverage" here means 100% coverage
of the currently known server code paths, discovered SDK/client repositories,
developer entry points, QA status, and missing work. It does not mean every
possible game, genre, client SDK, headset, browser, phone, watch, or engine has
been certified.

## Executive Summary

The Nakama server now exposes a platform-agnostic multiplayer foundation:

- `mp_create_match` creates generic multiplayer matches by template id.
- `mp_list_templates` lists the server-approved template ids and opcode ranges.
- `mp_read_match_result` reads persisted match outcomes.
- JavaScript match templates cover sync, async, lobby, tournament, live event,
  persistent party, conversational party, and mixed reality anchor sessions.
- Native Go match modules cover high-frequency realtime tick and avatar
  replication paths.
- AI agents are represented as first-class server-managed presences whose
  `user_id` starts with `agt_`.
- Conversational rooms support human members, AI agents, text, voice token
  minting, transcript settings, and moderation hooks.
- `max_players`, `max_members`, `max_attendees`, `max_users`, and `max_agents`
  use `0` to mean "unlimited by this template." Operators and game plugins can
  still set finite limits when gameplay, cost, bandwidth, or safety requires it.

Live EKS QA emulation passed match creation for:

- `sync-turn-v1`
- `async-turn-v1`
- `lobby-handoff-v1`
- `conversational-party-v1`
- `live-event-v1`
- `persistent-party-v1`
- `mixed-reality-anchor-v1`
- `avatar-replication-v1`
- `realtime-tick-v1`
- `quizverse_create_match`

The server foundation is signed off. End-to-end client/device/engine
certification remains pending until real clients and test harnesses are present
for each platform.

## SDK Synchronization Policy

This document must stay synchronized with the actual SDK/client codebase. A
capability is considered fully covered only when all of these are true:

1. The server implementation exists and is linked in this document.
2. The relevant SDK/client adapter exists and is linked in this document.
3. The adapter exposes the documented RPC, socket, match, payload, or presence
   behavior without relying on undocumented names.
4. A runnable test, smoke script, scene, browser harness, or device harness
   exists for the supported platform.
5. The docs state the exact platform/language/runtime coverage and any limits.

If any item is missing, the capability must be marked "server-ready" or
"documented gap", not "SDK signed off."

For the cross-platform process to add Agent Skills into any IDE, engine,
language, or existing project with a demo UI, follow
`docs/AGENT_SKILLS_INTEGRATION_PLAYBOOK.md`.

### Discovered SDK and Client Code

The local audit found these client/SDK surfaces outside this Nakama server repo:

| Codebase | Language/runtime | Observed Nakama use | Current sync status |
| --- | --- | --- | --- |
| `intelliverse-x-games-platform-2/games/quiz-verse` | Unity/C# | Heroic Labs Nakama Unity package, game RPC/social code, QuizVerse clients; realtime gameplay also uses Photon. | Present locally, but not yet synchronized to the new `mp_*` kernel templates or agent/avatar coverage in this doc. |
| `intelliverse-x-games-platform-2/games/water-sort` | Unity/C# | Nakama Unity package and sample/snippet patterns. | Present locally, app-layer multiplayer/agent/avatar coverage not verified. |
| `cricket-vr-mob` | Unity/C# | Nakama RPC/backend fantasy flows plus Photon packages. | Present locally, not verified as a Nakama multiplayer-kernel client. |
| `nakama/web` | TypeScript/React | Custom HTTP RPC helpers and raw WebSocket/channel/presence code. | Present in this repo, but not a full game SDK adapter for `mp_*` match templates. |
| `nakama/mcp-server` | TypeScript | Operator/admin tooling client. | Present in this repo, not a gameplay SDK. |

Not found in the local audit:

- Swift/iOS/visionOS/watchOS app code.
- Kotlin/Java Android app code.
- Unreal projects.
- Godot projects.
- A standalone npm `@heroiclabs/nakama-js` game client.
- Generated IntelliVerse multiplayer client adapters from `schemas/multiplayer`.

Therefore, the server and docs can be 100% synchronized for the Nakama repo, but
the SDK sign-off cannot be 100% until the Unity/web/native SDK adapters are
updated or linked and tested.

## Source Map

Use this map before changing behavior.

| Area | Source | Notes |
| --- | --- | --- |
| Multiplayer kernel entry point | `data/modules/src/multiplayer-kernel/index.ts` | Template ids, `mp_*` RPCs, `prepareTemplates`, Go-template whitelisting. |
| Match handler wrapper | `data/modules/src/multiplayer-kernel/match-handler.ts` | Wraps `IMatchTemplate` implementations and stores handlers by template id. |
| Nakama AST bridge | `data/modules/src/multiplayer-kernel/ast-match-bridge.ts` | Stable global match hook names used by the generated `InitModule`. |
| Build-time bridge injection | `data/modules/postbuild.js` | Registers direct `initializer.registerRpc` and `initializer.registerMatch` calls for Goja/Nakama AST compatibility. |
| Shared wire/kernel types | `data/modules/src/multiplayer-kernel/types.ts` | Opcode ranges, kernel errors, warnings, `IMatchTemplate`, match result envelope. |
| Opcode registry | `data/modules/src/multiplayer-kernel/code-registry.ts` | Detects range collisions and reserves JS/Go template opcode space. |
| Clock helpers | `data/modules/src/multiplayer-kernel/clock.ts` | Server clock authority and clock-sync emission. |
| Error helpers | `data/modules/src/multiplayer-kernel/error.ts` | Canonical error envelope builders and send helpers. |
| Idempotency helpers | `data/modules/src/multiplayer-kernel/idempotency.ts` | Client opcode UUID dedupe window. |
| Presence helpers | `data/modules/src/multiplayer-kernel/presence.ts` | Presence and reconnect bookkeeping. |
| Spatial helpers | `data/modules/src/multiplayer-kernel/spatial.ts` | Spatial frame and position utilities. |
| Voice helpers | `data/modules/src/multiplayer-kernel/voice.ts` | Speaker floor and shared voice state helpers. |
| AI agents | `data/modules/src/multiplayer-kernel/agents.ts` | Persona registry, agent spawn/despawn/speak, budgets, provider hooks, `agt_` ids. |
| Conversational party | `data/modules/src/multiplayer-kernel/templates/conversational-party-match.ts` | Human/agent social rooms, speaker queue, transcript, voice provider metadata. |
| Voice providers | `data/modules/src/multiplayer-kernel/voice-providers/index.ts` | `mp_voice_token` RPC and LiveKit token minting bridge. |
| Moderation | `data/modules/src/multiplayer-kernel/moderation.ts` | Text/agent moderation policy and admin RPCs. |
| Interest/AOI helpers | `data/modules/src/multiplayer-kernel/interest.ts` | Spatial interest bookkeeping and `mp_interest_size`. |
| Match result persistence | `data/modules/src/multiplayer-kernel/match-result.ts` | System-owned storage read/write for match outcomes. |
| Sync template | `data/modules/src/multiplayer-kernel/templates/sync-turn-match.ts` | Synchronous turn game base. |
| Async template | `data/modules/src/multiplayer-kernel/templates/async-turn-match.ts` | Persistent asynchronous turn game base. |
| Lobby template | `data/modules/src/multiplayer-kernel/templates/lobby-handoff-match.ts` | Pre-game lobby with handoff to a target match template. |
| Tournament template | `data/modules/src/multiplayer-kernel/templates/tournament-match.ts` | Registration, bracket generation, leg orchestration. |
| Live event template | `data/modules/src/multiplayer-kernel/templates/live-event-match.ts` | Long-running crowd/event sessions. |
| Persistent party template | `data/modules/src/multiplayer-kernel/templates/persistent-party-match.ts` | Long-lived social/party room state. |
| Mixed reality anchor template | `data/modules/src/multiplayer-kernel/templates/mixed-reality-anchor-match.ts` | XR anchor resolution and spatial state. |
| Realtime tick | `data/modules/realtime_tick/main.go` | Native Go low-latency tick template with snapshots, deltas, reconciliation, quality reports, and WebRTC signaling opcodes. |
| Avatar replication | `data/modules/avatar_replication/main.go` | Native Go high-frequency avatar pose replication template. |
| QuizVerse integration | `data/modules/src/games/quizverse/index.ts` | QuizVerse generators and wrapper RPCs. |
| QuizVerse KB triad | `data/modules/src/analytics/quizverse-kb-triad.ts` | Knowledge-base context, seen-question tracking, unseen-question filtering, and chatbox RPCs. |

## Implemented Multiplayer Templates

All template ids must be created through `mp_create_match` unless a game plugin
exposes a higher-level RPC such as `quizverse_create_match`.

| Template id | Runtime | Default capacity | Primary use |
| --- | --- | --- | --- |
| `sync-turn-v1` | TypeScript/Goja | `max_players: 0` | Synchronous turn games, quiz battles, party rounds. |
| `async-turn-v1` | TypeScript/Goja | Game-defined participants | Asynchronous turns, challenge games, delayed completion. |
| `lobby-handoff-v1` | TypeScript/Goja | `max_players: 0` | Lobby gathering, ready checks, handoff to target match. |
| `tournament-v1` | TypeScript/Goja | `max_players: 0` | Registration, bracket generation, tournament legs. |
| `live-event-v1` | TypeScript/Goja | `max_attendees: 0` | Large event rooms, crowd reactions, phase progression. |
| `persistent-party-v1` | TypeScript/Goja | `max_members: 0` | Persistent friend groups, parties, shared state. |
| `conversational-party-v1` | TypeScript/Goja | `max_members: 0`, `max_agents: 0` | Human/agent social rooms with voice and transcripts. |
| `mixed-reality-anchor-v1` | TypeScript/Goja | `max_users: 0` | XR anchor negotiation and shared spatial state. |
| `realtime-tick-v1` | Native Go plugin | `max_players: 0` | Low-latency realtime tick loops. |
| `avatar-replication-v1` | Native Go plugin | `max_avatars: 0` | High-frequency pose, avatar LOD, XR spatial voice bridge. |

`0` capacity means the template does not reject joins because of that specific
capacity setting. It does not remove real infrastructure limits such as CPU,
memory, network fan-out, database writes, LiveKit quotas, or per-game safety
policy.

## RPC Surface

### Multiplayer

| RPC | Implemented in | Purpose |
| --- | --- | --- |
| `mp_create_match` | `multiplayer-kernel/index.ts` | Create a match by `template_id`, `game_id`, `region`, and `template_init`. |
| `mp_list_templates` | `multiplayer-kernel/index.ts` | Return registered template ids and opcode ranges. |
| `mp_read_match_result` | `multiplayer-kernel/index.ts` | Read persisted result envelope. |

Example:

```json
{
  "template_id": "lobby-handoff-v1",
  "game_id": "my-game",
  "region": "us-east-1",
  "template_init": {
    "target_template_id": "sync-turn-v1",
    "target_template_init": {
      "generator_id": "my-game:round",
      "min_players": 2,
      "max_players": 0
    },
    "min_players": 2,
    "max_players": 0
  }
}
```

Documentation split: `docs/COMPLETE_RPC_REFERENCE.md` does not currently list
the `mp_*` multiplayer kernel RPCs. For multiplayer, agents, voice, moderation,
and interest RPCs, use this document and
`data/modules/src/multiplayer-kernel/README.md` as the current source of truth.
Also note that `IIVXMultiplayer.createMatch` appears as an intended adapter API
in the kernel README but is not defined in this repository.

### Agents

| RPC | Implemented in | Purpose |
| --- | --- | --- |
| `mp_agent_spawn` | `multiplayer-kernel/agents.ts` | Spawn a server-managed AI agent into a match. Gated by `isPrivileged`. |
| `mp_agent_despawn` | `multiplayer-kernel/agents.ts` | Remove an AI agent from a match. Gated by `isPrivileged`. |
| `mp_agent_list_personas` | `multiplayer-kernel/agents.ts` | List registered agent personas. Not gated by `isPrivileged` in current code. |
| `mp_agent_speak` | `multiplayer-kernel/agents.ts` | Run the agent speech path for a match. Gated by `isPrivileged`. |

Agent identifiers are generated with the `agt_` prefix. Templates and voice
providers use that prefix to distinguish AI agents from human users.

`isPrivileged` currently accepts one of these gates:

- `ctx.userId === "00000000-0000-0000-0000-000000000000"`
- `ctx.headers["x-ivx-server-token"]`
- `ctx.vars.server_token`

### Voice, Moderation, and Interest

| RPC | Implemented in | Purpose |
| --- | --- | --- |
| `mp_voice_token` | `multiplayer-kernel/voice-providers/index.ts` | Mint a match voice token, currently LiveKit-shaped. |
| `mp_mod_get_params` | `multiplayer-kernel/moderation.ts` | Inspect moderation settings. |
| `mp_mod_set_params` | `multiplayer-kernel/moderation.ts` | Update moderation settings. |
| `mp_mod_appeal` | `multiplayer-kernel/moderation.ts` | Open a moderation appeal. |
| `mp_interest_size` | `multiplayer-kernel/interest.ts` | Inspect interest/AOI bucket size. |

### QuizVerse

| RPC | Implemented in | Purpose |
| --- | --- | --- |
| `quizverse_create_match` | `games/quizverse/index.ts` | Create a QuizVerse match on top of `sync-turn-v1`. |
| `quizverse_list_packs` | `games/quizverse/index.ts` | List available question packs. |
| `quizverse_load_pack` | `games/quizverse/index.ts` | Load a specific question pack. System user only: `ctx.userId` must match `ctx.env["IVX_SYSTEM_USER_ID"]`. |
| `quizverse_kb_get_context` | `analytics/quizverse-kb-triad.ts` | Return KB context for QuizVerse. |
| `quizverse_kb_register_seen_questions` | `analytics/quizverse-kb-triad.ts` | Register seen question ids. |
| `quizverse_kb_filter_unseen_questions` | `analytics/quizverse-kb-triad.ts` | Filter question ids down to unseen questions. |
| `quizverse_chatbox_message` | `analytics/quizverse-kb-triad.ts` | Chatbox response path using KB triad context. |

The QuizVerse RPCs use global wrapper functions generated by `postbuild.js` so
Nakama's Goja AST extraction sees stable function names.

## Agent Skills Coverage

In this repository, "agent skills" means AI-agent capabilities available to
game sessions, not Cursor IDE skills.

Implemented:

- Persona registry via `MpKernelAgent.registerPersona`.
- Persona listing through `mp_agent_list_personas`.
- Agent spawn/despawn through privileged RPCs.
- Agent ids with `agt_` prefix.
- Agent speech through `MpKernelAgent.enqueueSpeech`.
- Default echo LLM provider for scaffold/testing without provider keys.
- Pluggable LLM provider via `setLLMProvider`.
- Pluggable TTS provider via `setTTSProvider`.
- Per-persona constraints:
  - `max_response_tokens`
  - `max_responses_per_minute`
  - `max_seconds_speaking_per_minute`
  - `max_concurrent_matches`
  - `allow_proactive_speak`
  - `allow_tools`
  - `cost_budget_usd_micros_per_match`
  - `locale_allowlist_csv`
- Budget, rate, and provider fallback fields on agent instances.
- Moderation entry point before speech fan-out.
- Conversational party support for AI participants with `max_agents: 0`.

Declared but not fully implemented:

- `AGENT_TOOL_CALL` opcode.
- `AGENT_TOOL_RESULT` opcode.
- End-to-end tool invocation, permissioning, result fan-out, retry policy, and
  audit log handling for agent tools.

Missing docs/gaps for agent skills:

- No `schemas/multiplayer/services/agent.proto` is present in this repository,
  even though code comments reference it.
- No canonical agent tool state machine is documented yet.
- No sample game plugin registers real production personas in this repository.
- No client adapter examples show rendering an `agt_` presence differently from
  a human player.
- No provider integration guide exists for OpenAI, Anthropic, Azure, custom LLM,
  or TTS vendors.
- No load/cost test fixture exists for many concurrent agent speakers.

Required before a full agent-skills production sign-off:

1. Add or link canonical proto/schema files.
2. Define the tool-call lifecycle:
   `request -> permission check -> provider/tool call -> result -> fan-out -> audit`.
3. Add at least one sample persona and one sample tool handler.
4. Add QA that spawns multiple agents into `conversational-party-v1`.
5. Add client rendering examples for human vs AI participants.
6. Add cost, rate, and moderation test cases.

## Avatar Interaction Coverage

There are two avatar meanings in this codebase.

### Profile Avatar

Profile avatar data, such as `avatar_url` or cosmetic metadata, is account or
game profile data. See:

- `PROFILE_SYSTEM_UPGRADE_SPECIFICATION.md`
- `docs/COMPLETE_RPC_REFERENCE.md`
- `GAME_ONBOARDING_GUIDE.md`

### Multiplayer Avatar Replication

Realtime avatar movement and XR pose replication use the native Go module:

- `data/modules/avatar_replication/main.go`

This module registers the `avatar-replication-v1` match handler and uses the
reserved `0xF000-0xFFFF` opcode range. It is designed for high-frequency pose
updates, avatar LOD, area-of-interest filtering, and spatial voice position
hints on the match wire. The Go module relays `OP_XR_VOICE_POSITION` as match
data; it does not directly publish to a LiveKit or other voice-provider API.

Implemented:

- Native Go avatar replication module.
- `avatar-replication-v1` template id whitelisted by the TypeScript kernel.
- Reserved XR pose opcode range.
- `max_avatars: 0` means unlimited avatars for join admission, matching the
  JavaScript templates' `0 = unlimited` convention.
- Conformance test file under `data/modules/avatar_replication/`.
- Server-side creation path through `mp_create_match`.

Missing docs/gaps:

- No top-level developer guide shows a client pose payload example.
- No Unity, WebXR, visionOS, Quest/Oculus, Unreal, or Godot sample client exists
  in this repository.
- No documented bandwidth budgets per avatar update channel.
- No documented graceful degradation rules for watchOS or low-power clients.
- No SDK adapter codegen from canonical avatar schemas exists in this checkout.

## Platform and Language Coverage

The server is engine-agnostic. Clients communicate with Nakama through RPCs,
realtime sockets, match joins, and match data messages. Platform readiness
depends on each client implementation.

| Platform/language | Server readiness | In-repo client/device QA |
| --- | --- | --- |
| Web browsers on PC (`TypeScript`/`JavaScript`) | Ready at RPC/socket/template level. | `nakama/web` exists with HTTP RPC and raw WebSocket/channel code, but no full `mp_*` game adapter/browser matrix. |
| Unity (`C#`) | Ready at Nakama protocol level. | Unity projects were found in sibling repos, but they are not yet synced to the new `mp_*` kernel/agent/avatar adapter surface. Archived SDK docs exist under `_archived_docs/sdk_guides/`. |
| Unreal (`C++`/Blueprint) | Ready at Nakama protocol level. | No Unreal project or harness found. |
| Godot (`GDScript`/C#) | Ready at Nakama protocol level. | No Godot project or harness found. |
| iOS/iPadOS (`Swift`, native or web view) | Ready at Nakama protocol level. | No Swift client or simulator harness found. |
| Android/mobile/tablet (`Kotlin`/`Java`) | Ready at Nakama protocol level. | No Kotlin/Java client harness found. |
| visionOS (`Swift`, Unity, WebXR) | Ready for server-side XR anchors/avatar sessions. | No visionOS simulator/device harness found. |
| Quest/Oculus (`Unity C#`, Unreal C++, WebXR) | Ready for server-side XR anchors/avatar sessions. | No headset harness found. |
| watchOS (`Swift`) | Suitable for companion/spectator/light-control flows. | No watchOS harness found; not signed off as a high-frequency gameplay client. |

Do not claim universal platform certification until client repositories and
automated device/browser/engine harnesses are connected.

## Game Genre Coverage

The server provides reusable primitives, not finished genre certification.

| Genre family | Best-fit template(s) | Notes |
| --- | --- | --- |
| Turn-based quiz/card/board | `sync-turn-v1`, `async-turn-v1` | Use game generators for scoring and turn payloads. |
| Party/social games | `lobby-handoff-v1`, `persistent-party-v1`, `conversational-party-v1` | Lobby and social state are covered; game-specific rules live in plugins. |
| Live events/trivia shows | `live-event-v1`, `sync-turn-v1` | Consider sharding for fan-out/cost. |
| Tournaments | `tournament-v1` plus target game template | Bracket and leg logic exists; client UX still required. |
| XR/shared-space games | `mixed-reality-anchor-v1`, `avatar-replication-v1` | Server primitives exist; headset/client payloads are not certified here. |
| Fast realtime action/FPS/racing/fighting | `realtime-tick-v1`, `avatar-replication-v1` | Server template exists, but genre-specific prediction, reconciliation, and anti-cheat require dedicated QA. |

## QA Status

Latest live server QA emulation:

- `mp_list_templates`: passed.
- `sync-turn-v1`: passed.
- `async-turn-v1`: passed.
- `lobby-handoff-v1`: passed.
- `conversational-party-v1`: passed with `max_members: 0` and `max_agents: 0`.
- `live-event-v1`: passed with `max_attendees: 0`.
- `persistent-party-v1`: passed with `max_members: 0`.
- `mixed-reality-anchor-v1`: passed with `max_users: 0`.
- `avatar-replication-v1`: passed match creation with `max_avatars: 0`.
- `realtime-tick-v1`: passed match creation.
- `quizverse_create_match`: passed with `max_players: 0`.

Build/runtime checks:

- `npm run build` in `data/modules`: passed.
- `node -c index.js`: passed.
- `scripts/smoke-test-js-runtime.sh image <image>`: passed.
- EKS rollout for `intelliverse-nakama`: passed.
- EKS rollout for `intelliverse-nakama-multiplayer`: passed.
- Recent logs: no active `matchCreate failed`, `registerMatch failed`, fatal,
  panic, or OTel sidecar errors observed in the checked window.

## Developer Definition of Done

For any change to multiplayer, agents, avatar replication, or templates:

1. Update the relevant source file and this coverage guide if behavior changes.
2. Run `npm run build` from `data/modules`.
3. Run `node -c index.js` from `data/modules`.
4. Run `scripts/smoke-test-js-runtime.sh image <candidate-image>` before deploy.
5. Verify `mp_list_templates` returns the expected template ids.
6. Verify `mp_create_match` for every changed template.
7. If adding a template, update:
   - `TEMPLATE_IDS` in `multiplayer-kernel/index.ts`
   - `prepareTemplates`
   - `postbuild.js` match bridge registration if it is a JS template
   - opcode reservation in `code-registry.ts` or Go equivalent
   - docs and QA cases
8. If adding an agent skill/tool, update:
   - `agents.ts` opcodes/handlers
   - privilege and moderation policy
   - audit logging
   - client rendering behavior
   - this document's agent skills section
9. If adding avatar wire payloads, update:
   - Go avatar module
   - canonical schema/proto docs
   - client payload examples
   - bandwidth and degradation budgets

## Known Missing Repository Gaps

These are the gaps that prevent a stronger "all platforms/all languages/all
genres" sign-off:

- Missing canonical schema files referenced by code comments:
  - `schemas/multiplayer/services/agent.proto`
  - `schemas/multiplayer/opcodes.proto`
  - `schemas/multiplayer/templates/*.proto`
- Missing `docs/multiplayer/error-taxonomy.md`, referenced by kernel types.
- Agent tool opcodes exist, but no full tool execution flow exists.
- No sample production persona registration.
- No client SDK adapter examples for agent presences, voice tokens, avatar pose
  payloads, or template-specific match data.
- Unity projects exist in sibling repositories, but no verified adapter coverage
  for the current `mp_*` kernel, agent, and avatar surface is documented here.
- No in-repo Unreal, Godot, Swift, Kotlin, visionOS, Quest/Oculus, or watchOS
  harnesses were available during QA.
- No automated browser matrix for Chrome, Edge, Firefox, and Safari.
- No genre-specific performance test suite for FPS/racing/fighting/MMO-style
  high-frequency traffic.
- No documented production limits for fan-out, bandwidth, LiveKit usage,
  storage writes, or maximum concurrent agent speakers.

## Sign-Off Language

Use this wording in release notes and stakeholder updates:

> Server-side multiplayer foundation is signed off for the currently
> implemented Nakama templates and RPC creation paths: sync, async, lobby,
> live event, persistent party, conversational party with AI agents, mixed
> reality anchor, and QuizVerse. The implementation supports unlimited
> template-level capacity semantics through `max_*: 0`, subject to real
> infrastructure and gameplay limits. Full client/device/engine certification
> remains pending for each platform, language, browser, headset, phone, tablet,
> and watch client.

Do not use:

> Certified for all games, all genres, all platforms, and all languages.

That claim is not supported by the codebase or QA evidence.
