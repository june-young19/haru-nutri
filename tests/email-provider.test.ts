import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { sendBrevoEmail } from "../lib/server/notifications";

// Pure transport tests: mock fetch only, never load .env or contact an email provider.
const originalFetch = globalThis.fetch;
const configuration = {
  apiKey: "test-only-brevo-key",
  fromEmail: "sender@example.test",
  fromName: "하루영양",
};
const delivery = {
  id: "bb60246e-d46c-4b02-8be0-326b49c0b5c6",
  recipient: "member@example.test",
  subject: "[하루영양] 복용 예정 시간이 지났어요 💊",
  body: "안녕하세요, 하루님.\n<img src=x onerror=alert(1)> & \"quoted\" 'text'",
};

beforeEach(() => {
  globalThis.fetch = async () => {
    throw new Error("Unexpected network access in provider test");
  };
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("Brevo transport sends the documented authenticated request and accepts messageId only", async () => {
  let requestCount = 0;
  globalThis.fetch = async (url, options) => {
    requestCount++;
    assert.equal(url, "https://api.brevo.com/v3/smtp/email");
    assert.equal(options?.method, "POST");
    assert.equal(options?.redirect, "error", "custom api-key must not follow cross-host redirects");
    assert.ok(options?.signal instanceof AbortSignal);
    const headers = new Headers(options?.headers);
    assert.equal(headers.get("api-key"), configuration.apiKey);
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(headers.get("content-type"), "application/json");
    assert.equal(headers.has("authorization"), false);
    assert.equal(headers.has("idempotency-key"), false);
    const payload = JSON.parse(String(options?.body));
    assert.deepEqual(payload.sender, {
      email: configuration.fromEmail,
      name: configuration.fromName,
    });
    assert.deepEqual(payload.to, [{ email: delivery.recipient }]);
    assert.equal(payload.subject, delivery.subject);
    assert.equal(payload.textContent, delivery.body);
    assert.deepEqual(payload.headers, { idempotencyKey: delivery.id });
    assert.match(payload.htmlContent, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(payload.htmlContent, /&amp; &quot;quoted&quot; &#39;text&#39;/);
    assert.doesNotMatch(payload.htmlContent, /<img/);
    return new Response(JSON.stringify({ messageId: "<accepted-id@example.test>" }), {
      status: 201,
    });
  };
  assert.deepEqual(await sendBrevoEmail(delivery, configuration), {
    status: "accepted",
    messageId: "<accepted-id@example.test>",
  });
  assert.equal(requestCount, 1);
});

test("Brevo explicit rejection is separate from an uncertain delivery and never exposes provider body", async () => {
  for (const status of [400, 401, 403, 404, 422, 429]) {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          code: "invalid_parameter",
          message: `Do not expose ${configuration.apiKey}`,
        }),
        { status },
      );
    const result = await sendBrevoEmail(delivery, configuration);
    assert.equal(result.status, "rejected");
    assert.match(result.error, new RegExp(`HTTP ${status}`));
    assert.doesNotMatch(result.error, /test-only-brevo-key|Do not expose/);
  }
});

test("Brevo duplicate_parameter never invents a successful delivery or replays automatically", async () => {
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response(JSON.stringify({ code: "duplicate_parameter", message: "duplicate" }), {
      status: 400,
    });
  };
  const result = await sendBrevoEmail(delivery, configuration);
  assert.equal(result.status, "uncertain");
  assert.equal(requests, 1);
  assert.match(result.error, /자동 재발송을 중단/);
  // An unrecognized error response must not be assumed safe to replay.
  for (const body of ["truncated", "{}", '{"code":""}']) {
    globalThis.fetch = async () => new Response(body, { status: 400 });
    assert.equal((await sendBrevoEmail(delivery, configuration)).status, "uncertain");
  }
});

test("Brevo timeouts, lost responses and HTTP server errors stay uncertain with no internal retries", async () => {
  for (const status of [408, 409, 500, 502, 503]) {
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      return new Response(JSON.stringify({ code: "temporary_error" }), { status });
    };
    assert.equal((await sendBrevoEmail(delivery, configuration)).status, "uncertain");
    assert.equal(requests, 1);
  }
  for (const error of [
    new Error(configuration.apiKey),
    new DOMException("timeout", "TimeoutError"),
  ]) {
    let requests = 0;
    globalThis.fetch = async () => {
      requests++;
      throw error;
    };
    const result = await sendBrevoEmail(delivery, configuration);
    assert.equal(result.status, "uncertain");
    assert.equal(requests, 1);
    assert.doesNotMatch(JSON.stringify(result), /test-only-brevo-key/);
  }
});

test("Brevo 2xx malformed or missing message IDs are uncertain rather than successful", async () => {
  for (const body of [
    "not-json",
    "null",
    "{}",
    '{"messageId":""}',
    '{"messageId":" "}',
    '{"messageId":3}',
    '{"messageIds":["unexpected-batch"]}',
  ]) {
    globalThis.fetch = async () => new Response(body, { status: 201 });
    assert.equal((await sendBrevoEmail(delivery, configuration)).status, "uncertain");
  }
});
