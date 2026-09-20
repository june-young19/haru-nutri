/**
 * Real HTTP integration suite. Run from the project directory with:
 *   pnpm test:integration
 * Uses a separate SQLite database and captures emails; no real emails are sent.
 * Do not run alongside another Next dev process in the same project directory.
 */
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { addDays, duplicateGroups } from "../lib/domain";
import type { Dashboard, DayHistory, Settings, Supplement, User } from "../lib/types";

const port = 3101;
const baseUrl = `http://127.0.0.1:${port}`;
const cronSecret = "integration-only-secret-32-characters";
const password = "Integration-test-only-2026!";

interface Notification {
  id: string;
  scheduleId: string;
  channel: "user" | "guardian";
  status: string;
  recipient: string;
  body: string;
  sentAt: string | null;
}
interface NotificationRun {
  mode: string;
  checked: number;
  sent: number;
  captured: number;
  failed: number;
  skipped: number;
}

interface SafetyAnalysis {
  age: number | null;
  hasExceedance: boolean;
  items: {
    name: string;
    count: number;
    totals: { amount: number; unit: string }[];
    currentTotals: { amount: number; unit: string }[];
    proposedTotals: { amount: number; unit: string }[];
    status:
      | "within"
      | "exceeds"
      | "no_ul"
      | "unknown"
      | "unit_mismatch"
      | "age_required"
      | "form_required";
    reference: { value: number; unit: string; sourceUrl: string } | null;
  }[];
}

class Client {
  cookie = "";

  async request<T>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      status?: number;
      headers?: Record<string, string>;
    } = {},
  ): Promise<T> {
    const method = options.method ?? "GET";
    const headers: Record<string, string> = { ...options.headers };
    if (this.cookie) headers.Cookie = this.cookie;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${baseUrl}/api${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(45_000),
      redirect: "error",
    });
    assert.equal(
      response.status,
      options.status ?? 200,
      `${method} /api${path}: unexpected status ${response.status}`,
    );
    const jar = new Map(
      this.cookie
        .split("; ")
        .filter(Boolean)
        .map((entry) => {
          const index = entry.indexOf("=");
          return [entry.slice(0, index), entry.slice(index + 1)];
        }),
    );
    for (const cookie of response.headers.getSetCookie()) {
      assert.match(cookie, /HttpOnly/i, "session cookie must be HttpOnly");
      assert.match(cookie, /SameSite=Lax/i, "session cookie must set SameSite");
      const pair = cookie.split(";")[0];
      const index = pair.indexOf("=");
      if (/Max-Age=0(?:;|$)/i.test(cookie)) jar.delete(pair.slice(0, index));
      else jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    this.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
    assert.match(response.headers.get("cache-control") ?? "", /no-store/i);
    const payload = (await response.json()) as { data?: T; error?: string };
    if (response.ok) {
      assert.ok("data" in payload, `${path}: expected a data envelope`);
      return payload.data as T;
    }
    assert.equal(typeof payload.error, "string", `${path}: expected a safe error message`);
    return undefined as T;
  }
}

async function assertPage(path: string, status: number, cookie = ""): Promise<void> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: cookie ? { Cookie: cookie } : undefined,
    redirect: "manual",
    signal: AbortSignal.timeout(60_000),
  });
  await response.arrayBuffer();
  assert.equal(response.status, status, `GET ${path}: unexpected status ${response.status}`);
  if (status === 307) {
    assert.equal(new URL(response.headers.get("location")!, baseUrl).pathname, "/login");
    assert.match(response.headers.get("cache-control") ?? "", /no-store|no-cache/i);
  } else {
    assert.equal(
      response.headers.has("location"),
      false,
      `GET ${path} must not hide errors as a login redirect`,
    );
  }
}

async function stopServer(server: ReturnType<typeof spawn>): Promise<void> {
  if (!server.pid || server.exitCode !== null || server.signalCode !== null) return;
  const pid = server.pid;
  if (process.platform === "win32") {
    // Fixed executable + validated PID; kill only this test's child process tree.
    assert.ok(Number.isInteger(pid) && pid > 0);
    await new Promise<void>((done) => {
      execFile(
        "taskkill",
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, timeout: 10_000 },
        () => done(),
      );
    });
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      server.kill("SIGTERM");
    }
  }
  for (
    let attempt = 0;
    attempt < 40 && server.exitCode === null && server.signalCode === null;
    attempt++
  )
    await delay(100);
  if (server.exitCode === null && server.signalCode === null) {
    if (process.platform !== "win32") {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        server.kill("SIGKILL");
      }
    } else server.kill();
  }
}

async function suite(databasePath: string): Promise<void> {
  const anonymous = new Client();
  const first = new Client();
  const second = new Client();
  const suffix = randomUUID();
  const email = `first-${suffix}@example.com`;
  const secondEmail = `second-${suffix}@example.com`;
  const protectedPages = [
    "/onboarding",
    "/survey",
    "/survey/results",
    "/dashboard",
    "/supplements",
    "/supplements/new",
    "/duplicates",
    "/history",
    "/settings",
    "/settings/guardian",
    "/settings/delete-account",
  ];
  for (const path of ["/", "/login", "/signup"]) await assertPage(path, 200);
  for (const path of protectedPages) await assertPage(path, 307);
  await anonymous.request("/dashboard", { status: 401 });
  await anonymous.request("/safety", { status: 401 });
  for (const age of [undefined, 0, 121, 1.5, "30"]) {
    await anonymous.request("/auth/signup", {
      method: "POST",
      status: 400,
      body: { email, password, name: "통합 테스트", age },
    });
  }
  const signup = await first.request<{ user: User }>("/auth/signup", {
    method: "POST",
    status: 201,
    body: { email, password, name: "통합 테스트", age: 30 },
  });
  assert.equal(signup.user.email, email);
  assert.equal(signup.user.name, "통합 테스트");
  assert.equal(signup.user.age, 30);
  assert.equal(signup.user.onboarded, false);
  assert.ok(first.cookie.startsWith("haru_session="));
  for (const path of protectedPages) await assertPage(path, 200, first.cookie);
  assert.equal("password" in signup.user || "password_hash" in signup.user, false);
  await anonymous.request("/auth/signup", {
    method: "POST",
    status: 409,
    body: { email, password, name: "중복", age: 30 },
  });
  await anonymous.request("/auth/login", {
    method: "POST",
    status: 401,
    body: { email, password: "Incorrect-password-2026!" },
  });
  const oldCookie = first.cookie;
  await first.request("/auth/logout", { method: "POST", body: {} });
  await first.request("/me", { status: 401 });
  first.cookie = oldCookie;
  await first.request("/me", { status: 401 });
  await assertPage("/settings", 307, oldCookie);
  await assertPage("/settings/guardian", 307, oldCookie);
  await assertPage("/dashboard", 307, "haru_session=invalid-session-token");
  await first.request("/auth/login", {
    method: "POST",
    body: { email: email.toUpperCase(), password },
  });
  assert.notEqual(first.cookie, oldCookie, "login should issue a fresh session");
  await first.request("/onboarding", { method: "POST", body: { choice: "direct" } });
  const me = await first.request<{ user: User }>("/me");
  assert.equal(me.user.onboarded, true);
  assert.equal(me.user.name, "통합 테스트");
  assert.equal(me.user.age, 30);
  console.log(
    "PASS name/age signup validation, duplicate email, login/logout, session invalidation, onboarding",
  );

  const multiInput = {
    name: "종합비타민",
    brand: "시연 제조사",
    color: "mint",
    times: ["00:00"],
    ingredients: [
      { name: "비타민 D", amount: 20, unit: "μg" },
      { name: "비타민 C", amount: 100, unit: "mg" },
    ],
  };
  const multi = await first.request<Supplement>("/supplements", {
    method: "POST",
    status: 201,
    body: multiInput,
  });
  const vitamin = await first.request<Supplement>("/supplements", {
    method: "POST",
    status: 201,
    body: {
      name: "비타민D",
      brand: "",
      color: "peach",
      times: ["00:00"],
      ingredients: [{ name: "Vitamin D", amount: 25, unit: "mcg" }],
    },
  });
  const products = await first.request<Supplement[]>("/supplements");
  assert.equal(products.length, 2);
  const duplicates = duplicateGroups(products);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].count, 2);
  assert.deepEqual(duplicates[0].totals, [{ amount: 45, unit: "μg" }]);
  const loaded = await first.request<Supplement>(`/supplements/${multi.id}`);
  assert.equal(loaded.ingredients.length, 2);
  await first.request("/supplements", {
    method: "POST",
    status: 400,
    body: { ...multiInput, times: ["25:00"] },
  });
  await first.request("/supplements", {
    method: "POST",
    status: 400,
    body: { ...multiInput, ingredients: [{ name: "아연", amount: -1, unit: "mg" }] },
  });
  console.log(
    "PASS persistent products, multiple ingredients, 45 μg duplicate total, input validation",
  );

  const currentSafety = await first.request<SafetyAnalysis>("/safety");
  assert.equal(currentSafety.age, 30);
  assert.equal(currentSafety.hasExceedance, false);
  const currentD = currentSafety.items.find((item) => item.name === "비타민 D")!;
  assert.ok(currentD, "registered vitamin D must be included in the safety analysis");
  assert.equal(currentD.status, "within");
  assert.deepEqual(currentD.totals, [{ amount: 45, unit: "μg" }]);
  assert.equal(currentD.reference?.value, 100);
  assert.equal(currentD.reference?.unit, "μg");
  assert.match(currentD.reference?.sourceUrl ?? "", /^https:\/\/ods\.od\.nih\.gov\//);
  const highDoseDraft = {
    name: "상한량 확인 시연",
    brand: "통합 테스트용",
    color: "blue",
    times: ["12:00"],
    ingredients: [{ name: "비타민 D", amount: 80, unit: "μg" }],
  };
  const previewSafety = await first.request<SafetyAnalysis>("/safety/preview", {
    method: "POST",
    body: highDoseDraft,
  });
  assert.equal(previewSafety.hasExceedance, true);
  const proposedD = previewSafety.items.find((item) => item.name === "비타민 D")!;
  assert.equal(proposedD.status, "exceeds");
  assert.deepEqual(proposedD.currentTotals, [{ amount: 45, unit: "μg" }]);
  assert.deepEqual(proposedD.proposedTotals, [{ amount: 80, unit: "μg" }]);
  assert.deepEqual(proposedD.totals, [{ amount: 125, unit: "μg" }]);
  assert.equal(
    (await first.request<Supplement[]>("/supplements")).length,
    2,
    "preview must not save a product",
  );
  const replacementPreview = await first.request<SafetyAnalysis>("/safety/preview", {
    method: "POST",
    body: {
      ...highDoseDraft,
      excludeSupplementId: vitamin.id,
      ingredients: [{ name: "비타민 D", amount: 30, unit: "μg" }],
    },
  });
  assert.equal(replacementPreview.hasExceedance, false);
  assert.deepEqual(replacementPreview.items.find((item) => item.name === "비타민 D")?.totals, [
    { amount: 50, unit: "μg" },
  ]);
  await first.request("/supplements", { method: "POST", status: 409, body: highDoseDraft });
  assert.equal(
    (await first.request<Supplement[]>("/supplements")).length,
    2,
    "unacknowledged exceedance must not persist",
  );
  const acknowledged = await first.request<Supplement>("/supplements", {
    method: "POST",
    status: 201,
    body: { ...highDoseDraft, safetyAcknowledged: true },
  });
  const higherDraft = {
    ...highDoseDraft,
    ingredients: [{ name: "비타민 D", amount: 200, unit: "μg" }],
  };
  await first.request(`/supplements/${acknowledged.id}`, {
    method: "PUT",
    status: 409,
    body: higherDraft,
  });
  assert.equal(
    (await first.request<Supplement>(`/supplements/${acknowledged.id}`)).ingredients[0].amount,
    80,
  );
  await first.request(`/supplements/${acknowledged.id}`, {
    method: "PUT",
    body: { ...higherDraft, safetyAcknowledged: true },
  });
  assert.equal((await first.request<SafetyAnalysis>("/safety")).hasExceedance, true);
  await first.request(`/supplements/${acknowledged.id}`, { method: "DELETE" });
  assert.equal((await first.request<SafetyAnalysis>("/safety")).hasExceedance, false);
  assert.equal((await first.request<Supplement[]>("/supplements")).length, 2);
  console.log(
    "PASS official age-based UL, additive/replacement previews, explicit exceedance acknowledgement, excluded archived products",
  );

  const initial = await first.request<Dashboard>("/dashboard");
  assert.equal(initial.total, 2);
  assert.equal(initial.completed, 0);
  const slot = initial.items.find((item) => item.supplementId === multi.id)!;
  assert.ok(slot, "created product should appear in today's timeline");
  const intake = { scheduleId: slot.scheduleId, date: initial.date, completed: true };
  const checked = await first.request<{ completedAt: string; completed: boolean }>("/intakes", {
    method: "PUT",
    body: intake,
  });
  assert.equal(checked.completed, true);
  assert.ok(Number.isFinite(Date.parse(checked.completedAt)));
  const checkedAgain = await first.request<{ completedAt: string }>("/intakes", {
    method: "PUT",
    body: intake,
  });
  assert.equal(
    checkedAgain.completedAt,
    checked.completedAt,
    "repeat completion must be idempotent",
  );
  assert.equal((await first.request<Dashboard>("/dashboard")).completed, 1);
  const history = await first.request<{ days: DayHistory[]; streak: number }>("/history");
  assert.equal(history.days.length, 7);
  assert.equal(history.days.at(-1)?.date, initial.date);
  assert.equal(history.days.at(-1)?.rate, 50);
  assert.ok(
    history.days.slice(0, -1).every((day) => day.total === 0),
    "new schedules must not be backfilled into past days",
  );
  await first.request("/intakes", { method: "PUT", body: { ...intake, completed: false } });
  assert.equal((await first.request<Dashboard>("/dashboard")).completed, 0);
  await first.request("/intakes", {
    method: "PUT",
    status: 404,
    body: { ...intake, date: addDays(initial.date, -1) },
  });
  await first.request("/intakes", { method: "PUT", body: intake });
  const edited = await first.request<Supplement>(`/supplements/${multi.id}`, {
    method: "PUT",
    body: { ...multiInput, name: "수정한 종합비타민", times: ["13:00", "20:00"] },
  });
  assert.equal(edited.scheduleChangeEffectiveDate, addDays(initial.date, 1));
  const afterEdit = await first.request<Dashboard>("/dashboard");
  assert.equal(
    afterEdit.total,
    2,
    "completed-day edits must preserve today's schedule denominator",
  );
  assert.equal(afterEdit.completed, 1);
  assert.equal(
    afterEdit.items.find((item) => item.scheduleId === slot.scheduleId)?.name,
    "종합비타민",
    "timeline must retain original product snapshot",
  );
  const otherSlot = afterEdit.items.find((item) => item.supplementId === vitamin.id)!;
  await first.request("/intakes", {
    method: "PUT",
    body: { scheduleId: otherSlot.scheduleId, date: initial.date, completed: true },
  });
  assert.equal((await first.request<Dashboard>("/dashboard")).streak, 1);
  await first.request("/intakes", {
    method: "PUT",
    body: { scheduleId: otherSlot.scheduleId, date: initial.date, completed: false },
  });
  console.log(
    "PASS completion/undo, seven-day history, streak, historical snapshots and deferred schedule edits",
  );

  const otherUser = await second.request<{ user: User }>("/auth/signup", {
    method: "POST",
    status: 201,
    body: { email: secondEmail, password, name: "다른 사용자", age: 28 },
  });
  assert.notEqual(otherUser.user.id, signup.user.id);
  assert.deepEqual(await second.request<Supplement[]>("/supplements"), []);
  const isolatedSafety = await second.request<SafetyAnalysis>("/safety");
  assert.equal(isolatedSafety.age, 28);
  assert.equal(isolatedSafety.items.length, 0);
  assert.equal(isolatedSafety.hasExceedance, false);
  const isolatedPreview = await second.request<SafetyAnalysis>("/safety/preview", {
    method: "POST",
    body: highDoseDraft,
  });
  assert.equal(
    isolatedPreview.hasExceedance,
    false,
    "preview must not include another user's 45 μg",
  );
  assert.deepEqual(isolatedPreview.items.find((item) => item.name === "비타민 D")?.totals, [
    { amount: 80, unit: "μg" },
  ]);
  await second.request(`/supplements/${multi.id}`, { status: 404 });
  await second.request(`/supplements/${multi.id}`, {
    method: "PUT",
    status: 404,
    body: multiInput,
  });
  await second.request(`/supplements/${multi.id}`, { method: "DELETE", status: 404 });
  await second.request("/intakes", { method: "PUT", status: 404, body: intake });
  assert.equal((await second.request<Dashboard>("/dashboard")).total, 0);
  const answers = [2, 2, 1, 2, 0, 1, 2];
  await second.request("/onboarding", { method: "POST", body: { choice: "survey", answers } });
  assert.deepEqual((await second.request<{ answers: number[] }>("/onboarding")).answers, answers);
  await first.request("/settings", {
    method: "PATCH",
    status: 403,
    headers: { Origin: "https://attacker.example" },
    body: { name: "forged" },
  });
  await first.request("/settings", {
    method: "PATCH",
    status: 403,
    headers: { "Sec-Fetch-Site": "cross-site" },
    body: { name: "forged" },
  });
  assert.equal((await first.request<Settings>("/settings")).name, "통합 테스트");
  assert.equal((await first.request<Settings>("/settings")).age, 30);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database.prepare("SELECT password_hash FROM users ORDER BY email").all() as {
      password_hash: string;
    }[];
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => /^[a-f0-9]{32}:[a-f0-9]{128}$/.test(row.password_hash)));
    assert.notEqual(
      rows[0].password_hash,
      rows[1].password_hash,
      "same passwords must have distinct random salts",
    );
    assert.ok(rows.every((row) => !row.password_hash.includes(password)));
    const sessions = database.prepare("SELECT token_hash FROM sessions").all() as {
      token_hash: string;
    }[];
    assert.ok(sessions.every((row) => /^[a-f0-9]{64}$/.test(row.token_hash)));
    assert.ok(sessions.every((row) => row.token_hash !== first.cookie.split("=")[1]));
  } finally {
    database.close();
  }
  console.log(
    "PASS account isolation, unauthorized object access, CSRF protection, salted passwords and hashed sessions",
  );

  await first.request("/settings", {
    method: "PATCH",
    status: 400,
    body: { guardianEmail: "guardian@example.com", guardianEnabled: true },
  });
  const preferences = await first.request<Settings>("/settings", {
    method: "PATCH",
    body: {
      reminderEnabled: true,
      delayMinutes: 5,
      guardianDelayMinutes: 5,
      guardianEmail: "guardian@example.com",
      guardianEnabled: true,
      guardianConsent: true,
    },
  });
  assert.equal(preferences.emailMode, "capture");
  assert.equal(preferences.guardianEnabled, true);
  assert.ok(preferences.guardianConsentedAt);
  assert.equal(preferences.guardianEmail, "guardian@example.com");
  const secondPreferences = await second.request<Settings>("/settings", {
    method: "PATCH",
    body: {
      userId: signup.user.id,
      guardianEmail: "second-guardian@example.com",
      guardianEnabled: true,
      guardianConsent: true,
    },
  });
  assert.equal(secondPreferences.guardianEmail, "second-guardian@example.com");
  assert.equal((await first.request<Settings>("/settings")).guardianEmail, "guardian@example.com");
  await anonymous.request("/cron/notifications", { status: 401 });
  const preview = await first.request<NotificationRun>("/notifications/preview", {
    method: "POST",
    body: {},
  });
  assert.equal(preview.mode, "capture");
  assert.equal(preview.sent, 0);
  assert.equal(preview.failed, 0);
  const logs = await first.request<Notification[]>("/notifications");
  const current = new Date();
  const due = new Date(`${initial.date}T00:05:00+09:00`);
  // The first five minutes of a Seoul day are correctly not overdue yet.
  if (current.getTime() >= due.getTime()) {
    assert.equal(logs.length, 1, "only the unfinished product should produce a notification");
    assert.equal(preview.captured, 1);
    assert.equal(logs[0].scheduleId, otherSlot.scheduleId);
    assert.equal(logs[0].channel, "user", "guardian must wait after the first user notification");
    assert.equal(logs[0].status, "captured");
    assert.equal(logs[0].sentAt, null, "capture must never imply an actual send");
    assert.equal(logs[0].recipient, email);
    assert.match(logs[0].body, /복용 완료가 아직 확인되지 않았습니다/);
  } else {
    assert.equal(logs.length, 0);
    assert.equal(preview.captured, 0);
  }
  const repeated = await first.request<NotificationRun>("/notifications/preview", {
    method: "POST",
    body: {},
  });
  assert.equal(repeated.captured, 0, "repeating delivery must not duplicate notifications");
  assert.equal((await first.request<Notification[]>("/notifications")).length, logs.length);
  assert.deepEqual(await second.request<Notification[]>("/notifications"), []);
  const cron = await anonymous.request<NotificationRun>("/cron/notifications", {
    headers: { Authorization: `Bearer ${cronSecret}` },
  });
  assert.equal(cron.mode, "capture");
  assert.equal(cron.sent, 0);
  const revoked = await first.request<Settings>("/settings", {
    method: "PATCH",
    body: { guardianEnabled: false },
  });
  assert.equal(revoked.guardianEnabled, false);
  assert.equal(revoked.guardianConsentedAt, null);
  const unaffectedGuardian = await second.request<Settings>("/settings");
  assert.equal(unaffectedGuardian.guardianEnabled, true);
  assert.equal(unaffectedGuardian.guardianEmail, "second-guardian@example.com");
  await first.request("/settings", {
    method: "PATCH",
    status: 400,
    body: { guardianEnabled: true },
  });
  console.log(
    "PASS consent requirement/revocation, captured email content, delivery deduplication and cron authentication",
  );

  await first.request(`/supplements/${vitamin.id}`, { method: "DELETE" });
  assert.equal((await first.request<Supplement[]>("/supplements")).length, 1);
  await first.request(`/supplements/${vitamin.id}`, { status: 404 });
  assert.equal(
    (await first.request<Dashboard>("/dashboard")).total,
    1,
    "archived uncompleted slot should leave today's timeline",
  );
  assert.equal((await first.request<Dashboard>("/dashboard")).completed, 1);
  const afterVitaminDelete = await first.request<SafetyAnalysis>("/safety");
  assert.deepEqual(afterVitaminDelete.items.find((item) => item.name === "비타민 D")?.totals, [
    { amount: 20, unit: "μg" },
  ]);
  assert.equal(duplicateGroups(await first.request<Supplement[]>("/supplements")).length, 0);
  await first.request(`/supplements/${multi.id}`, { method: "DELETE" });
  const afterCompletedDelete = await first.request<Dashboard>("/dashboard");
  assert.equal(
    afterCompletedDelete.total,
    0,
    "deleted products must leave today's timeline even when previously completed",
  );
  assert.equal(afterCompletedDelete.completed, 0);
  assert.equal(afterCompletedDelete.items.length, 0);
  assert.equal((await first.request<SafetyAnalysis>("/safety")).items.length, 0);
  await first.request("/intakes", { method: "PUT", status: 404, body: intake });
  await first.request("/auth/logout", { method: "POST", body: {} });
  await first.request("/supplements", { status: 401 });
  await first.request("/auth/login", { method: "POST", body: { email, password } });
  assert.deepEqual(await first.request<Supplement[]>("/supplements"), []);
  assert.equal((await first.request<Dashboard>("/dashboard")).total, 0);
  assert.equal((await first.request<SafetyAnalysis>("/safety")).items.length, 0);
  const retainedHistory = await first.request<{ days: DayHistory[]; streak: number }>("/history");
  assert.ok(
    retainedHistory.days
      .flatMap((day) => day.items)
      .some((item) => item.supplementId === multi.id && Boolean(item.completedAt)),
    "archive must retain the existing completed history snapshot",
  );
  assert.equal((await first.request<{ user: User }>("/me")).user.name, "통합 테스트");
  const writableDatabase = new DatabaseSync(databasePath);
  try {
    writableDatabase
      .prepare("UPDATE sessions SET expires_at=? WHERE user_id=?")
      .run("2000-01-01T00:00:00.000Z", otherUser.user.id);
    await second.request("/settings", { status: 401 });
    await assertPage("/settings/guardian", 307, second.cookie);
    await assertPage("/dashboard", 200, first.cookie);
    // Only this test's temporary database is altered. Storage failures must be
    // observable server errors, never mistaken for an expired login.
    writableDatabase.exec(
      "ALTER TABLE sessions RENAME COLUMN token_hash TO unavailable_token_hash",
    );
    try {
      await assertPage("/settings", 500, first.cookie);
      await first.request("/me", { status: 500 });
    } finally {
      writableDatabase.exec(
        "ALTER TABLE sessions RENAME COLUMN unavailable_token_hash TO token_hash",
      );
    }
    await assertPage("/settings", 200, first.cookie);
  } finally {
    writableDatabase.close();
  }
  const finalCookie = first.cookie;
  const doomed = new Client();
  const replay = new Client();
  const deletionEmail = `deletion-${suffix}@example.test`;
  const doomedUser = await doomed.request<{ user: User }>("/auth/signup", {
    method: "POST",
    status: 201,
    body: { email: deletionEmail, password, name: "탈퇴 전용 검사", age: 25 },
  });
  await replay.request("/auth/login", { method: "POST", body: { email: deletionEmail, password } });
  await doomed.request("/onboarding", {
    method: "POST",
    body: { choice: "survey", answers: [2, 2, 2, 2, 0, 1, 1] },
  });
  const doomedProduct = await doomed.request<Supplement>("/supplements", {
    method: "POST",
    status: 201,
    body: multiInput,
  });
  const doomedDay = await doomed.request<Dashboard>("/dashboard");
  await doomed.request("/intakes", {
    method: "PUT",
    body: {
      scheduleId: doomedProduct.schedules[0].id,
      date: doomedDay.date,
      completed: true,
    },
  });
  await doomed.request("/settings", {
    method: "PATCH",
    body: {
      guardianEmail: "deletion-guardian@example.test",
      guardianEnabled: true,
      guardianConsent: true,
    },
  });
  await anonymous.request("/account/deletion/verify", {
    method: "POST",
    body: { password },
    status: 401,
  });
  await doomed.request("/account/deletion/verify", {
    method: "POST",
    body: { password: "Incorrect-password-2026!" },
    status: 400,
  });
  await doomed.request("/me");
  await doomed.request("/account/deletion/verify", { method: "POST", body: { password } });
  await doomed.request("/account/deletion/complete", {
    method: "POST",
    body: { confirmed: false },
    status: 400,
  });
  await doomed.request("/account/deletion/complete", {
    method: "POST",
    body: { confirmed: true, user_id: signup.user.id },
  });
  assert.equal(doomed.cookie, "", "all authentication cookies must be cleared");
  await replay.request("/me", { status: 401 });
  for (const page of [
    "/dashboard",
    "/settings",
    "/supplements",
    "/history",
    "/settings/delete-account",
  ])
    await assertPage(page, 307, replay.cookie);
  await doomed.request("/auth/login", {
    method: "POST",
    body: { email: deletionEmail, password },
    status: 401,
  });
  assert.equal((await first.request<{ user: User }>("/me")).user.id, signup.user.id);
  const reborn = await doomed.request<{ user: User }>("/auth/signup", {
    method: "POST",
    status: 201,
    body: { email: deletionEmail, password, name: "새 계정", age: 25 },
  });
  assert.notEqual(reborn.user.id, doomedUser.user.id);
  assert.equal(reborn.user.onboarded, false);
  assert.deepEqual(await doomed.request("/supplements"), []);
  const cleanHistory = await doomed.request<{ days: DayHistory[] }>("/history");
  assert.equal(cleanHistory.days.flatMap((day) => day.items).length, 0);
  assert.equal((await doomed.request<Settings>("/settings")).guardianEmail, "");
  await doomed.request("/auth/logout", { method: "POST", body: {} });
  console.log(
    "PASS password-confirmed account deletion, all-session revocation, protected page redirects, cross-user isolation and fresh same-email signup",
  );
  await first.request("/auth/logout", { method: "POST", body: {} });
  for (const path of ["/dashboard", "/settings", "/settings/guardian"])
    await assertPage(path, 307, finalCookie);
  await second.request("/auth/logout", { method: "POST", body: {} });
  console.log(
    "PASS deletion persistence, server-side page authorization, expired/logout sessions, guardian isolation and database failures that remain server errors",
  );
}

async function main(): Promise<void> {
  // Avoid accidentally testing or terminating an unrelated listener.
  let occupied = false;
  try {
    await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1_000) });
    occupied = true;
  } catch {
    /* no existing HTTP listener */
  }
  assert.equal(
    occupied,
    false,
    `Port ${port} is already in use. Stop its server before running integration tests.`,
  );
  const temporaryRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, "haru-nutri-integration-"));
  const databasePath = join(directory, "integration.sqlite");
  const server = spawn(
    process.execPath,
    [
      join(process.cwd(), "node_modules", "next", "dist", "bin", "next"),
      "dev",
      "--webpack",
      "--port",
      String(port),
      "--hostname",
      "127.0.0.1",
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_PATH: databasePath,
        EMAIL_MODE: "capture",
        BREVO_API_KEY: "",
        EMAIL_FROM: "",
        EMAIL_FROM_NAME: "하루영양",
        APP_URL: baseUrl,
        CRON_SECRET: cronSecret,
        NODE_ENV: "development",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    },
  );
  let serverOutput = "";
  let spawnError: Error | undefined;
  server.on("error", (error) => {
    spawnError = error;
  });
  const collect = (chunk: Buffer) => {
    serverOutput = (serverOutput + chunk.toString()).slice(-12_000);
  };
  server.stdout?.on("data", collect);
  server.stderr?.on("data", collect);
  try {
    let ready = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      if (spawnError) throw spawnError;
      if (server.exitCode !== null)
        throw new Error(`Next development server exited (${server.exitCode}).\n${serverOutput}`);
      try {
        const health = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2_000) });
        if (health.ok) {
          ready = true;
          break;
        }
      } catch {
        /* first compilation may still be running */
      }
      await delay(1_000);
    }
    assert.ok(ready, `Next did not become healthy.\n${serverOutput}`);
    await suite(databasePath);
    console.log("All real HTTP integration checks passed. Emails were captured only.");
  } catch (error) {
    if (serverOutput) console.error("Next server diagnostics:\n" + serverOutput);
    throw error;
  } finally {
    await stopServer(server);
    const resolved = resolve(directory);
    assert.equal(
      dirname(resolved),
      temporaryRoot,
      "temporary cleanup must stay inside the OS temporary directory",
    );
    assert.ok(basename(resolved).startsWith("haru-nutri-integration-"));
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Integration test failed.");
  process.exitCode = 1;
});
