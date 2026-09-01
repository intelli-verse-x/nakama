#!/usr/bin/env node
// Harness for push.test.ts.
//
//   cd data/modules
//   npx tsc -p tsconfig.tests.json && node src/legacy/__tests__/run.js
//
// Same shape as src/recorder/__tests__/run.js: tsconfig.tests.json is the
// production tsconfig with __tests__ included, so the tests compile into the
// same single-file bundle as the runtime and every namespace is reachable as a
// sandbox global. InitModule is stubbed out because running it would need a real
// Nakama initializer — the push tests hand LegacyPush.register a fake one.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const bundle = path.join(__dirname, "..", "..", "..", "build-tests", "all-tests.js");
if (!fs.existsSync(bundle)) {
  console.error("missing " + bundle + "\nrun: npx tsc -p tsconfig.tests.json");
  process.exit(2);
}

let src = fs.readFileSync(bundle, "utf8");
src = src.replace(/function InitModule\([\s\S]*?^}/m, "function InitModule(){}");
// sq_rpcs.ts ends with `register(null as any)` on purpose: postbuild rewrites
// its registerRpc calls into __rpc_* assignments, so the null is never
// dereferenced in production. We load the raw tsc output, where it still is, so
// drop the call rather than run postbuild just to import a namespace.
src = src.replace(/^\s*register\(null\);\s*$/gm, "");

const sandbox = {
  Date, Math, Object, JSON, Array, String, Number, Boolean, Error, RegExp,
  Uint8Array, Int16Array, ArrayBuffer, Buffer,
  parseInt, parseFloat, isNaN, isFinite, Infinity, NaN, undefined,
  console,
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "all-tests.js" });

const suites = [
  ["PushTests", sandbox.PushTests],
];

let totalPassed = 0;
let totalFailed = 0;

for (const [name, ns] of suites) {
  if (!ns || typeof ns.runAll !== "function") {
    console.error(`${name}: not found in the bundle`);
    process.exit(2);
  }
  const r = ns.runAll();
  totalPassed += r.passed;
  totalFailed += r.failed;
  const mark = r.failed === 0 ? "PASS" : "FAIL";
  console.log(`${mark} ${name}: ${r.passed}/${r.total} passed`);
  for (const e of r.errors) console.log("  ✗ " + e);
}

console.log(`\n${totalFailed === 0 ? "ALL GREEN" : "FAILURES"} — ${totalPassed} passed, ${totalFailed} failed`);
process.exit(totalFailed === 0 ? 0 : 1);
