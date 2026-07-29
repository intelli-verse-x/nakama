# Engagement n8n workflows — shipped 2026-07-23

Ready to test after IMAP + SMTP App Password work.

## Workflows

| Workflow | ID | Webhook | Status |
|----------|-----|---------|--------|
| **CW.Contact.Ready** | `43wHCIQC3qZelM2S` | `POST /webhook/cw-contact-ready` | Published (bot-ask reply parse 2026-07-24) |
| **CW.BotAsk** | `vU9bDGCGICbUgC3O` | `POST /webhook/cw-bot-ask` | Published (needs Chatwoot API cred if used) |
| **CW.ParsePhoneReply** | `gueBzoMBpqiEx5Yw` | `POST /webhook/cw-parse-phone-reply` | Published |
| **VOICE.ScheduleCall** | `wj2tcv95XvaJjGyA` | `POST /webhook/voice-schedule-call` | Published |
| **VOICE.CallEnded** | `Xa0RZ3bGnuZ5bZMk` | `POST /webhook/voice-call-ended` | Published |

Bot-ask runbook: `docs/CHATWOOT_BOT_ASK_PRODUCTION.md` · seed: `docs/n8n/seed-chatwoot-bot-ask.ps1`

Links:
- https://n8n.intelli-verse-x.ai/workflow/43wHCIQC3qZelM2S
- https://n8n.intelli-verse-x.ai/workflow/vU9bDGCGICbUgC3O
- https://n8n.intelli-verse-x.ai/workflow/gueBzoMBpqiEx5Yw
- https://n8n.intelli-verse-x.ai/workflow/wj2tcv95XvaJjGyA
- https://n8n.intelli-verse-x.ai/workflow/Xa0RZ3bGnuZ5bZMk

Old **CW.Lead** (`/webhook/chatwoot-to-twenty`) stays **inactive** (spam). Use **CW.Contact.Ready** instead.

---

## One-time setup (before end-to-end test)

### 1. Fix Chatwoot SMTP (your 535 error)

Inbox **QuizVerse Email** → SMTP App Password for `support@quizverse.world`.

### 2. Point Chatwoot webhook → CW.Contact.Ready

Chatwoot → Settings → Integrations → Webhooks:

- URL: `https://n8n.intelli-verse-x.ai/webhook/cw-contact-ready`
- Events: conversation updated, message created (and contact updated if available)

Create label: **`ready_to_call`**

### 3. Fonoster MCP credential in n8n

n8n → Credentials → **HTTP Bearer Auth** named exactly:

`Fonoster MCP Bearer`

Token = same Bearer value as Cursor `fonoster` MCP (accessKeyId:apiKey:apiSecret).

Assign it on **VOICE.ScheduleCall** nodes: MCP Initialize + MCP Create Call.

### 4. Fonoster eventsHook (call write-back)

On app **IntelliVerse Voice AI** (`8157b0cb-…`), set:

```text
eventsHook.url  = https://n8n.intelli-verse-x.ai/webhook/voice-call-ended
events          = conversation.ended
```

(Same pattern as the other Autopilot app that already has eventsHook.)

### 5. VOICE.CallEnded credentials (required)

On workflow https://n8n.intelli-verse-x.ai/workflow/Xa0RZ3bGnuZ5bZMk assign:

| Credential | Type | Nodes |
|------------|------|-------|
| `Fonoster MCP Bearer` | HTTP Bearer Auth | MCP Initialize, MCP Get Call |
| `Twenty CRM API` | HTTP Bearer Auth | Find Person, Create Note, Attach Note |

Production path: map `chatHistory` → enrich `to` via `fonoster_get_call` → SITE.Lead → Twenty Note.  
Source of truth for the SDK: `docs/n8n/voice-call-ended.workflow.js`.

---

## Agent playbook

1. Reply in Chatwoot (after SMTP works)
2. Ask phone (+country) + city
3. Save phone on contact
4. Add label **`ready_to_call`**
5. Automation: Twenty upsert → peak wait → AI call → transcript to Twenty

---

## Smoke tests (after IMAP)

```bash
# 1) Ready contact → Twenty (+ voice queue if phone present)
curl -sS -X POST https://n8n.intelli-verse-x.ai/webhook/cw-contact-ready \
  -H 'Content-Type: application/json' \
  -d '{"event":"conversation_updated","inbox":{"name":"QuizVerse Email"},"contact":{"email":"you@gmail.com","phone_number":"+91XXXXXXXXXX","name":"Test"},"labels":[{"title":"ready_to_call"}],"custom_attributes":{"city":"Jaipur","country":"India","timezone":"Asia/Kolkata"}}'

# 2) Direct schedule dial (uses peak wait; may call immediately if in peak)
curl -sS -X POST https://n8n.intelli-verse-x.ai/webhook/voice-schedule-call \
  -H 'Content-Type: application/json' \
  -d '{"phone":"+91XXXXXXXXXX","email":"you@gmail.com","name":"Test","timezone":"Asia/Kolkata"}'

# 3) Call ended write-back
curl -sS -X POST https://n8n.intelli-verse-x.ai/webhook/voice-call-ended \
  -H 'Content-Type: application/json' \
  -d '{"to":"+91XXXXXXXXXX","email":"you@gmail.com","transcript":"Test transcript","recording_url":"https://example.com/r.wav","status":"completed"}'
```

---

## Peak windows

| TZ | Hours (local) |
|----|----------------|
| Asia/Kolkata | 10–13, 17–20 |
| America/* | 10–12, 16–19 |
| Default | 10–18 |
