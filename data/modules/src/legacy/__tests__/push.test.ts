// __tests__/push.test.ts
// ─────────────────────────────────────────────────────────────────────────────
// Offline tests for the push notification RPCs in src/legacy/push.ts.
//
// Same shape as src/recorder/__tests__/recorder_asr.test.ts — no Jest, no
// Mocha, because the file has to compile against the production tsconfig which
// carries no test-runner types. `PushTests.runAll()` returns
// { passed, failed, errors, total }; see ./run.js for the harness.
//
// The handlers are not exported. They are reached the way Nakama reaches them:
// LegacyPush.register() is handed a fake initializer that records every
// registerRpc(name, fn) pair, so the tests also pin the registered RPC names.
//
// The mock `nk` is deliberately faithful in the three ways that have teeth:
//
//   * storageRead OMITS misses rather than returning a null-valued entry;
//   * storageWrite ENFORCES the `version` precondition, so an optimistic
//     -concurrency bug shows up as a lost row rather than passing silently;
//   * storage rows carry their read/write permissions, so a client-writable
//     row is observable.
//
// Coverage
//   1. push_send_event   — authorization (the phishing hole)
//   2. push_get_endpoints — authorization (the IDOR)
//   3. push_register_token — the server-side age gate
//   4. push_tokens storage — server-only write permission
//   5. push_register_token — version-checked writes, no lost update
//   6. push_register_token — per-user pending markers, not one global array
//   7. push_register_token — per-account token cap and eviction
//   8. ghost pruning must not destroy an in-flight registration
//   9. no provider URL configured — refuse rather than fall back

namespace PushTests {

  // ── Micro test runner ─────────────────────────────────────────────────────

  interface TestCase { suite: string; name: string; fn: () => void; }

  var allTests: TestCase[] = [];
  var currentSuite = "(root)";

  function describe(suite: string, fn: () => void): void {
    var prev = currentSuite;
    currentSuite = suite;
    try { fn(); } finally { currentSuite = prev; }
  }

  function it(name: string, fn: () => void): void {
    allTests.push({ suite: currentSuite, name: name, fn: fn });
  }

  function fmt(v: any): string {
    try { return JSON.stringify(v); } catch (_e: any) { return String(v); }
  }

  function expectEq(actual: any, expected: any, msg?: string): void {
    if (actual !== expected) {
      throw new Error((msg ? msg + " — " : "") + "expected " + fmt(expected) + " got " + fmt(actual));
    }
  }

  function expectTrue(actual: any, msg?: string): void {
    if (actual !== true) throw new Error((msg ? msg + " — " : "") + "expected true, got " + fmt(actual));
  }

  function expectFalsy(actual: any, msg?: string): void {
    if (actual) throw new Error((msg ? msg + " — " : "") + "expected falsy, got " + fmt(actual));
  }

  // ── Mock Nakama ───────────────────────────────────────────────────────────

  var PUSH_TOKENS = "push_tokens";
  var PENDING_INDEX = "push_pending_index";
  var SYSTEM_USER = "00000000-0000-0000-0000-000000000000";

  interface Row {
    collection: string; key: string; userId: string; value: any;
    version: number; read: number; write: number;
  }

  interface MockNk {
    storageRead(reqs: any[]): any[];
    storageWrite(reqs: any[]): any[];
    storageDelete(reqs: any[]): void;
    storageList(userId: any, collection: string, limit: number, cursor: any): any;
    accountsGetId(ids: string[]): any[];
    usersGetId(ids: string[]): any[];
    notificationsSend(list: any[]): void;
    httpRequest(url: string, method: string, headers: any, body: string, timeoutMs: number): any;
    sqlQuery(q: string, params: any[]): any[];
    _rows: Row[];
    _http: any[];
    _notifications: any[];
    /** Accounts the mock knows about: userId → metadata. */
    _accounts: { [userId: string]: any };
    /** Endpoint ARN the register endpoint hands back; "" to fail the call. */
    _registerArn: string;
    /** HTTP status the register endpoint answers with. */
    _registerCode: number;
    /** Fires once, just before a storageWrite commits, so a test can inject a
     *  concurrent writer and produce a real version conflict. */
    _beforeWrite: ((req: any) => void) | null;
    _row(collection: string, key: string, userId: string): Row | null;
    _tokens(userId: string): any[];
  }

  function makeMockNk(): MockNk {
    var rows: Row[] = [];
    var http: any[] = [];
    var notifications: any[] = [];
    var arnSeq = 0;

    var nk: any = {
      _rows: rows,
      _http: http,
      _notifications: notifications,
      _accounts: {},
      _registerArn: "",
      _registerCode: 200,
      _beforeWrite: null,

      _row: function (collection: string, key: string, userId: string): Row | null {
        for (var i = 0; i < rows.length; i++) {
          var e = rows[i];
          if (e.collection === collection && e.key === key && e.userId === userId) return e;
        }
        return null;
      },

      _tokens: function (userId: string): any[] {
        var r = nk._row(PUSH_TOKENS, "token_" + userId, userId);
        return r && r.value && r.value.tokens ? r.value.tokens : [];
      },

      storageRead: function (reqs: any[]): any[] {
        var out: any[] = [];
        for (var i = 0; i < reqs.length; i++) {
          var r = reqs[i];
          var e = nk._row(r.collection, r.key, r.userId);
          if (!e) continue;   // misses are omitted, as in real Nakama
          out.push({
            collection: e.collection, key: e.key, userId: e.userId,
            // Deep copy: Nakama hands back a fresh object each read, and a
            // shared reference would hide mutate-without-write bugs.
            value: JSON.parse(JSON.stringify(e.value)),
            version: String(e.version),
            permissionRead: e.read, permissionWrite: e.write,
          });
        }
        return out;
      },

      storageWrite: function (reqs: any[]): any[] {
        for (var i = 0; i < reqs.length; i++) {
          var r = reqs[i];
          if (nk._beforeWrite) {
            var hook = nk._beforeWrite;
            nk._beforeWrite = null;   // one shot, or the injected write recurses
            hook(r);
          }
          var e = nk._row(r.collection, r.key, r.userId);
          // The version precondition, enforced. "*" means "must not exist".
          if (r.version !== undefined && r.version !== null) {
            if (r.version === "*") {
              if (e) throw new Error("storage write rejected: version check failed (object exists)");
            } else if (!e || String(e.version) !== String(r.version)) {
              throw new Error("storage write rejected: version check failed");
            }
          }
          if (e) {
            e.value = JSON.parse(JSON.stringify(r.value));
            e.version = e.version + 1;
            if (r.permissionRead !== undefined) e.read = r.permissionRead;
            if (r.permissionWrite !== undefined) e.write = r.permissionWrite;
          } else {
            rows.push({
              collection: r.collection, key: r.key, userId: r.userId,
              value: JSON.parse(JSON.stringify(r.value)),
              version: 1,
              read: r.permissionRead !== undefined ? r.permissionRead : 1,
              write: r.permissionWrite !== undefined ? r.permissionWrite : 1,
            });
          }
        }
        return [];
      },

      storageDelete: function (reqs: any[]): void {
        for (var i = 0; i < reqs.length; i++) {
          var r = reqs[i];
          for (var j = rows.length - 1; j >= 0; j--) {
            var e = rows[j];
            if (e.collection === r.collection && e.key === r.key && e.userId === r.userId) rows.splice(j, 1);
          }
        }
      },

      // `null`/undefined userId lists every owner, which is how the pending
      // scan reaches per-user rows. "" is rejected, as the real runtime does.
      storageList: function (userId: any, collection: string, limit: number, cursor: any): any {
        if (userId === "") throw new Error("expects empty or valid user id");
        var matching: Row[] = [];
        for (var i = 0; i < rows.length; i++) {
          var e = rows[i];
          if (e.collection !== collection) continue;
          if (userId !== null && userId !== undefined && e.userId !== userId) continue;
          matching.push(e);
        }
        matching.sort(function (x: Row, y: Row): number {
          if (x.userId !== y.userId) return x.userId < y.userId ? -1 : 1;
          return x.key < y.key ? -1 : (x.key > y.key ? 1 : 0);
        });
        var after = "" + (cursor || "");
        if (after.length > 0) {
          var start = 0;
          while (start < matching.length && (matching[start].userId + "/" + matching[start].key) <= after) start++;
          matching = matching.slice(start);
        }
        var objects: any[] = [];
        for (var j = 0; j < matching.length && objects.length < limit; j++) {
          objects.push({
            collection: matching[j].collection, key: matching[j].key, userId: matching[j].userId,
            value: JSON.parse(JSON.stringify(matching[j].value)),
          });
        }
        var last = objects.length > 0 ? objects[objects.length - 1] : null;
        var more = objects.length > 0 && matching.length > objects.length;
        return { objects: objects, cursor: more && last ? last.userId + "/" + last.key : "" };
      },

      accountsGetId: function (ids: string[]): any[] {
        var out: any[] = [];
        for (var i = 0; i < ids.length; i++) {
          var md = nk._accounts[ids[i]];
          if (md === undefined) continue;
          out.push({ user: { id: ids[i], metadata: md } });
        }
        return out;
      },

      usersGetId: function (ids: string[]): any[] {
        var out: any[] = [];
        for (var i = 0; i < ids.length; i++) {
          if (nk._accounts[ids[i]] === undefined) continue;
          out.push({ userId: ids[i] });
        }
        return out;
      },

      notificationsSend: function (list: any[]): void {
        for (var i = 0; i < list.length; i++) notifications.push(list[i]);
      },

      // Stands in for nakama-push-bridge. Same envelope the bridge returns.
      httpRequest: function (url: string, method: string, headers: any, body: string, timeoutMs: number): any {
        http.push({ url: url, method: method, headers: headers, body: JSON.parse(body || "{}"), timeoutMs: timeoutMs });
        if (("" + url).indexOf("/register") >= 0) {
          if (nk._registerCode !== 200) {
            return { code: nk._registerCode, headers: {}, body: JSON.stringify({ success: false, error: "forced failure" }) };
          }
          arnSeq++;
          var arn = nk._registerArn || ("arn:aws:sns:us-east-1:970547373533:endpoint/GCM/IntelliVerseX-Android/ep-" + arnSeq);
          return { code: 200, headers: {}, body: JSON.stringify({ success: true, endpointArn: arn }) };
        }
        return { code: 200, headers: {}, body: JSON.stringify({ success: true, messageId: "mid-" + http.length }) };
      },

      sqlQuery: function (_q: string, _params: any[]): any[] { return []; },
    };
    return nk as MockNk;
  }

  var ENV_OK: any = {
    PUSH_REGISTER_URL: "http://nakama-push-bridge.aicart.svc.cluster.local:8080/register",
    PUSH_SEND_URL: "http://nakama-push-bridge.aicart.svc.cluster.local:8080/send",
    DEFAULT_FCM_PROJECT_ID: "quiz-verse-4a475",
  };

  function ctxFor(userId: string, extraEnv?: any): any {
    var env: any = {};
    for (var k in ENV_OK) if (Object.prototype.hasOwnProperty.call(ENV_OK, k)) env[k] = ENV_OK[k];
    if (extraEnv) {
      for (var j in extraEnv) {
        if (!Object.prototype.hasOwnProperty.call(extraEnv, j)) continue;
        if (extraEnv[j] === null) delete env[j];   // null removes a var
        else env[j] = extraEnv[j];
      }
    }
    return { userId: userId, env: env };
  }

  function logger(): any {
    return {
      info: function (_m: string): void { },
      warn: function (_m: string): void { },
      error: function (_m: string): void { },
      debug: function (_m: string): void { },
    };
  }

  // ── Reaching the handlers the way Nakama does ─────────────────────────────

  var handlers: { [name: string]: any } = {};

  function loadHandlers(): void {
    if (handlers["push_register_token"]) return;
    var fakeInitializer: any = {
      registerRpc: function (name: string, fn: any): void { handlers[name] = fn; },
    };
    LegacyPush.register(fakeInitializer as nkruntime.Initializer);
  }

  function callRpc(name: string, ctx: any, nk: MockNk, payload: any): any {
    loadHandlers();
    var fn = handlers[name];
    if (!fn) throw new Error("RPC not registered: " + name);
    return JSON.parse(fn(ctx, logger(), nk as any, JSON.stringify(payload)));
  }

  // ── Fixtures ──────────────────────────────────────────────────────────────

  var USER_A = "11111111-1111-4111-8111-111111111111";
  var USER_B = "22222222-2222-4222-8222-222222222222";
  var ADMIN  = "33333333-3333-4333-8333-333333333333";

  /** An adult account with no dob_iso — the shape of every production account. */
  function plainAccount(nk: MockNk, userId: string): void {
    nk._accounts[userId] = { email: "u@example.com" };
  }

  function adminAccount(nk: MockNk, userId: string): void {
    nk._accounts[userId] = { admin: true };
  }

  function dobAccount(nk: MockNk, userId: string, yearsOld: number): void {
    var d = new Date();
    d.setUTCFullYear(d.getUTCFullYear() - yearsOld);
    d.setUTCDate(d.getUTCDate() - 1);   // safely past the birthday
    nk._accounts[userId] = { dob_iso: d.toISOString().substring(0, 10) };
  }

  function register(nk: MockNk, userId: string, token: string, extra?: any, extraEnv?: any): any {
    var body: any = { token: token, platform: "android", gameId: "quizverse" };
    if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) body[k] = extra[k];
    return callRpc("push_register_token", ctxFor(userId, extraEnv), nk, body);
  }

  /** A user who already owns a live, registered endpoint. */
  function seedRegisteredToken(nk: MockNk, userId: string, token: string, updatedAt?: number): void {
    var existing = nk._row(PUSH_TOKENS, "token_" + userId, userId);
    var tokens = existing && existing.value && existing.value.tokens ? existing.value.tokens : [];
    tokens.push({
      token: token, platform: "android",
      endpointArn: "arn:aws:sns:us-east-1:970547373533:endpoint/GCM/IntelliVerseX-Android/" + token,
      updatedAt: updatedAt !== undefined ? updatedAt : Math.floor(Date.now() / 1000),
      provider: "sns", providerRegisteredAt: Math.floor(Date.now() / 1000),
    });
    nk.storageWrite([{
      collection: PUSH_TOKENS, key: "token_" + userId, userId: userId,
      value: { tokens: tokens }, permissionRead: 1, permissionWrite: 0,
    }]);
  }

  // ── 1. push_send_event — authorization ────────────────────────────────────
  //
  // The hole this closes: the handler called no auth helper at all, so any
  // signed-in account could deliver an arbitrary title and body to any other
  // account, under this app's name and icon.

  describe("push_send_event — authorization", function (): void {

    it("refuses a signed-in caller targeting another account", function (): void {
      var nk = makeMockNk();
      plainAccount(nk, USER_A);
      plainAccount(nk, USER_B);
      seedRegisteredToken(nk, USER_B, "tokB");

      var resp = callRpc("push_send_event", ctxFor(USER_A), nk, {
        userId: USER_B, eventType: "phish", title: "Your account is locked", body: "Tap to verify",
      });

      expectEq(resp.success, false);
      expectEq(resp.code, "forbidden");
      expectEq(resp.http_status, 403);
      // Nothing may reach the device, and nothing may reach the inbox either.
      expectEq(nk._http.length, 0, "a refused send must not call the bridge");
      expectEq(nk._notifications.length, 0, "a refused send must not write an in-app notification");
    });

    it("allows a signed-in caller to push to itself", function (): void {
      var nk = makeMockNk();
      plainAccount(nk, USER_A);
      seedRegisteredToken(nk, USER_A, "tokA");

      var resp = callRpc("push_send_event", ctxFor(USER_A), nk, {
        userId: USER_A, eventType: "self_test", title: "Test", body: "Hello",
      });
      expectEq(resp.success, true);
      expectEq(resp.recipientCount, 1);
    });

    it("allows the server key (no ctx.userId) to push to anyone — the cron path", function (): void {
      var nk = makeMockNk();
      plainAccount(nk, USER_B);
      seedRegisteredToken(nk, USER_B, "tokB");

      var resp = callRpc("push_send_event", ctxFor(""), nk, {
        userId: USER_B, eventType: "daily_quiz", title: "New Daily Quiz", body: "Play now",
      });
      expectEq(resp.success, true);
      expectEq(resp.recipientCount, 1, "server-to-server fan-out must keep working");
    });

    it("allows an admin account to push to another user", function (): void {
      var nk = makeMockNk();
      adminAccount(nk, ADMIN);
      plainAccount(nk, USER_B);
      seedRegisteredToken(nk, USER_B, "tokB");

      var resp = callRpc("push_send_event", ctxFor(ADMIN), nk, {
        userId: USER_B, eventType: "ops", title: "Maintenance", body: "Back at 03:00",
      });
      expectEq(resp.success, true);
      expectEq(resp.recipientCount, 1);
    });

    it("does not let a non-admin claim admin by asserting it in the payload", function (): void {
      var nk = makeMockNk();
      plainAccount(nk, USER_A);
      plainAccount(nk, USER_B);
      seedRegisteredToken(nk, USER_B, "tokB");

      var resp = callRpc("push_send_event", ctxFor(USER_A), nk, {
        userId: USER_B, admin: true, isSystem: true, system: true, serverCall: true,
        title: "hi", body: "there",
      });
      expectEq(resp.http_status, 403, "trust must come from the context, never the payload");
      expectEq(nk._http.length, 0);
    });

    it("still requires a target user", function (): void {
      var nk = makeMockNk();
      var resp = callRpc("push_send_event", ctxFor(USER_A), nk, { title: "x", body: "y" });
      expectEq(resp.success, false);
      expectTrue(("" + resp.error).indexOf("userId") >= 0, resp.error);
    });
  });

  // ── 2. push_get_endpoints — authorization ─────────────────────────────────
  //
  // The hole this closes: `data.userId || userId` let any account read any
  // other account's SNS endpoint ARNs, and the ARN is the send capability.

  describe("push_get_endpoints — authorization", function (): void {

    it("refuses to read another account's endpoints", function (): void {
      var nk = makeMockNk();
      plainAccount(nk, USER_A);
      plainAccount(nk, USER_B);
      seedRegisteredToken(nk, USER_B, "tokB");

      var resp = callRpc("push_get_endpoints", ctxFor(USER_A), nk, { userId: USER_B });
      expectEq(resp.success, false);
      expectEq(resp.http_status, 403);
      expectEq(resp.endpoints, undefined, "no ARN may leak on the refused path");
    });

    it("returns the caller's own endpoints when no userId is passed", function (): void {
      // This is what the shipped Unity SDK sends: an empty payload.
      var nk = makeMockNk();
      plainAccount(nk, USER_A);
      seedRegisteredToken(nk, USER_A, "tokA");

      var resp = callRpc("push_get_endpoints", ctxFor(USER_A), nk, {});
      expectEq(resp.success, true);
      expectEq(resp.userId, USER_A);
      expectEq(resp.endpoints.length, 1);
    });

    it("allows a caller to name itself explicitly", function (): void {
      var nk = makeMockNk();
      plainAccount(nk, USER_A);
      seedRegisteredToken(nk, USER_A, "tokA");
      var resp = callRpc("push_get_endpoints", ctxFor(USER_A), nk, { userId: USER_A });
      expectEq(resp.success, true);
      expectEq(resp.endpoints.length, 1);
    });

    it("gives an admin the explicit cross-user path", function (): void {
      var nk = makeMockNk();
      adminAccount(nk, ADMIN);
      plainAccount(nk, USER_B);
      seedRegisteredToken(nk, USER_B, "tokB");
      var resp = callRpc("push_get_endpoints", ctxFor(ADMIN), nk, { userId: USER_B });
      expectEq(resp.success, true);
      expectEq(resp.userId, USER_B);
      expectEq(resp.endpoints.length, 1);
    });

    it("requires an explicit target for a server-key call", function (): void {
      var nk = makeMockNk();
      var resp = callRpc("push_get_endpoints", ctxFor(""), nk, {});
      expectEq(resp.success, false);
      expectTrue(("" + resp.error).indexOf("userId") >= 0, resp.error);
    });
  });

  // ── 3. push_register_token — the server-side age gate ─────────────────────

  describe("push_register_token — age gate", function (): void {

    it("refuses an account whose dob_iso is below the threshold", function (): void {
      var nk = makeMockNk();
      dobAccount(nk, USER_A, 11);

      var resp = register(nk, USER_A, "tok_child");
      expectEq(resp.success, false);
      expectEq(resp.code, "AGE_RESTRICTED");
      expectEq(resp.minAge, 13);
      expectEq(resp.ageBracket, "below_threshold");
      // A refused registration must leave nothing behind at all.
      expectEq(nk._tokens(USER_A).length, 0, "no token row may be stored for a refused minor");
      expectEq(nk._http.length, 0, "no SNS endpoint may be created for a refused minor");
      expectEq(nk._row(PENDING_INDEX, "pending", USER_A), null, "no retry marker either");
    });

    it("admits an account whose dob_iso is at or above the threshold", function (): void {
      var nk = makeMockNk();
      dobAccount(nk, USER_A, 30);
      var resp = register(nk, USER_A, "tok_adult");
      expectEq(resp.success, true);
      expectEq(nk._tokens(USER_A)[0].ageSource, "account_dob");
      expectEq(nk._tokens(USER_A)[0].ageBracket, "at_or_above_threshold");
    });

    it("refuses a client-declared below_threshold bracket", function (): void {
      var nk = makeMockNk();
      plainAccount(nk, USER_A);
      var resp = register(nk, USER_A, "tok_x", {
        age_assertion: { bracket: "below_threshold", min_age: 13 },
      });
      expectEq(resp.code, "AGE_RESTRICTED");
      expectEq(nk._tokens(USER_A).length, 0);
    });

    it("refuses an unanswered gate (bracket=unknown) — fails closed", function (): void {
      var nk = makeMockNk();
      plainAccount(nk, USER_A);
      var resp = register(nk, USER_A, "tok_x", { age_assertion: { bracket: "unknown" } });
      expectEq(resp.code, "AGE_RESTRICTED");
      expectEq(resp.ageBracket, "unknown");
      expectEq(nk._tokens(USER_A).length, 0);
    });

    it("treats an unrecognised bracket as unknown and refuses it", function (): void {
      var nk = makeMockNk();
      plainAccount(nk, USER_A);
      var resp = register(nk, USER_A, "tok_x", { age_assertion: { bracket: "probably_fine" } });
      expectEq(resp.code, "AGE_RESTRICTED");
    });

    it("admits a client-declared at_or_above_threshold bracket", function (): void {
      var nk = makeMockNk();
      plainAccount(nk, USER_A);
      var resp = register(nk, USER_A, "tok_ok", {
        age_assertion: { bracket: "at_or_above_threshold", min_age: 13 },
      });
      expectEq(resp.success, true);
      expectEq(nk._tokens(USER_A)[0].ageSource, "client");
    });

    it("trusts the account dob over a contradicting client assertion", function (): void {
      var nk = makeMockNk();
      dobAccount(nk, USER_A, 9);
      var resp = register(nk, USER_A, "tok_lie", {
        age_assertion: { bracket: "at_or_above_threshold", min_age: 13 },
      });
      expectEq(resp.code, "AGE_RESTRICTED", "a client claim must not override a real date of birth");
      expectEq(nk._tokens(USER_A).length, 0);
    });

    it("admits an absent declaration by default, and records it as absent", function (): void {
      // Deliberate: dob_iso is on 0 of 61,902 production accounts and no
      // shipped client sends age_assertion yet, so failing closed here would
      // refuse every registration in existence. See the block comment in
      // push.ts for the migration that lets this be closed.
      var nk = makeMockNk();
      plainAccount(nk, USER_A);
      var resp = register(nk, USER_A, "tok_absent");
      expectEq(resp.success, true, "the default must not break every existing user");
      var row = nk._tokens(USER_A)[0];
      expectEq(row.ageBracket, "absent");
      expectEq(row.ageSource, "absent", "the audit trail must not look like a claim that was made");
    });

    it("refuses an absent declaration when PUSH_REQUIRE_AGE_ASSERTION=1", function (): void {
      var nk = makeMockNk();
      plainAccount(nk, USER_A);
      var resp = register(nk, USER_A, "tok_absent", undefined, { PUSH_REQUIRE_AGE_ASSERTION: "1" });
      expectEq(resp.code, "AGE_RESTRICTED");
      expectEq(resp.ageBracket, "absent");
      expectEq(nk._tokens(USER_A).length, 0);
      expectEq(nk._http.length, 0);
    });

    it("honours a raised threshold from PUSH_AGE_THRESHOLD", function (): void {
      var nk = makeMockNk();
      dobAccount(nk, USER_A, 14);
      expectEq(register(nk, USER_A, "t1").success, true, "14 clears the default 13");
      var nk2 = makeMockNk();
      dobAccount(nk2, USER_A, 14);
      var resp = register(nk2, USER_A, "t2", undefined, { PUSH_AGE_THRESHOLD: "16" });
      expectEq(resp.code, "AGE_RESTRICTED", "14 must not clear a threshold of 16");
      expectEq(resp.minAge, 16);
    });
  });

  // ── 4. storage permissions ────────────────────────────────────────────────

  describe("push_tokens storage permissions", function (): void {

    it("writes the token row server-write-only, owner-read", function (): void {
      var nk = makeMockNk();
      plainAccount(nk, USER_A);
      register(nk, USER_A, "tokA");

      var row = nk._row(PUSH_TOKENS, "token_" + USER_A, USER_A);
      expectTrue(!!row, "the token row should exist");
      expectEq(row!.read, 1, "the owner still reads its own endpoint state");
      expectEq(row!.write, 0,
        "owner-write would let a client store an endpointArn of its choosing and " +
        "redirect this account's notifications to another device");
    });

    it("repairs the permissions of a legacy client-writable row on next write", function (): void {
      var nk = makeMockNk();
      plainAccount(nk, USER_A);
      // A row as it exists in production today: read=1, write=1.
      nk.storageWrite([{
        collection: PUSH_TOKENS, key: "token_" + USER_A, userId: USER_A,
        value: { tokens: [] }, permissionRead: 1, permissionWrite: 1,
      }]);
      expectEq(nk._row(PUSH_TOKENS, "token_" + USER_A, USER_A)!.write, 1);

      register(nk, USER_A, "tokA");
      expectEq(nk._row(PUSH_TOKENS, "token_" + USER_A, USER_A)!.write, 0,
        "an existing row must be tightened, not left as it was found");
    });
  });

  // ── 5. version-checked writes ─────────────────────────────────────────────

  describe("push_register_token — concurrent registration", function (): void {

    it("does not lose a row written by a concurrent registration", function (): void {
      // The lost-update shape: two devices of one account register at the same
      // instant. Each reads the row, adds its own token, writes back. With a
      // versionless write the second overwrites the first and one device
      // silently never receives a notification again.
      var nk = makeMockNk();
      plainAccount(nk, USER_A);

      var injected = false;
      nk._beforeWrite = function (req: any): void {
        // Fire once, on the first token-row write, simulating the other device
        // committing in between this call's read and its write.
        if (injected || req.collection !== PUSH_TOKENS) return;
        injected = true;
        var current = nk._row(PUSH_TOKENS, "token_" + USER_A, USER_A);
        var tokens = current && current.value ? current.value.tokens : [];
        tokens.push({ token: "tok_other_device", platform: "ios", updatedAt: 1, endpointArn: "arn:other" });
        nk.storageWrite([{
          collection: PUSH_TOKENS, key: "token_" + USER_A, userId: USER_A,
          value: { tokens: tokens }, permissionRead: 1, permissionWrite: 0,
        }]);
      };

      var resp = register(nk, USER_A, "tok_this_device");
      expectEq(resp.success, true, "the conflict must be retried, not surfaced: " + fmt(resp.error));

      var tokens = nk._tokens(USER_A);
      var names: string[] = [];
      for (var i = 0; i < tokens.length; i++) names.push(tokens[i].token);
      expectEq(tokens.length, 2, "both devices must survive, got " + fmt(names));
      expectTrue(names.indexOf("tok_other_device") >= 0, "the concurrent device was dropped: " + fmt(names));
      expectTrue(names.indexOf("tok_this_device") >= 0, "this device was dropped: " + fmt(names));
    });
  });

  // ── 6. pending markers ────────────────────────────────────────────────────

  describe("pending registration index", function (): void {

    it("marks a pending user with a per-user row, not a shared array", function (): void {
      var nk = makeMockNk();
      plainAccount(nk, USER_A);
      nk._registerCode = 502;   // provider down, so the row stays pending

      var resp = register(nk, USER_A, "tokA");
      expectEq(resp.pending, true);
      var marker = nk._row(PENDING_INDEX, "pending", USER_A);
      expectTrue(!!marker, "the scheduler needs a marker to find this registration");
      expectEq(marker!.userId, USER_A, "the row must be owned by the user, not the system account");
      expectEq(nk._row(PENDING_INDEX, "index", SYSTEM_USER), null,
        "the global hot row must not be recreated");
    });

    it("keeps both users when two accounts register concurrently and both fail", function (): void {
      // Under the shared array this is the lost update that made a failed
      // registration unrecoverable: whichever write landed second erased the
      // other user's entry, and the scheduler could then never see it.
      var nk = makeMockNk();
      plainAccount(nk, USER_A);
      plainAccount(nk, USER_B);
      nk._registerCode = 502;

      register(nk, USER_A, "tokA");
      register(nk, USER_B, "tokB");

      expectTrue(!!nk._row(PENDING_INDEX, "pending", USER_A), "A's marker is missing");
      expectTrue(!!nk._row(PENDING_INDEX, "pending", USER_B), "B's marker is missing");
    });

    it("clears the marker once the registration completes inline", function (): void {
      var nk = makeMockNk();
      plainAccount(nk, USER_A);
      var resp = register(nk, USER_A, "tokA");
      expectEq(resp.success, true);
      expectEq(nk._row(PENDING_INDEX, "pending", USER_A), null,
        "a settled user must not stay in the scan forever");
    });

    it("flush finds a pending user through the per-user row and completes it", function (): void {
      var nk = makeMockNk();
      plainAccount(nk, USER_A);
      nk._registerCode = 502;
      register(nk, USER_A, "tokA");
      expectEq(nk._tokens(USER_A)[0].pendingRegistration, true);

      // Provider recovers; the scheduler tick should finish the job.
      nk._registerCode = 200;
      // The 30-minute throttle is measured from pendingLastAttempt, so backdate it.
      var row = nk._row(PUSH_TOKENS, "token_" + USER_A, USER_A)!;
      row.value.tokens[0].pendingLastAttempt = Math.floor(Date.now() / 1000) - 3600;

      LegacyPush.flushPendingRegistrations(ctxFor(""), logger(), nk as any);

      var after = nk._tokens(USER_A)[0];
      expectFalsy(after.pendingRegistration, "the retry should have settled the row");
      expectTrue(("" + after.endpointArn).indexOf("arn:aws:sns:") === 0, "" + after.endpointArn);
      expectEq(nk._row(PENDING_INDEX, "pending", USER_A), null, "a settled marker must be cleared");
    });

    it("drains a legacy global array so nothing in flight at cutover is orphaned", function (): void {
      var nk = makeMockNk();
      plainAccount(nk, USER_A);
      // A pending row written by the old code, listed only in the shared array.
      nk.storageWrite([{
        collection: PUSH_TOKENS, key: "token_" + USER_A, userId: USER_A,
        value: {
          tokens: [{
            token: "tok_legacy", platform: "android", updatedAt: 1,
            pendingRegistration: true, pendingRetries: 0, pendingLastAttempt: 1,
          }],
        },
        permissionRead: 1, permissionWrite: 1,
      }]);
      nk.storageWrite([{
        collection: PENDING_INDEX, key: "index", userId: SYSTEM_USER,
        value: { userIds: [USER_A] }, permissionRead: 0, permissionWrite: 0,
      }]);

      LegacyPush.flushPendingRegistrations(ctxFor(""), logger(), nk as any);

      var after = nk._tokens(USER_A)[0];
      expectFalsy(after.pendingRegistration, "the legacy entry must still be picked up");
      expectTrue(("" + after.endpointArn).indexOf("arn:aws:sns:") === 0, "" + after.endpointArn);
    });
  });

  // ── 7. token cap ──────────────────────────────────────────────────────────

  describe("per-account token cap", function (): void {

    it("leaves a genuine two-device account alone", function (): void {
      var nk = makeMockNk();
      plainAccount(nk, USER_A);
      seedRegisteredToken(nk, USER_A, "phone");
      register(nk, USER_A, "tablet");
      expectEq(nk._tokens(USER_A).length, 2, "a phone and a tablet are both legitimate");
    });

    it("caps the fan-out at ten and evicts the least recently registered", function (): void {
      var nk = makeMockNk();
      plainAccount(nk, USER_A);
      // Twelve rotated tokens, oldest first by updatedAt.
      for (var i = 0; i < 12; i++) seedRegisteredToken(nk, USER_A, "old_" + i, 1000 + i);
      expectEq(nk._tokens(USER_A).length, 12);

      register(nk, USER_A, "newest");

      var tokens = nk._tokens(USER_A);
      var names: string[] = [];
      for (var j = 0; j < tokens.length; j++) names.push(tokens[j].token);
      expectEq(tokens.length, 10, "got " + fmt(names));
      expectTrue(names.indexOf("newest") >= 0, "the registration in flight must never be evicted");
      expectTrue(names.indexOf("old_0") < 0, "the least recently registered row should have gone");
      expectTrue(names.indexOf("old_1") < 0, "the second-least recently registered row should have gone");
      expectTrue(names.indexOf("old_11") >= 0, "the most recent survivor must be kept");
    });

    it("does not evict a row that is still awaiting its endpoint", function (): void {
      var nk = makeMockNk();
      plainAccount(nk, USER_A);
      for (var i = 0; i < 10; i++) seedRegisteredToken(nk, USER_A, "old_" + i, 5000 + i);
      // A very old pending row: eviction order would pick it first if it could.
      var row = nk._row(PUSH_TOKENS, "token_" + USER_A, USER_A)!;
      row.value.tokens.push({ token: "tok_pending", platform: "ios", updatedAt: 1, pendingRegistration: true });

      register(nk, USER_A, "newest");

      var tokens = nk._tokens(USER_A);
      var found = false;
      for (var j = 0; j < tokens.length; j++) if (tokens[j].token === "tok_pending") found = true;
      expectTrue(found, "an in-flight registration must survive eviction");
    });
  });

  // ── 8. ghost pruning must not eat in-flight registrations ─────────────────

  describe("ghost pruning", function (): void {

    it("keeps a pending row when another device registers", function (): void {
      // pruneGhostTokens dropped every row without an endpointArn, and a
      // pending row has none by definition — so a second device registering,
      // or any send, destroyed the first device's in-flight registration and
      // with it the only thing the retry scheduler had to work from.
      var nk = makeMockNk();
      plainAccount(nk, USER_A);
      nk._registerCode = 502;
      register(nk, USER_A, "tok_first");
      expectEq(nk._tokens(USER_A).length, 1);

      nk._registerCode = 200;
      register(nk, USER_A, "tok_second");

      var tokens = nk._tokens(USER_A);
      var names: string[] = [];
      for (var i = 0; i < tokens.length; i++) names.push(tokens[i].token);
      expectTrue(names.indexOf("tok_first") >= 0, "the pending registration was destroyed: " + fmt(names));
    });

    it("keeps a pending row across a send, and does not try to publish to it", function (): void {
      var nk = makeMockNk();
      plainAccount(nk, USER_A);
      nk._registerCode = 502;
      register(nk, USER_A, "tok_pending");
      var httpBefore = nk._http.length;

      var resp = callRpc("push_send_event", ctxFor(""), nk, {
        userId: USER_A, eventType: "x", title: "t", body: "b",
      });

      expectEq(nk._tokens(USER_A).length, 1, "the send must not prune an in-flight registration");
      expectEq(nk._http.length, httpBefore, "there is no endpoint to publish to yet");
      expectEq(resp.recipientCount, 0);
    });

    it("still drops a genuine ghost — no ARN and no longer pending", function (): void {
      var nk = makeMockNk();
      plainAccount(nk, USER_A);
      nk.storageWrite([{
        collection: PUSH_TOKENS, key: "token_" + USER_A, userId: USER_A,
        value: { tokens: [{ token: "ghost", platform: "android", updatedAt: 1, providerError: "max_retries_exceeded" }] },
        permissionRead: 1, permissionWrite: 1,
      }]);

      callRpc("push_get_endpoints", ctxFor(USER_A), nk, {});
      expectEq(nk._tokens(USER_A).length, 0, "a row that will never deliver must still be collected");
    });
  });

  // ── 9. no hardcoded provider URL ──────────────────────────────────────────

  describe("provider URL configuration", function (): void {

    it("refuses to register when PUSH_REGISTER_URL is unset instead of falling back", function (): void {
      // The removed fallback was a public, unauthenticated Lambda Function URL
      // in a legacy AWS account. A dropped config override must degrade loudly,
      // not silently move production back onto it.
      var nk = makeMockNk();
      plainAccount(nk, USER_A);
      var resp = register(nk, USER_A, "tokA", undefined, { PUSH_REGISTER_URL: null, PUSH_LAMBDA_URL: null });

      expectEq(resp.success, false);
      expectEq(resp.pending, true, "the token is still parked for a retry once config is fixed");
      expectEq(nk._http.length, 0, "no request may be made to any URL");
    });

    it("refuses to send when PUSH_SEND_URL is unset", function (): void {
      var nk = makeMockNk();
      plainAccount(nk, USER_A);
      seedRegisteredToken(nk, USER_A, "tokA");

      var resp = callRpc("push_send_event", ctxFor("", { PUSH_SEND_URL: null }), nk, {
        userId: USER_A, eventType: "x", title: "t", body: "b",
      });
      expectEq(nk._http.length, 0, "no request may be made to any URL");
      expectEq(resp.recipientCount, 0);
      expectEq(resp.providerConfigured, false);
    });

    it("targets the in-cluster bridge when configured, not a Lambda URL", function (): void {
      var nk = makeMockNk();
      plainAccount(nk, USER_A);
      register(nk, USER_A, "tokA");
      expectEq(nk._http.length, 1);
      expectEq(nk._http[0].url, ENV_OK.PUSH_REGISTER_URL);
    });
  });

  // ── Runner entry ──────────────────────────────────────────────────────────

  export function runAll(): { passed: number; failed: number; errors: string[]; total: number } {
    var passed = 0;
    var errors: string[] = [];
    for (var i = 0; i < allTests.length; i++) {
      var t = allTests[i];
      try {
        t.fn();
        passed++;
      } catch (e: any) {
        errors.push("[" + t.suite + "] " + t.name + " — " + (e && e.message ? e.message : String(e)));
      }
    }
    return { passed: passed, failed: errors.length, errors: errors, total: allTests.length };
  }
}
