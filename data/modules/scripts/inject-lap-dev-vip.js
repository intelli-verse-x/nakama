/**
 * Surgically inject QV_LAP_DEV_VIP into data/modules/index.js without
 * regenerating the video-quiz catalog.
 *
 * Usage: node data/modules/scripts/inject-lap-dev-vip.js
 */
const fs = require("fs");
const path = require("path");

const indexPath = path.join(__dirname, "..", "index.js");
let s = fs.readFileSync(indexPath, "utf8");

if (s.includes("QV_LAP_DEV_VIP") && s.includes("isVipUnlocked")) {
  console.log("index.js already contains QV_LAP_DEV_VIP — abort");
  process.exit(0);
}

const insert = [
  "    function isDevVipMode(ctx) {",
  '        var raw = "";',
  "        if (ctx && ctx.env) {",
  '            raw = String(ctx.env["QV_LAP_DEV_VIP"] || "");',
  "        }",
  "        var v = raw.trim().toLowerCase();",
  '        return v === "1" || v === "true" || v === "yes" || v === "on";',
  "    }",
  "    QvVipOverride.isDevVipMode = isDevVipMode;",
  "    function isVipUnlocked(ctx, userId) {",
  "        if (isVipUserId(userId))",
  "            return true;",
  "        return isDevVipMode(ctx);",
  "    }",
  "    QvVipOverride.isVipUnlocked = isVipUnlocked;",
].join("\n");

const marker =
  "    QvVipOverride.isVipUserId = isVipUserId;\n    /** Synthetic Pro+ subscription snapshot for VIP accounts. */";
if (!s.includes(marker)) {
  console.error("vip marker missing");
  process.exit(1);
}
s = s.replace(
  marker,
  "    QvVipOverride.isVipUserId = isVipUserId;\n" +
    insert +
    "\n    /** Synthetic Pro+ subscription snapshot for VIP accounts. */",
);

const entOld =
  "            // VIP Layer 0 — permanent Pro+ for hard-coded QA allow-list.\n" +
  "            if (QvVipOverride.isVipUserId(userId)) {\n" +
  '                logger.info("[QvEntitlements] VIP override active for user=" + userId);';
const entNew =
  "            // VIP Layer 0 — allow-list QA IDs, or whole-runtime QV_LAP_DEV_VIP unlock.\n" +
  "            if (QvVipOverride.isVipUnlocked(ctx, userId)) {\n" +
  '                logger.info("[QvEntitlements] VIP override active for user=" + userId +\n' +
  '                    (QvVipOverride.isDevVipMode(ctx) && !QvVipOverride.isVipUserId(userId) ? " (QV_LAP_DEV_VIP)" : ""));';
if (!s.includes(entOld)) {
  console.error("entitlements block missing");
  process.exit(1);
}
s = s.replace(entOld, entNew);

const quotOld =
  "    function subscriptionTier(nk, userId, nowMs) {\n" +
  "        // VIP Layer 0 — unlimited notes for hard-coded QA allow-list.\n" +
  "        if (QvVipOverride.isVipUserId(userId))\n" +
  '            return "pro_plus";';
const quotNew =
  "    function subscriptionTier(nk, userId, nowMs, ctx) {\n" +
  "        // VIP Layer 0 — unlimited notes for allow-list + optional QV_LAP_DEV_VIP runtime.\n" +
  "        if (ctx ? QvVipOverride.isVipUnlocked(ctx, userId) : QvVipOverride.isVipUserId(userId)) {\n" +
  '            return "pro_plus";\n' +
  "        }";
if (!s.includes(quotOld)) {
  console.error("quota block missing");
  process.exit(1);
}
s = s.replace(quotOld, quotNew);

const callOld = "var tier = subscriptionTier(nk, userId, now.getTime());";
const callNew = "var tier = subscriptionTier(nk, userId, now.getTime(), ctx);";
if (!s.includes(callOld)) {
  console.error("quota call missing");
  process.exit(1);
}
s = s.replace(callOld, callNew);

const hdrOld =
  "//  accounts are not blocked by free-tier note limits or missing RC grants.\n" +
  "// ---------------------------------------------------------------------------";
const hdrNew =
  "//  accounts are not blocked by free-tier note limits or missing RC grants.\n" +
  "//\n" +
  "//  Development unlock: set runtime env QV_LAP_DEV_VIP=1|true|yes|on to treat\n" +
  "//  EVERY authenticated caller as Pro+ (unlimited notes / full entitlements).\n" +
  '//  MUST stay unset / "0" in production.\n' +
  "// ---------------------------------------------------------------------------";
if (s.includes(hdrOld)) {
  s = s.replace(hdrOld, hdrNew);
}

fs.writeFileSync(indexPath, s);
console.log("patched OK");
console.log("QV_LAP_DEV_VIP:", s.includes("QV_LAP_DEV_VIP"));
console.log("isVipUnlocked:", s.includes("isVipUnlocked"));
