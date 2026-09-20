import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { closeDatabase, getDb, transaction } from "../lib/server/db";
import { runNotifications } from "../lib/server/notifications";

// All addresses, keys and records below are synthetic. No test contacts Brevo.
const environmentKeys = [
  "DATABASE_PATH",
  "EMAIL_MODE",
  "BREVO_API_KEY",
  "EMAIL_FROM",
  "EMAIL_FROM_NAME",
  "APP_URL",
] as const;
let savedEnvironment: Partial<Record<(typeof environmentKeys)[number], string>>;
let directory: string;
const originalFetch = globalThis.fetch;
const date = "2026-09-20";
const now = new Date(`${date}T12:00:00+09:00`);
const stamp = now.toISOString();

beforeEach(() => {
  closeDatabase();
  savedEnvironment = {};
  for (const key of environmentKeys) {
    if (process.env[key] !== undefined) savedEnvironment[key] = process.env[key];
    delete process.env[key];
  }
  directory = mkdtempSync(join(tmpdir(), "haru-account-notifications-"));
  process.env.DATABASE_PATH = join(directory, "isolated.sqlite");
  process.env.EMAIL_MODE = "capture";
  process.env.APP_URL = "https://haru.example.test";
  globalThis.fetch = async () => {
    throw new Error("Unexpected network access in account notification test");
  };
});

afterEach(() => {
  closeDatabase();
  globalThis.fetch = originalFetch;
  for (const key of environmentKeys) {
    if (savedEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnvironment[key];
  }
  rmSync(directory, { recursive: true, force: true });
});

function fixture(label: string, times: string[]) {
  const id = randomUUID();
  const productId = randomUUID();
  const email = `${label}@example.test`;
  const guardianEmail = `${label}-guardian@example.test`;
  const scheduleIds = times.map(() => randomUUID());
  transaction((db) => {
    db.prepare(
      "INSERT INTO users(id,email,name,age,password_hash,guardian_delay_minutes,created_at) VALUES(?,?,?,30,?,5,?)",
    ).run(id, email, label, "unused-test-fixture-hash", stamp);
    db.prepare(
      "INSERT INTO guardian_settings(user_id,email,enabled,consented_at) VALUES(?,?,1,?)",
    ).run(id, guardianEmail, stamp);
    db.prepare("INSERT INTO supplements(id,user_id,name,created_at) VALUES(?,?,?,?)").run(
      productId,
      id,
      `${label} product`,
      stamp,
    );
    times.forEach((time, index) => {
      db.prepare(
        "INSERT INTO intake_schedules(id,supplement_id,time,start_date,name_snapshot,color_snapshot,created_at) VALUES(?,?,?,?,?,'mint',?)",
      ).run(scheduleIds[index], productId, time, date, `${label} product`, stamp);
    });
  });
  return { id, productId, email, guardianEmail, scheduleIds };
}
type Fixture = ReturnType<typeof fixture>;

/** Equivalent fixture deletion order, independent of account/password validation. */
function deleteFixture(user: Fixture) {
  transaction((db) => {
    db.prepare("DELETE FROM notification_logs WHERE user_id=?").run(user.id);
    db.prepare("DELETE FROM intake_records WHERE user_id=?").run(user.id);
    db.prepare("DELETE FROM users WHERE id=?").run(user.id);
  });
}
function logs() {
  return getDb().prepare("SELECT user_id,channel,status,attempts FROM notification_logs").all() as {
    user_id: string;
    channel: string;
    status: string;
    attempts: number;
  }[];
}
function assertRemoved(user: Fixture) {
  assert.equal(getDb().prepare("SELECT id FROM users WHERE id=?").get(user.id), undefined);
  assert.equal(logs().filter((row) => row.user_id === user.id).length, 0);
  assert.deepEqual(getDb().prepare("PRAGMA foreign_key_check").all(), []);
}
function userLogsAlreadySent(user: Fixture) {
  const earlier = new Date(now.getTime() - 60 * 60_000).toISOString();
  for (const scheduleId of user.scheduleIds) {
    getDb()
      .prepare(
        "INSERT INTO notification_logs(id,user_id,schedule_id,date,channel,status,recipient,subject,body,created_at,claimed_at,sent_at) VALUES(?,?,?,?,'user','sent',?,'test','test',?,?,?)",
      )
      .run(randomUUID(), user.id, scheduleId, date, user.email, earlier, earlier, earlier);
  }
}
function heldTransport() {
  process.env.EMAIL_MODE = "brevo";
  process.env.BREVO_API_KEY = "test-only-account-deletion-key";
  process.env.EMAIL_FROM = "sender@example.test";
  const requests: { recipient: string; afterDeletion: boolean }[] = [];
  let afterDeletion = false;
  let firstFourStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    firstFourStarted = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://api.brevo.com/v3/smtp/email");
    const payload = JSON.parse(String(init?.body)) as { to: { email: string }[] };
    requests.push({ recipient: payload.to[0].email, afterDeletion });
    const index = requests.length;
    if (index === 4) firstFourStarted();
    if (index <= 4) await held;
    return Response.json({ messageId: `test-accepted-${index}` });
  };
  return {
    requests,
    started,
    release,
    markDeleted: () => {
      afterDeletion = true;
    },
  };
}
const firstEight = Array.from({ length: 8 }, (_, index) => `08:0${index}`);

test("capture skips deleted pending candidates without recreating logs and preserves another account", async () => {
  const removed = fixture("removed", firstEight);
  const survivor = fixture("survivor", ["09:00", "09:01"]);
  const pending = runNotifications({ now });
  // Four workers have captured their first item and yielded; four removed-user
  // candidates and both surviving-user candidates remain in the original list.
  assert.equal(logs().filter((row) => row.user_id === removed.id).length, 4);
  deleteFixture(removed);
  const result = await pending;
  assert.equal(result.checked, 10);
  assert.equal(result.captured, 6);
  assert.equal(result.failed, 0);
  assertRemoved(removed);
  assert.equal(logs().length, 2);
  assert.ok(logs().every((row) => row.user_id === survivor.id && row.status === "captured"));
  const repeated = await runNotifications({ now });
  assert.equal(repeated.checked, 2);
  assert.equal(repeated.captured, 0);
  assertRemoved(removed);
});

test(
  "in-flight user delivery cannot enqueue deleted user's remaining reminders or guardian follow-ups",
  { timeout: 10_000 },
  async () => {
    const removed = fixture("removed", firstEight);
    const survivor = fixture("survivor", ["09:00", "09:01"]);
    const transport = heldTransport();
    const pending = runNotifications({ now });
    try {
      await transport.started;
      assert.equal(transport.requests.length, 4);
      deleteFixture(removed);
      transport.markDeleted();
    } finally {
      transport.release();
    }
    const result = await pending;
    assert.equal(result.failed, 0);
    // The first four requests started before deletion and cannot be recalled.
    assert.equal(result.sent, 6);
    assert.equal(transport.requests.length, 6);
    assert.deepEqual(
      transport.requests
        .filter((request) => request.afterDeletion)
        .map((request) => request.recipient),
      [survivor.email, survivor.email],
    );
    assertRemoved(removed);
    assert.equal(logs().length, 2);
    assert.ok(logs().every((row) => row.user_id === survivor.id && row.status === "sent"));
    await runNotifications({ now });
    assert.equal(transport.requests.length, 6, "neither account is sent a duplicate");
    assertRemoved(removed);
  },
);

test(
  "in-flight guardian delivery skips deleted user's later candidates while surviving guardian notices continue",
  { timeout: 10_000 },
  async () => {
    const removed = fixture("removed", firstEight);
    const survivor = fixture("survivor", ["09:00", "09:01"]);
    userLogsAlreadySent(removed);
    userLogsAlreadySent(survivor);
    const transport = heldTransport();
    const pending = runNotifications({ now });
    try {
      await transport.started;
      assert.ok(transport.requests.every((request) => request.recipient === removed.guardianEmail));
      deleteFixture(removed);
      transport.markDeleted();
    } finally {
      transport.release();
    }
    const result = await pending;
    assert.equal(result.failed, 0);
    assert.equal(result.sent, 6);
    assert.equal(transport.requests.length, 6);
    assert.deepEqual(
      transport.requests
        .filter((request) => request.afterDeletion)
        .map((request) => request.recipient),
      [survivor.guardianEmail, survivor.guardianEmail],
    );
    assertRemoved(removed);
    assert.equal(logs().length, 4);
    assert.ok(logs().every((row) => row.user_id === survivor.id && row.status === "sent"));
    await runNotifications({ now });
    assert.equal(transport.requests.length, 6);
    assertRemoved(removed);
  },
);

test(
  "claim checks current schedule and consent before creating or retrying stale queued work",
  { timeout: 10_000 },
  async () => {
    fixture("blocker", ["07:00", "07:01", "07:02", "07:03"]);
    const archived = fixture("archived", ["08:00"]);
    const revoked = fixture("revoked", ["08:01", "08:02"]);
    userLogsAlreadySent(revoked);
    const retryId = randomUUID();
    const earlier = new Date(now.getTime() - 60 * 60_000).toISOString();
    getDb()
      .prepare(
        "INSERT INTO notification_logs(id,user_id,schedule_id,date,channel,status,recipient,subject,body,created_at,claimed_at,retryable) VALUES(?,?,?,?,'guardian','failed',?,'test','test',?,?,1)",
      )
      .run(
        retryId,
        revoked.id,
        revoked.scheduleIds[1],
        date,
        revoked.guardianEmail,
        earlier,
        earlier,
      );
    const transport = heldTransport();
    const pending = runNotifications({ now });
    try {
      await transport.started;
      getDb()
        .prepare("UPDATE supplements SET archived_at=? WHERE id=?")
        .run(stamp, archived.productId);
      getDb()
        .prepare("UPDATE guardian_settings SET enabled=0,consented_at=NULL WHERE user_id=?")
        .run(revoked.id);
    } finally {
      transport.release();
    }
    const result = await pending;
    assert.equal(result.failed, 0);
    assert.equal(transport.requests.length, 4);
    assert.equal(logs().filter((row) => row.user_id === archived.id).length, 0);
    const guardianLogs = logs().filter(
      (row) => row.user_id === revoked.id && row.channel === "guardian",
    );
    assert.equal(guardianLogs.length, 1, "revoked new guardian work must not create a log");
    assert.equal(guardianLogs[0].status, "failed");
    assert.equal(guardianLogs[0].attempts, 1, "revoked existing work must not reserve a retry");
  },
);
