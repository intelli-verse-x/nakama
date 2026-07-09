/**
 * Server-side write gate for the LiveOps copilot MCP tools.
 *
 * Two responsibilities, both enforced in the tool execute() path (NOT the
 * system prompt, which a model can ignore):
 *
 *  1. classifyToolAccess(toolName, args) — pure "read" | "write" classifier
 *     for exposed MCP tool names, default-deny on ambiguous names.
 *  2. HMAC confirmation tokens — a write tool's first call returns a
 *     confirmation_required result carrying a signed single-use token. The
 *     ONLY way the call executes is when the client UI's Confirm button puts
 *     that token in the top-level `confirmations` field of the next chat
 *     request body. The model cannot set request-body fields and cannot mint
 *     tokens (no secret), so it cannot self-approve.
 *
 * Note: this is distinct from classifyRpcAccess() in the dashboard server,
 * which does role-based routing for the /rpc proxy. This module gates the
 * copilot's MCP tool calls.
 *
 * Plain ESM, node:crypto only, so it is unit-testable with bare node.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const WRITE_TOKENS = new Set([
  "create", "update", "delete", "remove", "send", "resend", "post", "pay",
  "refund", "charge", "issue", "grant", "ban", "unban", "disable", "enable",
  "toggle", "publish", "schedule", "broadcast", "assign", "execute", "write",
  "set", "rotate", "deploy", "apply", "approve", "deny", "reject", "activate",
  "deactivate", "launch", "pause", "resume", "cancel", "redeem", "stake",
  "unstake", "flag", "book", "trigger", "promote", "submit", "upload",
  "import", "invalidate", "restart", "scale", "transfer", "mint", "revoke",
  "generate", "add", "use", "duplicate", "sign", "archive", "restore",
  "purge", "reset", "insert", "patch", "put", "kill", "stop",
]);

const READ_TOKENS = new Set([
  "list", "get", "search", "stats", "retrieve", "query", "describe", "health",
  "directory", "view", "inspect", "show", "find", "read", "fetch", "check",
  "status", "history", "balance", "preflight", "catalog", "learn", "lookup",
  "count", "preview", "analytics", "report", "summary", "overview",
  "forecast", "alerts", "alert", "dashboard", "url", "cost", "metrics",
  "timeline", "ping", "probe", "watch", "tail", "logs", "info", "detail",
  "details", "browse", "map", "crawl", "scrape", "extract", "research",
  "keywords", "serp", "rank", "slot",
]);

const GATEWAY_READ_METHODS = new Set(["tools/list", "resources/list", "prompts/list", "ping"]);

/**
 * Classify an exposed MCP tool as "read" or "write". DEFAULT-DENY: anything
 * ambiguous is a write.
 */
export function classifyToolAccess(toolName, args) {
  const name = String(toolName ?? "").toLowerCase();

  // viz renderers only create new S3 artifacts — explicitly non-gated.
  if (name.startsWith("viz_render_")) return "read";

  // The gateway meta-tool is classified structurally from its JSON-RPC args:
  // discovery methods are reads; tools/call inherits the inner tool's class;
  // anything else (unknown method) is a write.
  if (name === "admin_call_mcp") {
    const method = args && typeof args === "object" ? args.method : undefined;
    if (GATEWAY_READ_METHODS.has(method)) return "read";
    if (method === "tools/call") {
      const inner = args.tool;
      if (typeof inner !== "string" || !inner) return "write";
      return classifyToolAccess(inner, args.arguments);
    }
    return "write";
  }

  const tokens = name.split(/[_-]/).filter(Boolean);
  if (tokens.some((t) => WRITE_TOKENS.has(t))) return "write";
  if (tokens.some((t) => READ_TOKENS.has(t))) return "read";
  return "write";
}

// ── Confirmation tokens ─────────────────────────────────────────────────────

const SECRET = process.env.COPILOT_CONFIRM_SECRET || randomBytes(32).toString("hex");
const TOKEN_TTL_MS = 10 * 60_000;

// Single-use ledger: nonce → expiry. Pruned opportunistically.
const usedNonces = new Map();

function pruneUsedNonces() {
  const now = Date.now();
  for (const [nonce, exp] of usedNonces) {
    if (exp < now) usedNonces.delete(nonce);
  }
}

function hmacHex(body) {
  return createHmac("sha256", SECRET).update(body).digest("hex");
}

/** Mint a signed single-use confirmation token binding tool + exact args. */
export function mintConfirmToken(toolName, args) {
  const payload = {
    v: 1,
    tool: toolName,
    args: args ?? {},
    exp: Date.now() + TOKEN_TTL_MS,
    n: randomBytes(8).toString("hex"),
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${hmacHex(body)}`;
}

/**
 * Verify a confirmation token for a specific tool.
 * Returns { ok: true, args } with the EXACT approved args on success
 * (the caller must execute with these, never the model's re-issued args),
 * or { ok: false, reason } on any failure. Valid tokens are burned.
 */
export function verifyConfirmToken(token, toolName) {
  if (typeof token !== "string" || token.length > 16_384) {
    return { ok: false, reason: "malformed token" };
  }
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return { ok: false, reason: "malformed token" };
  const body = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1), "utf8");
  const expected = Buffer.from(hmacHex(body), "utf8");
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) {
    return { ok: false, reason: "invalid signature" };
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "unparseable payload" };
  }
  if (!payload || payload.v !== 1) return { ok: false, reason: "unsupported token version" };
  if (typeof payload.exp !== "number" || payload.exp < Date.now()) {
    return { ok: false, reason: "token expired" };
  }
  if (payload.tool !== toolName) return { ok: false, reason: "token is for a different tool" };
  pruneUsedNonces();
  if (typeof payload.n !== "string" || usedNonces.has(payload.n)) {
    return { ok: false, reason: "token already used" };
  }
  usedNonces.set(payload.n, payload.exp);
  return { ok: true, args: payload.args };
}

/** Compact one-line human summary of a pending write (~300 chars). */
export function summarizeWriteAction(toolName, args) {
  let argSummary = "";
  if (args && typeof args === "object" && !Array.isArray(args)) {
    argSummary = Object.entries(args)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(", ");
  } else if (args !== undefined && args !== null) {
    argSummary = JSON.stringify(args);
  }
  const summary = argSummary ? `${toolName} — ${argSummary}` : `${toolName} — (no arguments)`;
  return summary.length > 300 ? `${summary.slice(0, 297)}…` : summary;
}

/**
 * The tool result returned instead of executing an unconfirmed write.
 * Returned as a JSON string (tool outputs are text).
 */
export function confirmationRequiredResult(toolName, args) {
  return JSON.stringify({
    status: "confirmation_required",
    tool: toolName,
    args: args ?? {},
    humanSummary: summarizeWriteAction(toolName, args),
    confirmToken: mintConfirmToken(toolName, args),
    instructions:
      "This WRITE action was NOT executed. Server policy requires the user to approve it via the Confirm button now shown in the chat UI. Summarize exactly what will happen and ask the user to confirm. Do not retry until they confirm.",
  });
}
