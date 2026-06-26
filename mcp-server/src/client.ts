export interface NakamaConfig {
  consoleUrl: string;
  apiUrl: string;
  consoleUser: string;
  consolePassword: string;
  httpKey: string;
  // Analytics dashboard admin (admin_login RPC). Distinct from the Nakama
  // console user above — these are the ADMIN_USERNAME / ADMIN_PASSWORD the
  // analytics_admin.js module checks. Required for the strict-admin analytics
  // RPCs (analytics_health, analytics_retention_curves, etc.) that reject
  // plain http_key calls.
  adminUser: string;
  adminPassword: string;
}

export function loadConfig(): NakamaConfig {
  return {
    consoleUrl: process.env.NAKAMA_CONSOLE_URL || "http://localhost:7351",
    apiUrl: process.env.NAKAMA_API_URL || "http://localhost:7350",
    consoleUser: process.env.NAKAMA_CONSOLE_USER || "admin",
    consolePassword: process.env.NAKAMA_CONSOLE_PASSWORD || "password",
    httpKey: process.env.NAKAMA_HTTP_KEY || "defaulthttpkey",
    adminUser: process.env.NAKAMA_ADMIN_USER || "",
    adminPassword: process.env.NAKAMA_ADMIN_PASSWORD || "",
  };
}

export class NakamaConsoleClient {
  private baseUrl: string;
  private authHeader: string;

  constructor(config: NakamaConfig) {
    this.baseUrl = config.consoleUrl.replace(/\/$/, "");
    this.authHeader =
      "Basic " +
      Buffer.from(`${config.consoleUser}:${config.consolePassword}`).toString(
        "base64"
      );
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const opts: RequestInit = {
      method,
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "application/json",
      },
    };
    if (body !== undefined) {
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Console API ${method} ${path} → ${res.status}: ${text}`);
    }
    const text = await res.text();
    return text ? (JSON.parse(text) as T) : ({} as T);
  }

  async get<T = unknown>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  async put<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("PUT", path, body);
  }

  async del<T = unknown>(path: string): Promise<T> {
    return this.request<T>("DELETE", path);
  }

  // --- Account APIs ---

  async getStatus() {
    return this.get("/v2/console/status");
  }

  async listAccounts(params?: {
    filter?: string;
    cursor?: string;
    limit?: number;
  }) {
    const qs = new URLSearchParams();
    if (params?.filter) qs.set("filter", params.filter);
    if (params?.cursor) qs.set("cursor", params.cursor);
    if (params?.limit) qs.set("limit", String(params.limit));
    const q = qs.toString();
    return this.get(`/v2/console/account${q ? "?" + q : ""}`);
  }

  async getAccount(id: string) {
    return this.get(`/v2/console/account/${id}`);
  }

  async exportAccount(id: string) {
    return this.get(`/v2/console/account/${id}/export`);
  }

  async updateAccount(id: string, body: Record<string, unknown>) {
    return this.post(`/v2/console/account/${id}`, body);
  }

  async banAccount(id: string) {
    return this.post(`/v2/console/account/${id}/ban`);
  }

  async unbanAccount(id: string) {
    return this.post(`/v2/console/account/${id}/unban`);
  }

  async getWalletLedger(
    id: string,
    params?: { limit?: number; cursor?: string }
  ) {
    const qs = new URLSearchParams();
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.cursor) qs.set("cursor", params.cursor);
    const q = qs.toString();
    return this.get(`/v2/console/account/${id}/wallet${q ? "?" + q : ""}`);
  }

  async getFriends(id: string) {
    return this.get(`/v2/console/account/${id}/friend`);
  }

  async getGroups(id: string) {
    return this.get(`/v2/console/account/${id}/group`);
  }

  // --- Notification APIs ---

  async listNotifications(params?: {
    user_id?: string;
    limit?: number;
    cursor?: string;
  }) {
    const qs = new URLSearchParams();
    if (params?.user_id) qs.set("user_id", params.user_id);
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.cursor) qs.set("cursor", params.cursor);
    const q = qs.toString();
    return this.get(`/v2/console/notification${q ? "?" + q : ""}`);
  }

  async sendNotification(body: {
    user_id: string;
    subject: string;
    content: string;
    code: number;
    sender_id?: string;
    persistent?: boolean;
  }) {
    return this.post("/v2/console/notification", body);
  }

  // --- Storage APIs ---

  async listStorageCollections() {
    return this.get("/v2/console/storage");
  }

  async listStorage(params?: {
    collection?: string;
    key?: string;
    user_id?: string;
    cursor?: string;
    limit?: number;
  }) {
    const qs = new URLSearchParams();
    if (params?.collection) qs.set("collection", params.collection);
    if (params?.key) qs.set("key", params.key);
    if (params?.user_id) qs.set("user_id", params.user_id);
    if (params?.cursor) qs.set("cursor", params.cursor);
    if (params?.limit) qs.set("limit", String(params.limit));
    const q = qs.toString();
    return this.get(`/v2/console/storage${q ? "?" + q : ""}`);
  }

  async getStorageObject(
    collection: string,
    key: string,
    userId: string
  ) {
    return this.get(
      `/v2/console/storage/${encodeURIComponent(collection)}/${encodeURIComponent(key)}/${encodeURIComponent(userId)}`
    );
  }

  async deleteStorageObject(
    collection: string,
    key: string,
    userId: string,
    version: string
  ) {
    const qs = new URLSearchParams({ version });
    return this.del(
      `/v2/console/storage/${encodeURIComponent(collection)}/${encodeURIComponent(key)}/${encodeURIComponent(userId)}?${qs}`
    );
  }

  // --- Leaderboard APIs ---

  async listLeaderboards(params?: { cursor?: string; limit?: number }) {
    const qs = new URLSearchParams();
    if (params?.cursor) qs.set("cursor", params.cursor);
    if (params?.limit) qs.set("limit", String(params.limit));
    const q = qs.toString();
    return this.get(`/v2/console/leaderboard${q ? "?" + q : ""}`);
  }

  async getLeaderboard(id: string) {
    return this.get(`/v2/console/leaderboard/${encodeURIComponent(id)}`);
  }

  async listLeaderboardRecords(
    id: string,
    params?: { limit?: number; cursor?: string; owner_ids?: string[] }
  ) {
    const qs = new URLSearchParams();
    qs.set("leaderboard_id", id);
    if (params?.limit) qs.set("limit", String(params.limit));
    if (params?.cursor) qs.set("cursor", params.cursor);
    if (params?.owner_ids) {
      for (const oid of params.owner_ids) qs.append("owner_ids", oid);
    }
    return this.get(`/v2/console/leaderboard/${encodeURIComponent(id)}/records?${qs}`);
  }

  async deleteLeaderboard(id: string) {
    return this.del(`/v2/console/leaderboard/${encodeURIComponent(id)}`);
  }

  async deleteLeaderboardRecord(
    id: string,
    ownerId: string
  ) {
    return this.del(
      `/v2/console/leaderboard/${encodeURIComponent(id)}/owner/${encodeURIComponent(ownerId)}`
    );
  }

  // --- API Explorer ---

  async listApiEndpoints() {
    return this.get("/v2/console/api/endpoints");
  }

  async callRpcFromConsole(rpcId: string, body: string) {
    return this.post("/v2/console/api/endpoints/rpc", {
      method: rpcId,
      body,
    });
  }
}

export class NakamaApiClient {
  private baseUrl: string;
  private httpKey: string;
  private adminUser: string;
  private adminPassword: string;
  private adminToken: string | null = null;
  private adminTokenExpiresAt = 0;

  constructor(config: NakamaConfig) {
    this.baseUrl = config.apiUrl.replace(/\/$/, "");
    this.httpKey = config.httpKey;
    this.adminUser = config.adminUser;
    this.adminPassword = config.adminPassword;
  }

  async callRpc(rpcId: string, payload: unknown = {}): Promise<unknown> {
    const url = `${this.baseUrl}/v2/rpc/${encodeURIComponent(rpcId)}?unwrap&http_key=${encodeURIComponent(this.httpKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`RPC ${rpcId} → ${res.status}: ${text}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }

  /**
   * Authenticate against the analytics admin (admin_login RPC) and cache the
   * returned admin session token. Mirrors the analytics.html dashboard flow:
   * POST admin_login with the http_key, parse {success, token, expiresAt}.
   */
  async adminLogin(force = false): Promise<string> {
    if (!force && this.adminToken && Date.now() < this.adminTokenExpiresAt - 60_000) {
      return this.adminToken;
    }
    if (!this.adminUser || !this.adminPassword) {
      throw new Error(
        "admin_login requires NAKAMA_ADMIN_USER and NAKAMA_ADMIN_PASSWORD to be set in the MCP env."
      );
    }
    const url = `${this.baseUrl}/v2/rpc/admin_login?unwrap&http_key=${encodeURIComponent(this.httpKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: this.adminUser, password: this.adminPassword }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`admin_login → ${res.status}: ${text}`);
    }
    const data = JSON.parse((await res.text()) || "{}");
    if (!data.success || !data.token) {
      throw new Error(`admin_login failed: ${data.error || "no token returned"}`);
    }
    this.adminToken = data.token as string;
    // expiresAt may be a unix-seconds number or ISO string; fall back to 11h.
    const exp = data.expiresAt;
    this.adminTokenExpiresAt =
      typeof exp === "number"
        ? (exp > 1e12 ? exp : exp * 1000)
        : exp
          ? new Date(exp).getTime()
          : Date.now() + 11 * 60 * 60 * 1000;
    return this.adminToken;
  }

  /**
   * Call an admin-gated analytics RPC using a Bearer admin session token.
   * Works for every dashboard RPC (both http_key-trusted and strict-admin
   * ones like analytics_health / analytics_retention_curves). Auto-logs-in,
   * and retries once on a 401/403 (expired token).
   */
  async callAdminRpc(rpcId: string, payload: unknown = {}): Promise<any> {
    const doCall = async (token: string) => {
      const url = `${this.baseUrl}/v2/rpc/${encodeURIComponent(rpcId)}?unwrap`;
      return fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      });
    };

    let token = await this.adminLogin();
    let res = await doCall(token);
    if (res.status === 401 || res.status === 403) {
      token = await this.adminLogin(true);
      res = await doCall(token);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`RPC ${rpcId} → ${res.status}: ${text}`);
    }
    const text = await res.text();
    if (!text) return {};
    const data = JSON.parse(text);
    // With ?unwrap Nakama returns the raw RPC string; some RPCs still nest it
    // under {payload:"..."} when called token-auth'd — unwrap that too.
    if (data && typeof data === "object" && typeof data.payload === "string") {
      try {
        return JSON.parse(data.payload);
      } catch {
        return data;
      }
    }
    return data;
  }
}
