import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleApi } from "../lib/server/api";
import { getSessionUser, hashPassword, login, logout, rateLimit, signup } from "../lib/server/auth";
import {
  accountDeletionCookie,
  cancelAccountDeletion,
  completeAccountDeletion,
  verifyAccountDeletion,
} from "../lib/server/account-deletion";
import { closeDatabase, getDb, getToday, HttpError } from "../lib/server/db";
import { runNotifications } from "../lib/server/notifications";
import {
  completePasswordReset,
  processPasswordResetRequests,
  verifyPasswordReset,
} from "../lib/server/password-reset";
import {
  archiveSupplement,
  completeOnboarding,
  dashboard,
  getOnboarding,
  history,
  listSupplements,
  saveSupplement,
  setIntake,
  settings,
  updateSettings,
} from "../lib/server/service";

// Synthetic accounts and an isolated database. No real credentials, mail or APIs.
const environmentKeys = ["DATABASE_PATH", "EMAIL_MODE", "APP_URL", "NODE_ENV", "TRUST_PROXY"];
const originalFetch = globalThis.fetch;
const password = "deletion-test-password-123";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const future = (now: Date, seconds: number) => new Date(now.getTime() + seconds * 1000);
type Account = Awaited<ReturnType<typeof signup>>;
function assertHttpRejection(result: PromiseSettledResult<unknown>, status: number) {
  assert.equal(result.status, "rejected");
  if (result.status !== "rejected") assert.fail("Expected the concurrent request to reject");
  assert.ok(result.reason instanceof HttpError);
  assert.equal(result.reason.status, status);
}

describe("account deletion", () => {
  let directory: string;
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    closeDatabase();
    saved = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
    environmentKeys.forEach((key) => delete process.env[key]);
    directory = mkdtempSync(join(tmpdir(), "haru-delete-test-"));
    process.env.DATABASE_PATH = join(directory, "account.sqlite");
    process.env.EMAIL_MODE = "capture";
    process.env.APP_URL = "http://localhost:3000";
    globalThis.fetch = async () => {
      throw new Error("Unexpected external request in account-deletion test");
    };
  });
  afterEach(() => {
    closeDatabase();
    globalThis.fetch = originalFetch;
    environmentKeys.forEach((key) => {
      if (saved[key] === undefined) delete process.env[key];
      else (process.env as Record<string, string | undefined>)[key] = saved[key];
    });
    rmSync(directory, { force: true, recursive: true });
  });

  const account = (email = "delete-member@example.test") =>
    signup({ email, password, name: "탈퇴 테스트", age: 30 }, randomUUID());
  function request(session?: string, grant?: string, path = "/account/deletion/complete") {
    const headers = new Headers({ origin: "http://localhost:3000" });
    const cookies = [
      session ? `haru_session=${session}` : "",
      grant ? `haru_account_deletion=${grant}` : "",
    ].filter(Boolean);
    headers.set("cookie", cookies.join("; "));
    return new Request(`http://localhost:3000/api${path}`, { method: "POST", headers });
  }
  async function api(
    path: string,
    value: unknown = {},
    options: { session?: string; grant?: string; origin?: string; method?: string } = {},
  ) {
    const headers = new Headers(request(options.session, options.grant).headers);
    headers.set("content-type", "application/json");
    if (options.origin) headers.set("origin", options.origin);
    const method = options.method || "POST";
    const response = await handleApi(
      new Request(`http://localhost:3000/api${path}`, {
        method,
        headers,
        body: method === "GET" ? undefined : JSON.stringify(value),
      }),
    );
    const json = (await response.json()) as { data?: Record<string, unknown>; error?: string };
    return { response, json };
  }
  const authorize = (owner: Account, now?: Date) =>
    verifyAccountDeletion(request(owner.token), { password }, randomUUID(), { now });
  const erase = (owner: Account, grant: string, now?: Date) =>
    completeAccountDeletion(request(owner.token, grant), { confirmed: true }, "same-client", {
      now,
    });
  function resetRow(owner: Account, overrides: { userId?: string | null; status?: string } = {}) {
    const id = randomUUID();
    const now = new Date();
    getDb()
      .prepare(
        "INSERT INTO password_reset_requests(id,email_hash,user_id,code_hash,status,created_at,expires_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        id,
        digest(owner.user.email),
        overrides.userId === undefined ? owner.user.id : overrides.userId,
        "test-only-nonfunctional-hash",
        overrides.status || "queued",
        now.toISOString(),
        future(now, 600).toISOString(),
      );
    return id;
  }
  function seedData(owner: Account) {
    completeOnboarding(owner.user.id, { choice: "survey", answers: [0, 1, 0, 1, 0, 1, 0] });
    updateSettings(owner.user.id, {
      guardianEmail: `guardian-${owner.user.id}@example.test`,
      guardianEnabled: true,
      guardianConsent: true,
      delayMinutes: 5,
      guardianDelayMinutes: 5,
    });
    const product = saveSupplement(owner.user.id, {
      name: "활성 제품",
      brand: "테스트 제조사",
      color: "mint",
      times: ["00:00", "00:01"],
      ingredients: [{ name: "비타민 D", amount: 20, unit: "μg" }],
    });
    setIntake(owner.user.id, {
      scheduleId: product.schedules[0].id,
      date: getToday(),
      completed: true,
    });
    const archived = saveSupplement(owner.user.id, {
      name: "과거 제품",
      times: ["00:00"],
      ingredients: [{ name: "마그네슘", amount: 100, unit: "mg" }],
    });
    setIntake(owner.user.id, {
      scheduleId: archived.schedules[0].id,
      date: getToday(),
      completed: true,
    });
    archiveSupplement(owner.user.id, archived.id);
    for (const channel of ["user", "guardian"])
      getDb()
        .prepare(
          "INSERT INTO notification_logs(id,user_id,schedule_id,date,channel,status,recipient,subject,body,created_at,claimed_at,sent_at) VALUES(?,?,?,?,?,'captured',?,?,?,?,?,?)",
        )
        .run(
          randomUUID(),
          owner.user.id,
          product.schedules[1].id,
          getToday(),
          channel,
          "recipient@example.test",
          "테스트 안내",
          "개인 복용 항목의 완료가 확인되지 않았습니다.",
          new Date().toISOString(),
          new Date().toISOString(),
          new Date().toISOString(),
        );
    resetRow(owner);
    resetRow(owner, { userId: null, status: "invalidated" });
    return { product, archived };
  }
  function personalRows(owner: Account) {
    const db = getDb();
    return {
      users: db.prepare("SELECT * FROM users WHERE id=?").all(owner.user.id),
      sessions: db.prepare("SELECT * FROM sessions WHERE user_id=?").all(owner.user.id),
      supplements: db.prepare("SELECT * FROM supplements WHERE user_id=?").all(owner.user.id),
      ingredients: db
        .prepare(
          "SELECT i.* FROM supplement_ingredients i JOIN supplements s ON s.id=i.supplement_id WHERE s.user_id=?",
        )
        .all(owner.user.id),
      schedules: db
        .prepare(
          "SELECT i.* FROM intake_schedules i JOIN supplements s ON s.id=i.supplement_id WHERE s.user_id=?",
        )
        .all(owner.user.id),
      records: db.prepare("SELECT * FROM intake_records WHERE user_id=?").all(owner.user.id),
      guardian: db.prepare("SELECT * FROM guardian_settings WHERE user_id=?").all(owner.user.id),
      notifications: db
        .prepare("SELECT * FROM notification_logs WHERE user_id=?")
        .all(owner.user.id),
      resets: db
        .prepare("SELECT * FROM password_reset_requests WHERE user_id=? OR email_hash=?")
        .all(owner.user.id, digest(owner.user.email)),
      grants: db
        .prepare("SELECT * FROM account_deletion_grants WHERE user_id=?")
        .all(owner.user.id),
    };
  }

  test("unauthenticated, expired sessions and cross-origin requests cannot verify, cancel or delete", async () => {
    const owner = await account();
    for (const action of ["verify", "complete", "cancel"]) {
      const path = `/account/deletion/${action}`;
      const body = { password, confirmed: true };
      assert.equal((await api(path, body)).response.status, 401);
      assert.equal(
        (await api(path, body, { session: owner.token, origin: "https://untrusted.example" }))
          .response.status,
        403,
      );
    }
    getDb()
      .prepare("UPDATE sessions SET expires_at=? WHERE user_id=?")
      .run("2000-01-01T00:00:00.000Z", owner.user.id);
    assert.equal(
      (await api("/account/deletion/verify", { password }, { session: owner.token })).response
        .status,
      401,
    );
    assert.equal(getDb().prepare("SELECT COUNT(*) AS total FROM users").get()!.total, 1);
    assert.deepEqual(getDb().prepare("SELECT * FROM account_deletion_grants").all(), []);
  });

  test("wrong passwords produce a generic error without logout or a grant and account retries are bounded", async () => {
    const owner = await account();
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await api(
        "/account/deletion/verify",
        { password: "wrong-password-123" },
        { session: owner.token },
      );
      assert.equal(result.response.status, 400);
      assert.equal(result.json.error, "비밀번호가 올바르지 않습니다.");
      assert.equal(result.response.headers.getSetCookie().length, 0);
    }
    assert.equal(
      (await api("/account/deletion/verify", { password }, { session: owner.token })).response
        .status,
      429,
    );
    assert.equal(getSessionUser(owner.token)?.id, owner.user.id);
    assert.deepEqual(getDb().prepare("SELECT * FROM account_deletion_grants").all(), []);
  });

  test("the shared IP limit remains effective across accounts", async () => {
    const owner = await account();
    for (let attempt = 0; attempt < 20; attempt++) rateLimit("delete-verify-ip:local", 20, 900);
    assert.equal(
      (await api("/account/deletion/verify", { password }, { session: owner.token })).response
        .status,
      429,
    );
    assert.equal(getSessionUser(owner.token)?.id, owner.user.id);
  });

  test("verification returns only a secure scoped cookie and a hash stored for five minutes", async () => {
    const owner = await account();
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    const verified = await api("/account/deletion/verify", { password }, { session: owner.token });
    assert.equal(verified.response.status, 200);
    assert.deepEqual(verified.json.data, { verified: true, expiresIn: 300 });
    const cookie = verified.response.headers.getSetCookie()[0];
    assert.match(
      cookie,
      /^haru_account_deletion=[A-Za-z0-9_-]{43}; Path=\/api\/account\/deletion; HttpOnly; SameSite=Lax; Max-Age=300; Secure$/,
    );
    const token = cookie.split(";")[0].split("=")[1];
    const row = getDb().prepare("SELECT * FROM account_deletion_grants").get()!;
    assert.equal(row.token_hash, digest(token));
    assert.equal(row.session_hash, digest(owner.token));
    assert.equal(Date.parse(String(row.expires_at)) - Date.parse(String(row.created_at)), 300_000);
    assert.equal(JSON.stringify(row).includes(token), false);
    assert.equal(JSON.stringify(row).includes(password), false);
  });

  test("final confirmation and the same session's grant are both required, never a supplied user id", async () => {
    const owner = await account();
    const other = await account("other@example.test");
    const verified = await authorize(owner);
    const secondSession = await login({ email: owner.user.email, password }, randomUUID());
    for (const confirmed of [undefined, false, "true", 1])
      assert.equal(
        (
          await api(
            "/account/deletion/complete",
            { confirmed },
            { session: owner.token, grant: verified.token },
          )
        ).response.status,
        400,
      );
    assert.equal(
      (await api("/account/deletion/complete", { confirmed: true }, { session: owner.token }))
        .response.status,
      400,
    );
    assert.equal(
      (
        await api(
          "/account/deletion/complete",
          { confirmed: true, user_id: owner.user.id },
          { session: other.token, grant: verified.token },
        )
      ).response.status,
      400,
    );
    assert.equal(
      (
        await api(
          "/account/deletion/complete",
          { confirmed: true },
          { session: secondSession.token, grant: verified.token },
        )
      ).response.status,
      400,
    );
    const result = await api(
      "/account/deletion/complete",
      { confirmed: true, user_id: other.user.id, id: other.user.id },
      { session: owner.token, grant: verified.token },
    );
    assert.equal(result.response.status, 200);
    assert.equal(getSessionUser(owner.token), null);
    assert.equal(getSessionUser(other.token)?.id, other.user.id);
  });

  test("complete deletion erases every personal table and all sessions while preserving another user byte for byte", async () => {
    const owner = await account();
    const other = await account("other@example.test");
    seedData(owner);
    seedData(other);
    const secondSession = await login({ email: owner.user.email, password }, "second-browser");
    const verified = await authorize(owner);
    await authorize(other);
    const otherBefore = personalRows(other);
    assert.ok(Object.values(personalRows(owner)).every((rows) => rows.length > 0));
    const deleted = await api(
      "/account/deletion/complete",
      { confirmed: true },
      { session: owner.token, grant: verified.token },
    );
    assert.equal(deleted.response.status, 200);
    assert.deepEqual(deleted.json.data, { deleted: true });
    const cookies = deleted.response.headers.getSetCookie();
    assert.equal(cookies.length, 3);
    for (const name of ["haru_session", "haru_password_reset", "haru_account_deletion"])
      assert.ok(
        cookies.some((cookie) => cookie.startsWith(`${name}=;`) && cookie.includes("Max-Age=0")),
      );
    for (const [name, rows] of Object.entries(personalRows(owner)))
      assert.equal(rows.length, 0, name);
    assert.deepEqual(personalRows(other), otherBefore);
    assert.equal(getSessionUser(owner.token), null);
    assert.equal(getSessionUser(secondSession.token), null);
    assert.equal(getSessionUser(other.token)?.id, other.user.id);
    assert.deepEqual(getDb().prepare("PRAGMA foreign_key_check").all(), []);
    for (const path of [
      "/me",
      "/dashboard",
      "/history",
      "/supplements",
      "/settings",
      "/onboarding",
    ])
      assert.equal(
        (await api(path, {}, { session: secondSession.token, method: "GET" })).response.status,
        401,
      );
    assert.equal(
      (await api("/auth/login", { email: owner.user.email, password })).response.status,
      401,
    );
  });

  test("owned rate buckets are erased across IPs while shared IP/provider limits remain", async () => {
    const owner = await account();
    const other = await account("other@example.test");
    await login({ email: owner.user.email, password }, "browser-a");
    await login({ email: owner.user.email, password }, "browser-b");
    await login({ email: other.user.email, password }, "browser-a");
    const personal = [
      `reset-email-cooldown:${owner.user.email}`,
      `reset-email-hour:${owner.user.email}`,
      `products-user:${owner.user.id}`,
      `notification-preview:${owner.user.id}`,
    ];
    personal.forEach((bucket) => rateLimit(bucket, 5, 60));
    rateLimit("food-safety:test-provider-hash", 80, 3600);
    const verified = await authorize(owner);
    erase(owner, verified.token);
    for (const bucket of [
      ...personal,
      `login:${owner.user.email}:browser-a`,
      `login:${owner.user.email}:browser-b`,
      `login-account:${owner.user.email}`,
      `delete-verify-user:${owner.user.id}`,
    ])
      assert.equal(
        getDb().prepare("SELECT 1 FROM auth_attempts WHERE bucket=?").get(digest(bucket)),
        undefined,
      );
    for (const bucket of [
      "login-global:browser-a",
      "login-global:browser-b",
      "food-safety:test-provider-hash",
      "delete-complete-ip:same-client",
      `login:${other.user.email}:browser-a`,
    ])
      assert.ok(getDb().prepare("SELECT 1 FROM auth_attempts WHERE bucket=?").get(digest(bucket)));
    assert.deepEqual(
      getDb()
        .prepare("SELECT 1 FROM auth_attempts WHERE owner_hash IN (?,?)")
        .all(digest(`user:${owner.user.id}`), digest(`email:${owner.user.email}`)),
      [],
    );
  });

  test("deletion leaves no user or guardian reminder targets and queued reset work cannot send", async () => {
    const owner = await account();
    seedData(owner);
    const verified = await authorize(owner);
    erase(owner, verified.token);
    const now = new Date(`${getToday()}T23:59:00+09:00`);
    const reminders = await runNotifications({ now });
    assert.equal(reminders.checked, 0);
    assert.equal(reminders.sent, 0);
    assert.equal(reminders.captured, 0);
    const resets = await processPasswordResetRequests();
    assert.equal(resets.checked, 0);
    assert.equal(resets.accepted, 0);
    assert.deepEqual(getDb().prepare("SELECT * FROM notification_logs").all(), []);
  });

  test("the same email can rejoin as a new account without restored settings, survey or records", async () => {
    const owner = await account();
    seedData(owner);
    const verified = await authorize(owner);
    erase(owner, verified.token);
    const fresh = await account(owner.user.email);
    assert.notEqual(fresh.user.id, owner.user.id);
    assert.equal(fresh.user.onboarded, false);
    assert.deepEqual(listSupplements(fresh.user.id), []);
    assert.equal(dashboard(fresh.user.id).total, 0);
    assert.ok(history(fresh.user.id).days.every((day) => day.items.length === 0));
    assert.equal(getOnboarding(fresh.user.id).answers, null);
    assert.equal(settings(fresh.user.id).guardianEmail, "");
    assert.equal(settings(fresh.user.id).guardianEnabled, false);
    assert.deepEqual(personalRows(fresh).resets, []);
    assert.equal(getSessionUser(owner.token), null);
  });

  test("a database failure rolls back children, sessions and grant, returns a safe error, and permits retry", async () => {
    const owner = await account();
    seedData(owner);
    const verified = await authorize(owner);
    const before = personalRows(owner);
    getDb().exec(
      "CREATE TRIGGER block_deletion BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT, 'synthetic-private-SQL-error'); END",
    );
    const originalError = console.error;
    const logged: unknown[][] = [];
    console.error = (...values) => {
      logged.push(values);
    };
    try {
      const failed = await api(
        "/account/deletion/complete",
        { confirmed: true },
        { session: owner.token, grant: verified.token },
      );
      assert.equal(failed.response.status, 500);
      assert.equal(
        failed.json.error,
        "회원 탈퇴 처리 중 문제가 발생했습니다. 잠시 후 다시 시도해주세요.",
      );
      assert.equal(failed.response.headers.getSetCookie().length, 0);
      assert.equal(JSON.stringify(logged).includes("synthetic-private-SQL-error"), false);
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(personalRows(owner), before);
    assert.equal(getSessionUser(owner.token)?.id, owner.user.id);
    getDb().exec("DROP TRIGGER block_deletion");
    assert.deepEqual(erase(owner, verified.token), { deleted: true });
  });

  test("grants expire exactly after five minutes and re-verification invalidates the prior grant", async () => {
    const owner = await account();
    const now = new Date();
    const verified = await authorize(owner, now);
    assert.throws(
      () => erase(owner, verified.token, future(now, 300)),
      (error: unknown) => error instanceof HttpError && error.status === 400,
    );
    const first = await authorize(owner);
    const second = await authorize(owner);
    assert.throws(
      () => erase(owner, first.token),
      (error: unknown) => error instanceof HttpError && error.status === 400,
    );
    assert.deepEqual(erase(owner, second.token), { deleted: true });
  });

  test("cancel clears only the current session's grant and preserves the account", async () => {
    const owner = await account();
    const second = await login({ email: owner.user.email, password }, randomUUID());
    const verified = await authorize(owner);
    const secondGrant = await authorize(second);
    const cancelled = await api(
      "/account/deletion/cancel",
      {},
      { session: owner.token, grant: verified.token },
    );
    assert.equal(cancelled.response.status, 200);
    assert.deepEqual(cancelled.json.data, { cancelled: true });
    assert.deepEqual(cancelled.response.headers.getSetCookie(), [accountDeletionCookie("")]);
    assert.equal(getSessionUser(owner.token)?.id, owner.user.id);
    assert.throws(
      () => erase(owner, verified.token),
      (error: unknown) => error instanceof HttpError && error.status === 400,
    );
    assert.deepEqual(erase(second, secondGrant.token), { deleted: true });
  });

  test("cancel invalidates verification already awaiting scrypt and cannot be undone by its late response", async () => {
    const owner = await account();
    const previous = await authorize(owner);
    const pending = Promise.allSettled([authorize(owner)]);
    const reserved = getDb().prepare("SELECT password_version FROM account_deletion_grants").get()!;
    assert.equal(reserved.password_version, "");
    assert.throws(
      () => erase(owner, previous.token),
      (error: unknown) => error instanceof HttpError && error.status === 400,
    );
    assert.deepEqual(cancelAccountDeletion(request(owner.token)), { cancelled: true });
    assertHttpRejection((await pending)[0], 400);
    assert.deepEqual(getDb().prepare("SELECT * FROM account_deletion_grants").all(), []);
    assert.throws(
      () => erase(owner, previous.token),
      (error: unknown) => error instanceof HttpError && error.status === 400,
    );
    assert.equal(getSessionUser(owner.token)?.id, owner.user.id);
  });

  test("concurrent re-verification only authorizes the newest attempt and a wrong earlier attempt cannot clear it", async () => {
    const owner = await account();
    const first = authorize(owner);
    const second = authorize(owner);
    const outcomes = await Promise.allSettled([first, second]);
    assert.equal(outcomes[0].status, "rejected");
    assert.equal(outcomes[1].status, "fulfilled");
    assert.equal(
      getDb().prepare("SELECT COUNT(*) AS total FROM account_deletion_grants").get()!.total,
      1,
    );

    const wrong = verifyAccountDeletion(
      request(owner.token),
      { password: "wrong-password-456" },
      randomUUID(),
    );
    const newest = authorize(owner);
    const next = await Promise.allSettled([wrong, newest]);
    assert.equal(next[0].status, "rejected");
    assert.equal(next[1].status, "fulfilled");
    if (next[1].status !== "fulfilled") assert.fail("Newest verification must succeed");
    assert.deepEqual(erase(owner, next[1].value.token), { deleted: true });
  });

  test("logout during password verification prevents a grant and password changes invalidate verified grants", async () => {
    const owner = await account();
    const pending = Promise.allSettled([authorize(owner)]);
    logout(request(owner.token));
    assertHttpRejection((await pending)[0], 401);
    assert.deepEqual(getDb().prepare("SELECT * FROM account_deletion_grants").all(), []);
    const current = await login({ email: owner.user.email, password }, randomUUID());
    const grant = await authorize(current);
    const replacement = await hashPassword("changed-password-456");
    getDb().prepare("UPDATE users SET password_hash=? WHERE id=?").run(replacement, owner.user.id);
    assert.throws(
      () => erase(current, grant.token),
      (error: unknown) => error instanceof HttpError && error.status === 400,
    );
    assert.equal(getSessionUser(current.token)?.id, owner.user.id);
  });

  test("a password change during verification is rechecked after scrypt before minting a grant", async () => {
    const owner = await account();
    const replacement = await hashPassword("changed-password-456");
    const pending = Promise.allSettled([authorize(owner)]);
    getDb().prepare("UPDATE users SET password_hash=? WHERE id=?").run(replacement, owner.user.id);
    assertHttpRejection((await pending)[0], 400);
    assert.deepEqual(getDb().prepare("SELECT * FROM account_deletion_grants").all(), []);
  });

  test("concurrent completion is single-use and an old-password login cannot revive a deleted account", async () => {
    const owner = await account();
    const verified = await authorize(owner);
    // Observe rejection before waiting for deletion; scrypt can finish in either order.
    const pendingLogin = Promise.allSettled([
      login({ email: owner.user.email, password }, "racing-login"),
    ]);
    const deleted = await Promise.all([
      api(
        "/account/deletion/complete",
        { confirmed: true },
        { session: owner.token, grant: verified.token },
      ),
      api(
        "/account/deletion/complete",
        { confirmed: true },
        { session: owner.token, grant: verified.token },
      ),
    ]);
    assert.deepEqual(deleted.map((result) => result.response.status).sort(), [200, 401]);
    assertHttpRejection((await pendingLogin)[0], 401);
    assert.deepEqual(getDb().prepare("SELECT * FROM users").all(), []);
    assert.deepEqual(getDb().prepare("SELECT * FROM sessions").all(), []);
  });

  test("reset verification and password replacement in flight fail safely when deletion removes their rows", async () => {
    const owner = await account();
    const code = "123456";
    const codeHash = await hashPassword(code);
    const id = resetRow(owner, { status: "sent" });
    getDb().prepare("UPDATE password_reset_requests SET code_hash=? WHERE id=?").run(codeHash, id);
    const grantedReset = resetRow(owner, { status: "verified" });
    const resetToken = "x".repeat(43);
    getDb()
      .prepare(
        "UPDATE password_reset_requests SET reset_token_hash=?,reset_expires_at=? WHERE id=?",
      )
      .run(digest(resetToken), future(new Date(), 300).toISOString(), grantedReset);
    const verified = await authorize(owner);
    // Attach both rejection handlers in the same turn. Sequential assert.rejects
    // awaits leave the second request unobserved if its scrypt finishes first.
    const pendingResets = Promise.allSettled([
      verifyPasswordReset({ email: owner.user.email, requestId: id, code }, randomUUID()),
      completePasswordReset(
        { password: "new-password-456", passwordConfirm: "new-password-456" },
        resetToken,
        randomUUID(),
      ),
    ]);
    erase(owner, verified.token);
    const [verification, replacement] = await pendingResets;
    assertHttpRejection(verification, 400);
    assertHttpRejection(replacement, 400);
    assert.deepEqual(getDb().prepare("SELECT * FROM password_reset_requests").all(), []);
    assert.deepEqual(getDb().prepare("SELECT * FROM users").all(), []);
  });

  test("v4 migration preserves existing accounts and rate rows while adding the deletion grant schema", async () => {
    const owner = await account();
    seedData(owner);
    const before = personalRows(owner);
    const rateBefore = getDb().prepare("SELECT bucket,count,expires_at FROM auth_attempts").all();
    getDb().exec(
      "DROP TABLE account_deletion_grants; DROP INDEX attempts_owner; ALTER TABLE auth_attempts DROP COLUMN owner_hash; PRAGMA user_version=4",
    );
    closeDatabase();
    assert.equal(getDb().prepare("PRAGMA user_version").get()!.user_version, 5);
    assert.deepEqual(personalRows(owner), before);
    assert.deepEqual(
      getDb().prepare("SELECT bucket,count,expires_at FROM auth_attempts").all(),
      rateBefore,
    );
    assert.ok(
      getDb()
        .prepare("PRAGMA table_info(auth_attempts)")
        .all()
        .some((column) => column.name === "owner_hash"),
    );
    assert.equal(getSessionUser(owner.token)?.id, owner.user.id);
  });
});
