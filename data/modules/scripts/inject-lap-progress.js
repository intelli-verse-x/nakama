/**
 * Surgically inject lap-progress RPCs into data/modules/index.js WITHOUT
 * regenerating the video-quiz catalog (avoids ~87KB review noise).
 *
 * Usage: node data/modules/scripts/inject-lap-progress.js
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const indexPath = path.join(root, "index.js");
const srcPath = path.join(root, "lap-progress", "lap-progress.js");

let index = fs.readFileSync(indexPath, "utf8");
let src = fs.readFileSync(srcPath, "utf8");

if (index.includes("quizverse_lap_submit_progress")) {
  console.log("index.js already contains quizverse_lap_submit_progress — abort");
  process.exit(0);
}

// Transform module the way postbuild would for a plain JS module:
// - registerRpc("id", fn) → __rpc_id = __rpc_id || (fn);
// - InitModule → __ModuleInit_lap_progress
src = src.replace(
  /initializer\.registerRpc\(\s*"quizverse_lap_submit_progress"\s*,\s*rpcQuizverseLapSubmitProgress\s*\)/g,
  "__rpc_quizverse_lap_submit_progress = __rpc_quizverse_lap_submit_progress || (rpcQuizverseLapSubmitProgress)",
);
src = src.replace(
  /initializer\.registerRpc\(\s*"quizverse_lap_get_progress"\s*,\s*rpcQuizverseLapGetProgress\s*\)/g,
  "__rpc_quizverse_lap_get_progress = __rpc_quizverse_lap_get_progress || (rpcQuizverseLapGetProgress)",
);
src = src.replace(
  /function InitModule\s*\(/,
  "function __ModuleInit_lap_progress(",
);

const moduleBlock = [
  "",
  "// --- LAP note progress (surgical inject; keeps video catalog untouched) ---",
  src.trim(),
  "",
].join("\n");

// 1) Stub declarations next to existing LAP badge stubs
const stubNeedle = "var __rpc_quizverse_lap_badge_sync;";
if (!index.includes(stubNeedle)) {
  console.error("Could not find badge sync stub for insertion point");
  process.exit(1);
}
index = index.replace(
  stubNeedle,
  [
    stubNeedle,
    "var __rpc_quizverse_lap_submit_progress;",
    "var __rpc_quizverse_lap_get_progress;",
  ].join("\n"),
);

// 2) Insert module body just before the generated InitModule wrapper
const initNeedle = "function InitModule(ctx, logger, nk, initializer) {";
const initIdx = index.lastIndexOf(initNeedle);
if (initIdx < 0) {
  console.error("Could not find InitModule wrapper");
  process.exit(1);
}
index = index.slice(0, initIdx) + moduleBlock + "\n" + index.slice(initIdx);

// 3) Invoke module init + register RPCs inside wrapper, before final log line
const logNeedle =
  '  logger.info("[Postbuild] Registered " + 1305 + " RPCs via AST-compatible wrapper';
if (!index.includes(logNeedle)) {
  // fallback: find Registered 1305
  const alt = index.match(/logger\.info\("\[Postbuild\] Registered " \+ 1305 \+ " RPCs[^\n]*/);
  if (!alt) {
    console.error("Could not find Registered 1305 log line");
    process.exit(1);
  }
}

const injectRegs = [
  "  // --- LAP note progress (surgical) ---",
  "  try { __ModuleInit_lap_progress(ctx, logger, nk, initializer); } catch(e) {}",
  '  try { initializer.registerRpc("quizverse_lap_submit_progress", __rpc_quizverse_lap_submit_progress); } catch(e) {}',
  '  try { initializer.registerRpc("quizverse_lap_get_progress", __rpc_quizverse_lap_get_progress); } catch(e) {}',
  "",
].join("\n");

index = index.replace(
  /  logger\.info\("\[Postbuild\] Registered " \+ 1305 \+ " RPCs/,
  injectRegs + '  logger.info("[Postbuild] Registered " + 1307 + " RPCs',
);

// 4) Header RPC count
index = index.replace(/\/\/ RPC Count: 1305/, "// RPC Count: 1307");

// 5) Global replay assignments (modules-first section style)
const replayNeedle =
  "try { __rpc_quizverse_lap_badge_sync = __rpc_quizverse_lap_badge_sync || (rpcQuizverseLapBadgeSync); } catch(e) {}";
if (index.includes(replayNeedle)) {
  index = index.replace(
    replayNeedle,
    [
      replayNeedle,
      "try { __rpc_quizverse_lap_submit_progress = __rpc_quizverse_lap_submit_progress || (rpcQuizverseLapSubmitProgress); } catch(e) {}",
      "try { __rpc_quizverse_lap_get_progress = __rpc_quizverse_lap_get_progress || (rpcQuizverseLapGetProgress); } catch(e) {}",
    ].join("\n"),
  );
}

fs.writeFileSync(indexPath, index);
console.log("Injected lap-progress RPCs into index.js");
console.log(
  "submit:",
  (index.match(/quizverse_lap_submit_progress/g) || []).length,
  "get:",
  (index.match(/quizverse_lap_get_progress/g) || []).length,
);
console.log(
  "catalog version line preserved:",
  /__QV_VIDEO_QUIZ_CATALOG__ = \{"version":"2026-07-13T16:35/.test(index) ||
    /__QV_VIDEO_QUIZ_CATALOG__/.test(index),
);
