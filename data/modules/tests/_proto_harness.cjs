// Quick prototype: run the real bundle's submit_result against an in-memory nk mock.
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync('index.js', 'utf-8');

function makeSandbox() {
  var __store = {};
  var __walletCalls = [];
  function __k(c, k, u) { return c + "|" + k + "|" + u; }
  var nk = {
    storageRead: function (reqs) {
      var out = [];
      for (var i = 0; i < reqs.length; i++) {
        var r = reqs[i];
        var v = __store[__k(r.collection, r.key, r.userId)];
        if (v !== undefined) out.push({ value: JSON.parse(JSON.stringify(v.value)), version: v.version });
      }
      return out;
    },
    storageWrite: function (reqs) {
      for (var i = 0; i < reqs.length; i++) {
        var r = reqs[i];
        var key = __k(r.collection, r.key, r.userId);
        var existing = __store[key];
        if (r.version && existing && existing.version !== r.version) {
          throw new Error("Storage write rejected: version conflict");
        }
        __store[key] = { value: JSON.parse(JSON.stringify(r.value)), version: String(Date.now() + i) };
      }
    },
    storageDelete: function (reqs) {
      for (var i = 0; i < reqs.length; i++) delete __store[__k(reqs[i].collection, reqs[i].key, reqs[i].userId)];
    },
    storageList: function () { return { objects: [] }; },
    walletUpdate: function (userId, changeset) { __walletCalls.push(changeset); return {}; },
    leaderboardRecordWrite: function () {},
    leaderboardCreate: function () {},
    accountGetId: function () { return { user: { username: "tester", location: "US" } }; },
    usersGetId: function () { return [{ displayName: "Tester", username: "tester" }]; },
    uuidv4: function () { return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c){ var r = Math.random()*16|0; return (c==="x"?r:(r&0x3|0x8)).toString(16); }); },
  };
  var logger = { info: function(){}, warn: function(){}, error: function(){}, debug: function(){} };
  var sandbox = { console: console, nk: nk, logger: logger };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(src, sandbox, { filename: 'index.js' });
  return { sandbox: sandbox, store: __store, walletCalls: __walletCalls, k: __k };
}

var h = makeSandbox();
var userId = "user-sec-1";
// seed a pack
h.store[h.k("qv_question_packs", "pk_test_1", userId)] = {
  version: "v1",
  value: {
    pack_id: "pk_test_1", topic: "geography", lang: "en", game_id: "quizverse",
    question_ids: ["q1", "q2"],
    questions: [
      { id: "q1", topic: "geography", question_text: "Capital of France?", question_type: "single_select",
        options: [{id:"A",text:"Paris"},{id:"B",text:"London"}], correct_option_ids: ["A"], explanation: "Paris is the capital.", difficulty: "easy" },
      { id: "q2", topic: "geography", question_text: "Capital of Germany?", question_type: "single_select",
        options: [{id:"A",text:"Munich"},{id:"B",text:"Berlin"}], correct_option_ids: ["B"], explanation: "Berlin.", difficulty: "easy" }
    ],
    created_at_ms: Date.now(), expires_at_ms: Date.now() + 1800000
  }
};
var ctx = { userId: userId, username: "tester", env: {} };
var res = JSON.parse(h.sandbox.__rpc_quizverse_submit_result(ctx, h.sandbox.logger, h.sandbox.nk || h.sandbox.__nk, JSON.stringify({
  pack_id: "pk_test_1",
  answers: [
    { question_id: "q1", selected_option_id: "A", time_ms: 1500 },
    { question_id: "q2", selected_option_id: "A", time_ms: 2500 }
  ],
  duration_ms: 20000
})));
console.log("RESULT:", JSON.stringify(res).slice(0, 400));
console.log("wallet calls:", JSON.stringify(h.walletCalls));
