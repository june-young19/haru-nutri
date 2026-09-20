import { createHash, randomBytes } from "node:crypto";
import { rateLimit, requestToken, verifyPassword } from "./auth";
import { getDb, HttpError, transaction } from "./db";

export const DELETION_COOKIE = "haru_account_deletion";
const GRANT_SECONDS = 300;
const invalidGrant = "회원 탈퇴 본인 확인이 만료되었습니다. 비밀번호를 다시 확인해주세요.";
type Options = { now?: Date };
type ActiveSession = {
  id: string;
  email: string;
  password_hash: string;
  session_hash: string;
};
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function activeSession(request: Request, now: Date): ActiveSession {
  const token = requestToken(request);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new HttpError(401, "로그인이 필요합니다.");
  const row = getDb()
    .prepare(
      "SELECT u.id,u.email,u.password_hash,s.token_hash AS session_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?",
    )
    .get(digest(token), now.toISOString()) as ActiveSession | undefined;
  if (!row) throw new HttpError(401, "로그인이 만료되었습니다. 다시 로그인해주세요.");
  return row;
}

/** The grant is bound to one existing login session and the verified password version. */
export async function verifyAccountDeletion(
  request: Request,
  input: Record<string, unknown>,
  clientKey: string,
  options: Options = {},
) {
  const initial = activeSession(request, options.now || new Date());
  rateLimit(`delete-verify-ip:${clientKey}`, 20, 900);
  rateLimit(`delete-verify-user:${initial.id}`, 5, 900, `user:${initial.id}`);
  const token = randomBytes(32).toString("base64url");
  const tokenHash = digest(token);
  transaction((db) => {
    const now = options.now || new Date();
    const current = activeSession(request, now);
    if (current.id !== initial.id || current.password_hash !== initial.password_hash)
      throw new HttpError(400, invalidGrant);
    db.prepare("DELETE FROM account_deletion_grants WHERE expires_at<=? OR session_hash=?").run(
      now.toISOString(),
      current.session_hash,
    );
    // Reserve before scrypt: cancellation or a newer verification removes this
    // exact attempt. An empty version is pending and can never authorize deletion.
    db.prepare(
      "INSERT INTO account_deletion_grants(token_hash,user_id,session_hash,password_version,created_at,expires_at) VALUES(?,?,?,?,?,?)",
    ).run(
      tokenHash,
      current.id,
      current.session_hash,
      "",
      now.toISOString(),
      new Date(now.getTime() + GRANT_SECONDS * 1000).toISOString(),
    );
  });
  try {
    if (
      typeof input.password !== "string" ||
      input.password.length < 10 ||
      input.password.length > 128 ||
      !(await verifyPassword(input.password, initial.password_hash))
    )
      throw new HttpError(400, "비밀번호가 올바르지 않습니다.");
    return transaction((db) => {
      // Logout, reset, cancellation and newer verification may finish during scrypt.
      const now = options.now || new Date();
      const current = activeSession(request, now);
      if (current.id !== initial.id || current.password_hash !== initial.password_hash)
        throw new HttpError(400, invalidGrant);
      const activated = db
        .prepare(
          "UPDATE account_deletion_grants SET password_version=?,created_at=?,expires_at=? WHERE token_hash=? AND user_id=? AND session_hash=? AND password_version='' AND expires_at>?",
        )
        .run(
          digest(current.password_hash),
          now.toISOString(),
          new Date(now.getTime() + GRANT_SECONDS * 1000).toISOString(),
          tokenHash,
          current.id,
          current.session_hash,
          now.toISOString(),
        );
      if (!activated.changes) throw new HttpError(400, invalidGrant);
      return { token, expiresIn: GRANT_SECONDS };
    });
  } catch (error) {
    // Only this attempt may be removed; a newer request owns a different token.
    getDb().prepare("DELETE FROM account_deletion_grants WHERE token_hash=?").run(tokenHash);
    throw error;
  }
}

/** A synchronous transaction removes all personal rows, including archived history. */
export function completeAccountDeletion(
  request: Request,
  input: Record<string, unknown>,
  clientKey: string,
  options: Options = {},
) {
  activeSession(request, options.now || new Date());
  rateLimit(`delete-complete-ip:${clientKey}`, 30, 900);
  if (input.confirmed !== true) throw new HttpError(400, "회원 탈퇴 최종 확인이 필요합니다.");
  const token = deletionToken(request);
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new HttpError(400, invalidGrant);
  try {
    return transaction((db) => {
      const now = options.now || new Date();
      const user = activeSession(request, now);
      const grant = db
        .prepare(
          "SELECT password_version FROM account_deletion_grants WHERE token_hash=? AND user_id=? AND session_hash=? AND expires_at>?",
        )
        .get(digest(token), user.id, user.session_hash, now.toISOString()) as
        { password_version: string } | undefined;
      if (!grant || grant.password_version !== digest(user.password_hash))
        throw new HttpError(400, invalidGrant);

      // These two schedule references deliberately have NO ACTION, since normal
      // supplement archiving retains history. Account deletion must erase both first.
      db.prepare("DELETE FROM intake_records WHERE user_id=?").run(user.id);
      db.prepare("DELETE FROM notification_logs WHERE user_id=?").run(user.id);
      // Include anonymous requests made before this address registered.
      db.prepare("DELETE FROM password_reset_requests WHERE user_id=? OR email_hash=?").run(
        user.id,
        digest(user.email.trim().toLowerCase()),
      );
      db.prepare("DELETE FROM auth_attempts WHERE owner_hash IN (?,?)").run(
        digest(`user:${user.id}`),
        digest(`email:${user.email}`),
      );
      const personalBuckets = [
        `login-account:${user.email}`,
        `login:${user.email}:${clientKey}`,
        `reset-email-cooldown:${user.email}`,
        `reset-email-hour:${user.email}`,
        `products-user:${user.id}`,
        `notification-preview:${user.id}`,
        `delete-verify-user:${user.id}`,
      ];
      const removeBucket = db.prepare("DELETE FROM auth_attempts WHERE bucket=?");
      personalBuckets.forEach((bucket) => removeBucket.run(digest(bucket)));
      // Cascades remove settings/survey, every session and grant, supplements,
      // ingredient rows and all schedule versions, including archived products.
      db.prepare("DELETE FROM users WHERE id=?").run(user.id);
      return { deleted: true };
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    // Never expose SQL, account details or password/grant hashes to the client.
    console.error("[account-deletion] Database deletion failed.");
    throw new HttpError(500, "회원 탈퇴 처리 중 문제가 발생했습니다. 잠시 후 다시 시도해주세요.");
  }
}

export function cancelAccountDeletion(request: Request) {
  const session = activeSession(request, new Date());
  getDb()
    .prepare("DELETE FROM account_deletion_grants WHERE session_hash=?")
    .run(session.session_hash);
  return { cancelled: true };
}
function deletionToken(request: Request): string | undefined {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${DELETION_COOKIE}=`))
    ?.slice(DELETION_COOKIE.length + 1);
}
export function accountDeletionCookie(token: string): string {
  return `${DELETION_COOKIE}=${token}; Path=/api/account/deletion; HttpOnly; SameSite=Lax; Max-Age=${token ? GRANT_SECONDS : 0}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}
