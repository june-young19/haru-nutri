import assert from "node:assert/strict";
import { beforeEach, afterEach, describe, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { handleApi } from "../lib/server/api";
import { getSessionUser, hashPassword, login, signup, verifyPassword } from "../lib/server/auth";
import { closeDatabase, getDb, getToday } from "../lib/server/db";
import { saveSupplement, setIntake, updateSettings } from "../lib/server/service";
import {
  completePasswordReset,
  passwordResetCookie,
  processPasswordResetRequests,
  requestPasswordReset,
  verifyPasswordReset,
} from "../lib/server/password-reset";

// Synthetic accounts, isolated SQLite and mocked Brevo only. Never read a .env file.
const keys = [
  "DATABASE_PATH",
  "EMAIL_MODE",
  "BREVO_API_KEY",
  "EMAIL_FROM",
  "EMAIL_FROM_NAME",
  "APP_URL",
  "NODE_ENV",
  "CRON_SECRET",
  "TRUST_PROXY",
] as const;
let saved: Record<string, string | undefined>;
let directory: string;
let messages: {
  to: { email: string }[];
  textContent: string;
  headers: { idempotencyKey: string };
}[];
const originalFetch = globalThis.fetch;
describe("password reset", () => {
  beforeEach(() => {
    closeDatabase();
    saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    keys.forEach((key) => delete process.env[key]);
    directory = mkdtempSync(join(tmpdir(), "haru-reset-test-"));
    process.env.DATABASE_PATH = join(directory, "reset.sqlite");
    process.env.EMAIL_MODE = "brevo";
    process.env.BREVO_API_KEY = "test-only-key-no-real-delivery";
    process.env.EMAIL_FROM = "sender@example.test";
    process.env.APP_URL = "http://localhost:3000";
    messages = [];
    globalThis.fetch = async (_url, options) => {
      messages.push(JSON.parse(String(options?.body)));
      return new Response(JSON.stringify({ messageId: `<test-${messages.length}@example.test>` }), {
        status: 201,
      });
    };
  });
  afterEach(() => {
    closeDatabase();
    globalThis.fetch = originalFetch;
    keys.forEach((key) => {
      if (saved[key] === undefined) delete process.env[key];
      else (process.env as Record<string, string | undefined>)[key] = saved[key];
    });
    rmSync(directory, { force: true, recursive: true });
  });
  const later = (now: Date, seconds: number) => new Date(now.getTime() + seconds * 1000);
  const account = (email = "member@example.test") =>
    signup({ email, password: "old-password-123", name: "하루", age: 30 }, randomUUID());
  const codeFrom = (index = messages.length - 1) =>
    messages[index].textContent.match(/인증번호는 (\d{6})입니다/)![1];
  const wrongCode = () => (codeFrom() === "000000" ? "111111" : "000000");
  const resetRows = () =>
    getDb().prepare("SELECT * FROM password_reset_requests ORDER BY created_at").all();
  async function http(
    path: string,
    value: unknown,
    options: {
      cookie?: string;
      origin?: string;
      schedule?: (task: () => Promise<void>) => void;
      headers?: Record<string, string>;
    } = {},
  ) {
    const headers = new Headers({
      "content-type": "application/json",
      origin: options.origin || "http://localhost:3000",
      ...options.headers,
    });
    if (options.cookie) headers.set("cookie", options.cookie);
    const response = await handleApi(
      new Request(`http://localhost:3000/api${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(value),
      }),
      { scheduleResetDelivery: options.schedule },
    );
    return {
      response,
      json: (await response.json()) as { data: Record<string, unknown>; error?: string },
    };
  }
  async function ready(email = "member@example.test", now = new Date()) {
    const owner = await account(email);
    const request = await requestPasswordReset({ email }, randomUUID(), { now });
    await processPasswordResetRequests({ requestId: request.requestId, now });
    return { ...owner, request, code: codeFrom(), now, email };
  }
  async function grant(email = "member@example.test", now = new Date()) {
    const setup = await ready(email, now);
    const result = await verifyPasswordReset(
      { email, requestId: setup.request.requestId, code: setup.code },
      randomUUID(),
      { now },
    );
    return { ...setup, grant: result.token };
  }

  test("signup, login and logout clear the reset grant cookie while preserving their session cookie behavior", async () => {
    const setup = await grant();
    function cookies(response: Response) {
      const values = response.headers.getSetCookie();
      assert.equal(values.length, 2);
      assert.match(values[0], /^haru_session=/);
      assert.equal(values[1], passwordResetCookie(""));
      assert.match(
        values[1],
        /Path=\/api\/auth\/password-reset; HttpOnly; SameSite=Lax; Max-Age=0/,
      );
      return { session: values[0], token: values[0].split(";")[0].split("=")[1] };
    }

    const signedUp = await http("/auth/signup", {
      email: "new-member@example.test",
      password: "new-member-password-123",
      name: "새 회원",
      age: 25,
    });
    assert.equal(signedUp.response.status, 201);
    const signupCookies = cookies(signedUp.response);
    assert.match(signupCookies.session, /Max-Age=604800/);
    assert.equal(getSessionUser(signupCookies.token)?.email, "new-member@example.test");

    const loggedIn = await http("/auth/login", {
      email: setup.email,
      password: "old-password-123",
    });
    assert.equal(loggedIn.response.status, 200);
    const loginCookies = cookies(loggedIn.response);
    assert.match(loginCookies.session, /Max-Age=604800/);
    assert.equal(getSessionUser(loginCookies.token)?.id, setup.user.id);

    const loggedOut = await http(
      "/auth/logout",
      {},
      {
        cookie: `haru_session=${loginCookies.token}`,
      },
    );
    assert.equal(loggedOut.response.status, 200);
    const logoutCookies = cookies(loggedOut.response);
    assert.equal(logoutCookies.token, "");
    assert.match(logoutCookies.session, /Max-Age=0/);
    assert.equal(getSessionUser(loginCookies.token), null);
    assert.equal(getSessionUser(signupCookies.token)?.email, "new-member@example.test");
  });

  test("public request, email code, restricted cookie and password change revoke all owner sessions only", async () => {
    const owner = await account();
    const otherSession = await login(
      { email: owner.user.email, password: "old-password-123" },
      "second-browser",
    );
    const outsider = await account("other@example.test");
    const product = saveSupplement(owner.user.id, {
      name: "보존할 영양제",
      brand: "테스트",
      color: "mint",
      times: ["09:00"],
      ingredients: [{ name: "비타민 D", amount: 20, unit: "μg" }],
    });
    setIntake(owner.user.id, {
      scheduleId: product.schedules[0].id,
      date: getToday(),
      completed: true,
    });
    updateSettings(owner.user.id, {
      guardianEmail: "guardian@example.test",
      guardianEnabled: true,
      guardianConsent: true,
    });
    const preservedTables = [
      "supplements",
      "supplement_ingredients",
      "intake_schedules",
      "intake_records",
      "guardian_settings",
    ];
    const snapshots = preservedTables.map((table) =>
      JSON.stringify(getDb().prepare(`SELECT * FROM ${table}`).all()),
    );
    const tasks: (() => Promise<void>)[] = [];
    const requested = await http(
      "/auth/password-reset/request",
      { email: owner.user.email },
      { schedule: (task) => tasks.push(task) },
    );
    assert.equal(requested.response.status, 202);
    assert.equal(messages.length, 0, "mail work must start only after the neutral response");
    assert.equal(tasks.length, 1);
    assert.equal(requested.json.data.expiresIn, 600);
    assert.equal(requested.json.data.resendAfter, 60);
    assert.match(String(requested.json.data.message), /요청을 접수/);
    assert.doesNotMatch(
      JSON.stringify(requested.json),
      /발송했습니다|전송했습니다|code_hash|password_hash/,
    );
    assert.match(requested.response.headers.get("cache-control")!, /no-store/);
    await tasks[0]();
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0].to, [{ email: owner.user.email }]);
    const code = codeFrom();
    assert.match(code, /^\d{6}$/);
    assert.equal(await verifyPassword(code, String(resetRows()[0].code_hash)), true);
    assert.equal(resetRows()[0].code_hash === code, false);
    assert.equal(
      getDb().prepare("SELECT count(*) AS count FROM notification_logs").get()!.count,
      0,
    );
    const verified = await http("/auth/password-reset/verify", {
      email: owner.user.email,
      requestId: requested.json.data.requestId,
      code,
    });
    assert.equal(verified.response.status, 200);
    assert.deepEqual(verified.json.data, { verified: true, expiresIn: 300 });
    const cookie = verified.response.headers.get("set-cookie")!;
    assert.match(cookie, /Path=\/api\/auth\/password-reset; HttpOnly; SameSite=Lax; Max-Age=300/);
    const token = cookie.split(";")[0].split("=")[1];
    assert.notEqual(resetRows()[0].reset_token_hash, token);
    const completed = await http(
      "/auth/password-reset/complete",
      { password: "new-password-456", passwordConfirm: "new-password-456" },
      { cookie: cookie.split(";")[0] },
    );
    assert.equal(completed.response.status, 200);
    assert.deepEqual(completed.json.data, { reset: true });
    assert.equal(completed.response.headers.getSetCookie().length, 2);
    assert.ok(
      completed.response.headers.getSetCookie().every((value) => value.includes("Max-Age=0")),
    );
    assert.equal(getSessionUser(owner.token), null);
    assert.equal(getSessionUser(otherSession.token), null);
    assert.equal(getSessionUser(outsider.token)?.id, outsider.user.id);
    preservedTables.forEach((table, index) =>
      assert.equal(
        JSON.stringify(getDb().prepare(`SELECT * FROM ${table}`).all()),
        snapshots[index],
        `${table} survives a reset`,
      ),
    );
    await assert.rejects(
      login({ email: owner.user.email, password: "old-password-123" }, "old-login"),
      { status: 401 },
    );
    assert.equal(
      (await login({ email: owner.user.email, password: "new-password-456" }, "new-login")).user.id,
      owner.user.id,
    );
  });

  test("known and unknown emails have the same public response and indistinguishable invalid-code errors", async () => {
    await account();
    const tasks: (() => Promise<void>)[] = [];
    const known = await http(
      "/auth/password-reset/request",
      { email: "member@example.test" },
      { schedule: (task) => tasks.push(task) },
    );
    const unknown = await http(
      "/auth/password-reset/request",
      { email: "unknown@example.test" },
      { schedule: (task) => tasks.push(task) },
    );
    assert.equal(known.response.status, 202);
    assert.equal(unknown.response.status, 202);
    const publicShape = (data: Record<string, unknown>) => ({ ...data, requestId: "opaque" });
    assert.deepEqual(publicShape(known.json.data), publicShape(unknown.json.data));
    assert.ok(
      resetRows().every((row) => typeof row.code_hash === "string" && row.code_hash.length > 100),
    );
    assert.equal(messages.length, 0);
    await Promise.all(tasks.map((task) => task()));
    assert.equal(messages.length, 1, "unknown addresses do not receive unsolicited mail");
    const knownError = await http("/auth/password-reset/verify", {
      email: "member@example.test",
      requestId: known.json.data.requestId,
      code: wrongCode(),
    });
    const unknownError = await http("/auth/password-reset/verify", {
      email: "unknown@example.test",
      requestId: unknown.json.data.requestId,
      code: "123456",
    });
    assert.equal(knownError.response.status, 400);
    assert.deepEqual(knownError.json, unknownError.json);
  });

  test("normalized email cooldown and five-per-hour limits apply equally to unknown accounts", async () => {
    const now = new Date();
    for (let index = 0; index < 5; index++) {
      const moment = later(now, index * 60);
      await requestPasswordReset({ email: " NO-ACCOUNT@EXAMPLE.TEST " }, `ip-${index}`, {
        now: moment,
      });
      await assert.rejects(
        requestPasswordReset({ email: "no-account@example.test" }, `retry-${index}`, {
          now: later(moment, 59),
        }),
        { status: 429 },
      );
    }
    await assert.rejects(
      requestPasswordReset({ email: "no-account@example.test" }, "sixth", { now: later(now, 300) }),
      { status: 429 },
    );
    await requestPasswordReset({ email: "no-account@example.test" }, "next-window", {
      now: later(now, 3600),
    });
    assert.equal(resetRows().length, 6);
  });

  test("request limits span every email for the same IP", async () => {
    for (let index = 0; index < 20; index++)
      await requestPasswordReset({ email: `address-${index}@example.test` }, "same-ip");
    await assert.rejects(requestPasswordReset({ email: "different@example.test" }, "same-ip"), {
      status: 429,
    });
    assert.equal(resetRows().length, 20);
  });

  test("five wrong codes invalidate a challenge and simultaneous guessing cannot reserve more attempts", async () => {
    const setup = await ready();
    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        verifyPasswordReset(
          { email: setup.email, requestId: setup.request.requestId, code: wrongCode() },
          randomUUID(),
        ),
      ),
    );
    assert.ok(attempts.every((result) => result.status === "rejected"));
    assert.equal(resetRows()[0].attempts, 5);
    assert.equal(resetRows()[0].status, "invalidated");
    await assert.rejects(
      verifyPasswordReset(
        { email: setup.email, requestId: setup.request.requestId, code: setup.code },
        "correct-after-limit",
      ),
      { status: 400 },
    );
    assert.equal(
      getSessionUser(setup.token)?.id,
      setup.user.id,
      "reset failures never lock the normal account",
    );
  });

  test("a code is valid for less than ten minutes and only one simultaneous verifier receives a grant", async () => {
    const setup = await ready();
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        verifyPasswordReset(
          { email: setup.email, requestId: setup.request.requestId, code: setup.code },
          randomUUID(),
          { now: setup.now },
        ),
      ),
    );
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const expired = await ready("expired@example.test");
    await assert.rejects(
      verifyPasswordReset(
        { email: expired.email, requestId: expired.request.requestId, code: expired.code },
        "expired",
        { now: later(expired.now, 600) },
      ),
      { status: 400 },
    );
  });

  test("reissuing a code invalidates earlier codes and already verified reset grants", async () => {
    const setup = await grant();
    const moment = later(setup.now, 60);
    const second = await requestPasswordReset({ email: setup.email }, "reissue", { now: moment });
    await assert.rejects(
      completePasswordReset(
        { password: "another-password", passwordConfirm: "another-password" },
        setup.grant,
        "old-grant",
        { now: moment },
      ),
      { status: 400 },
    );
    await assert.rejects(
      verifyPasswordReset(
        { email: setup.email, requestId: setup.request.requestId, code: setup.code },
        "old-code",
        { now: moment },
      ),
      { status: 400 },
    );
    await processPasswordResetRequests({ requestId: second.requestId, now: moment });
    assert.ok(
      (
        await verifyPasswordReset(
          { email: setup.email, requestId: second.requestId, code: codeFrom() },
          "new-code",
          { now: moment },
        )
      ).token,
    );
  });

  test("reset grants expire in five minutes, are single use, and enforce confirmation and the existing password policy", async () => {
    const setup = await grant();
    await assert.rejects(
      completePasswordReset({ password: "short", passwordConfirm: "short" }, setup.grant, "weak", {
        now: setup.now,
      }),
      { status: 400 },
    );
    await assert.rejects(
      completePasswordReset(
        { password: "new-password-456", passwordConfirm: "mismatch-value" },
        setup.grant,
        "mismatch",
        { now: setup.now },
      ),
      { status: 400 },
    );
    await assert.rejects(
      completePasswordReset(
        { password: "new-password-456", passwordConfirm: "new-password-456" },
        setup.grant,
        "expired",
        { now: later(setup.now, 300) },
      ),
      { status: 400 },
    );
    const active = await grant("active@example.test");
    const body = { password: "new-password-456", passwordConfirm: "new-password-456" };
    const results = await Promise.allSettled(
      Array.from({ length: 2 }, () =>
        completePasswordReset(body, active.grant, randomUUID(), { now: active.now }),
      ),
    );
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(resetRows().filter((row) => row.status === "consumed").length, 1);
  });

  test("pending work survives restart and the authenticated existing cron recovers it", async () => {
    await account();
    const requested = await requestPasswordReset({ email: "member@example.test" }, "request");
    closeDatabase();
    process.env.CRON_SECRET = "test-cron-secret-123456789012345";
    const denied = await http("/cron/notifications", {});
    assert.equal(denied.response.status, 401);
    assert.equal(messages.length, 0);
    const processed = await http(
      "/cron/notifications",
      {},
      { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } },
    );
    assert.equal(processed.response.status, 200);
    assert.equal(processed.json.data.mode, "brevo");
    assert.equal(messages.length, 1);
    assert.equal(messages[0].headers.idempotencyKey, requested.requestId);
    assert.equal(resetRows()[0].status, "sent");
  });

  test("concurrent delivery workers claim once and stale claimed work is never replayed", async () => {
    await account();
    const now = new Date();
    const requested = await requestPasswordReset({ email: "member@example.test" }, "request", {
      now,
    });
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        processPasswordResetRequests({ requestId: requested.requestId, now }),
      ),
    );
    assert.equal(
      results.reduce((sum, result) => sum + result.accepted, 0),
      1,
    );
    assert.equal(messages.length, 1);
    getDb()
      .prepare("UPDATE password_reset_requests SET status='processing',claimed_at=? WHERE id=?")
      .run(later(now, -61).toISOString(), requested.requestId);
    closeDatabase();
    await processPasswordResetRequests({ now });
    assert.equal(messages.length, 1);
    assert.equal(resetRows()[0].status, "failed");
    assert.equal(resetRows()[0].code_hash, "");
  });

  test("provider rejection, lost response and malformed acceptance invalidate the code without logging it or retrying", async () => {
    for (const kind of ["rejected", "uncertain", "malformed", "network"]) {
      await account(`${kind}@example.test`);
      const request = await requestPasswordReset({ email: `${kind}@example.test` }, kind);
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        if (kind === "network") throw new Error("test-secret-that-must-not-appear");
        return new Response(
          JSON.stringify(
            kind === "malformed"
              ? {}
              : { code: "unauthorized", message: "test-secret-that-must-not-appear" },
          ),
          { status: kind === "rejected" ? 401 : kind === "uncertain" ? 503 : 201 },
        );
      };
      await processPasswordResetRequests({ requestId: request.requestId });
      await processPasswordResetRequests({ requestId: request.requestId });
      assert.equal(calls, 1);
      const row = getDb()
        .prepare("SELECT * FROM password_reset_requests WHERE id=?")
        .get(request.requestId)!;
      assert.equal(row.status, "failed");
      assert.equal(row.code_hash, "");
      assert.equal(row.provider_id, null);
      assert.doesNotMatch(String(row.error), /test-secret-that-must-not-appear/);
    }
    assert.equal(getDb().prepare("SELECT count(*) AS n FROM notification_logs").get()!.n, 0);
  });

  test("global email configuration errors are identical for registered and unknown addresses with no false success", async () => {
    await account();
    for (const mode of ["capture", "brevo"]) {
      process.env.EMAIL_MODE = mode;
      delete process.env.BREVO_API_KEY;
      const known = await http("/auth/password-reset/request", { email: "member@example.test" });
      const unknown = await http("/auth/password-reset/request", { email: "unknown@example.test" });
      assert.equal(known.response.status, 503);
      assert.equal(unknown.response.status, 503);
      assert.deepEqual(known.json, unknown.json);
    }
    assert.equal(resetRows().length, 0);
    assert.equal(messages.length, 0);
  });

  test("reset APIs reject cross-origin requests and production grants are secure HttpOnly scoped cookies", async () => {
    for (const path of ["request", "verify", "complete"])
      assert.equal(
        (
          await http(
            `/auth/password-reset/${path}`,
            { email: "member@example.test" },
            { origin: "https://attacker.example.test" },
          )
        ).response.status,
        403,
      );
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    assert.match(
      passwordResetCookie("opaque-token"),
      /HttpOnly; SameSite=Lax; Max-Age=300; Secure$/,
    );
    assert.match(passwordResetCookie(""), /Max-Age=0; Secure$/);
    assert.equal(resetRows().length, 0);
  });

  test("v3 to v4 migration is additive and preserves existing users and sessions", async () => {
    const owner = await account();
    const before = JSON.stringify(getDb().prepare("SELECT * FROM users").all());
    getDb().exec("DROP TABLE password_reset_requests; PRAGMA user_version=3");
    closeDatabase();
    assert.equal(getDb().prepare("PRAGMA user_version").get()!.user_version, 4);
    assert.equal(JSON.stringify(getDb().prepare("SELECT * FROM users").all()), before);
    assert.equal(getSessionUser(owner.token)?.id, owner.user.id);
    assert.deepEqual(resetRows(), []);
  });

  test("a login that verified the previous password cannot create a session after a concurrent reset", async () => {
    const owner = await account();
    const replacement = await hashPassword("new-password-456");
    const pending = login(
      { email: owner.user.email, password: "old-password-123" },
      "racing-login",
    );
    getDb().exec("BEGIN IMMEDIATE");
    getDb().prepare("UPDATE users SET password_hash=? WHERE id=?").run(replacement, owner.user.id);
    getDb().prepare("DELETE FROM sessions WHERE user_id=?").run(owner.user.id);
    getDb().exec("COMMIT");
    await assert.rejects(pending, { status: 401 });
    assert.equal(
      getDb().prepare("SELECT count(*) AS n FROM sessions WHERE user_id=?").get(owner.user.id)!.n,
      0,
    );
  });

  test("reissue during an in-flight email invalidates that delivery without letting a second worker duplicate it", async () => {
    const owner = await account();
    const now = new Date();
    const first = await requestPasswordReset({ email: owner.user.email }, "first", { now });
    let begin: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });
    let finish: () => void = () => {};
    const release = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let calls = 0;
    let initialCode = "";
    globalThis.fetch = async (_url, options) => {
      calls++;
      const payload = JSON.parse(String(options?.body));
      initialCode = String(payload.textContent).match(/인증번호는 (\d{6})입니다/)![1];
      begin();
      await release;
      return new Response(JSON.stringify({ messageId: "<late-accepted@example.test>" }), {
        status: 201,
      });
    };
    const sending = processPasswordResetRequests({ requestId: first.requestId, now });
    await started;
    const overlap = await processPasswordResetRequests({ requestId: first.requestId, now });
    assert.equal(overlap.accepted, 0);
    const second = await requestPasswordReset({ email: owner.user.email }, "second", {
      now: later(now, 60),
    });
    finish();
    assert.equal((await sending).accepted, 0);
    assert.equal(calls, 1);
    await assert.rejects(
      verifyPasswordReset(
        { email: owner.user.email, requestId: first.requestId, code: initialCode },
        "old",
        { now: later(now, 60) },
      ),
      { status: 400 },
    );
    assert.equal(
      getDb()
        .prepare("SELECT status FROM password_reset_requests WHERE id=?")
        .get(second.requestId)!.status,
      "queued",
    );
  });

  function overdueReminder(userId: string) {
    // Always one hour ago, including around KST midnight; no dependency on the test's clock hour.
    const occurrence = new Date(Date.now() - 60 * 60_000);
    const time = new Date(occurrence.getTime() + 9 * 60 * 60_000).toISOString().slice(11, 16);
    const product = saveSupplement(userId, {
      name: "정기 복용 알림",
      color: "mint",
      times: [time],
      ingredients: [{ name: "비타민 D", amount: 20, unit: "μg" }],
    });
    getDb()
      .prepare("UPDATE intake_schedules SET start_date=?,end_date=? WHERE supplement_id=?")
      .run(getToday(occurrence), getToday(occurrence), product.id);
  }

  test("cron recovery starts intake reminders while a reset email is still waiting for the provider", async () => {
    const owner = await account();
    overdueReminder(owner.user.id);
    await requestPasswordReset({ email: owner.user.email }, "queued-reset");
    process.env.CRON_SECRET = "test-cron-secret-123456789012345";
    let releaseReset: () => void = () => {};
    const resetPending = new Promise<void>((resolve) => {
      releaseReset = resolve;
    });
    let markReset: () => void = () => {};
    const resetStarted = new Promise<void>((resolve) => {
      markReset = resolve;
    });
    let markReminder: () => void = () => {};
    const reminderStarted = new Promise<void>((resolve) => {
      markReminder = resolve;
    });
    let resetCalls = 0;
    let reminderCalls = 0;
    globalThis.fetch = async (_url, options) => {
      const payload = JSON.parse(String(options?.body));
      if (String(payload.subject).includes("비밀번호 재설정")) {
        resetCalls++;
        markReset();
        await resetPending;
      } else {
        reminderCalls++;
        markReminder();
      }
      return new Response(JSON.stringify({ messageId: "<parallel-test@example.test>" }), {
        status: 201,
      });
    };
    const cron = http(
      "/cron/notifications",
      {},
      { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([resetStarted, reminderStarted]),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Intake reminder waited for reset delivery")),
            3000,
          );
        }),
      ]);
      assert.equal(
        reminderCalls,
        1,
        "the regular reminder starts before the reset response is released",
      );
      assert.equal(resetCalls, 1);
    } finally {
      clearTimeout(timer);
      releaseReset();
      await cron;
    }
    const result = await cron;
    assert.equal(result.response.status, 200);
    assert.equal(result.json.data.sent, 1);
    assert.equal(resetRows()[0].status, "sent");
  });

  test("cron recovery errors are isolated and do not suppress intake reminders", async () => {
    const owner = await account();
    overdueReminder(owner.user.id);
    process.env.CRON_SECRET = "test-cron-secret-123456789012345";
    const originalError = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    // Only the isolated fixture is damaged, specifically in the reset queue schema.
    getDb().exec("ALTER TABLE password_reset_requests RENAME TO unavailable_password_resets");
    try {
      const result = await http(
        "/cron/notifications",
        {},
        { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } },
      );
      assert.equal(result.response.status, 200);
      assert.equal(result.json.data.sent, 1);
      assert.equal(messages.length, 1);
      assert.match(messages[0].textContent, /복용 완료가 아직 확인되지 않았습니다/);
      assert.deepEqual(errors, ["[password-reset] Queue recovery failed."]);
      assert.doesNotMatch(
        JSON.stringify(errors),
        /unavailable_password_resets|SELECT|test-only-key/,
      );
    } finally {
      getDb().exec("ALTER TABLE unavailable_password_resets RENAME TO password_reset_requests");
      console.error = originalError;
    }
  });
});
