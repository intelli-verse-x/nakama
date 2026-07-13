#!/usr/bin/env node
// Idempotent bounded seeder for the canonical SeedQ mode registry.
// Uses each mode's declared connector; all candidates still pass server-side
// semantic + mobile-experience QA and stable-ID deduplication.

const argv = process.argv.slice(2);
function flag(name, envName, dflt) {
  const i = argv.indexOf(name);
  if (i >= 0 && argv[i + 1] !== undefined) return argv[i + 1];
  return process.env[envName] || dflt;
}
const HOST = flag("--host", "NAKAMA_HOST", "http://localhost:7350").replace(/\/+$/, "");
const HTTP_KEY = flag("--http-key", "HTTP_KEY", "defaulthttpkey");
const TARGET = Math.max(20, parseInt(flag("--target", "SEEDQ_TARGET", "50"), 10) || 50);
const MAX_ROUNDS = Math.min(8, Math.max(1, parseInt(flag("--rounds", "SEEDQ_ROUNDS", "4"), 10) || 4));

async function adminRpc(id, body) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(`${HOST}/v2/rpc/${id}?http_key=${encodeURIComponent(HTTP_KEY)}&unwrap`, {
        method: "POST", headers: { "Content-Type": "application/json", Connection: "close" },
        body: JSON.stringify(body || {}),
      });
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
      if (!r.ok || data.ok === false) throw new Error(`${id}: HTTP ${r.status} ${JSON.stringify(data).slice(0, 240)}`);
      return data;
    } catch (e) {
      last = e;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 750));
    }
  }
  throw last;
}

const registry = await adminRpc("quizverse_seedq_sources", {});
const modes = registry.modes || [];
if (!modes.length) throw new Error("server returned no canonical modes; deploy SeedQ v1.2+ first");
const seedModes = modes.filter((mode) =>
  mode.seedq_required &&
  mode.kind === "question" &&
  (!mode.inventory_mode || mode.inventory_mode === mode.mode)
);

const reports = [];
for (const mode of seedModes) {
  let accepted = 0, rejected = 0, duplicates = 0, poolSize = 0, rounds = 0, lastError = "";
  for (; rounds < MAX_ROUNDS && poolSize < TARGET; rounds++) {
    let res;
    try {
      res = await adminRpc("quizverse_seedq_ingest", {
        source: mode.source, mode: mode.mode, topic: mode.default_topic, count: 60,
      });
    } catch (error) {
      lastError = String(error && error.message ? error.message : error).slice(0, 300);
      break;
    }
    const x = res.result || {};
    accepted += x.accepted || 0; rejected += x.rejected || 0;
    duplicates += x.duplicates || 0; poolSize = x.pool_size || poolSize;
    lastError = x.last_error || "";
    if ((x.accepted || 0) === 0 && (x.duplicates || 0) > 0) break;
  }
  reports.push({
    mode: mode.mode, source: mode.source, topic: mode.default_topic,
    rounds, accepted, rejected, duplicates, pool_size: poolSize,
    last_error: lastError,
    target: TARGET, status: poolSize >= TARGET ? "PASS" :
      (mode.support === "fallback" ? "WARN" : "BLOCKED"),
  });
  console.log(`${reports.at(-1).status.padEnd(7)} ${mode.mode.padEnd(22)} pool=${String(poolSize).padStart(3)}/${TARGET} accepted=${accepted} rejected=${rejected} dup=${duplicates}`);
}

const coverage = await adminRpc("quizverse_seedq_pool_stats", {});
const denominator = (coverage.mode_coverage || []).filter((row) => row.denominator);
const summary = {
  host: HOST, target: TARGET, seeded_inventory_modes: reports.length,
  denominator_modes: denominator.length,
  pass: denominator.filter((r) => r.status === "PASS").length,
  warn: denominator.filter((r) => r.status === "WARN").length,
  blocked: denominator.filter((r) => r.status === "BLOCKED").length,
  reports, coverage: coverage.mode_coverage || [],
};
console.log(JSON.stringify(summary, null, 2));
process.exit(summary.blocked === 0 && summary.warn === 0 ? 0 : 1);
