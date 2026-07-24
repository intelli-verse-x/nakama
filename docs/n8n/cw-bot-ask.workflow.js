import { workflow, node, trigger, sticky, ifElse, expr, newCredential } from '@n8n/workflow-sdk';

/**
 * CW.BotAsk — when admin adds label `bot-ask-phone`, send the phone/country ask email via Chatwoot API.
 * Idempotent via label `bot-ask-sent`.
 *
 * Chatwoot webhook → POST /webhook/cw-bot-ask
 * Cred: HTTP Header Auth named `Chatwoot API` — header `api_access_token` = user access token
 */

const info = sticky(
  '## CW.BotAsk\n\nAdmin adds label **bot-ask-phone** → this workflow sends the ask email once, then adds **bot-ask-sent**.\n\nWebhook: POST /webhook/cw-bot-ask\n\nCred: Chatwoot API (header `api_access_token`).',
  [],
  { position: [200, 80], color: 4 }
);

const webhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Bot Ask Webhook',
    position: [240, 360],
    parameters: {
      httpMethod: 'POST',
      path: 'cw-bot-ask',
      responseMode: 'lastNode',
      responseData: 'firstEntryJson',
    },
  },
  output: [{ body: { event: 'conversation_updated', labels: [{ title: 'bot-ask-phone' }] } }],
});

const map = node({
  type: 'n8n-nodes-base.code',
  version: 2,
  config: {
    name: 'Should Send Bot Ask',
    position: [500, 360],
    parameters: {
      mode: 'runOnceForEachItem',
      language: 'javaScript',
      jsCode: `const CW_ACCOUNT_ID = 1;
const BASE = 'https://inbox.intelli-verse-x.ai';
const ASK = [
  'Thanks for reaching out to QuizVerse Support.',
  '',
  'To help us follow up, please reply with:',
  '1) Your mobile number with country code (example: +916378978141)',
  '2) Your country (example: India)',
  '',
  'You can reply in one line like:',
  'PHONE:+916378978141 COUNTRY:India',
  '',
  'We will reach out with next steps after we receive this.'
].join('\\n');

const raw = $json.body && Object.keys($json.body).length ? $json.body : $json;
const event = String(raw.event || '');
const allowed = {
  conversation_created: 1,
  conversation_updated: 1,
  conversation_status_changed: 1,
  'macro.executed': 1
};
if (event && !allowed[event]) {
  return { skip: true, reason: 'ignored_event', event: event };
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
const wantsBot = names.some(function (n) { return n === 'bot-ask-phone' || n.indexOf('bot-ask-phone') >= 0; });
const alreadySent = names.some(function (n) { return n === 'bot-ask-sent' || n.indexOf('bot-ask-sent') >= 0; });
const isManual = names.some(function (n) { return n === 'manual' || n === 'handle-manual'; });

if (isManual) return { skip: true, reason: 'manual_path' };
if (!wantsBot) return { skip: true, reason: 'no_bot_ask_label' };
if (alreadySent) return { skip: true, reason: 'already_sent' };

const convId = raw.id || (raw.conversation && raw.conversation.id);
if (!convId) return { skip: true, reason: 'missing_conversation_id' };

return {
  skip: false,
  account_id: CW_ACCOUNT_ID,
  conversation_id: convId,
  inbox: inboxName,
  ask_body: ASK,
  labels_url: BASE + '/api/v1/accounts/' + CW_ACCOUNT_ID + '/conversations/' + convId + '/labels',
  message_url: BASE + '/api/v1/accounts/' + CW_ACCOUNT_ID + '/conversations/' + convId + '/messages'
};
`,
    },
  },
  output: [{ skip: false, conversation_id: 160, message_url: 'https://inbox.intelli-verse-x.ai/api/v1/accounts/1/conversations/160/messages' }],
});

const gate = ifElse({
  version: 2.2,
  config: {
    name: 'Send Ask?',
    position: [760, 360],
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
        combinator: 'and',
        conditions: [{
          id: 'send',
          leftValue: expr('{{ $json.skip }}'),
          operator: { type: 'boolean', operation: 'false', singleValue: true },
          rightValue: '',
        }],
      },
    },
  },
});

const sendMsg = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Send Ask via Chatwoot',
    position: [1020, 240],
    onError: 'continueRegularOutput',
    credentials: { httpHeaderAuth: newCredential('Chatwoot API') },
    parameters: {
      method: 'POST',
      url: expr('{{ $json.message_url }}'),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: {
        parameters: [{ name: 'Content-Type', value: 'application/json' }],
      },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr("={{ JSON.stringify({ content: $json.ask_body, message_type: 'outgoing', private: false }) }}"),
      options: { timeout: 20000, response: { response: { fullResponse: true, neverError: true } } },
    },
  },
  output: [{ statusCode: 200 }],
});

const markSent = node({
  type: 'n8n-nodes-base.httpRequest',
  version: 4.4,
  config: {
    name: 'Add bot-ask-sent Label',
    position: [1280, 240],
    onError: 'continueRegularOutput',
    credentials: { httpHeaderAuth: newCredential('Chatwoot API') },
    parameters: {
      method: 'POST',
      url: expr("={{ $('Should Send Bot Ask').item.json.labels_url }}"),
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendHeaders: true,
      specifyHeaders: 'keypair',
      headerParameters: {
        parameters: [{ name: 'Content-Type', value: 'application/json' }],
      },
      sendBody: true,
      contentType: 'json',
      specifyBody: 'json',
      jsonBody: expr("={{ JSON.stringify({ labels: ['bot-ask-phone', 'bot-ask-sent'] }) }}"),
      options: { timeout: 15000, response: { response: { fullResponse: true, neverError: true } } },
    },
  },
  output: [{ statusCode: 200 }],
});

const accepted = node({
  type: 'n8n-nodes-base.set',
  version: 3.4,
  config: {
    name: 'Accepted',
    position: [1540, 240],
    parameters: {
      mode: 'manual',
      includeOtherFields: false,
      assignments: {
        assignments: [
          { id: 'a1', name: 'ok', value: true, type: 'boolean' },
          { id: 'a2', name: 'action', value: 'bot_ask_sent', type: 'string' },
          { id: 'a3', name: 'conversation_id', value: expr("={{ $('Should Send Bot Ask').item.json.conversation_id }}"), type: 'number' },
          { id: 'a4', name: 'send_status', value: expr('={{ $json.statusCode || 0 }}'), type: 'number' },
        ],
      },
    },
  },
  output: [{ ok: true, action: 'bot_ask_sent' }],
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

export default workflow('cw-bot-ask', 'CW.BotAsk — label bot-ask-phone → email ask for phone/country')
  .add(info)
  .add(webhook)
  .to(map)
  .to(gate.onTrue(sendMsg.to(markSent.to(accepted))).onFalse(skipped));
