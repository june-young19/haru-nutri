import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { readWorkerConfig, startReminderWorker } from "../scripts/reminder-worker.mjs";

const secret = "worker-test-secret-at-least-24-characters";
const config = readWorkerConfig({ APP_URL: "https://example.test", CRON_SECRET: secret });

function output() {
  const messages: string[] = [];
  return {
    messages,
    logger: {
      log: (value: string) => messages.push(value),
      error: (value: string) => messages.push(value),
    },
  };
}

function success(data: Record<string, unknown> = {}) {
  return Response.json({ data: { mode: "capture", checked: 1, captured: 1, ...data } });
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail("Worker did not reach the expected state.");
}

test("worker validates production origin and cron secret without reflecting values", () => {
  assert.equal(config.endpoint, "https://example.test/api/cron/notifications");
  assert.equal(
    readWorkerConfig({ CRON_SECRET: secret }).endpoint,
    "http://localhost:3000/api/cron/notifications",
  );
  assert.equal(
    readWorkerConfig({ APP_URL: "http://app:3000", CRON_SECRET: secret, NODE_ENV: "production" })
      .endpoint,
    "http://app:3000/api/cron/notifications",
  );
  for (const APP_URL of [
    "not-a-url",
    "ftp://example.test",
    "https://user:private@example.test",
    "https://example.test/?token=private",
    "https://example.test/#private",
    "https://example.test/extra",
  ]) {
    assert.throws(
      () => readWorkerConfig({ APP_URL, CRON_SECRET: secret }),
      (error: Error) => !error.message.includes(APP_URL),
    );
  }
  assert.throws(
    () => readWorkerConfig({ CRON_SECRET: secret, NODE_ENV: "production" }),
    /APP_URL is required/,
  );
  assert.throws(() => readWorkerConfig({ CRON_SECRET: "short" }), /CRON_SECRET/);
  assert.throws(() => readWorkerConfig({ CRON_SECRET: `${secret}\r\n` }), /CRON_SECRET/);
});

test("worker authenticates, refuses redirects, and logs only safe counters", async () => {
  const capture = output();
  let requested = false;
  const worker = startReminderWorker(config, {
    logger: capture.logger,
    fetchFn: async (url, init) => {
      assert.equal(url, config.endpoint);
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${secret}`);
      assert.equal(init?.redirect, "error");
      requested = true;
      return success({
        recipient: "private@example.test",
        token: secret,
        sent: "sensitive",
        skipped: -1,
      });
    },
  });
  try {
    await waitFor(() => capture.messages.length === 1);
    assert.ok(requested);
    assert.match(capture.messages[0], /"captured":1/);
    assert.match(capture.messages[0], /"sent":0/);
    assert.match(capture.messages[0], /"skipped":0/);
    assert.ok(!capture.messages.join().includes(secret));
    assert.ok(!capture.messages.join().includes("private@example.test"));
    assert.ok(!capture.messages.join().includes("sensitive"));
  } finally {
    await worker.stop();
  }
});

test("worker does not overlap slow scans and shutdown aborts an active request", async () => {
  let calls = 0;
  let aborted = false;
  const capture = output();
  const worker = startReminderWorker(config, {
    logger: capture.logger,
    intervalMs: 5,
    fetchFn: async (_url, init) => {
      calls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error(secret));
          },
          { once: true },
        );
      });
    },
  });
  await delay(30);
  assert.equal(calls, 1);
  await worker.stop();
  await worker.stop();
  await delay(15);
  assert.ok(aborted);
  assert.equal(calls, 1);
  assert.equal(capture.messages.length, 0);
});

test("worker accepts Brevo results while keeping provider credentials and recipients out of logs", async () => {
  const capture = output();
  const worker = startReminderWorker(config, {
    logger: capture.logger,
    fetchFn: async () =>
      success({
        mode: "brevo",
        captured: 0,
        sent: 2,
        apiKey: "private-provider-key",
        recipient: "private@example.test",
      }),
  });
  try {
    await waitFor(() => capture.messages.length === 1);
    assert.match(capture.messages[0], /"mode":"brevo"/);
    assert.match(capture.messages[0], /"sent":2/);
    assert.match(capture.messages[0], /"captured":0/);
    assert.ok(!capture.messages[0].includes("private-provider-key"));
    assert.ok(!capture.messages[0].includes("private@example.test"));
  } finally {
    await worker.stop();
  }
});

test("worker rejects missing or unsupported provider modes without silently treating them as capture", async () => {
  const capture = output();
  let calls = 0;
  const worker = startReminderWorker(config, {
    logger: capture.logger,
    intervalMs: 5,
    fetchFn: async () => {
      calls += 1;
      if (calls === 1) return success({ mode: undefined });
      if (calls === 2) return success({ mode: "private-unsupported-provider" });
      return success({ mode: "brevo", sent: 1, captured: 0 });
    },
  });
  try {
    await waitFor(() => capture.messages.length >= 3);
    assert.match(capture.messages[0], /Request failed/);
    assert.match(capture.messages[1], /Request failed/);
    assert.match(capture.messages[2], /"mode":"brevo"/);
    assert.ok(!capture.messages.join().includes("private-unsupported-provider"));
    assert.ok(!capture.messages.slice(0, 2).join().includes('"captured":1'));
  } finally {
    await worker.stop();
  }
});

test("worker retries a failed HTTP scan on a later tick and hides the error body", async () => {
  const capture = output();
  let calls = 0;
  const worker = startReminderWorker(config, {
    logger: capture.logger,
    intervalMs: 10,
    fetchFn: async () => {
      calls += 1;
      return calls === 1 ? new Response(secret, { status: 503 }) : success();
    },
  });
  try {
    await waitFor(() => calls >= 2 && capture.messages.length >= 2);
    assert.match(capture.messages[0], /HTTP 503/);
    assert.match(capture.messages[1], /"captured":1/);
    assert.ok(!capture.messages.join().includes(secret));
  } finally {
    await worker.stop();
  }
  const stoppedAt = calls;
  await delay(25);
  assert.equal(calls, stoppedAt);
});

test("worker request timeout aborts the request and permits the next scan", async () => {
  const capture = output();
  let calls = 0;
  let aborted = false;
  const worker = startReminderWorker(config, {
    logger: capture.logger,
    intervalMs: 5,
    requestTimeoutMs: 10,
    fetchFn: async (_url, init) => {
      calls += 1;
      if (calls > 1) return success();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error(secret));
          },
          { once: true },
        );
      });
    },
  });
  try {
    await waitFor(() => calls >= 2 && capture.messages.length >= 2);
    assert.ok(aborted);
    assert.match(capture.messages[0], /timed out/);
    assert.match(capture.messages[1], /"captured":1/);
    assert.ok(!capture.messages.join().includes(secret));
  } finally {
    await worker.stop();
  }
});

test("worker handles a malformed response and network error without leaking details", async () => {
  const capture = output();
  let calls = 0;
  const worker = startReminderWorker(config, {
    logger: capture.logger,
    intervalMs: 5,
    fetchFn: async () => {
      calls += 1;
      if (calls === 1) return new Response(secret);
      if (calls === 2) throw new Error(`private request ${secret}`);
      return success();
    },
  });
  try {
    await waitFor(() => capture.messages.length >= 3);
    assert.match(capture.messages[0], /Request failed/);
    assert.match(capture.messages[1], /Request failed/);
    assert.match(capture.messages[2], /"captured":1/);
    assert.ok(!capture.messages.join().includes(secret));
  } finally {
    await worker.stop();
  }
});
