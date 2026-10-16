const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const ts = require('typescript');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/analytics/privacy-rpc.ts'), 'utf8');
const gid = '126bf539-dae2-4bcf-964d-316c0fa1f92b';
function setup(options = {}) {
  const rpcs = {}, events = [], rows = new Map(); let seq = 0;
  const id = r => [r.userId, r.collection, r.key].join('/');
  const put = (collection, key, userId = 'player-one') => rows.set(id({collection,key,userId}), {collection,key,userId,value:{},version:String(++seq)});
  const ctx = {userId:'player-one',env:{IVX_AI_SVC_BASE_URL:'https://ai.example/api/ai',IVX_INSIGHTS_SHARED_SECRET:'test-secret'}};
  const nk = {
    storageRead: refs => refs.map(r=>rows.get(id(r))).filter(Boolean),
    storageWrite: writes => writes.map(r => {
      events.push('write'); const old = rows.get(id(r));
      if (options.claimFails || (r.version === '*' ? !!old : old?.version !== r.version)) throw Error('conflict');
      const saved = {...r,version:String(++seq)}; rows.set(id(r),saved); return saved;
    }),
    storageList: (userId,collection,limit,cursor) => {
      if(options.storageFails) throw Error('storage');
      const items = [...rows.values()].filter(r=>r.userId===userId && r.collection===collection && (!cursor || r.key>cursor)).sort((a,b)=>a.key.localeCompare(b.key));
      const objects = items.slice(0,2); return {objects,cursor:items.length>2?objects.at(-1).key:undefined};
    },
    storageDelete: refs => { for(const r of refs) { assert.equal(rows.get(id(r)).version,r.version); rows.delete(id(r)); events.push(['delete',r]); } },
    hmacSha256Hash: (m,s) => crypto.createHmac('sha256',s).update(m).digest(),
    base16Encode: b => b.toString('hex'),
    httpRequest: (url,method,headers,body) => {
      events.push(['ai',JSON.parse(body)]); assert.equal(url,'https://ai.example/api/ai/privacy/erase');
      assert.equal(headers['X-IVX-Signature'],crypto.createHmac('sha256','test-secret').update(headers['X-IVX-Timestamp']+':/api/ai/privacy/erase:'+body).digest('hex'));
      return options.ai || {code:200,body:JSON.stringify({ok:true,cacheErasureVerified:true})};
    },
    leaderboardsGetId: ids => ids.map(id=>({id})),
    leaderboardRecordDelete: (board,user) => {if(options.boardFails) throw Error('board'); events.push(['board',board,user]);},
    accountDeleteId: () => assert.fail('shared identity deleted'),
    walletUpdate: () => assert.fail('wallet changed'),
  };
  const sandbox = {}; vm.createContext(sandbox); vm.runInContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES5}}).outputText,sandbox);
  sandbox.QvPrivacy.register({registerRpc:(id,fn)=>rpcs[id]=fn});
  const call = (payload={gameId:gid,confirmUserId:ctx.userId},rpc='privacy_erase_game') => JSON.parse(rpcs[rpc](ctx,{warn(){}},nk,typeof payload==='string'?payload:JSON.stringify(payload)));
  return {call,ctx,events,rows,put};
}
test('unauthenticated and wrong confirmation have no effects',()=>{const s=setup();s.ctx.userId='';assert.equal(s.call().error,'unauthenticated');s.ctx.userId='player-one';assert.equal(s.call({gameId:gid,confirmUserId:'victim'}).error,'confirmation_mismatch');assert.equal(s.events.length,0);});
test('unknown game and malformed input fail before claim',()=>{const s=setup();for(const gameId of ['cricket','default','quizverse_other',null]) assert.equal(s.call({gameId,confirmUserId:s.ctx.userId}).error,'unsupported_game');for(const x of ['null','[]','{']) assert.equal(s.call(x).ok,false);assert.equal(s.events.length,0);});
test('claim conflict prevents side effects',()=>{const s=setup({claimFails:true});assert.equal(s.call().error,'claim_unavailable');assert.deepEqual(s.events,['write']);});
test('active claim blocks concurrent calls, expired claim recovers',()=>{const s=setup();s.rows.set('player-one/privacy_game_erasure/quizverse',{version:'1',value:{leaseUntil:Date.now()+60000}});assert.equal(s.call().status,'in_progress');assert.equal(s.events.length,0);s.rows.values().next().value.value.leaseUntil=0;assert.equal(s.call().ok,true);});
test('happy cascade preserves other players, games, shared profiles and wallets',()=>{const s=setup();for(let i=0;i<5;i++)s.put('hiro_stats',gid+':score'+i);s.put('qv_quests',gid+'_player-one');s.put('quiz-verse_quiz_history','history');s.put('game_inventory','quizverse_player-one');s.put('qv_onboarding_profiles','profile');for(const [c,k,u] of [['hiro_stats','cricket:values'],['hiro_stats','values'],['qv_quests','cricket_player-one'],['wallets','wallet'],['profile','profile'],['qv_seen','global_general'],['hiro_stats',gid+':values','other-player']])s.put(c,k,u);assert.equal(s.call().ok,true);assert.equal(s.events[0],'write');assert.equal(s.rows.size,8);for(const e of s.events.filter(e=>Array.isArray(e)&&e[0]==='board')){assert.ok(e[1]==='quizverse_leaderboard'||e[1].endsWith('_daily_puzzle_leaderboard'));assert.equal(e[2],'player-one');}assert.equal(s.call().ok,true);assert.equal(s.rows.size,8);});
test('aliases normalize AI game and subject never comes from payload',()=>{for(const gameId of [gid,'quizverse','quiz-verse']){const s=setup();assert.equal(s.call({gameId,confirmUserId:s.ctx.userId,userId:'victim'}).ok,true);const ai=s.events.find(e=>e[0]==='ai')[1];assert.equal(ai.gameId,'quizverse');assert.equal(ai.userId,'player-one');}});
test('AI failures and malformed success are partial and retryable',()=>{for(const ai of [{code:503,body:'private diagnostics'},{code:200,body:'{}'},{code:200,body:'not json'},{code:200,body:'{"ok":true}'}]){const s=setup({ai});const r=s.call();assert.equal(r.status,'partial');assert.equal(r.retryable,true);assert.equal(r.subsystems.ai,'failed');assert.equal(r.subsystems.storage,'erased');assert.equal(s.rows.get('player-one/privacy_game_erasure/quizverse').value.status,'partial');}});
test('storage and leaderboard failures stay visible',()=>{for(const option of ['storageFails','boardFails']){const s=setup({[option]:true});assert.equal(s.call().status,'partial');}});
test('missing HMAC secret sends no HTTP request',()=>{const s=setup();s.ctx.env.IVX_INSIGHTS_SHARED_SECRET='';assert.equal(s.call().status,'partial');assert.ok(!s.events.some(e=>e[0]==='ai'));});
test('legacy QuizVerse forwarder binds session and maps UUID',()=>{const s=setup();assert.equal(s.call({game_id:gid,user_id:'victim'},'privacy_erase_user').error,'subject_mismatch');assert.equal(s.events.length,0);assert.equal(s.call({game_id:gid,user_id:s.ctx.userId},'privacy_erase_user').ok,true);s.ctx.userId='';assert.equal(s.call({game_id:gid,user_id:'player-one'},'privacy_erase_user').error,'unauthenticated');});
