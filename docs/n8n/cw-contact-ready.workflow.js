import { workflow, node, trigger, sticky, ifElse, expr } from '@n8n/workflow-sdk';

const note = sticky(
  '## CW.Contact.Ready\n\nChatwoot → filtered Twenty upsert (+ queue voice dial).\n\n**Point Chatwoot webhook here** (conversation_updated / message_created):\n`https://n8n.intelli-verse-x.ai/webhook/cw-contact-ready`\n\nRequires: phone **or** label `ready_to_call`. Skips noreply. Inbox allowlist: QuizVerse Email / Support.',
  [],
  { position: [220, 120], color: 4 }
);

const webhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Chatwoot Ready Webhook',
    position: [240, 360],
    parameters: {
      httpMethod: 'POST',
      path: 'cw-contact-ready',
      responseMode: 'lastNode',
      responseData: 'firstEntryJson',
    },
  },
  output: [{ body: { event: 'conversation_updated' } }],
});

const mapLead = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Filter + Map Ready Contact',
    position: [520, 360],
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: `const raw = $json.body && Object.keys($json.body).length ? $json.body : $json;
const event = String(raw.event || '');
const allowedEvents = {
  conversation_created: 1,
  conversation_updated: 1,
  conversation_status_changed: 1,
  contact_updated: 1,
  message_created: 1
};
if (event && !allowedEvents[event]) {
  return { skip: true, reason: 'ignored_event', event: event };
}

const sender = (raw.meta && raw.meta.sender) || raw.sender || (raw.conversation && raw.conversation.meta && raw.conversation.meta.sender) || {};
const contact = raw.contact || {};
const email = String(sender.email || contact.email || '').trim().toLowerCase();
let phone = String(sender.phone_number || contact.phone_number || contact.phone || '').trim();
const name = String(sender.name || contact.name || (email ? email.split('@')[0] : '') || 'Chatwoot contact').trim();

const noreply = /^(noreply|no-reply|donotreply|mailer-daemon|notifications?)@/i;
if (email && noreply.test(email)) {
  return { skip: true, reason: 'noreply_sender', email: email };
}

const inbox = raw.inbox || (raw.conversation && raw.conversation.inbox) || {};
const inboxName = String(inbox.name || '');
const allowInbox = /quizverse\\s*(email|support)/i.test(inboxName) || inboxName === '';
if (inboxName && !allowInbox) {
  return { skip: true, reason: 'inbox_not_allowed', inbox: inboxName };
}

const labels = [].concat(
  raw.labels || [],
  (raw.conversation && raw.conversation.labels) || [],
  (contact.labels) || []
);
const labelNames = labels.map(function (l) { return String(l.title || l.name || l).toLowerCase(); });
const attrs = Object.assign(
  {},
  raw.custom_attributes || {},
  (raw.conversation && raw.conversation.custom_attributes) || {},
  contact.custom_attributes || {}
);
const ready =
  labelNames.some(function (n) { return n.indexOf('ready_to_call') >= 0 || n.indexOf('ready-to-call') >= 0 || n === 'ready'; }) ||
  attrs.ready_to_call === true ||
  attrs.ready_to_call === 'true' ||
  String(attrs.ready_to_call || '').toLowerCase() === 'yes';
const inBotAsk =
  labelNames.some(function (n) {
    return n === 'bot-ask-phone' || n.indexOf('bot-ask-phone') >= 0 ||
      n === 'bot-ask-sent' || n.indexOf('bot-ask-sent') >= 0;
  });
const isManual = labelNames.some(function (n) { return n === 'manual' || n === 'handle-manual'; });

const firstMsg = Array.isArray(raw.messages) && raw.messages[0] ? raw.messages[0] : raw;
let message = String((firstMsg && firstMsg.content) || raw.content || attrs.notes || '').trim();

function extractPhone(text) {
  if (!text) return '';
  const tagged = text.match(/phone\\s*[:=]\\s*([+\\d][\\d\\s().-]{7,20})/i);
  if (tagged) {
    var digits = tagged[1].replace(/[^\\d+]/g, '');
    var bare = digits.replace(/\\D/g, '');
    if (bare.length >= 8) return digits.indexOf('+') === 0 ? digits : '+' + bare;
  }
  const e164 = text.match(/\\+[1-9]\\d{7,14}\\b/);
  if (e164) return e164[0];
  const local = text.match(/\\b([6-9]\\d{9})\\b/);
  if (local && (inBotAsk || /phone|mobile|whatsapp/i.test(text))) return '+91' + local[1];
  return '';
}
function extractCountry(text) {
  if (!text) return '';
  const tagged = text.match(/country\\s*[:=]\\s*([A-Za-z][A-Za-z\\s.-]{1,40})/i);
  if (tagged) return tagged[1].trim().replace(/[.!,;]+$/, '');
  const known = [
    ['india', 'India'], ['united states', 'United States'], ['usa', 'United States'],
    ['uk', 'United Kingdom'], ['united kingdom', 'United Kingdom'], ['canada', 'Canada'],
    ['australia', 'Australia'], ['uae', 'United Arab Emirates'], ['singapore', 'Singapore']
  ];
  const lower = text.toLowerCase();
  for (var i = 0; i < known.length; i++) {
    if (lower.indexOf(known[i][0]) >= 0) return known[i][1];
  }
  return '';
}

const msgType = raw.message_type;
const isIncoming = event === 'message_created' && (msgType === 'incoming' || msgType === 0 || msgType === '0' || msgType === undefined);
let parsedFromReply = false;
if (!phone && isIncoming && !isManual && (inBotAsk || /phone\\s*[:=]|country\\s*[:=]|\\+[1-9]\\d{7,14}/i.test(message))) {
  const parsedPhone = extractPhone(message);
  if (parsedPhone) {
    phone = parsedPhone;
    parsedFromReply = true;
  }
}
const parsedCountry = extractCountry(message);

if (!phone && !ready) {
  return { skip: true, reason: 'need_phone_or_ready_to_call', email: email, event: event };
}
if (!email && !phone) {
  return { skip: true, reason: 'missing_email_and_phone', event: event };
}

const city = String(attrs.city || attrs.location || contact.city || '').trim();
let country = String(attrs.country || contact.country || parsedCountry || '').trim();
const timezone = String(attrs.timezone || attrs.time_zone || '').trim() ||
  (/india|in\\b/i.test(city + ' ' + country) ? 'Asia/Kolkata' :
   /united states|usa|us\\b/i.test(country) ? 'America/Chicago' : 'UTC');

if (!message) message = 'Chatwoot ready_to_call';

if (phone && phone.indexOf('+') !== 0) {
  phone = phone.replace(/\\s+/g, '');
  if (phone.length === 10) phone = '+91' + phone;
  else if (phone.indexOf('+') !== 0) phone = '+' + phone.replace(/^00/, '');
}

return {
  skip: false,
  queue_voice: Boolean(phone),
  app_id: 'quizverse',
  brand: 'quizverse',
  email: email || undefined,
  phone: phone || undefined,
  name: name,
  message: message,
  source: 'chatwoot',
  page: 'chatwoot:' + (inboxName || 'inbox'),
  subject: 'Chatwoot ready: ' + (inboxName || 'inbox'),
  category: 'support',
  lead_source: 'chatwoot',
  job_title: parsedFromReply ? 'Lead via chatwoot bot-ask reply' : 'Lead via chatwoot ready_to_call',
  city: city || undefined,
  country: country || undefined,
  timezone: timezone,
  call_status: phone ? 'pending' : 'awaiting_phone',
  marketing_consent: true,
  submitted_at: new Date().toISOString(),
  event: 'support_inquiry',
  chatwoot_event: event,
  chatwoot_inbox: inboxName,
  chatwoot_conversation_id: raw.id || (raw.conversation && raw.conversation.id) || null,
  ready_to_call: ready || parsedFromReply,
  parsed_from_bot_ask_reply: parsedFromReply
};
`,
    },
  },
  output: [{ skip: false, queue_voice: true, email: 'a@b.com', phone: '+916378978141' }],
});

const shouldForward = ifElse({
  version: 2.2,
  config: {
    name: 'Should Forward',
    position: [780, 360],
    parameters: {
      conditions: {
        conditions: [
          {
            leftValue: expr('{{ $json.skip }}'),
            operator: { type: 'boolean', operation: 'false' },
            rightValue: true,
          },
        ],
      },
    },
  },
});

const toSiteLead = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Upsert Twenty via SITE.Lead',
    position: [1040, 260],
    parameters: {
      method: 'POST',
      url: 'https://n8n.intelli-verse-x.ai/webhook/site-lead',
      authentication: 'none',
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: {
        parameters: [
          { name: 'Content-Type', value: 'application/json' },
          { name: 'X-QV-Event', value: 'support_inquiry' },
          { name: 'X-IVX-Bridge', value: 'CW.Contact.Ready' },
        ],
      },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr("={{ $('Filter + Map Ready Contact').item.json }}"),
      options: {
        timeout: 15000,
        response: { response: { fullResponse: true, neverError: true } },
      },
    },
  },
  output: [{ statusCode: 200 }],
});

const maybeVoice = ifElse({
  version: 2.2,
  config: {
    name: 'Has Phone for Dial',
    position: [1300, 260],
    parameters: {
      conditions: {
        conditions: [
          {
            leftValue: expr("={{ $('Filter + Map Ready Contact').item.json.queue_voice }}"),
            operator: { type: 'boolean', operation: 'true' },
            rightValue: true,
          },
        ],
      },
    },
  },
});

const queueVoice = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Queue VOICE.ScheduleCall',
    position: [1560, 160],
    parameters: {
      method: 'POST',
      url: 'https://n8n.intelli-verse-x.ai/webhook/voice-schedule-call',
      authentication: 'none',
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: {
        parameters: [{ name: 'Content-Type', value: 'application/json' }],
      },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr("={{ $('Filter + Map Ready Contact').item.json }}"),
      options: {
        timeout: 10000,
        response: { response: { fullResponse: true, neverError: true } },
      },
    },
  },
  output: [{ statusCode: 200 }],
});

const accepted = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Accepted Response',
    position: [1820, 260],
    parameters: {
      mode: 'manual',
      includeOtherFields: false,
      assignments: {
        assignments: [
          { id: 'a1', name: 'ok', value: true, type: 'boolean' },
          { id: 'a2', name: 'routed', value: 'site-lead', type: 'string' },
          { id: 'a3', name: 'voice_queued', value: expr("={{ $('Filter + Map Ready Contact').item.json.queue_voice }}"), type: 'boolean' },
          { id: 'a4', name: 'upstream_status', value: expr('={{ $json.statusCode || 0 }}'), type: 'number' },
        ],
      },
    },
  },
  output: [{ ok: true }],
});

const skipped = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Skipped Response',
    position: [1040, 480],
    parameters: {
      mode: 'manual',
      includeOtherFields: true,
      assignments: {
        assignments: [
          { id: 's1', name: 'ok', value: true, type: 'boolean' },
          { id: 's2', name: 'skipped', value: true, type: 'boolean' },
        ],
      },
    },
  },
  output: [{ ok: true, skipped: true }],
});

export default workflow('cw-contact-ready', 'CW.Contact.Ready — Chatwoot ready_to_call → Twenty + voice queue')
  .add(note)
  .add(webhook)
  .to(mapLead)
  .to(
    shouldForward
      .onTrue(
        toSiteLead.to(
          maybeVoice
            .onTrue(queueVoice.to(accepted))
            .onFalse(accepted)
        )
      )
      .onFalse(skipped)
  );
