'use strict';
/**
 * Surgical inject of quizverse_lap_gamification_* into origin/master index.js
 * Usage: node data/modules/scripts/inject-lap-gamification-into-index.js
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'index.js');
const SRC_MOD = path.join(ROOT, 'lap-gamification', 'lap-gamification.js');

const RPC_IDS = [
  'quizverse_lap_gamification_get',
  'quizverse_lap_gamification_upsert',
];

const FN_MAP = {
  quizverse_lap_gamification_get: 'rpcQuizverseLapGamificationGet',
  quizverse_lap_gamification_upsert: 'rpcQuizverseLapGamificationUpsert',
};

function loadMaster() {
  return execSync('git show origin/master:data/modules/index.js', {
    maxBuffer: 50 * 1024 * 1024,
  }).toString('utf8');
}

function stripModuleInit(src) {
  let body = src.replace(/\r\n/g, '\n');
  body = body.replace(/\nfunction InitModule\([\s\S]*?\n\}\n?$/, '\n');
  return body.trim() + '\n';
}

function injectStubs(index) {
  if (index.indexOf('var __rpc_quizverse_lap_gamification_get;') !== -1) {
    return index;
  }
  const anchor = 'var __rpc_quizverse_lap_library_stats;';
  const fallback = 'var __rpc_quizverse_lap_badge_sync;';
  const stubs = RPC_IDS.map(function (id) {
    return 'var __rpc_' + id + ';';
  }).join('\n');
  if (index.indexOf(anchor) !== -1) {
    return index.replace(anchor, anchor + '\n' + stubs);
  }
  if (index.indexOf(fallback) !== -1) {
    return index.replace(fallback, fallback + '\n' + stubs);
  }
  throw new Error('stub anchor not found');
}

function injectRegisterCatchBlocks(index) {
  if (index.indexOf('__rpc_quizverse_lap_gamification_get =') !== -1) {
    return index;
  }
  const lines = RPC_IDS.map(function (id) {
    return (
      'try { __rpc_' +
      id +
      ' = __rpc_' +
      id +
      ' || (' +
      FN_MAP[id] +
      '); } catch(e) {}'
    );
  }).join('\n');
  const markers = [
    'try { __rpc_quizverse_lap_library_stats = __rpc_quizverse_lap_library_stats || (rpcQuizverseLapLibraryStats); } catch(e) {}',
    'try { __rpc_quizverse_lap_badge_sync = __rpc_quizverse_lap_badge_sync || (rpcQuizverseLapBadgeSync); } catch(e) {}',
  ];
  for (var i = 0; i < markers.length; i++) {
    if (index.indexOf(markers[i]) !== -1) {
      return index.replace(markers[i], markers[i] + '\n' + lines);
    }
  }
  throw new Error('|| assignment anchor not found');
}

function injectRegisterRpcCalls(index) {
  if (index.indexOf('registerRpc("quizverse_lap_gamification_get"') !== -1) {
    return index;
  }
  const lines = RPC_IDS.map(function (id) {
    return (
      'try { initializer.registerRpc("' +
      id +
      '", __rpc_' +
      id +
      '); } catch(e) {}'
    );
  }).join('\n');
  const markers = [
    'try { initializer.registerRpc("quizverse_lap_library_stats", __rpc_quizverse_lap_library_stats); } catch(e) {}',
    'try { initializer.registerRpc("quizverse_lap_badge_sync", __rpc_quizverse_lap_badge_sync); } catch(e) {}',
  ];
  for (var i = 0; i < markers.length; i++) {
    if (index.indexOf(markers[i]) !== -1) {
      return index.replace(markers[i], markers[i] + '\n' + lines);
    }
  }
  throw new Error('registerRpc anchor not found');
}

function injectModuleBody(index, body) {
  if (index.indexOf('LAP_XP_COLLECTION') !== -1) {
    return index;
  }
  const lastIdx = index.lastIndexOf('function InitModule(ctx, logger, nk, initializer)');
  if (lastIdx === -1) throw new Error('InitModule wrapper not found');
  const banner =
    '\n// --- Module: lap-gamification/lap-gamification.js (injected) ---\n' +
    body +
    '\n';
  return index.slice(0, lastIdx) + banner + index.slice(lastIdx);
}

function bumpRpcCount(index) {
  return index.replace(/\/\/ RPC Count: (\d+)/, function (_m, n) {
    return '// RPC Count: ' + (parseInt(n, 10) + RPC_IDS.length);
  });
}

function main() {
  const raw = fs.readFileSync(SRC_MOD, 'utf8');
  const body = stripModuleInit(raw);
  let index = loadMaster();
  index = injectStubs(index);
  index = injectModuleBody(index, body);
  index = injectRegisterCatchBlocks(index);
  index = injectRegisterRpcCalls(index);
  index = bumpRpcCount(index);
  for (var i = 0; i < RPC_IDS.length; i++) {
    if (index.indexOf('registerRpc("' + RPC_IDS[i] + '"') === -1) {
      throw new Error('missing registerRpc for ' + RPC_IDS[i]);
    }
  }
  fs.writeFileSync(INDEX, index, 'utf8');
  console.log('[inject] Wrote ' + INDEX + ' (+' + RPC_IDS.length + ' gamification RPCs)');
}

main();
