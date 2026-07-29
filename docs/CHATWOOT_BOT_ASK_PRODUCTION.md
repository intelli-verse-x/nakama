# Chatwoot bot-ask vs manual (production)

**Status:** LIVE 2026-07-24  
**Goal:** On QuizVerse Email, admin chooses **bot ask** or **manual**. Bot emails for mobile + country; reply auto-queues voice via existing CW.Contact.Ready.

## How agents use it (day 1)

1. Open conversation in [Chatwoot](https://inbox.intelli-verse-x.ai) (QuizVerse Email).
2. **Bot path:** Macros → **Bot ask phone**  
   - Adds label `bot-ask-phone`  
   - Sends thank-you + ask for `PHONE:+… COUNTRY:…`
3. **Manual path:** Macros → **Handle manual**  
   - Adds label `manual` — no auto email, no auto parse.
4. Customer replies with phone (+ country) → n8n parses → Twenty SITE.Lead + VOICE.ScheduleCall (peak windows).

Preferred reply format:

```text
PHONE:+916378978141 COUNTRY:India
```

Bare `+E.164` also works on bot-ask conversations.

## One-time setup (do once)

### A) Seed labels + macros (2 min)

```powershell
$env:CHATWOOT_API_TOKEN = '<Profile → Access Token>'
# optional: $env:CHATWOOT_ACCOUNT_ID = '1'
cd d:\nakama
.\docs\n8n\seed-chatwoot-bot-ask.ps1
```

Or create in UI:

| Label | Color tip |
|-------|-----------|
| `bot-ask-phone` | blue |
| `bot-ask-sent` | purple |
| `manual` | gray |
| `ready_to_call` | green (may already exist) |

| Macro | Actions |
|-------|---------|
| **Bot ask phone** | `add_label` → `bot-ask-phone` + `send_message` → ask copy from seed script |
| **Handle manual** | `add_label` → `manual` |

Ask email body is in `docs/n8n/seed-chatwoot-bot-ask.ps1`.

### B) Chatwoot webhooks (required)

Settings → Integrations → Webhooks — ensure **at least**:

| URL | Events |
|-----|--------|
| `https://n8n.intelli-verse-x.ai/webhook/cw-contact-ready` | `conversation_created`, `conversation_updated`, `message_created` |

Optional (API bot-ask if you skip macros’ send_message):

| URL | Events |
|-----|--------|
| `https://n8n.intelli-verse-x.ai/webhook/cw-bot-ask` | `conversation_updated` |
| `https://n8n.intelli-verse-x.ai/webhook/cw-parse-phone-reply` | `message_created` |

**Primary production path:** Macro sends the email; **Contact.Ready** parses the reply. Extra webhooks are backup.

### C) Optional: CW.BotAsk Chatwoot API cred

Only if you want label `bot-ask-phone` alone (without macro send) to trigger ask email via API:

1. Chatwoot → Profile → Access Token  
2. n8n → Credentials → HTTP Header Auth named **Chatwoot API**  
   - Header name: `api_access_token`  
   - Value: token  
3. Open workflow **CW.BotAsk** (`vU9bDGCGICbUgC3O`) → bind cred on both HTTP nodes → **Publish**

## Live n8n workflows

| Workflow | ID | Webhook |
|----------|----|---------|
| CW.Contact.Ready | `43wHCIQC3qZelM2S` | `/webhook/cw-contact-ready` |
| CW.ParsePhoneReply | `gueBzoMBpqiEx5Yw` | `/webhook/cw-parse-phone-reply` |
| CW.BotAsk | `vU9bDGCGICbUgC3O` | `/webhook/cw-bot-ask` |

Sources: `nakama/docs/n8n/cw-contact-ready.workflow.js`, `cw-parse-phone-reply.workflow.js`, `cw-bot-ask.workflow.js`

## Smoke test (safe)

```powershell
# Simulates customer reply — should return ok + voice_queued when phone parse works
$body = @{
  event = 'message_created'
  message_type = 'incoming'
  content = 'PHONE:+916378978141 COUNTRY:India'
  inbox = @{ name = 'QuizVerse Email' }
  labels = @(@{ title = 'bot-ask-sent' })
  conversation = @{ id = 999001; labels = @(@{ title = 'bot-ask-sent' }); inbox = @{ name = 'QuizVerse Email' } }
  meta = @{ sender = @{ email = 'botask-smoke@example.com'; name = 'BotAsk Smoke'; phone_number = '' } }
  contact = @{ email = 'botask-smoke@example.com'; name = 'BotAsk Smoke' }
} | ConvertTo-Json -Depth 8

Invoke-RestMethod -Method POST `
  -Uri 'https://n8n.intelli-verse-x.ai/webhook/cw-contact-ready' `
  -ContentType 'application/json' `
  -Body $body
```

Expect: `ok: true`, `voice_queued: true`. Check n8n execution + SITE.Lead / ScheduleCall. Use a **test** phone you control; peak dial may wait until IN 10–13 or 17–20 IST.

## Failure modes

| Symptom | Fix |
|---------|-----|
| Macro missing | Run seed script / create macros |
| Ask email not sent | Macro must include `send_message` (or bind Chatwoot API on CW.BotAsk) |
| Reply not queued | Webhook must include `message_created` → Contact.Ready; labels include bot-ask-* or body has `PHONE:` |
| Manual still auto-parses | Ensure label `manual` present; Contact.Ready skips parse when `manual` |
| MCP republish broke BotAsk | Rebind Chatwoot API + Publish |

## Do not

- Attach an inbox-wide Agent Bot (forces bot on all mail)
- Put Twenty Bearer on SITE.Lead
- Treat support form → Twenty as Chatwoot conversation creation (separate path)
