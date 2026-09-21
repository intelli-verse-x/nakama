#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {createHash} from 'node:crypto';
const source = fs.readFileSync(new URL('../src/legacy/wallet.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES5}}).outputText;
const ctx = {Constants:{WALLETS_COLLECTION:'wallets',SYSTEM_USER_ID:'system'},
 RpcHelpers:{parseRpcPayload:JSON.parse,successResponse:d=>JSON.stringify({success:true,data:d}),errorResponse:e=>JSON.stringify({success:false,error:e})}};
vm.createContext(ctx); vm.runInContext(compiled,ctx);
const key = r => `${r.userId}/${r.key}`;
let db, calls, failBefore, lostResponse, interfere;
function reset(){db=new Map();calls=0;failBefore=false;lostResponse=false;interfere=null;}
const nk={
 sha256Hash:s=>createHash('sha256').update(s).digest('hex'),
 storageRead:req=>req.flatMap(r=>db.has(key(r))?[structuredClone({...db.get(key(r)),...r})]:[]),
 storageWrite:req=>{
  calls++;
  if(failBefore) throw Error('database unavailable');
  if(interfere){const f=interfere;interfere=null;f();}
  // Model Nakama's atomic storage batch: validate every version before writes.
  for(const r of req){const old=db.get(key(r));
   if(r.version==='*' ? !!old : !old || old.version!==r.version)throw Error('version conflict');}
  for(const r of req)db.set(key(r),structuredClone({...r,version:String(calls)}));
  if(lostResponse){lostResponse=false;throw Error('response lost after commit');}
 }
};
const award={userId:'player',gameId:'game',grantId:'round-one',coins:2,xp:3};
const grant=(payload=award,user={})=>JSON.parse(ctx.LegacyWallet.rpcKioskxArcadeWalletGrant(user,{},nk,JSON.stringify(payload)));
const balance=()=>db.get('player/wallet_player_game')?.value.currencies.game||0;
reset(); assert.equal(grant().success,true);assert.equal(balance(),2);assert.equal(calls,1);
assert.equal(db.get('player/global_player').value.currencies.xp,3);
assert.equal(db.get('player/wallet_player_game').permissionWrite,0);
assert.equal(grant().data.idempotent,true);assert.equal(calls,1);
assert.equal(grant({...award,coins:3}).success,false);assert.equal(balance(),2);
assert.equal(grant(award,{userId:'untrusted'}).success,false);
console.log('PASS atomic balances+receipt, immutable award, replay and session refusal');
reset();failBefore=true;assert.equal(grant().success,false);assert.equal(db.size,0);
failBefore=false;assert.equal(grant().success,true);assert.equal(balance(),2);
console.log('PASS outage leaves no partial award; same grant recovers');
reset();lostResponse=true;assert.equal(grant().data.idempotent,true);assert.equal(balance(),2);
console.log('PASS lost commit acknowledgement does not duplicate coins or XP');
reset();interfere=()=>assert.equal(grant().success,true);
assert.equal(grant().data.idempotent,true);assert.equal(balance(),2);
console.log('PASS two workers claiming same receipt mint once');
reset();interfere=()=>assert.equal(grant({...award,grantId:'other-round'}).success,true);
assert.equal(grant().success,true);assert.equal(balance(),4);
assert.equal(db.get('player/global_player').value.currencies.xp,6);
console.log('PASS competing distinct awards preserve both balance changes');

reset();const longId='round-'.repeat(30);
assert.equal(grant({...award,grantId:longId}).success,true);
assert.equal(grant({...award,grantId:longId+'different'}).success,true);
assert.equal(balance(),4);
assert([...db.keys()].every(k=>k.split('/')[1].length<=128));
console.log('PASS long round IDs are distinct and storage keys stay bounded');
reset();db.set('system/arcade_grant_round-one',{value:{...award,gameBalance:2,xpBalance:3},version:'old'});
assert.equal(grant().data.idempotent,true);assert.equal(calls,0);
console.log('PASS pre-upgrade receipts never remint');
