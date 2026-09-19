// The worker calls the web service; only the web service needs database/provider access.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** @param {Record<string, string | undefined>} env */
export function readWorkerConfig(env = process.env) {
  const secret = env.CRON_SECRET;
  if (!secret || secret.trim() !== secret || /[\r\n]/.test(secret) || secret.length < 24) {
    throw new Error(
      "CRON_SECRET must contain at least 24 characters without surrounding whitespace.",
    );
  }
  if (!env.APP_URL && env.NODE_ENV === "production") {
    throw new Error("APP_URL is required for the production reminder worker.");
  }
  let appUrl;
  try {
    appUrl = new URL(env.APP_URL || "http://localhost:3000");
  } catch {
    throw new Error("APP_URL must be an absolute HTTP(S) origin.");
  }
  if (
    !["http:", "https:"].includes(appUrl.protocol) ||
    appUrl.username ||
    appUrl.password ||
    appUrl.search ||
    appUrl.hash ||
    appUrl.pathname !== "/"
  ) {
    throw new Error(
      "APP_URL must be an HTTP(S) origin without credentials, path, query, or fragment.",
    );
  }
  return { endpoint: new URL("/api/cron/notifications", appUrl).href, secret };
}

/**
 * Requests are serial. A failed request is retried on the next tick, without a tight retry loop.
 * The server's persistent notification claims handle retries and overlapping deployments.
 * @param {{endpoint: string, secret: string}} config
 * @param {{fetchFn?: typeof fetch, logger?: Pick<Console, "log" | "error">, intervalMs?: number, requestTimeoutMs?: number}} options
 */
export function startReminderWorker(config, options = {}) {
  const fetchFn = options.fetchFn || fetch;
  const logger = options.logger || console;
  const intervalMs = options.intervalMs ?? 60_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 55_000;
  if (
    !Number.isFinite(intervalMs) ||
    intervalMs < 1 ||
    !Number.isFinite(requestTimeoutMs) ||
    requestTimeoutMs < 1
  ) {
    throw new Error("Reminder intervals and timeouts must be positive numbers.");
  }
  let stopped = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {AbortController | undefined} */
  let activeController;
  /** @type {Promise<void>} */
  let inFlight;

  async function run() {
    if (stopped) return;
    const controller = new AbortController();
    activeController = controller;
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchFn(config.endpoint, {
        headers: { Authorization: `Bearer ${config.secret}` },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        // Never log response bodies, request headers, URLs, or provider/user data.
        logger.error(`[reminders] HTTP ${response.status}; retrying on the next tick.`);
        await response.body?.cancel();
      } else {
        const result = await response.json();
        if (!result?.data || typeof result.data !== "object") throw new Error("Invalid response");
        if (!["capture", "brevo"].includes(result.data.mode)) throw new Error("Invalid email mode");
        const counts = Object.fromEntries(
          ["checked", "sent", "captured", "failed", "skipped"].map((key) => [
            key,
            Number.isSafeInteger(result.data[key]) && result.data[key] >= 0 ? result.data[key] : 0,
          ]),
        );
        const mode = result.data.mode;
        logger.log(
          `[reminders] ${new Date().toISOString()} ${JSON.stringify({ mode, ...counts })}`,
        );
      }
    } catch {
      if (!stopped) {
        logger.error(
          controller.signal.aborted
            ? "[reminders] Request timed out; retrying on the next tick."
            : "[reminders] Request failed; retrying on the next tick.",
        );
      }
    } finally {
      clearTimeout(timeout);
      activeController = undefined;
      if (!stopped) {
        // Schedule only after completion, so a slow scan cannot overlap another scan.
        timer = setTimeout(() => {
          inFlight = run();
        }, intervalMs);
      }
    }
  }

  inFlight = run();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      activeController?.abort();
      await inFlight;
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const worker = startReminderWorker(readWorkerConfig());
    const shutdown = () => {
      void worker.stop();
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  } catch (error) {
    // Configuration errors are authored above and do not contain the supplied values.
    console.error(
      `[reminders] ${error instanceof Error ? error.message : "Invalid configuration."}`,
    );
    process.exitCode = 1;
  }
}
