# Agent Skills Integration Playbook

**Status:** Required process for SDK/client parity  
**Audience:** SDK authors, game teams, AI-agent developers, QA, platform owners  
**Companion doc:** `docs/AGENT_MULTIPLAYER_DEVELOPER_COVERAGE.md`

This playbook defines the required process for adding Agent Skills to any
existing project, IDE, platform, engine, or language while keeping the SDK,
server, demo UI, docs, and QA in sync.

The goal is simple: an agent skill should feel the same whether a developer is
using Unity/C#, Web/TypeScript, Unreal/C++, Godot, Swift, Kotlin, Java, C++,
Python tooling, visionOS, Quest/Oculus, watchOS, mobile, tablet, desktop, or a
custom engine. The implementation details can differ, but the adapter contract,
demo UI, and sign-off gates must not drift.

## Definition

An Agent Skill is a named, permissioned action that an AI agent can perform in a
multiplayer session or companion experience.

Examples:

- Speak as a conversational AI avatar.
- Request or take a turn in a sync game.
- Submit an async turn suggestion.
- Explain a lobby, rule, item, or quest.
- Spawn as a coach, host, NPC, moderator, teammate, opponent, or narrator.
- Call a safe game tool such as "hint", "summarize", "translate", "moderate",
  "teleport to anchor", "change outfit", "join party", or "start round".
- Emit avatar expression, viseme, gesture, pose, or spatial voice metadata.

Current server code already declares agent tool opcodes:

- `AGENT_TOOL_CALL`
- `AGENT_TOOL_RESULT`

Those opcodes are documented as not fully implemented in
`docs/AGENT_MULTIPLAYER_DEVELOPER_COVERAGE.md`. Until the full tool lifecycle is
implemented, each SDK must expose the current supported subset clearly:

- agent persona listing
- agent spawn
- agent despawn
- agent speak
- agent presence rendering via `agt_` user ids
- conversational room participation
- voice-token handoff where available
- avatar representation where available

## Required Repository Shape

Every platform adapter must have these files or equivalents:

```text
<project>/
  agent-skills/
    README.md
    AgentSkillClient.<language>
    AgentSkillModels.<language>
    AgentSkillDemo.<language-or-scene>
    AgentSkillTests.<language>
    platform-support.md
```

If the platform has its own conventions, use native naming while preserving the
same responsibilities:

- Unity: `AgentSkillClient.cs`, sample scene/prefab, PlayMode tests.
- Web: `agentSkillClient.ts`, React/Vue/Svelte demo component, browser tests.
- Unreal: `AgentSkillClient.h/.cpp`, Blueprint wrapper, sample map.
- Godot: `agent_skill_client.gd`, sample scene.
- iOS/visionOS/watchOS: Swift package/module, sample view, XCTest.
- Android: Kotlin/Java module, sample Activity/Composable, instrumented tests.
- C++ custom engine: header/source adapter, sample executable or scene.
- Python/CLI tools: package module, command demo, integration tests.

## Adapter Contract

Every SDK adapter must expose these capabilities with equivalent behavior.

### Connection and Auth

- Configure server host, SSL, ports, and auth/session token.
- Connect to Nakama socket when realtime behavior is needed.
- Reconnect and rejoin match/session after transient failures.
- Surface connection state to the demo UI.

### Template Discovery

- Call `mp_list_templates`.
- Cache available template ids and opcode ranges.
- Show unsupported or missing templates in the demo UI.
- Fail clearly if the server does not list a template required by the demo.

### Match Creation

- Call `mp_create_match`.
- Support these template ids:
  - `sync-turn-v1`
  - `async-turn-v1`
  - `lobby-handoff-v1`
  - `conversational-party-v1`
  - `live-event-v1`
  - `persistent-party-v1`
  - `mixed-reality-anchor-v1`
  - `avatar-replication-v1`
  - `realtime-tick-v1`
- Support `max_*: 0` as "unlimited by this template."
- Let game code pass finite caps when desired.

### Match Join and Messaging

- Join a match by id.
- Send match data messages with a stable envelope model.
- Receive and route match data by opcode.
- Expose human and agent presences.
- Treat `agt_` user ids as AI-agent presences.
- Include client-generated idempotency ids where the template requires them.

### Agent Persona and Presence

- Call `mp_agent_list_personas`.
- Render personas in the demo UI.
- Render AI agents separately from human users.
- Display agent state:
  - joined
  - left
  - thinking
  - spoke
  - degraded
  - budget exceeded
  - tool call pending, once implemented
  - tool result, once implemented

### Agent Control

Privileged/server-side tools may call:

- `mp_agent_spawn`
- `mp_agent_despawn`
- `mp_agent_speak`

Client SDKs must not hide the privilege requirement. Demo UIs must show whether
the current session can call privileged agent RPCs.

### Conversational AI Avatar

Every platform that supports a conversational AI avatar must provide:

- Human participant UI.
- Agent participant UI.
- Speak/send prompt control.
- Transcript display.
- Agent speaking/thinking indicator.
- Optional voice token flow through `mp_voice_token`.
- Optional viseme/expression/gesture hooks.
- Avatar fallback state when voice, TTS, LLM, or pose data is unavailable.

The avatar may be 2D, 3D, XR, voice-only, text-only, watch companion, or custom.
The flavor is platform-specific, but the state model and lifecycle must remain
consistent.

## Required Demo UI

Every platform/language integration must include a runnable demo UI. It can be
minimal, but it must be real and testable.

The demo must include:

1. Environment panel
   - server URL
   - auth/session status
   - socket status
   - current user id
2. Template panel
   - `mp_list_templates`
   - template availability
   - selected template
3. Match panel
   - create sync match
   - create async match
   - create lobby handoff match
   - create conversational room
   - create avatar/XR match when platform supports it
   - join match by id
4. Agent panel
   - list personas
   - show `agt_` presences
   - spawn/despawn/speak if privileged
   - non-privileged explanatory state otherwise
5. Conversation/avatar panel
   - prompt input
   - transcript
   - speaking/thinking indicator
   - voice/viseme/avatar fallback indicators
6. Log panel
   - RPC request id
   - match id
   - template id
   - errors and server messages

## Required Experience Coverage

Each adapter must prove these paths:

### Sync Game

- Create `sync-turn-v1`.
- Join the match.
- Render players and agents.
- Send one valid turn/input message or a documented placeholder if the game
  generator is not implemented in that client.
- Receive at least one server message.

### Async Game

- Create `async-turn-v1`.
- Persist or display the match id.
- Reopen/rejoin/read state through the platform's normal lifecycle.
- Show pending/complete status.

### Lobby Experience

- Create `lobby-handoff-v1`.
- Join lobby.
- Render ready/waiting state.
- Trigger handoff or show why handoff cannot happen yet.

### Conversational AI Avatar

- Create `conversational-party-v1`.
- List or show AI personas.
- Display at least one agent presence or documented mock if privileged spawn is
  unavailable.
- Send a prompt or privileged speak command where allowed.
- Show transcript and fallback state.

### Avatar/XR

When the platform supports avatar or XR:

- Create `avatar-replication-v1` or `mixed-reality-anchor-v1`.
- Join the match.
- Send or mock a pose/anchor payload.
- Render remote avatar/anchor state or a documented placeholder.
- Show graceful degradation for low-power devices and watch companion surfaces.

## IDE Process

Every IDE setup must include a documented path to add Agent Skills.

### Cursor / VS Code

- Add snippets or templates for the platform adapter.
- Add README instructions to run the demo UI.
- Add tasks for build/test/smoke where available.
- Link this playbook from the project README.

### JetBrains IDEs

- Add run configurations for demo and tests.
- Add package restore/build instructions.
- Link platform-support docs.

### Xcode

- Add sample scheme for iOS, iPadOS, watchOS, and visionOS where applicable.
- Add XCTest target for Agent Skill adapter behavior.
- Add simulator/device notes.

### Android Studio

- Add sample app module or demo Activity/Composable.
- Add instrumented tests.
- Add emulator/device notes.

### Unity Editor

- Add a sample scene.
- Add prefabs for Agent panel, Match panel, Conversation panel, and logs.
- Add PlayMode tests or a documented manual QA checklist.

### Unreal Editor

- Add sample map.
- Add Blueprint wrapper for the adapter.
- Add PIE test notes.

### Godot Editor

- Add sample scene.
- Add autoload or node wrapper for the adapter.
- Add manual and automated test notes.

### Custom Engines / CLI

- Add a runnable sample executable or command.
- Add environment-variable setup.
- Add deterministic smoke output.

## Platform Checklist

Each platform must maintain a `platform-support.md` with this matrix:

| Field | Required value |
| --- | --- |
| Platform | Web, Unity, Unreal, Godot, iOS, visionOS, watchOS, Android, Quest/Oculus, desktop, custom |
| Language | TypeScript, JavaScript, C#, C++, Swift, Kotlin, Java, GDScript, Python, etc. |
| IDE | Cursor, VS Code, JetBrains, Xcode, Android Studio, Unity, Unreal, Godot, other |
| Adapter file | Path to implementation |
| Demo UI | Path to scene/component/sample app |
| Tests | Path to tests or QA checklist |
| Supported templates | Exact list |
| Supported agent features | Exact list |
| Supported avatar features | Exact list |
| Unsupported features | Exact list |
| Last verified | Date, image digest, server version |

## Implementation Steps

Use this process for every adapter.

1. Read server coverage
   - `docs/AGENT_MULTIPLAYER_DEVELOPER_COVERAGE.md`
   - `data/modules/src/multiplayer-kernel/README.md`
2. Add adapter models
   - template ids
   - RPC request/response models
   - match envelope
   - agent persona
   - agent presence
   - voice token response
   - avatar pose/anchor models if supported
3. Add RPC client methods
   - `listTemplates`
   - `createMatch`
   - `readMatchResult`
   - `listAgentPersonas`
   - `spawnAgent` if privileged
   - `despawnAgent` if privileged
   - `agentSpeak` if privileged
   - `mintVoiceToken` if voice is supported
4. Add realtime socket methods
   - connect
   - disconnect
   - join match
   - leave match
   - send match data
   - receive match data
   - route opcodes
5. Add demo UI
   - sync game
   - async game
   - lobby
   - conversational AI avatar
   - avatar/XR if supported
6. Add tests
   - unit tests for payload construction
   - integration smoke for RPCs
   - match join smoke where possible
   - demo UI smoke or manual QA script
7. Update docs
   - project README
   - `platform-support.md`
   - this playbook if the process changes
   - coverage doc if capability support changes
8. Run QA
   - server smoke
   - adapter tests
   - demo UI test
   - platform/device test
9. Record sign-off
   - commit SHA
   - image digest
   - platform version
   - test command/output location
   - known limitations

## Required Adapter API

Adapter names can follow local language conventions, but every platform must
provide equivalents of:

```text
connect(config)
authenticate(credentials)
listTemplates()
createMatch(templateId, gameId, templateInit)
joinMatch(matchId)
leaveMatch(matchId)
sendMatchData(matchId, opcode, payload)
onMatchData(handler)
onPresence(handler)
readMatchResult(matchId)
listAgentPersonas()
spawnAgent(matchId, personaId, options)
despawnAgent(matchId, agentId, reason)
agentSpeak(matchId, agentId, text, options)
mintVoiceToken(matchId, identityKind)
```

If a platform cannot implement a method, it must expose an explicit
`unsupported` result with a reason. Silent no-ops are not allowed.

## Conversational AI Avatar Flavors

Any flavor is acceptable if it follows the same lifecycle:

- text-only chat avatar
- voice-only assistant
- 2D portrait/avatar
- 3D humanoid
- XR body/avatar
- NPC host
- coach/tutorial guide
- moderator
- opponent/teammate bot
- watch companion assistant
- kiosk/desktop assistant

Required lifecycle:

```text
persona selected
agent spawned or represented
agent joins room
agent receives prompt/context
agent thinks
agent speaks or emits fallback
transcript updates
avatar/voice/viseme state updates when supported
agent leaves or session ends
```

## QA Gates

No Agent Skill adapter can be marked complete until these pass:

- `mp_list_templates` succeeds against the target server.
- Required template creation succeeds.
- Demo UI can create or join a match.
- Human presence appears.
- Agent presence is rendered or unsupported state is explicit.
- Conversational room can show transcript/fallback.
- Adapter handles server errors visibly.
- Reconnect path is tested or explicitly unsupported.
- Platform-specific build succeeds.
- Platform-specific demo runs.
- Docs and support matrix are updated.

## Current Gaps To Close

These are required before claiming seamless all-platform/all-language support:

- Implement actual SDK adapters for current `mp_*` multiplayer kernel APIs.
- Add demo UI for Unity/C#.
- Add demo UI for Web/TypeScript.
- Add native Swift adapter and demos for iOS, iPadOS, visionOS, and watchOS.
- Add Kotlin/Java adapter and Android demo.
- Add Unreal C++/Blueprint adapter and demo map.
- Add Godot adapter and demo scene.
- Add Quest/Oculus validation path through Unity, Unreal, or WebXR.
- Add browser matrix for Chrome, Edge, Firefox, and Safari.
- Add agent tool-call lifecycle implementation behind `AGENT_TOOL_CALL` and
  `AGENT_TOOL_RESULT`.
- Add canonical schemas/protos and generate adapters from them.
- Add sample conversational AI avatar assets and fallback UI.
- Add platform-specific load and reconnect tests.

## Sign-Off Rule

Use this exact rule:

> Agent Skills are signed off for a platform only when that platform has a real
> adapter, demo UI, tests, documented unsupported features, and verified server
> compatibility for the target Nakama image digest.

Do not claim "all platforms, all languages, all IDEs" until every platform row
has an adapter, demo, tests, and sign-off record.
