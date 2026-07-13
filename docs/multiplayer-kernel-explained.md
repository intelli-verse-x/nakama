# 🎮 Multiplayer Kernel — Complete Guide (Plain English)

> **What is this?**  
> The Multiplayer Kernel is the core engine that powers all real-time and turn-based game modes on Nakama. Think of it as a **router + rulebook** — it decides how players connect to each other, how messages flow between them, and what happens when someone wins, loses, disconnects, or cheats.

---

## 📦 The Big Picture

```
Your Game (Unity / Web client)
        │
        │  calls  mp_create_match("template-name", { ...options })
        ▼
 ┌──────────────────────────────────────────┐
 │          Nakama Server                   │
 │                                          │
 │   Kernel (policeman + postman)           │
 │     ↕ routes messages to ↕              │
 │   Template (game-specific rules)         │
 │     ↕ talks to ↕                        │
 │   Generator (question/move supplier)     │
 └──────────────────────────────────────────┘
        │
        │  stores results in
        ▼
   CockroachDB (mp_async_games, mp_match_results, mp_party)
```

**Three layers you need to know:**

| Layer | What it does | Analogy |
|-------|-------------|---------|
| **Kernel** | Handles connections, timeouts, heartbeats, errors, message ordering | Post Office |
| **Template** | Game rules — when turns happen, who wins, how scoring works | Referee |
| **Generator** | Content supply — what question/puzzle/move comes next | Dealer at a card table |

---

## 🗂️ All Game Templates (Modes)

There are **10 templates** built into the kernel. Each owns a reserved number range so messages never collide.

| Template | Number Range | Best For |
|----------|-------------|----------|
| `sync-turn-v1` | 0x4000–0x4FFF | Quiz battles — everyone answers at the same time |
| `async-turn-v1` | 0x5000–0x5FFF | Chess/words style — players take turns over hours/days |
| `realtime-tick-v1` | 0x6000–0x6FFF | Fast action games (Go plugin, not JS) |
| `lobby-handoff-v1` | 0x7000–0x7FFF | Waiting room before a real game starts |
| `tournament-v1` | 0x8000–0x8FFF | Brackets, elimination rounds |
| `live-event-v1` | 0x9000–0x9FFF | Scheduled group events everyone joins at once |
| `persistent-party-v1` | 0xA000–0xAFFF | Friend group party room (lives forever) |
| `mixed-reality-anchor-v1` | 0xB000–0xBFFF | AR/XR spatial experiences |
| `conversational-party-v1` | 0x1000–0x1FFF | Social chat rooms |
| `avatar-replication-v1` | 0xF000–0xFFFF | Avatar pose syncing (Go plugin) |

---

## 📨 How Every Message Looks (The Wire Envelope)

Every single message sent between client and server uses this format:

```json
{
  "h": {
    "wire_version": 1,
    "op": 16385,
    "seq": 42,
    "match_time_ms": 3200,
    "sender_user_id": "server",
    "match_id": "abc-123",
    "client_opcode_uuid": ""
  },
  "p": { ...actual game data... }
}
```

- **`h`** = header (who sent it, when, which operation)
- **`p`** = payload (the actual data — a question, an answer, a move)
- **`seq`** = sequence number (if messages arrive out of order, server detects the gap and re-syncs)
- **`op`** = the operation code — this is how the server knows what kind of message it is

---

## 🔄 Template 1: Sync-Turn (`sync-turn-v1`)

> "Everyone answers at the same time. Fastest correct answer wins more points."  
> **Used by: QuizVerse battles**

### Flow

```
1. Player A calls mp_create_match("sync-turn-v1", { min_players:2, generator_id:"quizverse:classic" })
   → Server creates a match, returns match_id

2. Player B joins using match_id

3. PRE-GAME: Server waits for min_players to send PLAYER_READY
   (if nobody ready in time → match cancelled)

4. TURN LOOP (repeats until no more questions):
   ├── Server → all: TURN_START  { question data }
   ├── Server → all: TURN_INPUT_OPENED  (timer starts — default 15 seconds)
   ├── Players → server: TURN_INPUT_SUBMIT  { their answer }
   ├── Timer expires OR all submitted
   ├── Server → all: TURN_INPUT_CLOSED
   ├── Server → all: TURN_RESOLVED  { correct answer, who got it right }
   └── Server → all: SCORE_UPDATE  { new scores for everyone }

5. POST-GAME: Server → all: MATCH_ENDED + result saved to storage
```

### Key Rules
- Server is the **only authority** — clients never calculate scores themselves
- Speed bonus: faster correct answers = more points (server tracks response time)
- If a player disconnects, they get a **60-second grace window** to reconnect before being kicked
- AI agents can fill empty seats (`agent_seat_count`)

### Opcodes
| Code | Who Sends | Meaning |
|------|-----------|---------|
| `0x4001` TURN_START | Server | New turn, here's the question |
| `0x4002` TURN_INPUT_OPENED | Server | You can submit answers now |
| `0x4003` TURN_INPUT_CLOSED | Server | Time's up, no more answers |
| `0x4004` TURN_RESOLVED | Server | Correct answer revealed |
| `0x4005` SCORE_UPDATE | Server | Leaderboard update |
| `0x4006` PLAYER_ELIMINATED | Server | Player knocked out (tournament mode) |
| `0x4010` TURN_INPUT_SUBMIT | Client | My answer is... |
| `0x4011` PLAYER_READY | Client | I'm ready to start |
| `0x4012` PLAYER_FORFEIT | Client | I give up |

---

## 🔄 Template 2: Async-Turn (`async-turn-v1`)

> "I make my move, you make yours whenever you're ready — could be tomorrow."  
> **Used by: chess, word games, daily puzzle PvP**

### The Big Trick: Two Separate IDs

```
match_id  = temporary session handle (only lives while someone is online)
game_id   = the real persistent game (lives in storage forever)

Same game_id can spawn MANY match_ids over its lifetime.
```

### Flow

```
Day 1 — Player A's turn:
├── A calls mp_create_match("async-turn-v1", { game_id:"chess-001", starting_actor: A })
├── Server creates match, loads saved state from storage (or starts fresh)
├── Server → A: TURN_START { board state }
├── A → Server: TURN_SUBMIT { move: "e2 to e4" }
├── Server validates move via generator.applyMove()
├── Server saves new board state to storage (mp_async_games)
├── Server → all: TURN_END { new board, next_actor: B }
├── B is offline → Server sends push notification: "Your move!"
└── A leaves → Server saves state, match terminates (nobody online)

Day 1 — 2 hours later, Player B's turn:
├── B opens the game
├── Server creates a NEW match instance, loads saved board from storage
├── Server → B: TURN_START { current board }
├── B → Server: TURN_SUBMIT { move: "e7 to e5" }
├── Server saves, notifies A offline
└── Match terminates again
```

### Move Timeout
- Default: **7 days** to make a move
- If exceeded: server auto-forfeits the slow player, opponent wins

### Persist Format (what gets saved to `mp_async_games`)
```json
{
  "actors": ["user-a-id", "user-b-id"],
  "gen_state": { ...game-specific board/state... },
  "last_move_unix_ms": 1719000000000,
  "started_unix_ms": 1718900000000,
  "ended": false,
  "winner_user_id": ""
}
```

### Opcodes
| Code | Who Sends | Meaning |
|------|-----------|---------|
| `0x5000` TURN_START | Server | It's your move, here's the board |
| `0x5001` TURN_SUBMIT | Client | Here's my move |
| `0x5002` TURN_END | Server | Move accepted, new board for everyone |
| `0x5003` NOTIFY_OPPONENT | Server | Wake-up ping for the next player |
| `0x5004` FORFEIT | Either | Forfeit (timeout = server-triggered) |
| `0x5005` RESIGN | Client | I resign, you win |

---

## 🔄 Template 3: Lobby Handoff (`lobby-handoff-v1`)

> "Everyone gathers in a waiting room. When enough people are ready, the server kicks off the real game and moves everyone there."

### Flow

```
FORM_UP phase:
├── Players join lobby match
├── Each player sends READY when they've picked their loadout/character
├── If min_players ready → go to HANDOFF
└── If form_up_timeout_ms passes without enough players → DISBAND

HANDOFF phase:
├── Server creates the real game match (e.g. sync-turn-v1)
├── Server → all: HANDOFF_INFO { target_match_id, webrtc_signaling_url? }
├── Clients immediately connect to target_match_id
├── Lobby waits 5 seconds (grace), then self-terminates
└── DONE
```

### Why use this?
Without a lobby, players join a game before it's ready and miss the start. The lobby gathers everyone first, then hands them off atomically.

---

## 🔄 Template 4: Persistent Party (`persistent-party-v1`)

> "A friend group that never disappears. Like a Discord server but inside the game."

### Key Concept
The party **in storage** (`mp_party` collection) is permanent. The match instance is just the live chat/presence layer on top of it — it can die and restart without losing the party.

### Roles
| Role | Can Do |
|------|--------|
| `owner` | Everything — kick, promote, demote, transfer ownership, change settings |
| `officer` | Invite, kick members |
| `member` | Chat, set ready for match |

### Flow
```
Party creation:
└── mp_create_match("persistent-party-v1", { party_id: "my-crew" })
    → Server reads mp_party storage or creates new party doc
    → Creator becomes owner

Normal session:
├── Members join/leave freely (they're "online" while in match)
├── Server → all: MEMBER_PRESENCE whenever someone joins/leaves
├── Party state saved to storage on every membership change

Queueing for a game:
├── Members send READY_FOR_MATCH
├── Owner hits "Play" → server calls mp_create_match for the real game
└── Server → all: MATCH_QUEUE_INFO { target_match_id }

After game ends:
└── Players return to party room (same party_id, fresh match instance)
```

### Idle Termination
The match instance dies after `idle_terminate_ms` of zero online members — but the party document in storage is never deleted. Next person to join creates a fresh match instance, hydrates from storage.

---

## 🔄 The Kernel (Wraps Everything)

The **Kernel** (`match-handler.ts`) is the invisible layer that runs underneath every template. Game code never sees this directly.

### What the Kernel does automatically

| Job | What happens |
|-----|-------------|
| **Heartbeat** | Pings clients every few ticks. If no response, starts disconnect timer |
| **Reconnect grace** | Disconnected player gets 60 seconds to rejoin before being removed |
| **Flapping guard** | Player joining/leaving too fast gets kicked (`FLAP_KICKS` counter) |
| **Sequence gap detection** | If messages arrive out of order (gap > 32), client gets forced re-sync |
| **Idempotency dedup** | Duplicate messages silently dropped (client-side retries safe) |
| **Clock sync** | Server broadcasts authoritative match time so all clients agree on timing |
| **Error envelope** | All errors use the same format with numeric codes (no free-text errors) |
| **Result persistence** | When match ends, `MatchResultEnvelope` saved to `mp_match_results` |

### Kernel Control Opcodes (0x0000–0x0FFF)
| Code | Meaning |
|------|---------|
| `0x0001` CLIENT_HELLO | Client says "I'm here" on connect |
| `0x0002` SERVER_HELLO | Server responds with match info |
| `0x0003` HEARTBEAT | Keep-alive ping |
| `0x0004` PLAYER_JOINED | Someone joined the match |
| `0x0005` PLAYER_LEFT | Someone left |
| `0x0006` PLAYER_KICKED | Someone was removed by server |
| `0x0007` MATCH_ENDED | Game over, here's the result |
| `0x0008` ERROR | Something went wrong |
| `0x0009` MATCH_RESUME | Reconnecting player asking for state |
| `0x000A` MATCH_RESUME_ACK | Server sends full state to reconnector |
| `0x0011` NETWORK_CLOCK_PING | Client ping for latency measurement |
| `0x0012` NETWORK_CLOCK_PONG | Server pong |

---

## 🧩 The Generator Pattern

Every template that has "turns" needs a **Generator** — the thing that decides what comes next.

```
Template (referee) asks Generator (dealer): "What's the next question/move?"
Generator returns:   { turn_payload, correct_answer, scoring_rules }
Template resolves:   scores all player submissions, updates leaderboard
```

### Built-in test generators
| Generator ID | What it does |
|---|---|
| `echo` | Returns dummy questions for SDK testing (sync-turn) |
| `async-echo` | Ping-pong turns for SDK testing (async-turn) |

### Real generators (registered by game plugins)
| Generator ID | Game |
|---|---|
| `quizverse:classic` | Standard QuizVerse quiz battle |
| *(your custom one)* | Whatever game you build |

### Generator interface (simplified)

```typescript
// For sync-turn (quiz style):
{
  generatorId: "my-game",
  initBlob(initParams):       blob,           // setup state
  nextTurn(context):          turnData | null, // null = game over
  scoreSubmission(answer):    number,          // points to add
  buildResolvedPayload(...):  any              // what to broadcast after turn
}

// For async-turn (chess style):
{
  generatorId: "my-game",
  initState(params, saved):   { state, actor, ended },
  applyMove(state, user, move): { state, actor, ended, broadcast } | null,
  buildResult(state, ...):    any
}
```

---

## 🚦 Error Codes Cheat Sheet

| Range | Category | Examples |
|-------|----------|---------|
| 1–9 | Schema / timing | Bad payload, sequence gap, clock skew |
| 20–29 | Capacity | Match full, not found, rate limited |
| 30–39 | Auth | Permission denied, kicked, banned |
| 40–49 | AI agent | Bad persona, budget exceeded |
| 50–59 | XR / spatial | Anchor lost, incompatible |
| 60–69 | Voice | Voice unavailable |
| 70–79 | Moderation | Content moderated |
| 80–89 | Fatal lifecycle | Timeout, quorum lost, state overflow |
| 100–119 | Infrastructure | Server overload, persistence degraded |
| 999 | Catch-all | Internal error |

---

## 🔑 The 3 Public RPCs (What Unity/Web Calls)

```
mp_create_match      →  Start a match of any template
mp_read_match_result →  Read a saved match result by match_id
mp_list_templates    →  See all available templates + their opcode ranges
```

### Example: Start a QuizVerse battle

```json
// Call: mp_create_match
{
  "template_id": "sync-turn-v1",
  "game_id": "quizverse",
  "template_init": {
    "min_players": 2,
    "max_players": 4,
    "generator_id": "quizverse:classic",
    "default_input_window_ms": 15000
  }
}

// Response:
{
  "match_id": "abc-123..",
  "template_id": "sync-turn-v1",
  "game_id": "quizverse",
  "server_unix_ms": 1719000000000
}
```

---

## 📊 MatchResultEnvelope (Saved After Every Game)

When any match ends, this gets saved to `mp_match_results`:

```json
{
  "match_id": "abc-123",
  "template_id": "sync-turn-v1",
  "game_id": "quizverse",
  "started_unix_ms": 1719000000000,
  "ended_unix_ms":   1719000180000,
  "duration_ms":     180000,
  "outcomes": [
    {
      "user_id": "player-1",
      "is_agent": false,
      "placement": 1,
      "score": 850,
      "completed": true,
      "left_early": false,
      "game_payload": { ...custom game data... }
    },
    {
      "user_id": "player-2",
      "is_agent": false,
      "placement": 2,
      "score": 620,
      "completed": true,
      "left_early": false
    }
  ],
  "game_payload": { ...match-level summary... }
}
```

---

## 🛠️ How to Add a New Game Mode

1. **Pick a template** — sync-turn for quiz/battle, async-turn for chess, lobby-handoff for matchmaking
2. **Write a Generator** implementing the generator interface
3. **Register it** in your game plugin's `InitModule`:
   ```typescript
   MpKernelSyncTurn.registerGenerator(myGenerator);
   ```
4. **In Unity**, call `mp_create_match` with your `generator_id` in `template_init`
5. **Listen for opcodes** in your Unity match adapter — TURN_START, TURN_RESOLVED, MATCH_ENDED

That's it. The kernel handles everything else (connections, timing, errors, result storage).

---

## 🗺️ Complete Opcode Map

```
0x0000–0x0FFF  KERNEL     Hello, heartbeat, join/leave, errors, resume
0x1000–0x1FFF  SOCIAL     ConversationalParty chat
0x2000–0x2FFF  AGENTS     AI agent turns + voice
0x3000–0x3FFF  MODERATION Voice ASR + text classification
0x4000–0x4FFF  SYNC TURN  Quiz battle (TURN_START / SUBMIT / RESOLVED)
0x5000–0x5FFF  ASYNC TURN Chess-style (TURN_START / SUBMIT / END)
0x6000–0x6FFF  REALTIME   Fast-action game ticks (Go plugin)
0x7000–0x7FFF  LOBBY      Ready-up + handoff to real game
0x8000–0x8FFF  TOURNAMENT Brackets + elimination
0x9000–0x9FFF  LIVE EVENT Scheduled group events
0xA000–0xAFFF  PARTY      Persistent friend group rooms
0xB000–0xBFFF  MR ANCHOR  Mixed reality spatial anchors
0xC000–0xCFFF  GAME DEF   Per-game custom opcodes
0xF000–0xFFFF  XR POSE    Avatar replication (Go plugin)
```
