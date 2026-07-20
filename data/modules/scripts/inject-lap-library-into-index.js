'use strict';
/**
 * Surgical inject: take origin/master index.js and insert ONLY the
 * quizverse_lap_library_* pieces from the rebuilt PR bundle, preserving
 * master byte-order for everything else (incl. video quiz catalog).
 *
 * Usage (from repo root):
 *   node data/modules/scripts/inject-lap-library-into-index.js
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INDEX = path.join(ROOT, 'index.js');
const SRC_MOD = path.join(ROOT, 'lap-library', 'lap-library.js');

const RPC_IDS = [
  'quizverse_lap_library_save',
  'quizverse_lap_library_list',
  'quizverse_lap_library_get',
  'quizverse_lap_library_delete',
  'quizverse_lap_library_pin',
  'quizverse_lap_library_recall',
  'quizverse_lap_library_stats',
];

const FN_MAP = {
  quizverse_lap_library_save: 'rpcQuizverseLapLibrarySave',
  quizverse_lap_library_list: 'rpcQuizverseLapLibraryList',
  quizverse_lap_library_get: 'rpcQuizverseLapLibraryGet',
  quizverse_lap_library_delete: 'rpcQuizverseLapLibraryDelete',
  quizverse_lap_library_pin: 'rpcQuizverseLapLibraryPin',
  quizverse_lap_library_recall: 'rpcQuizverseLapLibraryRecall',
  quizverse_lap_library_stats: 'rpcQuizverseLapLibraryStats',
};

function loadMaster() {
  return execSync('git show origin/master:data/modules/index.js', {
    maxBuffer: 50 * 1024 * 1024,
  }).toString('utf8');
}

function stripModuleInit(src) {
  // postbuild renames InitModule → InitModule_lap_library_lap_library (folder_file pattern)
  // and rewrites registerRpc("id", fn) → __rpc_id = __rpc_id || (fn)
  let body = src.replace(/\r\n/g, '\n');

  // Remove the local InitModule — registration happens only in the merged InitModule.
  body = body.replace(/\nfunction InitModule\([\s\S]*?\n\}\n?$/, '\n');

  // Rename for uniqueness isn't strictly needed if we strip InitModule, but keep handlers.
  return body.trim() + '\n';
}

function injectStubs(index) {
  // Insert after quizverse_lap_badge_sync stub (alphabetical neighbors)
  const anchor = 'var __rpc_quizverse_lap_badge_sync;';
  if (index.indexOf('var __rpc_quizverse_lap_library_save;') !== -1) {
    console.log('[inject] stubs already present — skipping');
    return index;
  }
  if (index.indexOf(anchor) === -1) {
    throw new Error('anchor stub __rpc_quizverse_lap_badge_sync not found');
  }
  const stubs = RPC_IDS.map(function (id) {
    return 'var __rpc_' + id + ';';
  }).join('\n');
  return index.replace(anchor, anchor + '\n' + stubs);
}

function injectRegisterCatchBlocks(index) {
  // postbuild adds: try { __rpc_X = __rpc_X || (fn); } catch(e) {}
  // Find block near other quizverse_lap_badge assignments
  const marker = 'try { __rpc_quizverse_lap_badge_sync = __rpc_quizverse_lap_badge_sync || (rpcQuizverseLapBadgeSync); } catch(e) {}';
  if (index.indexOf('__rpc_quizverse_lap_library_save =') !== -1) {
    console.log('[inject] || assignments already present — skipping');
    return index;
  }
  if (index.indexOf(marker) === -1) {
    // softer search
    const soft = index.indexOf('__rpc_quizverse_lap_badge_sync = __rpc_quizverse_lap_badge_sync');
    if (soft === -1) throw new Error('cannot find lap_badge_sync || assignment');
  }
  const lines = RPC_IDS.map(function (id) {
    const fn = FN_MAP[id];
    return (
      'try { __rpc_' +
      id +
      ' = __rpc_' +
      id +
      ' || (' +
      fn +
      '); } catch(e) {}'
    );
  }).join('\n');

  if (index.indexOf(marker) !== -1) {
    return index.replace(marker, marker + '\n' + lines);
  }
  // Fallback: insert after first occurrence of badge_sync || line
  return index.replace(
    /try \{ __rpc_quizverse_lap_badge_sync = __rpc_quizverse_lap_badge_sync \|\| \([^)]+\); \} catch\(e\) \{\}/,
    function (m) {
      return m + '\n' + lines;
    },
  );
}

function injectRegisterRpcCalls(index) {
  const marker =
    'try { initializer.registerRpc("quizverse_lap_badge_sync", __rpc_quizverse_lap_badge_sync); } catch(e) {}';
  if (index.indexOf('registerRpc("quizverse_lap_library_save"') !== -1) {
    console.log('[inject] registerRpc calls already present — skipping');
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
  if (index.indexOf(marker) === -1) {
    throw new Error('cannot find registerRpc lap_badge_sync anchor');
  }
  return index.replace(marker, marker + '\n' + lines);
}

function injectModuleBody(index, body) {
  if (index.indexOf('LAP_LIB_COLLECTION') !== -1) {
    console.log('[inject] module body already present — skipping');
    return index;
  }
  // Place before the final generated InitModule wrapper
  const markers = [
    '\nfunction InitModule(ctx, logger, nk, initializer) {',
    '\nfunction InitModule(ctx, logger, nk, initializer)',
  ];
  // Prefer the LAST InitModule (merged wrapper)
  const lastIdx = index.lastIndexOf('function InitModule(ctx, logger, nk, initializer)');
  if (lastIdx === -1) throw new Error('InitModule wrapper not found');

  const banner =
    '\n// --- Module: lap-library/lap-library.js (injected) ---\n' + body + '\n';
  return index.slice(0, lastIdx) + banner + index.slice(lastIdx);
}

function bumpRpcCount(index) {
  return index.replace(/\/\/ RPC Count: (\d+)/, function (_m, n) {
    return '// RPC Count: ' + (parseInt(n, 10) + RPC_IDS.length);
  });
}

function main() {
  if (!fs.existsSync(SRC_MOD)) {
    throw new Error('missing ' + SRC_MOD);
  }
  let index = loadMaster();
  if (index.indexOf('LAP_LIB_COLLECTION') !== -1) {
    console.log('[inject] master already has LAP library — nothing to do');
    process.exit(0);
  }

  const raw = fs.readFileSync(SRC_MOD, 'utf8');
  const body = stripModuleInit(raw);

  index = injectStubs(index);
  index = injectModuleBody(index, body);
  index = injectRegisterCatchBlocks(index);
  index = injectRegisterRpcCalls(index);
  index = bumpRpcCount(index);

  // Verify
  for (let i = 0; i < RPC_IDS.length; i++) {
    const id = RPC_IDS[i];
    if (index.indexOf('registerRpc("' + id + '"') === -1) {
      throw new Error('missing registerRpc for ' + id);
    }
  }
  if (index.indexOf('LAP_LIB_COLLECTION') === -1) {
    throw new Error('module body missing after inject');
  }

  // Preserve master's catalog line untouched (we started from master).
  fs.writeFileSync(INDEX, index, 'utf8');
  console.log('[inject] Wrote ' + INDEX);
  console.log('[inject] Catalog preserved from origin/master');
  console.log('[inject] Added ' + RPC_IDS.length + ' quizverse_lap_library_* RPCs');
}

main();
