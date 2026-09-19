import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { handleApi } from "../lib/server/api";
import { getSessionUser } from "../lib/server/auth";
import {
  closeDatabase,
  getDb,
  getToday,
  HttpError,
  scheduledInstant,
  shiftDate,
} from "../lib/server/db";
import { runNotifications } from "../lib/server/notifications";
import {
  archiveSupplement,
  dailyItems,
  dashboard,
  getOnboarding,
  history,
  listSupplements,
  listNotifications,
  saveSupplement,
  setIntake,
  settings,
  streak,
  updateSettings,
  validateSupplement,
} from "../lib/server/service";
import type { Supplement, User } from "../lib/types";
import { duplicateGroups } from "../lib/domain";

// Every test uses its own on-disk database. No real provider or real email is contacted.
const environmentKeys = [
  "DATABASE_PATH",
  "EMAIL_MODE",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "APP_URL",
  "CRON_SECRET",
  "TRUST_PROXY",
  "NODE_ENV",
] as const;
let savedEnvironment: Partial<Record<(typeof environmentKeys)[number], string>>;
let temporaryDirectory: string;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  closeDatabase();
  savedEnvironment = {};
  environmentKeys.forEach((key) => {
    if (process.env[key] !== undefined) savedEnvironment[key] = process.env[key];
    delete process.env[key];
  });
  temporaryDirectory = mkdtempSync(join(tmpdir(), "haru-server-test-"));
  process.env.DATABASE_PATH = join(temporaryDirectory, "test.sqlite");
  process.env.EMAIL_MODE = "capture";
  process.env.APP_URL = "http://localhost:3000";
  // Fail immediately if any test unexpectedly tries to reach the internet.
  globalThis.fetch = async () => {
    throw new Error("Unexpected network request in server test");
  };
});
afterEach(() => {
  closeDatabase();
  globalThis.fetch = originalFetch;
  environmentKeys.forEach((key) => {
    if (savedEnvironment[key] === undefined) delete process.env[key];
    else (process.env as Record<string, string | undefined>)[key] = savedEnvironment[key];
  });
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

async function api<T = Record<string, unknown>>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    cookie?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const headers = new Headers({ origin: "http://localhost:3000", ...options.headers });
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.cookie) headers.set("cookie", options.cookie);
  const response = await handleApi(
    new Request(`http://localhost:3000/api${path}`, {
      method: options.method || "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    }),
  );
  return { response, payload: (await response.json()) as { data: T; error?: string } };
}
async function account(email = "member@example.com") {
  const result = await api<{ user: User }>("/auth/signup", {
    method: "POST",
    body: { email, password: "valid-password-123", name: "테스터", age: 30 },
  });
  assert.equal(result.response.status, 201, result.payload.error);
  const cookie = result.response.headers.get("set-cookie")!.split(";")[0];
  return { user: result.payload.data.user, cookie, response: result.response };
}
const input = (overrides: Record<string, unknown> = {}) => ({
  name: "종합비타민",
  brand: "하루",
  color: "mint",
  ingredients: [{ name: "비타민 D", amount: 20, unit: "μg" }],
  times: ["09:00"],
  ...overrides,
});
const at = (time: string) => new Date(`${getToday()}T${time}:00+09:00`);
const later = (now: Date, minutes: number) => new Date(now.getTime() + minutes * 60_000);
function liveMode() {
  process.env.EMAIL_MODE = "resend";
  process.env.RESEND_API_KEY = "test-only-key-never-send";
  process.env.EMAIL_FROM = "Haru <noreply@example.com>";
}
function guardian(userId: string) {
  return updateSettings(userId, {
    guardianEmail: "guardian@example.com",
    guardianEnabled: true,
    guardianConsent: true,
    guardianDelayMinutes: 5,
  });
}
function logRows() {
  return getDb().prepare("SELECT * FROM notification_logs ORDER BY created_at,channel").all() as {
    id: string;
    status: string;
    channel: string;
    sent_at: string | null;
    error: string | null;
    attempts: number;
  }[];
}

test("signup persists hashed credentials and sessions; login, expiration and logout work", async () => {
  const { user, cookie, response } = await account();
  assert.match(response.headers.get("set-cookie")!, /HttpOnly; SameSite=Lax/);
  assert.equal(response.headers.get("cache-control"), "no-store, private");
  const stored = getDb().prepare("SELECT password_hash FROM users WHERE id=?").get(user.id) as {
    password_hash: string;
  };
  assert.notEqual(stored.password_hash, "valid-password-123");
  assert.match(stored.password_hash, /^[0-9a-f]+:[0-9a-f]+$/);
  const session = getDb().prepare("SELECT token_hash FROM sessions").get() as {
    token_hash: string;
  };
  assert.notEqual(session.token_hash, cookie.split("=")[1]);
  closeDatabase();
  assert.equal(
    (await api("/me", { cookie })).response.status,
    200,
    "session survives database reopening",
  );
  assert.equal(
    (
      await api("/auth/signup", {
        method: "POST",
        body: {
          email: "MEMBER@example.com",
          password: "valid-password-123",
          name: "중복",
          age: 30,
        },
      })
    ).response.status,
    409,
  );
  assert.equal(
    (
      await api("/auth/login", {
        method: "POST",
        body: { email: user.email, password: "incorrect-password" },
      })
    ).response.status,
    401,
  );
  const signedIn = await api<{ user: User }>("/auth/login", {
    method: "POST",
    body: { email: "MEMBER@EXAMPLE.COM", password: "valid-password-123" },
  });
  assert.equal(signedIn.payload.data.user.id, user.id);
  await api("/auth/logout", { method: "POST", cookie });
  assert.equal((await api("/me", { cookie })).response.status, 401);
  getDb().prepare("UPDATE sessions SET expires_at='2000-01-01T00:00:00.000Z'").run();
  const nextCookie = signedIn.response.headers.get("set-cookie")!.split(";")[0];
  assert.equal((await api("/me", { cookie: nextCookie })).response.status, 401);
});

test("cross-origin writes, invalid bodies and repeated login attempts are rejected", async () => {
  assert.equal(
    (
      await api("/auth/signup", {
        method: "POST",
        headers: { origin: "https://evil.example" },
        body: { email: "x@example.com" },
      })
    ).response.status,
    403,
  );
  assert.equal(
    (
      await api("/auth/signup", {
        method: "POST",
        headers: { "sec-fetch-site": "cross-site" },
        body: {},
      })
    ).response.status,
    403,
  );
  assert.equal(
    (
      await handleApi(
        new Request("http://localhost:3000/api/auth/signup", {
          method: "POST",
          body: "email=x@example.com",
        }),
      )
    ).status,
    415,
  );
  assert.equal(
    (
      await api("/auth/signup", {
        method: "POST",
        body: { email: "invalid", name: "a", age: 30, password: "short" },
      })
    ).response.status,
    400,
  );
  assert.equal(
    (await api("/auth/signup", { method: "POST", body: { text: "x".repeat(70_000) } })).response
      .status,
    413,
  );
  await account();
  for (let i = 0; i < 10; i++)
    assert.equal(
      (
        await api("/auth/login", {
          method: "POST",
          body: { email: "member@example.com", password: "incorrect-password" },
        })
      ).response.status,
      401,
    );
  assert.equal(
    (
      await api("/auth/login", {
        method: "POST",
        body: { email: "member@example.com", password: "valid-password-123" },
      })
    ).response.status,
    429,
  );
});

test("every product and intake mutation enforces account ownership", async () => {
  const owner = await account();
  const outsider = await account("outsider@example.com");
  const created = await api<Supplement>("/supplements", {
    method: "POST",
    cookie: owner.cookie,
    body: input(),
  });
  assert.equal(created.response.status, 201);
  const supplement = created.payload.data;
  assert.deepEqual(
    (await api<Supplement[]>("/supplements", { cookie: outsider.cookie })).payload.data,
    [],
  );
  for (const method of ["GET", "PUT", "DELETE"])
    assert.equal(
      (
        await api(`/supplements/${supplement.id}`, {
          method,
          cookie: outsider.cookie,
          body: method === "PUT" ? input() : undefined,
        })
      ).response.status,
      404,
    );
  assert.equal(
    (
      await api("/intakes", {
        method: "PUT",
        cookie: outsider.cookie,
        body: { scheduleId: supplement.schedules[0].id, date: getToday(), completed: true },
      })
    ).response.status,
    404,
  );
  assert.equal((await api("/supplements")).response.status, 401);
  assert.equal(dashboard(owner.user.id).total, 1);
  assert.equal(dashboard(outsider.user.id).total, 0);
});

test("ingredient/time validation rejects invalid input and SQL-like names remain ordinary data", async () => {
  const { user } = await account();
  for (const overrides of [
    { times: ["24:00"] },
    { times: ["09:00", "09:00"] },
    { times: [] },
    { ingredients: [] },
    { ingredients: [{ name: "아연", amount: -1, unit: "mg" }] },
    { ingredients: [{ name: "아연", amount: Infinity, unit: "mg" }] },
    { ingredients: [{ name: "아연", amount: 10, unit: "unsupported" }] },
    {
      ingredients: [
        { name: "비타민 D", amount: 1, unit: "μg" },
        { name: "비타민D", amount: 2, unit: "μg" },
      ],
    },
  ])
    assert.throws(() => saveSupplement(user.id, input(overrides)), HttpError);
  const item = saveSupplement(
    user.id,
    input({ name: "D'); DROP TABLE users;--", times: ["21:30", "09:00"] }),
  );
  assert.equal(item.name, "D'); DROP TABLE users;--");
  assert.deepEqual(item.times, ["09:00", "21:30"]);
  assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n, 1);
});

test("today intake is idempotent, reversible, stored on disk, and cannot predate its schedule", async () => {
  const { user } = await account();
  const item = saveSupplement(user.id, input({ times: ["09:00", "20:00"] }));
  const scheduleId = item.schedules[0].id;
  const first = setIntake(user.id, { scheduleId, date: getToday(), completed: true });
  assert.equal(
    setIntake(user.id, { scheduleId, date: getToday(), completed: true }).completedAt,
    first.completedAt,
  );
  closeDatabase();
  assert.equal(dashboard(user.id).completed, 1);
  assert.equal(dashboard(user.id).total, 2);
  assert.throws(
    () => setIntake(user.id, { scheduleId, date: shiftDate(getToday(), -1), completed: true }),
    HttpError,
  );
  assert.equal(
    history(user.id)
      .days.slice(0, 6)
      .every((day) => day.total === 0),
    true,
  );
  setIntake(user.id, { scheduleId, date: getToday(), completed: false });
  assert.equal(dashboard(user.id).completed, 0);
});

test("editing schedules preserves yesterday's snapshots and completed-today edits start tomorrow", async () => {
  const { user } = await account();
  const today = getToday();
  const yesterday = shiftDate(today, -1);
  const first = saveSupplement(user.id, input());
  getDb()
    .prepare("UPDATE intake_schedules SET start_date=? WHERE supplement_id=?")
    .run(yesterday, first.id);
  const second = saveSupplement(
    user.id,
    input({ name: "새 제품", times: ["10:00", "20:00"] }),
    first.id,
  );
  assert.equal(dailyItems(user.id, yesterday)[0].name, "종합비타민");
  assert.equal(dailyItems(user.id, yesterday)[0].time, "09:00");
  assert.deepEqual(
    dailyItems(user.id, today).map((slot) => slot.time),
    ["10:00", "20:00"],
  );
  setIntake(user.id, { scheduleId: second.schedules[0].id, date: today, completed: true });
  const third = saveSupplement(user.id, input({ name: "내일부터", times: ["12:00"] }), first.id);
  assert.equal(third.scheduleChangeEffectiveDate, shiftDate(today, 1));
  assert.deepEqual(
    dailyItems(user.id, today).map((slot) => slot.time),
    ["10:00", "20:00"],
  );
  assert.equal(dailyItems(user.id, today)[0].name, "새 제품");
  saveSupplement(user.id, input({ name: "다시 수정", times: ["13:00"] }), first.id);
  assert.deepEqual(
    dailyItems(user.id, shiftDate(today, 1)).map((slot) => slot.time),
    ["13:00"],
  );
  archiveSupplement(user.id, first.id);
  assert.equal(
    dailyItems(user.id, today).length,
    0,
    "archived products never remain in active daily items",
  );
  assert.ok(dailyItems(user.id, today, "history")[0].completedAt);
  assert.equal(dailyItems(user.id, tomorrow(today)).length, 0);
  assert.equal(dailyItems(user.id, yesterday, "history").length, 1);
});
function tomorrow(date: string) {
  return shiftDate(date, 1);
}

test("Korean date boundaries and streaks preserve yesterday while today is unfinished", async () => {
  assert.equal(getToday(new Date("2026-09-18T14:59:59Z")), "2026-09-18");
  assert.equal(getToday(new Date("2026-09-18T15:00:00Z")), "2026-09-19");
  assert.equal(scheduledInstant("2026-01-01", "00:00").toISOString(), "2025-12-31T15:00:00.000Z");
  assert.equal(shiftDate("2024-02-28", 1), "2024-02-29");
  const { user } = await account();
  const item = saveSupplement(user.id, input());
  const today = getToday();
  getDb()
    .prepare("UPDATE intake_schedules SET start_date=? WHERE supplement_id=?")
    .run(shiftDate(today, -3), item.id);
  for (const offset of [-2, -1])
    getDb()
      .prepare(
        "INSERT INTO intake_records(id,user_id,schedule_id,date,completed_at) VALUES(?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        user.id,
        item.schedules[0].id,
        shiftDate(today, offset),
        new Date().toISOString(),
      );
  assert.equal(streak(user.id), 2);
  setIntake(user.id, { scheduleId: item.schedules[0].id, date: today, completed: true });
  assert.equal(streak(user.id), 3);
  assert.deepEqual(
    history(user.id)
      .days.slice(-3)
      .map((day) => day.rate),
    [100, 100, 100],
  );
});

test("guardian enrollment requires explicit consent and changed email requires renewed consent", async () => {
  const { user } = await account();
  assert.throws(
    () => updateSettings(user.id, { guardianEmail: "guardian@example.com", guardianEnabled: true }),
    HttpError,
  );
  assert.equal(settings(user.id).guardianEmail, "");
  assert.ok(guardian(user.id).guardianConsentedAt);
  assert.throws(
    () => updateSettings(user.id, { guardianEmail: "another@example.com", guardianEnabled: true }),
    HttpError,
  );
  assert.equal(settings(user.id).guardianEmail, "guardian@example.com");
  const revoked = updateSettings(user.id, { guardianConsent: false });
  assert.equal(revoked.guardianEnabled, false);
  assert.equal(revoked.guardianConsentedAt, null);
  assert.throws(() => updateSettings(user.id, { guardianEnabled: true }), HttpError);
  guardian(user.id);
  const cleared = updateSettings(user.id, { guardianEmail: "" });
  assert.equal(cleared.guardianEnabled, false);
  assert.equal(cleared.guardianConsentedAt, null);
});

test("survey answers are validated and persisted for a later results page", async () => {
  const { user, cookie } = await account();
  assert.equal(
    (await api("/onboarding", { method: "POST", cookie, body: { choice: "survey", answers: [1] } }))
      .response.status,
    400,
  );
  const answers = [0, 1, 2, 0, 1, 2, 0];
  assert.equal(
    (await api("/onboarding", { method: "POST", cookie, body: { choice: "survey", answers } }))
      .response.status,
    200,
  );
  closeDatabase();
  assert.deepEqual(getOnboarding(user.id), { onboarded: true, choice: "survey", answers });
  assert.deepEqual((await api("/onboarding", { cookie })).payload.data.answers, answers);
});

test("capture respects due time and concurrent checks generate only one unsent log", async () => {
  const { user } = await account();
  saveSupplement(user.id, input());
  assert.equal((await runNotifications({ userId: user.id, now: at("09:29") })).captured, 0);
  const results = await Promise.all(
    Array.from({ length: 8 }, () => runNotifications({ userId: user.id, now: at("09:30") })),
  );
  assert.equal(
    results.reduce((sum, result) => sum + result.captured, 0),
    1,
  );
  assert.equal(logRows().length, 1);
  assert.equal(logRows()[0].status, "captured");
  assert.equal(logRows()[0].sent_at, null);
  assert.match(
    (listNotifications(user.id)[0] as { body: string }).body,
    /복용 완료가 아직 확인되지 않았습니다/,
  );
});

test("guardian capture waits from user notification and revocation prevents further delivery", async () => {
  const { user } = await account();
  saveSupplement(user.id, input());
  guardian(user.id);
  const now = at("10:00");
  assert.equal((await runNotifications({ userId: user.id, now })).captured, 1);
  assert.equal((await runNotifications({ userId: user.id, now: later(now, 4) })).captured, 0);
  assert.equal((await runNotifications({ userId: user.id, now: later(now, 5) })).captured, 1);
  assert.deepEqual(
    logRows().map((log) => log.status),
    ["captured", "captured"],
  );
  const next = saveSupplement(user.id, input({ name: "두번째" }));
  assert.equal((await runNotifications({ userId: user.id, now })).captured, 1);
  updateSettings(user.id, { guardianEnabled: false });
  await runNotifications({ userId: user.id, now: later(now, 10) });
  assert.equal(
    (
      getDb()
        .prepare(
          "SELECT COUNT(*) AS n FROM notification_logs WHERE schedule_id=? AND channel='guardian'",
        )
        .get(next.schedules[0].id) as { n: number }
    ).n,
    0,
  );
});

test("completing or archiving an item suppresses reminders and preview is scoped to its user", async () => {
  const owner = await account();
  const other = await account("other@example.com");
  const complete = saveSupplement(owner.user.id, input());
  const archived = saveSupplement(owner.user.id, input({ name: "삭제" }));
  const pending = saveSupplement(owner.user.id, input({ name: "아직 미확인" }));
  saveSupplement(other.user.id, input());
  setIntake(owner.user.id, {
    scheduleId: complete.schedules[0].id,
    date: getToday(),
    completed: true,
  });
  archiveSupplement(owner.user.id, archived.id);
  assert.equal((await runNotifications({ userId: owner.user.id, now: at("10:00") })).captured, 1);
  assert.equal(listNotifications(other.user.id).length, 0);
  assert.equal(
    (listNotifications(owner.user.id)[0] as { scheduleId: string }).scheduleId,
    pending.schedules[0].id,
  );
});

test("live email fails closed on missing configuration and cron requires its own secret", async () => {
  const { user, cookie } = await account();
  saveSupplement(user.id, input());
  process.env.EMAIL_MODE = "resend";
  await assert.rejects(runNotifications({ now: at("10:00") }), { status: 503 });
  assert.equal(logRows().length, 0);
  assert.equal(
    (await api("/notifications/preview", { method: "POST", cookie })).response.status,
    503,
  );
  process.env.CRON_SECRET = "strong-test-cron-secret-123456789";
  assert.equal((await api("/cron/notifications")).response.status, 401);
  assert.equal((await api("/cron/notifications", { cookie })).response.status, 401);
  process.env.EMAIL_MODE = "capture";
  assert.equal(
    (
      await api("/cron/notifications", {
        headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
      })
    ).response.status,
    200,
  );
});

test("Resend success uses stable idempotency and concurrent workers submit exactly once", async () => {
  const { user } = await account();
  const item = saveSupplement(user.id, input());
  guardian(user.id);
  liveMode();
  const requests: { key: string; to: string[]; text: string }[] = [];
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "https://api.resend.com/emails");
    const payload = JSON.parse(String(options?.body)) as { to: string[]; text: string };
    requests.push({ key: new Headers(options?.headers).get("idempotency-key")!, ...payload });
    await new Promise((resolve) => setTimeout(resolve, 5));
    return new Response(JSON.stringify({ id: `mock-${requests.length}` }), { status: 200 });
  };
  const now = at("10:00");
  const results = await Promise.all(
    Array.from({ length: 5 }, () => runNotifications({ userId: user.id, now })),
  );
  assert.equal(
    results.reduce((sum, result) => sum + result.sent, 0),
    1,
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].key, `haru-${item.schedules[0].id}-${getToday()}-user`);
  assert.deepEqual(requests[0].to, [user.email]);
  assert.equal(logRows()[0].status, "sent");
  assert.ok(logRows()[0].sent_at);
  assert.equal((await runNotifications({ userId: user.id, now: later(now, 5) })).sent, 1);
  assert.deepEqual(requests[1].to, ["guardian@example.com"]);
  assert.equal((await runNotifications({ userId: user.id, now: later(now, 10) })).sent, 0);
  assert.equal(requests.length, 2);
});

test("provider failures never become sent or trigger guardians; retry retains idempotency", async () => {
  const { user } = await account();
  saveSupplement(user.id, input());
  guardian(user.id);
  liveMode();
  const keys: string[] = [];
  globalThis.fetch = async (_url, options) => {
    keys.push(new Headers(options?.headers).get("idempotency-key")!);
    return keys.length === 1
      ? new Response("private-provider-error", { status: 503 })
      : new Response(JSON.stringify({ id: "retried-id" }), { status: 200 });
  };
  const now = at("10:00");
  assert.equal((await runNotifications({ userId: user.id, now })).failed, 1);
  assert.equal(logRows()[0].status, "failed");
  assert.equal(logRows()[0].sent_at, null);
  assert.doesNotMatch(logRows()[0].error!, /private-provider-error/);
  assert.equal((await runNotifications({ userId: user.id, now: later(now, 0.5) })).sent, 0);
  assert.equal(keys.length, 1);
  assert.equal((await runNotifications({ userId: user.id, now: later(now, 1) })).sent, 1);
  assert.equal(keys[0], keys[1]);
  assert.equal(logRows().length, 1);
  assert.equal(logRows()[0].attempts, 2);
  assert.equal(logRows()[0].status, "sent");
  assert.equal((await runNotifications({ userId: user.id, now: later(now, 5) })).sent, 0);
  assert.equal((await runNotifications({ userId: user.id, now: later(now, 6) })).sent, 1);
});

test("a capture is never upgraded to live sending or used to authorize a live guardian alert", async () => {
  const { user } = await account();
  saveSupplement(user.id, input());
  guardian(user.id);
  const now = at("10:00");
  assert.equal((await runNotifications({ userId: user.id, now })).captured, 1);
  liveMode();
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return new Response(JSON.stringify({ id: "should-not-send" }));
  };
  assert.equal((await runNotifications({ userId: user.id, now: later(now, 60) })).sent, 0);
  assert.equal(requests, 0);
  assert.equal(logRows().length, 1);
  assert.equal(logRows()[0].status, "captured");
});

test("stale processing claims recover and disabling notifications suppresses all channels", async () => {
  const { user } = await account();
  saveSupplement(user.id, input());
  const now = at("10:00");
  await runNotifications({ userId: user.id, now });
  getDb()
    .prepare("UPDATE notification_logs SET status='processing',claimed_at=?")
    .run(later(now, -16).toISOString());
  assert.equal((await runNotifications({ userId: user.id, now })).captured, 1);
  assert.equal(logRows()[0].attempts, 2);
  saveSupplement(user.id, input({ name: "새 항목" }));
  guardian(user.id);
  updateSettings(user.id, { reminderEnabled: false });
  assert.equal((await runNotifications({ userId: user.id, now: later(now, 60) })).checked, 0);
  assert.equal(logRows().length, 1);
});

test("malformed provider success is a failure and a later capture starts a fresh guardian delay", async () => {
  const { user } = await account();
  saveSupplement(user.id, input());
  guardian(user.id);
  liveMode();
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ message: "missing delivery id" }), { status: 200 });
  const now = at("10:00");
  assert.equal((await runNotifications({ userId: user.id, now })).failed, 1);
  assert.equal(logRows()[0].status, "failed");
  assert.equal(logRows()[0].sent_at, null);
  process.env.EMAIL_MODE = "capture";
  const captureTime = later(now, 30);
  assert.equal((await runNotifications({ userId: user.id, now: captureTime })).captured, 1);
  assert.equal(logRows().length, 1, "an old failed attempt cannot start the guardian countdown");
  assert.equal(
    (await runNotifications({ userId: user.id, now: later(captureTime, 4) })).captured,
    0,
  );
  assert.equal(
    (await runNotifications({ userId: user.id, now: later(captureTime, 5) })).captured,
    1,
  );
});

test("repeated saves and metadata changes cannot duplicate today's same-time reminders", async () => {
  const { user } = await account();
  const item = saveSupplement(user.id, input());
  guardian(user.id);
  const now = at("10:00");
  assert.equal((await runNotifications({ userId: user.id, now })).captured, 1);
  const unchanged = saveSupplement(user.id, input(), item.id);
  assert.equal(unchanged.schedules[0].id, item.schedules[0].id);
  const ingredientOnly = saveSupplement(
    user.id,
    input({ ingredients: [{ name: "비타민 D", amount: 25, unit: "μg" }] }),
    item.id,
  );
  assert.equal(ingredientOnly.schedules[0].id, item.schedules[0].id);
  const renamed = saveSupplement(user.id, input({ name: "이름 수정" }), item.id);
  assert.notEqual(
    renamed.schedules[0].id,
    item.schedules[0].id,
    "a metadata change preserves history with a new snapshot",
  );
  assert.equal((await runNotifications({ userId: user.id, now: later(now, 4) })).captured, 0);
  assert.equal(
    (await runNotifications({ userId: user.id, now: later(now, 5) })).captured,
    1,
    "guardian delay follows the original user notification",
  );
  saveSupplement(user.id, input({ name: "다시 수정" }), item.id);
  assert.equal((await runNotifications({ userId: user.id, now: later(now, 10) })).captured, 0);
  assert.equal(logRows().length, 2);
  assert.equal(logRows().filter((row) => row.channel === "user").length, 1);
  assert.equal(logRows().filter((row) => row.channel === "guardian").length, 1);
});

test("an uncertain provider retry keeps its original key and payload after schedule replacement", async () => {
  const { user } = await account();
  const item = saveSupplement(user.id, input());
  liveMode();
  const requests: { key: string; body: string }[] = [];
  globalThis.fetch = async (_url, options) => {
    requests.push({
      key: new Headers(options?.headers).get("idempotency-key")!,
      body: String(options?.body),
    });
    if (requests.length === 1)
      throw new Error("Connection lost after provider may have accepted request");
    return new Response(JSON.stringify({ id: "same-provider-delivery" }), { status: 200 });
  };
  const now = at("10:00");
  assert.equal((await runNotifications({ userId: user.id, now })).failed, 1);
  const renamed = saveSupplement(user.id, input({ name: "업데이트한 이름" }), item.id);
  assert.notEqual(renamed.schedules[0].id, item.schedules[0].id);
  assert.equal((await runNotifications({ userId: user.id, now: later(now, 1) })).sent, 1);
  assert.equal(requests[0].key, requests[1].key);
  assert.equal(requests[0].body, requests[1].body);
  assert.equal(requests[0].key, `haru-${item.schedules[0].id}-${getToday()}-user`);
  saveSupplement(user.id, input({ name: "한번 더 저장" }), item.id);
  assert.equal((await runNotifications({ userId: user.id, now: later(now, 2) })).sent, 0);
  assert.equal(requests.length, 2);
  assert.equal(logRows().length, 1);
});

test("editing an item during an in-flight send does not let another worker claim a new delivery", async () => {
  const { user } = await account();
  const item = saveSupplement(user.id, input());
  liveMode();
  let release: () => void = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    await waiting;
    return new Response(JSON.stringify({ id: "single-delivery" }), { status: 200 });
  };
  const now = at("10:00");
  const first = runNotifications({ userId: user.id, now });
  saveSupplement(user.id, input({ name: "발송 중 변경" }), item.id);
  const second = await runNotifications({ userId: user.id, now });
  assert.equal(second.sent, 0);
  assert.equal(requests, 1);
  release();
  assert.equal((await first).sent, 1);
  assert.equal(logRows().length, 1);
});

test("recent seven-day corrections require an existing owned schedule and record the correction time", async () => {
  const owner = await account();
  const outsider = await account("outsider@example.com");
  const item = saveSupplement(owner.user.id, input());
  const today = getToday();
  const yesterday = shiftDate(today, -1);
  getDb()
    .prepare("UPDATE intake_schedules SET start_date=? WHERE supplement_id=?")
    .run(shiftDate(today, -8), item.id);
  const correction = { scheduleId: item.schedules[0].id, date: yesterday, completed: true };
  const response = await api<{ date: string; completedAt: string }>("/intakes", {
    method: "PUT",
    cookie: owner.cookie,
    body: correction,
  });
  assert.equal(response.response.status, 200);
  assert.equal(response.payload.data.date, yesterday);
  assert.equal(
    getToday(new Date(response.payload.data.completedAt)),
    today,
    "timestamp means when the record was made, not an invented past intake time",
  );
  assert.equal(
    dailyItems(owner.user.id, yesterday)[0].completedAt,
    response.payload.data.completedAt,
  );
  assert.equal(
    (await api("/intakes", { method: "PUT", cookie: outsider.cookie, body: correction })).response
      .status,
    404,
  );
  setIntake(owner.user.id, { ...correction, date: shiftDate(today, -6) });
  for (const date of [
    shiftDate(today, -7),
    shiftDate(today, 1),
    "2026-02-30",
    "2026-13-01",
    "not-a-date",
    "2026-9-1",
  ])
    assert.throws(() => setIntake(owner.user.id, { ...correction, date }), { status: 400 });
  setIntake(owner.user.id, { ...correction, completed: false });
  assert.equal(dailyItems(owner.user.id, yesterday)[0].completedAt, null);
});

test("23:50 reminders roll over to 00:20 and guardian notices can follow on the next calendar day", async () => {
  const { user } = await account();
  const item = saveSupplement(user.id, input({ times: ["23:50"] }));
  const occurrenceDate = shiftDate(getToday(), -1);
  getDb()
    .prepare("UPDATE intake_schedules SET start_date=?,end_date=? WHERE supplement_id=?")
    .run(occurrenceDate, occurrenceDate, item.id);
  guardian(user.id);
  updateSettings(user.id, { guardianDelayMinutes: 1440 });
  const due = scheduledInstant(getToday(), "00:20");
  assert.equal((await runNotifications({ userId: user.id, now: later(due, -1) })).captured, 0);
  assert.equal((await runNotifications({ userId: user.id, now: due })).captured, 1);
  assert.equal((await runNotifications({ userId: user.id, now: later(due, 1439) })).captured, 0);
  assert.equal((await runNotifications({ userId: user.id, now: later(due, 1440) })).captured, 1);
  const logs = getDb()
    .prepare("SELECT date,channel,body FROM notification_logs ORDER BY created_at")
    .all() as { date: string; channel: string; body: string }[];
  assert.deepEqual(
    logs.map((log) => log.channel),
    ["user", "guardian"],
  );
  assert.ok(logs.every((log) => log.date === occurrenceDate));
  assert.match(logs[0].body, new RegExp(`${occurrenceDate} 23:50`));
  assert.equal((await runNotifications({ userId: user.id, now: later(due, 1441) })).captured, 0);
});

test("a corrected completed occurrence yesterday suppresses rollover notifications and user catch-up expires after 24 hours", async () => {
  const { user } = await account();
  const yesterday = shiftDate(getToday(), -1);
  const completed = saveSupplement(user.id, input({ times: ["23:50"] }));
  getDb()
    .prepare("UPDATE intake_schedules SET start_date=?,end_date=? WHERE supplement_id=?")
    .run(yesterday, yesterday, completed.id);
  setIntake(user.id, { scheduleId: completed.schedules[0].id, date: yesterday, completed: true });
  assert.equal((await runNotifications({ userId: user.id, now: at("00:20") })).captured, 0);
  assert.equal(logRows().length, 0);
  const tooOld = saveSupplement(user.id, input({ name: "오래된 항목", times: ["23:50"] }));
  const originalDate = shiftDate(getToday(), -2);
  getDb()
    .prepare("UPDATE intake_schedules SET start_date=?,end_date=? WHERE supplement_id=?")
    .run(originalDate, originalDate, tooOld.id);
  assert.equal(
    (await runNotifications({ userId: user.id, now: at("00:20") })).captured,
    0,
    "24h30m old occurrence cannot begin a new user notice",
  );
  assert.equal(logRows().length, 0);
});

test("guardian rollover is bounded to 52 hours after the scheduled occurrence", async () => {
  const { user } = await account();
  const item = saveSupplement(user.id, input({ times: ["00:00"] }));
  const occurrenceDate = shiftDate(getToday(), -2);
  getDb()
    .prepare("UPDATE intake_schedules SET start_date=?,end_date=? WHERE supplement_id=?")
    .run(occurrenceDate, occurrenceDate, item.id);
  guardian(user.id);
  updateSettings(user.id, { guardianDelayMinutes: 1440 });
  const occurrence = scheduledInstant(occurrenceDate, "00:00");
  assert.equal(
    (await runNotifications({ userId: user.id, now: later(occurrence, 23 * 60) })).captured,
    1,
  );
  assert.equal(
    (await runNotifications({ userId: user.id, now: later(occurrence, 53 * 60) })).captured,
    0,
  );
  assert.equal(logRows().length, 1, "a long-offline worker does not send stale guardian mail");
});

test("name and age are required on signup, validated on edits, and isolated in public profiles", async () => {
  for (const age of [undefined, null, 0, -1, 121, 1.5, "30", true]) {
    const result = await api("/auth/signup", {
      method: "POST",
      body: { email: "age@example.com", password: "valid-password-123", name: "회원", age },
    });
    assert.equal(result.response.status, 400);
  }
  for (const name of [undefined, "", " ", "a".repeat(31)])
    assert.equal(
      (
        await api("/auth/signup", {
          method: "POST",
          body: { email: "name@example.com", password: "valid-password-123", name, age: 30 },
        })
      ).response.status,
      400,
    );
  const first = await account();
  const second = await account("other-profile@example.com");
  assert.equal(first.user.name, "테스터");
  assert.equal(first.user.age, 30);
  const updated = updateSettings(first.user.id, { name: "  김하루  ", age: 120 });
  assert.equal(updated.name, "김하루");
  assert.equal(updated.age, 120);
  assert.equal(dashboard(first.user.id).name, "김하루");
  assert.equal(dashboard(first.user.id).age, 120);
  assert.equal(settings(second.user.id).name, "테스터");
  assert.equal(settings(second.user.id).age, 30);
  assert.throws(() => updateSettings(first.user.id, { name: "", age: 30 }), { status: 400 });
  assert.throws(() => updateSettings(first.user.id, { age: null }), { status: 400 });
  assert.throws(() => updateSettings(first.user.id, { age: 121 }), { status: 400 });
  assert.equal(updateSettings(first.user.id, { age: 1 }).age, 1);
  closeDatabase();
  const me = await api<{ user: User }>("/me", { cookie: first.cookie });
  assert.equal(me.payload.data.user.name, "김하루");
  assert.equal(me.payload.data.user.age, 1);
  assert.equal("nickname" in me.payload.data.user, false);
});

test("v1 nickname migration preserves accounts, sessions, supplements and stored history without inventing an age", async () => {
  const { user, cookie } = await account();
  const product = saveSupplement(user.id, input({ times: ["09:00", "20:00"] }));
  setIntake(user.id, { scheduleId: product.schedules[0].id, date: getToday(), completed: true });
  guardian(user.id);
  await runNotifications({ userId: user.id, now: at("22:00") });
  await api("/onboarding", {
    method: "POST",
    cookie,
    body: { choice: "survey", answers: [0, 1, 2, 0, 1, 2, 0] },
  });
  const db = getDb();
  const tables = [
    "sessions",
    "supplements",
    "supplement_ingredients",
    "intake_schedules",
    "intake_records",
    "guardian_settings",
    "notification_logs",
  ];
  const snapshots = new Map(
    tables.map((table) => [
      table,
      JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
    ]),
  );
  const passwordHash = (
    db.prepare("SELECT password_hash FROM users WHERE id=?").get(user.id) as {
      password_hash: string;
    }
  ).password_hash;
  // Only the isolated test fixture is converted to the exact v1 users schema.
  db.exec(
    "ALTER TABLE users RENAME COLUMN name TO nickname; ALTER TABLE users DROP COLUMN age; PRAGMA user_version=1;",
  );
  closeDatabase();
  const migrated = getDb();
  assert.equal(
    (migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
    2,
  );
  const row = migrated
    .prepare("SELECT name,age,password_hash FROM users WHERE id=?")
    .get(user.id) as { name: string; age: number | null; password_hash: string };
  assert.deepEqual({ ...row }, { name: "테스터", age: null, password_hash: passwordHash });
  for (const table of tables)
    assert.equal(
      JSON.stringify(migrated.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
      snapshots.get(table),
      `${table} must remain unchanged during migration`,
    );
  const me = await api<{ user: User }>("/me", { cookie });
  assert.equal(me.response.status, 200, "existing session remains valid");
  assert.equal(me.payload.data.user.name, "테스터");
  assert.equal(me.payload.data.user.age, null);
  assert.equal(history(user.id).days.at(-1)!.completed, 1);
  assert.equal(getOnboarding(user.id).choice, "survey");
  assert.equal(updateSettings(user.id, { name: "기존 회원" }).age, null);
  assert.equal(updateSettings(user.id, { age: 42 }).age, 42);
  closeDatabase();
  assert.equal(settings(user.id).age, 42, "v2 reopening is idempotent");
});

test("archiving a completed product removes active schedules and duplicate inputs but preserves past completion snapshots", async () => {
  const { user, cookie } = await account();
  const archived = saveSupplement(user.id, input());
  const remaining = saveSupplement(
    user.id,
    input({ name: "비타민D", ingredients: [{ name: "비타민 D", amount: 25, unit: "μg" }] }),
  );
  const today = getToday();
  const yesterday = shiftDate(today, -1);
  getDb()
    .prepare("UPDATE intake_schedules SET start_date=? WHERE supplement_id=?")
    .run(yesterday, archived.id);
  for (const date of [yesterday, today])
    setIntake(user.id, { scheduleId: archived.schedules[0].id, date, completed: true });
  assert.equal(duplicateGroups(listSupplements(user.id)).length, 1);
  archiveSupplement(user.id, archived.id);
  assert.deepEqual(
    dashboard(user.id).items.map((item) => item.supplementId),
    [remaining.id],
  );
  assert.equal(dashboard(user.id).completed, 0);
  assert.equal(dashboard(user.id).total, 1);
  assert.equal(
    dailyItems(user.id, shiftDate(today, 1)).some((item) => item.supplementId === archived.id),
    false,
  );
  assert.deepEqual(duplicateGroups(listSupplements(user.id)), []);
  for (const date of [yesterday, today]) {
    const snapshot = dailyItems(user.id, date, "history").find(
      (item) => item.supplementId === archived.id,
    )!;
    assert.ok(snapshot.completedAt);
    assert.equal(snapshot.name, "종합비타민");
    assert.equal(snapshot.archived, true);
    assert.throws(
      () => setIntake(user.id, { scheduleId: archived.schedules[0].id, date, completed: false }),
      { status: 404 },
    );
  }
  closeDatabase();
  assert.equal((await api<Supplement[]>("/supplements", { cookie })).payload.data.length, 1);
  assert.equal(
    dashboard(user.id).items.some((item) => item.supplementId === archived.id),
    false,
  );
});

test("legacy archived rows are filtered even if their schedules were never retired", async () => {
  const { user } = await account();
  const item = saveSupplement(user.id, input({ times: ["09:00", "20:00"] }));
  setIntake(user.id, { scheduleId: item.schedules[0].id, date: getToday(), completed: true });
  getDb()
    .prepare("UPDATE supplements SET archived_at=? WHERE id=?")
    .run(new Date().toISOString(), item.id);
  assert.equal(dashboard(user.id).total, 0);
  assert.equal(dashboard(user.id).completed, 0);
  assert.deepEqual(dailyItems(user.id, shiftDate(getToday(), 1)), []);
  assert.deepEqual(listSupplements(user.id), []);
  const historical = history(user.id).days.at(-1)!;
  assert.equal(
    historical.total,
    1,
    "an unretired archived schedule is not a pending item in today's history",
  );
  assert.equal(historical.completed, 1);
  assert.equal(historical.items[0].archived, true);
  assert.equal((await runNotifications({ userId: user.id, now: at("23:00") })).captured, 0);
  assert.throws(
    () =>
      setIntake(user.id, { scheduleId: item.schedules[0].id, date: getToday(), completed: false }),
    { status: 404 },
  );
});

test("archived products never send user or guardian reminders, including live mode and next day", async () => {
  for (const mode of ["capture", "resend"] as const) {
    const { user } = await account(`${mode}@example.com`);
    const item = saveSupplement(user.id, input());
    guardian(user.id);
    process.env.EMAIL_MODE = mode;
    const providerPayloads: { subject: string; text: string; to: string[] }[] = [];
    if (mode === "resend") {
      liveMode();
      globalThis.fetch = async (_url, options) => {
        providerPayloads.push(
          JSON.parse(String(options?.body)) as { subject: string; text: string; to: string[] },
        );
        return new Response(JSON.stringify({ id: "mock-personal-notification" }), { status: 200 });
      };
    }
    const now = at("10:00");
    const first = await runNotifications({ userId: user.id, now });
    assert.equal(mode === "capture" ? first.captured : first.sent, 1);
    const ownNotice = listNotifications(user.id)[0] as { subject: string; body: string };
    assert.equal(ownNotice.subject, "[하루영양] 복용 예정 시간이 지났어요 💊");
    assert.match(ownNotice.body, /^안녕하세요, 테스터님\./);
    assert.match(ownNotice.body, /실제 미복용을 의미하지 않습니다/);
    archiveSupplement(user.id, item.id);
    for (const moment of [later(now, 5), later(now, 24 * 60)]) {
      const result = await runNotifications({ userId: user.id, now: moment });
      assert.equal(result.sent, 0);
      assert.equal(result.captured, 0);
    }
    assert.equal(
      listNotifications(user.id).length,
      1,
      "existing user log is retained and no guardian log is added",
    );
    if (mode === "resend") {
      assert.equal(providerPayloads.length, 1);
      assert.equal(providerPayloads[0].subject, ownNotice.subject);
      assert.equal(providerPayloads[0].text, ownNotice.body);
    }
  }
});

test("exported supplement validation rejects Korean-English aliases duplicated within one product", () => {
  assert.throws(
    () =>
      validateSupplement(
        input({
          ingredients: [
            { name: "비타민 D", amount: 20, unit: "μg" },
            { name: "Vitamin D3", amount: 20, unit: "μg" },
          ],
        }),
      ),
    { status: 400 },
  );
  const validated = validateSupplement(
    input({
      times: ["20:00", "09:00"],
      ingredients: [{ name: "비타민 D", amount: 20, unit: "mcg" }],
    }),
  );
  assert.deepEqual(validated.times, ["09:00", "20:00"]);
  assert.equal(validated.ingredients[0].unit, "μg");
});

test("logout and expiry invalidate every private API while another account's session remains valid", async () => {
  const first = await account();
  const second = await account("second-session@example.com");
  const token = first.cookie.split("=")[1];
  assert.equal(getSessionUser(token)?.id, first.user.id);
  const loggedOut = await api("/auth/logout", { method: "POST", cookie: first.cookie });
  assert.equal(loggedOut.response.status, 200);
  assert.match(loggedOut.response.headers.get("set-cookie")!, /Max-Age=0/);
  assert.equal(getSessionUser(token), null);
  for (const path of [
    "/me",
    "/dashboard",
    "/supplements",
    "/history",
    "/settings",
    "/notifications",
    "/onboarding",
    "/safety",
  ])
    assert.equal((await api(path, { cookie: first.cookie })).response.status, 401, path);
  for (const [path, method] of [
    ["/settings", "PATCH"],
    ["/onboarding", "POST"],
    ["/supplements", "POST"],
    ["/safety/preview", "POST"],
    ["/intakes", "PUT"],
    ["/notifications/preview", "POST"],
  ])
    assert.equal(
      (await api(path, { method, cookie: first.cookie, body: {} })).response.status,
      401,
      path,
    );
  assert.equal((await api("/me", { cookie: second.cookie })).response.status, 200);
  getDb()
    .prepare("UPDATE sessions SET expires_at=? WHERE user_id=?")
    .run("2000-01-01T00:00:00.000Z", second.user.id);
  assert.equal(getSessionUser(second.cookie.split("=")[1]), null);
  assert.equal((await api("/dashboard", { cookie: second.cookie })).response.status, 401);
});

test("session lookup propagates database errors instead of classifying them as a missing login", async () => {
  const { cookie } = await account();
  getDb().exec("ALTER TABLE sessions RENAME COLUMN token_hash TO unavailable_token_hash");
  try {
    assert.equal(getSessionUser(undefined), null);
    assert.equal(getSessionUser("x".repeat(101)), null);
    assert.throws(
      () => getSessionUser(cookie.split("=")[1]),
      (error: unknown) => error instanceof Error && !(error instanceof HttpError),
    );
    const response = await api("/me", { cookie });
    assert.equal(response.response.status, 500);
    assert.equal(response.response.headers.has("location"), false);
    assert.doesNotMatch(response.payload.error!, /unavailable_token_hash|token_hash|SELECT/);
  } finally {
    getDb().exec("ALTER TABLE sessions RENAME COLUMN unavailable_token_hash TO token_hash");
  }
  assert.equal((await api("/me", { cookie })).response.status, 200);
});

test("guardian settings and notification history stay separate for accounts A and B", async () => {
  const first = await account("account-a@example.com");
  const second = await account("account-b@example.com");
  await api("/settings", {
    method: "PATCH",
    cookie: second.cookie,
    body: {
      guardianEmail: "guardian-b@example.com",
      guardianEnabled: true,
      guardianConsent: true,
      guardianDelayMinutes: 5,
    },
  });
  await api("/settings", {
    method: "PATCH",
    cookie: first.cookie,
    body: {
      userId: second.user.id,
      guardianEmail: "guardian-a@example.com",
      guardianEnabled: true,
      guardianConsent: true,
      guardianDelayMinutes: 5,
    },
  });
  const settingsA = (await api<{ guardianEmail: string }>("/settings", { cookie: first.cookie }))
    .payload.data;
  const settingsB = (await api<{ guardianEmail: string }>("/settings", { cookie: second.cookie }))
    .payload.data;
  assert.equal(settingsA.guardianEmail, "guardian-a@example.com");
  assert.equal(settingsB.guardianEmail, "guardian-b@example.com");
  saveSupplement(first.user.id, input());
  saveSupplement(second.user.id, input());
  const now = at("10:00");
  await runNotifications({ userId: first.user.id, now });
  await runNotifications({ userId: first.user.id, now: later(now, 5) });
  const notificationsA = (
    await api<{ recipient: string }[]>("/notifications", { cookie: first.cookie })
  ).payload.data;
  assert.deepEqual(
    new Set(notificationsA.map((item) => item.recipient)),
    new Set([first.user.email, "guardian-a@example.com"]),
  );
  assert.deepEqual((await api("/notifications", { cookie: second.cookie })).payload.data, []);
  await api("/settings", {
    method: "PATCH",
    cookie: first.cookie,
    body: { guardianEnabled: false },
  });
  assert.equal(settings(second.user.id).guardianEnabled, true);
  assert.equal(settings(second.user.id).guardianEmail, "guardian-b@example.com");
});
