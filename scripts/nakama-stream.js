#!/usr/bin/env node
/**
 * nakama-stream.js — real-time stream of Nakama events.
 *
 * Zero dependencies (Node built-ins only). Three modes, pick based on what the
 * target server exposes:
 *
 *   poll     (default)  Tail the RPC interceptor via the
 *                       `nakama_analytics_recent` RPC. Every RPC call hitting
 *                       the server is streamed (id, group, latency, ok/err).
 *                       Samples buffer in-memory then flush to storage every
 *                       ~30s, so this is NEAR real-time (up to ~30s lag) and
 *                       DOES require the database to be up (samples are read
 *                       back from storage). Best general-purpose
 *                       "what RPCs are firing" feed.
 *
 *   webhook             Start a local HTTP receiver, register a wildcard
 *                       Satori webhook (`satori_webhooks_upsert`) pointing back
 *                       at it, and print each game event Nakama PUSHES in real
 *                       time (currency_earned, store_purchase, quiz_completed,
 *                       session_start/end, score_submitted, ...). True push,
 *                       lowest latency. Requires: DB up (webhook config is
 *                       stored) + Nakama able to reach the receiver URL.
 *                       Local Docker -> use http://host.docker.internal:<port>.
 *                       Remote/prod -> expose the receiver via a tunnel
 *                       (ngrok/cloudflared) and pass --callback <public-url>.
 *
 *   logs                Convenience wrapper around
 *                       `docker compose logs -f nakama` (raw server log feed).
 *
 * Usage:
 *   node scripts/nakama-stream.js [poll|webhook|logs] [flags]
 *
 * Common flags (or env vars):
 *   --url       NAKAMA_API_URL    (default http://localhost:7350)
 *   --key       NAKAMA_HTTP_KEY   (default defaulthttpkey)
 *
 * poll flags:
 *   --interval  <ms>              poll cadence (default 2000)
 *   --window    <minutes>         look-back per poll (default 5)
 *
 * webhook flags:
 *   --port      <n>              local receiver port (default 8787)
 *   --callback  <url>            URL Nakama uses to reach the receiver
 *                                (default http://host.docker.internal:<port>)
 *   --events    a,b,c            event names, or "*" for all (default *)
 *   --secret    <s>             HMAC-SHA256 secret to verify signatures
 *   --keep                      do NOT delete the webhook on exit
 *
 * Examples:
 *   node scripts/nakama-stream.js                       # poll localhost
 *   node scripts/nakama-stream.js poll --interval 1000
 *   node scripts/nakama-stream.js webhook --events quiz_completed,store_purchase
 *   NAKAMA_API_URL=https://api.example.ai NAKAMA_HTTP_KEY=xxx \
 *     node scripts/nakama-stream.js poll
 */

"use strict";

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { URL } = require("url");

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const mode = args._[0] || "poll";

const NAKAMA_URL = (args.url || process.env.NAKAMA_API_URL || "http://localhost:7350").replace(/\/$/, "");
const HTTP_KEY = args.key || process.env.NAKAMA_HTTP_KEY || "defaulthttpkey";

// ---------------------------------------------------------------------------
// tiny color + log helpers
// ---------------------------------------------------------------------------
const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

function ts() {
  return new Date().toISOString().slice(11, 23);
}

function banner(text) {
  console.error(C.dim(`[nakama-stream] ${text}`));
}

// ---------------------------------------------------------------------------
// minimal http client (no deps), returns parsed JSON
// ---------------------------------------------------------------------------
function callRpc(rpcId, payload) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${NAKAMA_URL}/v2/rpc/${encodeURIComponent(rpcId)}`);
    u.searchParams.set("unwrap", "");
    u.searchParams.set("http_key", HTTP_KEY);
    const body = JSON.stringify(payload || {});
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      u,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`${rpcId} -> HTTP ${res.statusCode}: ${data}`));
          }
          try {
            resolve(data ? JSON.parse(data) : {});
          } catch (e) {
            reject(new Error(`${rpcId} -> bad JSON: ${data}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ===========================================================================
// MODE: poll  (in-memory RPC interceptor stream)
// ===========================================================================
async function runPoll() {
  const interval = Number(args.interval || 2000);
  const windowMin = Number(args.window || 5);
  banner(`poll mode -> ${NAKAMA_URL}  (every ${interval}ms, window ${windowMin}m)`);
  banner("streaming RPC activity from nakama_analytics_recent (near real-time, ~30s flush lag).");
  banner("requires DB up + live RPC traffic. Ctrl+C to stop.\n");

  const seen = new Set();
  let firstPass = true;

  async function tick() {
    try {
      const res = await callRpc("nakama_analytics_recent", { minutes: windowMin, limit: 2000 });
      const data = res && res.data ? res.data : res;
      const samples = (data && data.samples) || [];
      // oldest first for natural chronological streaming
      samples.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      for (const s of samples) {
        const key = `${s.timestamp}|${s.rpc || s.rpcId}|${s.latency || s.latencyMs}|${s.success}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (firstPass) continue; // skip backlog on first pass; only stream new
        printSample(s);
      }
      firstPass = false;
      // bound memory: keep the set from growing unbounded
      if (seen.size > 20000) {
        const arr = Array.from(seen).slice(-10000);
        seen.clear();
        for (const k of arr) seen.add(k);
      }
    } catch (e) {
      banner(C.red(`poll error: ${e.message}`));
    }
  }

  await tick(); // prime backlog
  banner(C.dim("primed; now streaming new events only...\n"));
  setInterval(tick, interval);
}

function printSample(s) {
  const t = ts();
  const id = s.rpc || s.rpcId || "?";
  const group = s.group ? C.cyan(`[${s.group}]`) : "";
  const lat = s.latency != null ? s.latency : s.latencyMs;
  const latStr = lat != null ? C.dim(`${lat}ms`) : "";
  const ok = s.success === false ? C.red("ERR") : C.green("ok");
  const err = s.error ? C.red(` ${s.error}`) : "";
  console.log(`${C.dim(t)} ${ok} ${group} ${C.bold(id)} ${latStr}${err}`);
}

// ===========================================================================
// MODE: webhook  (push-based game event stream)
// ===========================================================================
async function runWebhook() {
  const port = Number(args.port || 8787);
  const callback = args.callback || `http://host.docker.internal:${port}`;
  const events = String(args.events || "*").split(",").map((s) => s.trim()).filter(Boolean);
  const secret = args.secret || "";
  const keep = !!args.keep;
  const webhookId = `live-stream-${process.pid}`;

  banner(`webhook mode -> ${NAKAMA_URL}`);
  banner(`receiver on :${port}, Nakama will POST to ${callback}`);
  banner(`events: ${events.join(", ")}\n`);

  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405);
      return res.end("method not allowed");
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
      let sigOk = null;
      if (secret) {
        const expected = crypto.createHmac("sha256", secret).update(body).digest("hex");
        const got = req.headers["x-webhook-signature"];
        sigOk = got === expected;
      }
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (_) {
        parsed = { raw: body };
      }
      printEvent(parsed, req.headers["x-webhook-event"], sigOk);
    });
  });

  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, resolve);
  });

  // register the webhook
  try {
    await callRpc("satori_webhooks_upsert", {
      id: webhookId,
      url: callback,
      events: events,
      secret: secret || undefined,
      enabled: true,
    });
    banner(C.green(`registered webhook '${webhookId}'. Streaming pushed events. Ctrl+C to stop.\n`));
  } catch (e) {
    banner(C.red(`failed to register webhook: ${e.message}`));
    banner(C.yellow("receiver is still listening; you can register one manually."));
  }

  async function cleanup() {
    if (!keep) {
      try {
        await callRpc("satori_webhooks_delete", { id: webhookId });
        banner(C.dim(`\nremoved webhook '${webhookId}'.`));
      } catch (e) {
        banner(C.red(`could not remove webhook '${webhookId}': ${e.message}`));
      }
    }
    process.exit(0);
  }
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

function printEvent(evt, headerEvent, sigOk) {
  const t = ts();
  const name = (evt && evt.event) || headerEvent || "event";
  const sig = sigOk === null ? "" : sigOk ? C.green(" [sig ok]") : C.red(" [sig BAD]");
  const data = evt && evt.data !== undefined ? evt.data : evt;
  console.log(`${C.dim(t)} ${C.bold(C.cyan(name))}${sig} ${JSON.stringify(data)}`);
}

// ===========================================================================
// MODE: logs  (raw docker log stream)
// ===========================================================================
function runLogs() {
  banner("logs mode -> docker compose logs -f nakama (Ctrl+C to stop)\n");
  const child = spawn("docker", ["compose", "logs", "-f", "--tail", "20", "nakama"], {
    stdio: "inherit",
  });
  child.on("error", (e) => banner(C.red(`failed to spawn docker: ${e.message}`)));
  child.on("exit", (code) => process.exit(code || 0));
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
(async () => {
  switch (mode) {
    case "poll":
      await runPoll();
      break;
    case "webhook":
      await runWebhook();
      break;
    case "logs":
      runLogs();
      break;
    default:
      console.error(`Unknown mode '${mode}'. Use: poll | webhook | logs`);
      process.exit(1);
  }
})().catch((e) => {
  banner(C.red(`fatal: ${e.message}`));
  process.exit(1);
});
