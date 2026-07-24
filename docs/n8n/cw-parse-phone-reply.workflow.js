import { workflow, node, trigger, sticky, ifElse, expr } from '@n8n/workflow-sdk';

/**
 * CW.ParsePhoneReply — dedicated webhook for bot-ask replies.
 * No Chatwoot API credential required: parses phone/country and forwards to CW.Contact.Ready.
 *
 * Prefer pointing Chatwoot message_created at CW.Contact.Ready (now parses replies).
 * Use this path if you want a separate webhook URL.
 */

const READY_HOOK = 'https://n8n.intelli-verse-x.ai/webhook/cw-contact-ready';

const info = sticky(
  '## CW.ParsePhoneReply\n\nIncoming reply with phone/country → normalize → `CW.Contact.Ready`.\n\nWebhook: POST /webhook/cw-parse-phone-reply\n\nNo Chatwoot API cred needed.',
  [],
  { position: [200, 80], color: 5 }
);

const webhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Parse Reply Webhook',
    position: [240, 360],
    parameters: {
      httpMethod: 'POST',
      path: 'cw-parse-phone-reply',
      responseMode: 'lastNode',
      responseData: 'firstEntryJson',
    },
  },
  output: [{ body: { event: 'message_created', message_type: 'incoming', content: 'PHONE:+916378978141 COUNTRY:India' } }],
});

const map = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Parse Phone Country',
    position: [500, 360],
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: `const raw = $json.body && Object.keys($json.body).length ? $json.body : $json;
const event = String(raw.event || '');
if (event && event !== 'message_created') {
  return { skip: true, reason: 'ignored_event', event: event };
}

const messageType = String(raw.message_type);
const isIncoming = messageType === 'incoming' || messageType === '0' || raw.message_type === 0 || raw.message_type === undefined;
if (!isIncoming) {
  return { skip: true, reason: 'not_incoming' };
}

const inbox = raw.inbox || (raw.conversation && raw.conversation.inbox) || {};
const inboxName = String(inbox.name || '');
if (inboxName && !/quizverse\\s*(email|support)/i.test(inboxName)) {
  return { skip: true, reason: 'inbox_not_allowed', inbox: inboxName };
}

const labels = [].concat(
  raw.labels || [],
  (raw.conversation && raw.conversation.labels) || []
);
const names = labels.map(function (l) { return String(l.title || l.name || l).toLowerCase(); });
const inBotFlow = names.some(function (n) {
  return n === 'bot-ask-phone' || n.indexOf('bot-ask-phone') >= 0 ||
    n === 'bot-ask-sent' || n.indexOf('bot-ask-sent') >= 0;
});
const alreadyReady = names.some(function (n) {
  return n === 'ready_to_call' || n.indexOf('ready_to_call') >= 0;
});
if (alreadyReady) return { skip: true, reason: 'already_ready' };

const content = String(raw.content || raw.processed_message_content || '');
const contentHasPhoneHint = /phone\\s*[:=]|\\+\\d{8,15}|whatsapp|mobile|country\\s*[:=]/i.test(content);
if (!inBotFlow && !contentHasPhoneHint) {
  return { skip: true, reason: 'not_bot_flow_and_no_phone_hint' };
}

function extractPhone(text) {
  const tagged = text.match(/phone\\s*[:=]\\s*([+\\d][\\d\\s().-]{7,20})/i);
  if (tagged) {
    var digits = tagged[1].replace(/[^\\d+]/g, '');
    var bare = digits.replace(/\\D/g, '');
    if (bare.length >= 8) return digits.indexOf('+') === 0 ? digits : '+' + bare;
  }
  const e164 = text.match(/\\+[1-9]\\d{7,14}\\b/);
  if (e164) return e164[0];
  const local = text.match(/\\b([6-9]\\d{9})\\b/);
  if (local) return '+91' + local[1];
  return '';
}

function extractCountry(text) {
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

const phone = extractPhone(content);
const country = extractCountry(content);
if (!phone) {
  return { skip: true, reason: 'phone_not_found', content_preview: content.slice(0, 180) };
}

const conv = raw.conversation || {};
const convId = conv.id || raw.conversation_id || raw.id;
const contact = raw.sender || raw.contact || (conv.meta && conv.meta.sender) || {};
const contactId = contact.id || (raw.contact && raw.contact.id);
const email = String(contact.email || (raw.contact && raw.contact.email) || '').trim().toLowerCase();
const name = String(contact.name || (raw.contact && raw.contact.name) || email || 'Support Lead').trim();

return {
  skip: false,
  conversation_id: convId,
  contact_id: contactId,
  email: email,
  name: name,
  phone: phone,
  country: country || 'Unknown',
  ready_payload: {
    event: 'message_created',
    message_type: 'incoming',
    content: content,
    id: convId,
    labels: [{ title: 'bot-ask-sent' }, { title: 'ready_to_call' }],
    conversation: {
      id: convId,
      labels: [{ title: 'bot-ask-sent' }, { title: 'ready_to_call' }],
      inbox: inbox
    },
    inbox: inbox,
    meta: { sender: { id: contactId, email: email, name: name, phone_number: phone } },
    contact: { id: contactId, email: email, name: name, phone_number: phone },
    custom_attributes: { country: country || 'Unknown', phone: phone, source: 'cw_bot_ask_reply' }
  }
};
`,
    },
  },
  output: [{ skip: false, phone: '+916378978141', country: 'India' }],
});

const gate = ifElse({
  version: 2.2,
  config: {
    name: 'Parsed OK?',
    position: [760, 360],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        combinator: 'and',
        conditions: [{
          id: 'ok',
          leftValue: expr('{{ $json.skip }}'),
          operator: { type: 'boolean', operation: 'false', singleValue: true },
          rightValue: '',
        }],
      },
    },
  },
});

const fireReady = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Fire CW.Contact.Ready',
    position: [1020, 240],
    onError: 'continueRegularOutput',
    parameters: {
      method: 'POST',
      url: READY_HOOK,
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: {
        parameters: [{ name: 'Content-Type', value: 'application/json' }],
      },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr("={{ JSON.stringify($json.ready_payload) }}"),
      options: { timeout: 30000, response: { response: { fullResponse: true, neverError: true } } },
    },
  },
  output: [{ statusCode: 200 }],
});

const accepted = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Accepted',
    position: [1280, 240],
    parameters: {
      mode: 'manual',
      includeOtherFields: false,
      assignments: {
        assignments: [
          { id: 'a1', name: 'ok', value: true, type: 'boolean' },
          { id: 'a2', name: 'action', value: 'phone_parsed_ready', type: 'string' },
          { id: 'a3', name: 'phone', value: expr("={{ $('Parse Phone Country').item.json.phone }}"), type: 'string' },
          { id: 'a4', name: 'country', value: expr("={{ $('Parse Phone Country').item.json.country }}"), type: 'string' },
          { id: 'a5', name: 'email', value: expr("={{ $('Parse Phone Country').item.json.email }}"), type: 'string' },
          { id: 'a6', name: 'ready_status', value: expr('={{ $json.statusCode || 0 }}'), type: 'number' },
        ],
      },
    },
  },
  output: [{ ok: true, action: 'phone_parsed_ready' }],
});

const skipped = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Skipped',
    position: [1020, 480],
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

export default workflow('cw-parse-phone-reply', 'CW.ParsePhoneReply — parse phone/country reply → ready_to_call + voice')
  .add(info)
  .add(webhook)
  .to(map)
  .to(gate.onTrue(fireReady.to(accepted)).onFalse(skipped));
