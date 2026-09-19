import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { hashPassword, passwordInput, rateLimit, validEmail, verifyPassword } from "./auth";
import { getDb, HttpError, transaction } from "./db";
import { getBrevoConfiguration, sendBrevoEmail } from "./notifications";

export const RESET_COOKIE = "haru_password_reset";
const CODE_SECONDS = 600;
const GRANT_SECONDS = 300;
const DUMMY_HASH = `${"0".repeat(32)}:${"0".repeat(128)}`;
const invalidCode = "인증번호가 올바르지 않거나 만료되었습니다. 새 인증번호를 요청해주세요.";
const invalidGrant = "비밀번호 변경 인증이 만료되었거나 이미 사용되었습니다. 다시 인증해주세요.";
const requestMessage =
  "요청을 접수했습니다. 가입된 이메일이라면 인증번호 안내를 받을 수 있습니다. 도착하지 않으면 잠시 후 다시 요청해주세요.";
type Options = { now?: Date };
type ResetRow = {
  id: string;
  email_hash: string;
  user_id: string | null;
  code_hash: string;
  status: string;
  attempts: number;
  expires_at: string;
  reset_token_hash: string | null;
  reset_expires_at: string | null;
};

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
function sixDigits() {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}
function resetRequestId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
  )
    throw new HttpError(400, invalidCode);
  return value;
}

/** The public response never claims mail was sent or reveals whether an account exists. */
export async function requestPasswordReset(
  input: Record<string, unknown>,
  clientKey: string,
  options: Options = {},
) {
  rateLimit(`reset-request-ip:${clientKey}`, 20, 3600);
  const email = validEmail(input.email);
  // Account-independent configuration failures are honest 503s for every address.
  getBrevoConfiguration();
  const now = options.now || new Date();
  const stamp = now.toISOString();
  const emailHash = digest(email);
  const requestId = randomUUID();
  // Identical crypto work for known and unknown addresses. No usable code exists
  // until the durable queue is claimed; only its salted hash is persisted here.
  const dummyHash = await hashPassword(sixDigits());
  transaction((db) => {
    db.prepare("DELETE FROM auth_attempts WHERE expires_at<=?").run(now.getTime());
    const limits = [
      { bucket: digest(`reset-email-cooldown:${email}`), limit: 1, seconds: 60 },
      { bucket: digest(`reset-email-hour:${email}`), limit: 5, seconds: 3600 },
    ];
    for (const limit of limits) {
      const row = db.prepare("SELECT count FROM auth_attempts WHERE bucket=?").get(limit.bucket) as
        { count: number } | undefined;
      if (row && row.count >= limit.limit)
        throw new HttpError(
          429,
          limit.seconds === 60
            ? "인증번호는 60초 후에 다시 요청할 수 있습니다."
            : "이 이메일의 인증 요청이 많습니다. 1시간 후 다시 시도해주세요.",
        );
    }
    for (const limit of limits)
      db.prepare(
        "INSERT INTO auth_attempts(bucket,count,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1",
      ).run(limit.bucket, now.getTime() + limit.seconds * 1000);
    const user = db.prepare("SELECT id FROM users WHERE email=?").get(email) as
      { id: string } | undefined;
    db.prepare(
      "UPDATE password_reset_requests SET status='invalidated',code_hash='',reset_token_hash=NULL WHERE email_hash=? AND status NOT IN ('consumed','invalidated','expired')",
    ).run(emailHash);
    db.prepare(
      "INSERT INTO password_reset_requests(id,email_hash,user_id,code_hash,status,created_at,expires_at) VALUES(?,?,?,?,'queued',?,?)",
    ).run(
      requestId,
      emailHash,
      user?.id || null,
      dummyHash,
      stamp,
      new Date(now.getTime() + CODE_SECONDS * 1000).toISOString(),
    );
  });
  return { requestId, expiresIn: CODE_SECONDS, resendAfter: 60, message: requestMessage };
}

/**
 * Next.after starts delivery after the uniform 202 response; the existing cron
 * also recovers queued rows after a web-process restart. Codes are generated only
 * after an atomic claim and are never stored in an outbox, logs or API responses.
 * A claimed job is never replayed: a crash may have happened after acceptance.
 */
export async function processPasswordResetRequests(
  options: Options & { requestId?: string; limit?: number } = {},
) {
  const now = options.now || new Date();
  const stamp = now.toISOString();
  const db = getDb();
  db.prepare(
    "UPDATE password_reset_requests SET status='failed',code_hash='',error=? WHERE status='processing' AND claimed_at<=?",
  ).run(
    "이메일 전송 결과를 확인할 수 없어 자동 재발송을 중단했습니다. 새 인증번호를 요청해주세요.",
    new Date(now.getTime() - 60_000).toISOString(),
  );
  db.prepare(
    "UPDATE password_reset_requests SET status='expired',code_hash='',reset_token_hash=NULL WHERE (status IN ('queued','sent') AND expires_at<=?) OR (status='verified' AND reset_expires_at<=?)",
  ).run(stamp, stamp);
  const pending = db
    .prepare(
      "SELECT id FROM password_reset_requests WHERE status='queued' AND expires_at>? AND (? IS NULL OR id=?) ORDER BY created_at LIMIT ?",
    )
    .all(
      stamp,
      options.requestId || null,
      options.requestId || null,
      Math.max(1, Math.min(20, options.limit || 20)),
    ) as { id: string }[];
  const result = { checked: pending.length, accepted: 0, failed: 0, skipped: 0 };
  let cursor = 0;
  async function worker() {
    while (cursor < pending.length) {
      const id = pending[cursor++].id;
      const row = transaction((connection) => {
        const changed = connection
          .prepare(
            "UPDATE password_reset_requests SET status='processing',claimed_at=? WHERE id=? AND status='queued' AND expires_at>?",
          )
          .run(stamp, id, stamp);
        if (!changed.changes) return null;
        return connection
          .prepare(
            "SELECT r.*,u.email,u.name FROM password_reset_requests r LEFT JOIN users u ON u.id=r.user_id WHERE r.id=?",
          )
          .get(id) as ResetRow & { email: string | null; name: string | null };
      });
      if (!row) {
        result.skipped++;
        continue;
      }
      const code = sixDigits();
      const hash = await hashPassword(code);
      const sendStamp = (options.now || new Date()).toISOString();
      const updated = db
        .prepare(
          "UPDATE password_reset_requests SET code_hash=? WHERE id=? AND status='processing' AND expires_at>?",
        )
        .run(hash, id, sendStamp);
      if (!updated.changes || !row.user_id || !row.email) {
        db.prepare(
          "UPDATE password_reset_requests SET status='invalidated',code_hash='' WHERE id=? AND status='processing'",
        ).run(id);
        result.skipped++;
        continue;
      }
      let configuration;
      try {
        configuration = getBrevoConfiguration();
      } catch {
        db.prepare(
          "UPDATE password_reset_requests SET status='failed',code_hash='',error=? WHERE id=? AND status='processing'",
        ).run("이메일 서비스 설정으로 인증번호를 보낼 수 없습니다. 관리자에게 문의해주세요.", id);
        result.failed++;
        continue;
      }
      // No body containing an authentication code is written to notification_logs.
      const outcome = await sendBrevoEmail(
        {
          id,
          recipient: row.email,
          subject: "[하루영양] 비밀번호 재설정 인증번호",
          body: `안녕하세요, ${row.name}님.\n\n비밀번호 재설정 인증번호는 ${code}입니다.\n요청 시점부터 10분 동안만 사용할 수 있습니다.\n\n인증번호를 타인에게 알려주지 마세요. 직접 요청하지 않았다면 이 메일을 무시해주세요. 기존 비밀번호는 변경되지 않았습니다.`,
        },
        configuration,
      );
      if (outcome.status === "accepted") {
        const changed = db
          .prepare(
            "UPDATE password_reset_requests SET status='sent',sent_at=?,provider_id=?,error=NULL WHERE id=? AND status='processing'",
          )
          .run(stamp, outcome.messageId, id);
        if (changed.changes) result.accepted++;
        else result.skipped++;
      } else {
        db.prepare(
          "UPDATE password_reset_requests SET status='failed',code_hash='',error=? WHERE id=? AND status='processing'",
        ).run(outcome.error, id);
        result.failed++;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
  if (result.failed > 0)
    console.error(
      "[password-reset] Email delivery failed; details are stored without codes or keys.",
      { failed: result.failed },
    );
  return result;
}

export async function verifyPasswordReset(
  input: Record<string, unknown>,
  clientKey: string,
  options: Options = {},
) {
  rateLimit(`reset-verify-ip:${clientKey}`, 100, 900);
  const emailHash = digest(validEmail(input.email));
  const id = resetRequestId(input.requestId);
  if (typeof input.code !== "string" || !/^\d{6}$/.test(input.code))
    throw new HttpError(400, invalidCode);
  const now = options.now || new Date();
  const stamp = now.toISOString();
  const row = transaction((db) => {
    const found = db
      .prepare("SELECT * FROM password_reset_requests WHERE id=? AND email_hash=?")
      .get(id, emailHash) as ResetRow | undefined;
    if (!found || found.status !== "sent" || found.expires_at <= stamp || found.attempts >= 5)
      return null;
    // Reserve the attempt before asynchronous scrypt; parallel requests cannot exceed five.
    db.prepare("UPDATE password_reset_requests SET attempts=attempts+1 WHERE id=?").run(id);
    return found;
  });
  const valid = await verifyPassword(input.code, row?.code_hash || DUMMY_HASH);
  const token = randomBytes(32).toString("base64url");
  const verified = transaction((db) => {
    if (!row) return false;
    const verifiedNow = options.now || new Date();
    const verifiedStamp = verifiedNow.toISOString();
    const current = db
      .prepare("SELECT * FROM password_reset_requests WHERE id=?")
      .get(id) as ResetRow;
    if (
      current.status !== "sent" ||
      current.expires_at <= verifiedStamp ||
      current.code_hash !== row.code_hash
    )
      return false;
    if (!valid) {
      if (current.attempts >= 5)
        db.prepare(
          "UPDATE password_reset_requests SET status='invalidated',code_hash='' WHERE id=?",
        ).run(id);
      return false;
    }
    db.prepare(
      "UPDATE password_reset_requests SET status='verified',code_hash='',verified_at=?,reset_token_hash=?,reset_expires_at=? WHERE id=?",
    ).run(
      verifiedStamp,
      digest(token),
      new Date(verifiedNow.getTime() + GRANT_SECONDS * 1000).toISOString(),
      id,
    );
    return true;
  });
  if (!verified) throw new HttpError(400, invalidCode);
  return { token, expiresIn: GRANT_SECONDS };
}

export async function completePasswordReset(
  input: Record<string, unknown>,
  token: string | undefined,
  clientKey: string,
  options: Options = {},
) {
  rateLimit(`reset-complete-ip:${clientKey}`, 30, 900);
  const password = passwordInput(input.password);
  if (password !== input.passwordConfirm)
    throw new HttpError(400, "비밀번호 확인이 일치하지 않습니다.");
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(400, invalidGrant);
  const hash = await hashPassword(password);
  const stamp = (options.now || new Date()).toISOString();
  transaction((db) => {
    const row = db
      .prepare("SELECT * FROM password_reset_requests WHERE reset_token_hash=?")
      .get(digest(token)) as ResetRow | undefined;
    if (
      !row ||
      !row.user_id ||
      row.status !== "verified" ||
      !row.reset_expires_at ||
      row.reset_expires_at <= stamp
    )
      throw new HttpError(400, invalidGrant);
    db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(hash, row.user_id);
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(row.user_id);
    db.prepare(
      "UPDATE password_reset_requests SET status='invalidated',code_hash='',reset_token_hash=NULL WHERE user_id=? AND status!='consumed'",
    ).run(row.user_id);
    db.prepare("UPDATE password_reset_requests SET status='consumed',consumed_at=? WHERE id=?").run(
      stamp,
      row.id,
    );
  });
  return { reset: true };
}

export function passwordResetToken(request: Request): string | undefined {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${RESET_COOKIE}=`))
    ?.slice(RESET_COOKIE.length + 1);
}
export function passwordResetCookie(token: string): string {
  return `${RESET_COOKIE}=${token}; Path=/api/auth/password-reset; HttpOnly; SameSite=Lax; Max-Age=${token ? GRANT_SECONDS : 0}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}
