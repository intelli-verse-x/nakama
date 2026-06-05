/**
 * run-toolbelt-tests.js — executes the Learner Toolbelt micro test suite.
 *
 * The tests in src/learner-toolbelt/__tests__/skeleton.test.ts are written in
 * the same Goja/ES5 namespace style as the production runtime (no Jest/Mocha,
 * no ES modules), so we can compile the toolbelt + shared namespaces + the test
 * into one ES5 bundle (tsconfig.tests.json, outFile) and run `runAll()` inside a
 * Node VM context that mimics the Goja global scope.
 *
 * Usage:  npm run test:toolbelt   (compiles then runs)
 * Exit:   0 = all passed, 1 = one or more failed, 2 = harness/setup error.
 */
"use strict";

var fs = require("fs");
var path = require("path");
var vm = require("vm");

var bundlePath = path.join(__dirname, "build-tests", "toolbelt-tests.js");

if (!fs.existsSync(bundlePath)) {
  console.error(
    "[test:toolbelt] compiled bundle missing at " +
      bundlePath +
      "\n  Run `npx tsc -p tsconfig.tests.json` first (the npm script does this)."
  );
  process.exit(2);
}

var code = fs.readFileSync(bundlePath, "utf8");

// Goja exposes the standard ES5 globals; we mirror the subset the toolbelt and
// the tests actually touch. nkruntime is type-only (erased at compile), so no
// runtime shim is needed — the tests pass mock nk/ctx/logger objects directly.
var sandbox = {
  console: console,
  JSON: JSON,
  Math: Math,
  Date: Date,
  Array: Array,
  Object: Object,
  Number: Number,
  String: String,
  Boolean: Boolean,
  RegExp: RegExp,
  Error: Error,
  isNaN: isNaN,
  parseInt: parseInt,
  parseFloat: parseFloat,
  encodeURIComponent: encodeURIComponent,
  decodeURIComponent: decodeURIComponent,
};

vm.createContext(sandbox);

try {
  vm.runInContext(code, sandbox, { filename: "toolbelt-tests.js" });
} catch (e) {
  console.error("[test:toolbelt] bundle failed to evaluate:");
  console.error(e && e.stack ? e.stack : String(e));
  process.exit(2);
}

var tests = sandbox.LearnerToolbeltTests;
if (!tests || typeof tests.runAll !== "function") {
  console.error(
    "[test:toolbelt] LearnerToolbeltTests.runAll() not found on the bundle global."
  );
  process.exit(2);
}

var result = tests.runAll();

console.log("");
console.log("──────────────────────────────────────────────");
console.log(" Learner Toolbelt test suite");
console.log("──────────────────────────────────────────────");
console.log(
  " " +
    result.passed +
    "/" +
    result.total +
    " passed" +
    (result.failed > 0 ? "  ·  " + result.failed + " FAILED" : "")
);
if (result.failed > 0) {
  console.log("");
  for (var i = 0; i < result.errors.length; i++) {
    console.log("  \u2717 " + result.errors[i]);
  }
}
console.log("──────────────────────────────────────────────");

process.exit(result.failed > 0 ? 1 : 0);
