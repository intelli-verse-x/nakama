import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COPILOT_MODELS,
  COPILOT_SYSTEM_PROMPT,
  DEFAULT_COPILOT_MODEL,
  getCopilotSkill,
} from "./copilot-skills.mjs";
import {
  classifyToolAccess,
  confirmationRequiredResult,
  verifyConfirmToken,
} from "./write-gate.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const distDir = resolve(process.env.ADMIN_DASHBOARD_DIST_DIR ?? join(__dirname, "..", "dist"));
const basePath = normalizePrefix(process.env.ADMIN_DASHBOARD_BASE_PATH ?? "/admin-dashboard");
const apiPrefix = `${basePath}/api`;
const legacyAnalyticsPath = `${basePath}/legacy-analytics`;
const legacyAnalyticsRedirectPaths = new Set([
  "/analytics",
  "/analytics/",
  "/analytics-dashboard",
  "/analytics-dashboard/",
  "/legacy-analytics",
  "/legacy-analytics/",
  legacyAnalyticsPath,
  `${legacyAnalyticsPath}/`,
]);
const canonicalAnalyticsUrl = "https://nakama.intelli-verse-x.ai/analytics.html";
const port = Number(process.env.PORT ?? process.env.ADMIN_DASHBOARD_PORT ?? 8080);
const nakamaBaseUrl = stripTrailingSlash(process.env.NAKAMA_BASE_URL ?? "http://intelliverse-nakama:7350");
const nakamaHttpKey = process.env.NAKAMA_HTTP_KEY ?? "";
const consoleAuth = process.env.NAKAMA_CONSOLE_BASIC_AUTH
  ?? buildBasicAuth(process.env.NAKAMA_CONSOLE_USERNAME, process.env.NAKAMA_CONSOLE_PASSWORD);

// ── LiveOps copilot (POST {apiPrefix}/chat) ─────────────────────────────────
// LiteLLM (OpenAI-compatible) + tools discovered per-request from the
// admin-mcp JSON-RPC gateway. All values optional: with no LiteLLM key the
// route 503s, with no admin-mcp env the copilot degrades to a no-tools chat.
const litellmBaseUrl = stripTrailingSlash(process.env.LITELLM_BASE_URL ?? "https://litellm.intelli-verse-x.ai");
const litellmKey = process.env.LITELLM_NAKAMA_CHAT_KEY ?? process.env.LITELLM_ADMIN_CHAT_KEY ?? "";
const adminMcpUrl = process.env.ADMIN_MCP_URL ?? "";
const adminMcpToken = process.env.ADMIN_MCP_TOKEN ?? "";

// Cross-origin allowlist for the chat route only: the legacy analytics
// dashboard (served from nakama.intelli-verse-x.ai) embeds a copilot dock that
// calls this endpoint directly. Same-origin requests are always allowed.
const chatCorsAllowlist = new Set([
  "https://nakama.intelli-verse-x.ai",
  ...(process.env.CHAT_CORS_EXTRA_ORIGINS ?? "")
    .split(",")
    .map((o) => stripTrailingSlash(o.trim()))
    .filter(Boolean),
]);

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function normalizePrefix(value) {
  const prefixed = value.startsWith("/") ? value : `/${value}`;
  return prefixed.endsWith("/") ? prefixed.slice(0, -1) : prefixed;
}

function stripTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function buildBasicAuth(username, password) {
  if (!username || !password) return "";
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(text);
}

function sendText(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 1024 * 1024) {
      throw new Error("Request body too large");
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function isSafePath(base, candidate) {
  const rel = relative(base, candidate);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function getBearerToken(req) {
  const header = req.headers.authorization ?? "";
  const prefix = "Bearer ";
  return header.startsWith(prefix) ? header.slice(prefix.length).trim() : "";
}

function decodeTokenRole(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return payload?.role ?? payload?.vars?.role ?? payload?.vrs?.role ?? "admin";
  } catch {
    return "admin";
  }
}

function classifyRpcAccess(rpcId) {
  if (/(_set|_delete|_grant|_reset|_toggle|_schedule|_setup|_broadcast|_send|_update|_import|_invalidate|define|set_alert)$/i.test(rpcId)) {
    return "liveops_write";
  }
  if (/wallet|inventory|mailbox|account|storage|gift|player/i.test(rpcId) && /(grant|reset|send|delete|update|set)/i.test(rpcId)) {
    return "admin_write";
  }
  if (/analytics|intelligence|metrics|taxonomy|cohort|retention|health|events_timeline/i.test(rpcId)) {
    return "analytics_read";
  }
  return "liveops_read";
}

function roleCanAccess(role, access) {
  const normalized = String(role ?? "viewer").toLowerCase();
  if (normalized === "admin") return true;
  if (normalized === "liveops" || normalized === "liveops_operator" || normalized === "operator") {
    return access !== "admin_write";
  }
  if (normalized === "analyst") {
    return access === "analytics_read" || access === "liveops_read";
  }
  return access === "analytics_read" || access === "liveops_read";
}

async function fetchNakamaRpc(rpcId, payload, auth) {
  const params = new URLSearchParams();
  const headers = { "Content-Type": "application/json" };
  let body;

  if (auth.type === "http-key") {
    if (!nakamaHttpKey) {
      return { ok: false, status: 503, body: { success: false, error: "Nakama HTTP key is not configured on the dashboard proxy" } };
    }
    params.set("http_key", nakamaHttpKey);
    params.set("unwrap", "true");
    body = JSON.stringify(payload ?? {});
  } else {
    headers.Authorization = `Bearer ${auth.token}`;
    body = JSON.stringify(JSON.stringify(payload ?? {}));
  }

  const qs = params.toString();
  const response = await fetch(`${nakamaBaseUrl}/v2/rpc/${encodeURIComponent(rpcId)}${qs ? `?${qs}` : ""}`, {
    method: "POST",
    headers,
    body,
  });
  const responseText = await response.text();
  let parsed = null;
  try {
    parsed = responseText ? JSON.parse(responseText) : null;
  } catch {
    parsed = responseText;
  }
  return { ok: response.ok, status: response.status, body: parsed };
}

async function validateAdminToken(token) {
  if (!token) return false;
  const result = await fetchNakamaRpc("admin_health_check", {}, { type: "bearer", token });
  if (!result.ok || !result.body || result.body.success === false) return false;
  return {
    role: decodeTokenRole(token),
  };
}

async function handleLogin(req, res) {
  const body = await readJson(req);
  const result = await fetchNakamaRpc(
    "admin_login",
    { username: body.username, password: body.password },
    { type: "http-key" },
  );
  if (!result.ok || !result.body || result.body.success === false) {
    sendJson(res, result.status || 401, result.body ?? { success: false, error: "Login failed" });
    return;
  }
  sendJson(res, 200, result.body);
}

// ── Copilot chat route ──────────────────────────────────────────────────────

// The ai / @ai-sdk/openai-compatible packages are regular deps of this
// package (resolved by walking up from server/ to the package node_modules,
// or /app/node_modules in the Docker image). Loaded lazily so a deployment
// that never installed them still serves the SPA — the chat route alone 503s.
let aiSdkPromise = null;
function loadAiSdk() {
  aiSdkPromise ??= Promise.all([import("ai"), import("@ai-sdk/openai-compatible")])
    .then(([ai, compat]) => ({
      streamText: ai.streamText,
      convertToModelMessages: ai.convertToModelMessages,
      stepCountIs: ai.stepCountIs,
      tool: ai.tool,
      jsonSchema: ai.jsonSchema,
      createOpenAICompatible: compat.createOpenAICompatible,
    }))
    .catch((error) => {
      aiSdkPromise = null;
      throw error;
    });
  return aiSdkPromise;
}

function chatCorsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin) return {}; // same-origin / curl — no CORS negotiation needed
  const host = req.headers.host ?? "";
  const normalized = stripTrailingSlash(origin);
  let sameOrigin = false;
  try {
    sameOrigin = new URL(origin).host === host;
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin && !chatCorsAllowlist.has(normalized)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

async function mcpRpc(method, params) {
  const response = await fetch(adminMcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(adminMcpToken ? { Authorization: `Bearer ${adminMcpToken}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`admin-mcp ${method} -> HTTP ${response.status}`);
  const json = await response.json();
  if (json.error) throw new Error(json.error.message ?? "admin-mcp error");
  return json.result;
}

// Tool list rarely changes — cache across requests for 5 minutes.
let mcpToolCache = null;

async function loadMcpToolSpecs() {
  if (!adminMcpUrl) return [];
  if (mcpToolCache && Date.now() - mcpToolCache.at < 5 * 60_000) return mcpToolCache.specs;
  const result = await mcpRpc("tools/list");
  const specs = Array.isArray(result?.tools) ? result.tools : [];
  // Game-ops first: the model reads the catalog top-down, so nakama tools
  // lead; the rest of the admin fleet stays available after them.
  const nakamaScore = (name) =>
    /nakama|quizverse|lasttolive|analytics|hiro|satori/i.test(name ?? "") ? 0 : 1;
  specs.sort((a, b) => nakamaScore(a.name) - nakamaScore(b.name) || a.name.localeCompare(b.name));
  mcpToolCache = { specs, at: Date.now() };
  return specs;
}

const TOOL_OUTPUT_CAP = 12_000;

function buildMcpTools(sdk, specs, confirmations = []) {
  const tools = {};
  for (const spec of specs) {
    if (!spec?.name) continue;
    tools[spec.name] = sdk.tool({
      description: spec.description ?? "",
      inputSchema: sdk.jsonSchema(spec.inputSchema ?? { type: "object", properties: {} }),
      execute: async (args) => {
        // Server-enforced write gate: a write-classified tool only executes
        // when the request body carried a valid confirmation token for it.
        // The model cannot set request-body fields — only the client UI's
        // Confirm button can — so the model cannot self-approve writes.
        let callArgs = args ?? {};
        if (classifyToolAccess(spec.name, callArgs) === "write") {
          let approved = null;
          for (const token of confirmations) {
            const verdict = verifyConfirmToken(token, spec.name);
            if (verdict.ok) {
              approved = verdict;
              break;
            }
          }
          if (!approved) return confirmationRequiredResult(spec.name, callArgs);
          // Execute the EXACT approved args, not the model's re-issued args.
          callArgs = approved.args;
        }
        try {
          const result = await mcpRpc("tools/call", { name: spec.name, arguments: callArgs });
          const text = Array.isArray(result?.content)
            ? result.content.map((c) => c?.text ?? "").join("\n")
            : JSON.stringify(result ?? null);
          // Keep tool payloads bounded so cheap models don't blow their context.
          return text.length <= TOOL_OUTPUT_CAP ? text : `${text.slice(0, TOOL_OUTPUT_CAP)}\n…(truncated)`;
        } catch (error) {
          return `Tool error: ${error instanceof Error ? error.message : String(error)}`;
        }
      },
    });
  }
  return tools;
}

const COPILOT_MODEL_IDS = new Set(COPILOT_MODELS.map((m) => m.id));
const CHAT_MAX_MESSAGES = 80;
const CHAT_MAX_SYSTEM_CHARS = 8_000;
const CHAT_MAX_CONFIRMATIONS = 20;
const CHAT_MAX_CONFIRMATION_CHARS = 8_192;

function validateChatBody(body) {
  if (!body || typeof body !== "object") return "invalid JSON body";
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return "messages must be a non-empty array";
  }
  if (body.messages.length > CHAT_MAX_MESSAGES) {
    return `messages array too long (max ${CHAT_MAX_MESSAGES})`;
  }
  if (body.model !== undefined && typeof body.model !== "string") return "model must be a string";
  if (body.skillId !== undefined && body.skillId !== null && typeof body.skillId !== "string") {
    return "skillId must be a string";
  }
  if (body.system !== undefined && body.system !== null && typeof body.system !== "string") {
    return "system must be a string";
  }
  if (typeof body.system === "string" && body.system.length > CHAT_MAX_SYSTEM_CHARS) {
    return `system prompt too long (max ${CHAT_MAX_SYSTEM_CHARS} chars)`;
  }
  if (body.confirmations !== undefined) {
    if (!Array.isArray(body.confirmations)) return "confirmations must be an array of strings";
    if (body.confirmations.length > CHAT_MAX_CONFIRMATIONS) {
      return `confirmations array too long (max ${CHAT_MAX_CONFIRMATIONS})`;
    }
    for (const token of body.confirmations) {
      if (typeof token !== "string") return "confirmations must be an array of strings";
      if (token.length > CHAT_MAX_CONFIRMATION_CHARS) {
        return `confirmation token too long (max ${CHAT_MAX_CONFIRMATION_CHARS} chars)`;
      }
    }
  }
  return null;
}

async function handleChatPreflight(req, res) {
  const cors = chatCorsHeaders(req);
  if (cors === null) {
    sendJson(res, 403, { success: false, error: "origin not allowed" });
    return;
  }
  res.writeHead(204, cors);
  res.end();
}

async function handleChat(req, res, url) {
  const cors = chatCorsHeaders(req);
  if (cors === null) {
    sendJson(res, 403, { success: false, error: "origin not allowed" });
    return;
  }
  // Errors before streaming starts still need the CORS headers, otherwise the
  // analytics dock can't even read the status code.
  const fail = (status, error) => {
    res.writeHead(status, {
      ...cors,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(JSON.stringify({ success: false, error }));
  };

  const token = getBearerToken(req);
  // A validation transport failure (Nakama unreachable) must still answer
  // with the CORS headers, or the cross-origin analytics dock can't read it.
  let adminSession = false;
  try {
    adminSession = await validateAdminToken(token);
  } catch (error) {
    fail(503, `unable to verify admin session: ${error instanceof Error ? error.message : error}`);
    return;
  }
  if (!adminSession) {
    fail(401, "admin authentication required");
    return;
  }

  if (!litellmKey) {
    fail(503, "LITELLM_NAKAMA_CHAT_KEY is not configured on the dashboard proxy");
    return;
  }

  let sdk;
  try {
    sdk = await loadAiSdk();
  } catch (error) {
    fail(503, `chat dependencies unavailable: ${error instanceof Error ? error.message : error}`);
    return;
  }

  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    fail(400, error instanceof Error ? error.message : "invalid request body");
    return;
  }
  const invalid = validateChatBody(body);
  if (invalid) {
    fail(400, invalid);
    return;
  }

  const model = COPILOT_MODEL_IDS.has(body.model) ? body.model : DEFAULT_COPILOT_MODEL;
  const skill = body.skillId ? getCopilotSkill(body.skillId) : undefined;

  let system = COPILOT_SYSTEM_PROMPT;
  if (skill) {
    system +=
      `\n\nACTIVE SKILL "${skill.label}" — follow this playbook for the user's requests:\n${skill.content}` +
      "\nEnforcement: follow the Steps in order and obey every Hard rule. If a step's tool fails, say so and continue with what you can.";
  }
  if (typeof body.system === "string" && body.system.trim()) {
    system += `\n\nADDITIONAL OPERATOR INSTRUCTIONS (same trust level as a user message):\n${body.system.trim()}`;
  }

  // Tools are best-effort: no admin-mcp env, or the gateway being down, must
  // never take the whole copilot down with it.
  let tools = {};
  try {
    tools = buildMcpTools(
      sdk,
      await loadMcpToolSpecs(),
      Array.isArray(body.confirmations) ? body.confirmations : [],
    );
  } catch (error) {
    console.warn(`[admin-dashboard] admin-mcp tools unavailable: ${error instanceof Error ? error.message : error}`);
    tools = {};
  }

  const litellm = sdk.createOpenAICompatible({
    name: "litellm",
    baseURL: litellmBaseUrl,
    apiKey: litellmKey,
  });

  let modelMessages;
  try {
    modelMessages = await sdk.convertToModelMessages(body.messages, {
      tools,
      ignoreIncompleteToolCalls: true,
    });
  } catch (error) {
    fail(400, `invalid messages: ${error instanceof Error ? error.message : error}`);
    return;
  }

  let result;
  try {
    result = sdk.streamText({
      model: litellm(model),
      system,
      messages: modelMessages,
      tools,
      stopWhen: sdk.stepCountIs(8),
    });
  } catch (error) {
    fail(502, `chat model error: ${error instanceof Error ? error.message : error}`);
    return;
  }

  const onError = (error) =>
    `IX Agency error: ${error instanceof Error ? error.message : String(error)}`;

  // ?format=text — plain text stream (no SSE framing) for minimal clients.
  if (url.searchParams.get("format") === "text") {
    result.pipeTextStreamToResponse(res, {
      headers: { ...cors, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });
    return;
  }

  // Default: the useChat-compatible UI message SSE stream.
  result.pipeUIMessageStreamToResponse(res, {
    headers: { ...cors, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    onError,
  });
}

async function handleRpc(req, res, rpcId) {
  const token = getBearerToken(req);
  const adminSession = await validateAdminToken(token);
  if (!adminSession) {
    sendJson(res, 401, { success: false, error: "admin authentication required" });
    return;
  }
  const access = classifyRpcAccess(rpcId);
  if (!roleCanAccess(adminSession.role, access)) {
    sendJson(res, 403, { success: false, error: `role '${adminSession.role}' cannot perform ${access}` });
    return;
  }

  const payload = await readJson(req);
  // The proxy has already verified the admin bearer token. Forward privileged
  // dashboard RPCs with the server-side HTTP key so Nakama runtime admin RPCs
  // see a trusted server-to-server context instead of a player context.
  const result = await fetchNakamaRpc(rpcId, payload, { type: "http-key" });
  sendJson(res, result.status, result.body);
}

async function handleHttpProxy(req, res, url) {
  const token = getBearerToken(req);
  const adminSession = await validateAdminToken(token);
  if (!adminSession) {
    sendJson(res, 401, { success: false, error: "admin authentication required" });
    return;
  }
  if (req.method !== "GET" && !roleCanAccess(adminSession.role, "admin_write")) {
    sendJson(res, 403, { success: false, error: `role '${adminSession.role}' cannot proxy Nakama console writes` });
    return;
  }
  if (!consoleAuth) {
    sendJson(res, 503, { success: false, error: "Nakama console auth is not configured on the dashboard proxy" });
    return;
  }

  const targetPath = url.pathname.slice(`${apiPrefix}/http`.length) || "/";
  const target = `${nakamaBaseUrl}${targetPath}${url.search}`;
  const headers = {
    Authorization: consoleAuth,
    "Content-Type": req.headers["content-type"] ?? "application/json",
  };
  const response = await fetch(target, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : await rawBody(req),
  });
  const responseBody = await response.arrayBuffer();
  res.writeHead(response.status, {
    "Content-Type": response.headers.get("content-type") ?? "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(Buffer.from(responseBody));
}

async function rawBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 1024 * 1024) {
      throw new Error("Request body too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function serveStatic(req, res, url) {
  if (url.pathname === "/healthz") {
    sendText(res, 200, "ok\n");
    return;
  }

  if (url.pathname === basePath) {
    res.writeHead(301, { Location: `${basePath}/` });
    res.end();
    return;
  }

  if (
    legacyAnalyticsRedirectPaths.has(url.pathname)
    || url.pathname.startsWith(`${legacyAnalyticsPath}/`)
    || url.pathname.startsWith("/legacy-analytics/")
    || url.pathname.startsWith("/analytics-dashboard/")
  ) {
    res.writeHead(308, {
      Location: canonicalAnalyticsUrl,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end();
    return;
  }

  if (!url.pathname.startsWith(`${basePath}/`)) {
    sendText(res, 404, "not found\n");
    return;
  }

  let relativePath;
  try {
    relativePath = decodeURIComponent(url.pathname.slice(basePath.length + 1));
  } catch {
    sendText(res, 400, "bad request\n");
    return;
  }
  const candidate = resolve(distDir, relativePath || "index.html");
  const safeCandidate = isSafePath(distDir, candidate) ? candidate : join(distDir, "index.html");
  let filePath = join(distDir, "index.html");
  if (existsSync(safeCandidate)) {
    const stat = statSync(safeCandidate);
    if (stat.isFile()) {
      filePath = safeCandidate;
    } else if (stat.isDirectory()) {
      const indexCandidate = join(safeCandidate, "index.html");
      if (isSafePath(distDir, indexCandidate) && existsSync(indexCandidate) && statSync(indexCandidate).isFile()) {
        filePath = indexCandidate;
      }
    }
  }

  const ext = extname(filePath);
  res.writeHead(200, {
    "Content-Type": mimeTypes[ext] ?? "application/octet-stream",
    "Cache-Control": ext === ".html" ? "no-cache, must-revalidate" : "public, max-age=31536000, immutable",
    // Allow embedding from the IntelliVerse admin hub and local dev.
    // CSP frame-ancestors supersedes X-Frame-Options; we clear the old header.
    "Content-Security-Policy": "frame-ancestors 'self' https://admin.intelli-verse-x.ai http://localhost:3000",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  });
  createReadStream(filePath).pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === `${apiPrefix}/login` && req.method === "POST") {
      await handleLogin(req, res);
      return;
    }
    if (url.pathname === `${apiPrefix}/chat`) {
      if (req.method === "OPTIONS") {
        await handleChatPreflight(req, res);
        return;
      }
      if (req.method === "POST") {
        await handleChat(req, res, url);
        return;
      }
      sendJson(res, 405, { success: false, error: "method not allowed" });
      return;
    }
    if (url.pathname.startsWith(`${apiPrefix}/rpc/`) && req.method === "POST") {
      await handleRpc(req, res, decodeURIComponent(url.pathname.slice(`${apiPrefix}/rpc/`.length)));
      return;
    }
    if (url.pathname.startsWith(`${apiPrefix}/http/`)) {
      await handleHttpProxy(req, res, url);
      return;
    }

    serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, 500, {
      success: false,
      error: error instanceof Error ? error.message : "dashboard proxy error",
    });
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`[admin-dashboard] listening on ${port}, serving ${distDir}, Nakama ${nakamaBaseUrl}`);
});
