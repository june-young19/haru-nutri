import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { getDb, HttpError, transaction } from "./db";

export const SESSION_COOKIE = "haru_session";
const SESSION_SECONDS = 7 * 24 * 60 * 60;
export type PublicUser = {
  id: string;
  email: string;
  name: string;
  age: number | null;
  onboarded: boolean;
};
type UserRow = {
  id: string;
  email: string;
  name: string;
  age: number | null;
  onboarded: number;
  password_hash: string;
};

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, 64, (error, key) => (error ? reject(error) : resolve(key))),
  );
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${(await derive(password, salt)).toString("hex")}`;
}
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const [salt, stored] = hash.split(":");
  if (!salt || !stored) return false;
  const expected = Buffer.from(stored, "hex");
  const actual = await derive(password, salt);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function publicUser(user: UserRow): PublicUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    age: user.age,
    onboarded: Boolean(user.onboarded),
  };
}
export function validEmail(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "이메일을 입력해주세요.");
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new HttpError(400, "올바른 이메일을 입력해주세요.");
  return email;
}
export function validName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 30)
    throw new HttpError(400, "이름은 1~30자로 입력해주세요.");
  return value.trim();
}
export function validAge(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 120)
    throw new HttpError(400, "나이는 1~120 사이의 정수로 입력해주세요.");
  return value;
}
export function passwordInput(value: unknown): string {
  if (typeof value !== "string" || value.length < 10 || value.length > 128)
    throw new HttpError(400, "비밀번호는 10~128자로 입력해주세요.");
  return value;
}

/** Persistent limits survive application restarts; buckets never store email/IP in cleartext. */
export function rateLimit(
  bucket: string,
  limit: number,
  windowSeconds: number,
  owner?: string,
): void {
  const now = Date.now();
  const key = digest(bucket);
  const allowed = transaction((db) => {
    db.prepare("DELETE FROM auth_attempts WHERE expires_at < ?").run(now);
    const row = db.prepare("SELECT count FROM auth_attempts WHERE bucket = ?").get(key) as
      { count: number } | undefined;
    if (row && row.count >= limit) return false;
    db.prepare(
      "INSERT INTO auth_attempts(bucket,count,expires_at,owner_hash) VALUES(?,1,?,?) ON CONFLICT(bucket) DO UPDATE SET count=count+1,owner_hash=COALESCE(excluded.owner_hash,auth_attempts.owner_hash)",
    ).run(key, now + windowSeconds * 1000, owner ? digest(owner) : null);
    return true;
  });
  if (!allowed) throw new HttpError(429, "시도가 너무 많습니다. 잠시 후 다시 시도해주세요.");
}

export async function signup(
  input: Record<string, unknown>,
  clientKey: string,
): Promise<{ user: PublicUser; token: string }> {
  const email = validEmail(input.email);
  const password = passwordInput(input.password);
  const name = validName(input.name);
  const age = validAge(input.age);
  rateLimit(`signup:${clientKey}`, 20, 3600);
  const hash = await hashPassword(password);
  const user = transaction((db) => {
    if (db.prepare("SELECT id FROM users WHERE email=?").get(email))
      throw new HttpError(409, "이미 가입된 이메일입니다.");
    const id = randomUUID();
    db.prepare(
      "INSERT INTO users(id,email,name,age,password_hash,created_at) VALUES(?,?,?,?,?,?)",
    ).run(id, email, name, age, hash, new Date().toISOString());
    db.prepare("INSERT INTO guardian_settings(user_id) VALUES(?)").run(id);
    return { id, email, name, age, onboarded: false };
  });
  return { user, token: createSession(user.id) };
}

export async function login(
  input: Record<string, unknown>,
  clientKey: string,
): Promise<{ user: PublicUser; token: string }> {
  const email = validEmail(input.email);
  const password = passwordInput(input.password);
  rateLimit(`login:${email}:${clientKey}`, 10, 900, `email:${email}`);
  rateLimit(`login-account:${email}`, 20, 900, `email:${email}`);
  rateLimit(`login-global:${clientKey}`, 100, 900);
  const row = getDb().prepare("SELECT * FROM users WHERE email=?").get(email) as
    UserRow | undefined;
  // Derive a dummy key for unknown accounts to avoid a fast account-discovery path.
  const valid = await verifyPassword(
    password,
    row?.password_hash || `${"0".repeat(32)}:${"0".repeat(128)}`,
  );
  if (!row || !valid) throw new HttpError(401, "이메일 또는 비밀번호를 확인해주세요.");
  // A reset may have completed while scrypt was running. Never create a fresh
  // session from a password hash that has since been replaced.
  return transaction((db) => {
    const current = db.prepare("SELECT * FROM users WHERE id=?").get(row.id) as UserRow | undefined;
    if (!current || current.password_hash !== row.password_hash)
      throw new HttpError(401, "이메일 또는 비밀번호를 확인해주세요.");
    return { user: publicUser(current), token: createSession(current.id) };
  });
}

function createSession(userId: string): string {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const db = getDb();
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now.toISOString());
  db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)").run(
    digest(token),
    userId,
    new Date(now.getTime() + SESSION_SECONDS * 1000).toISOString(),
    now.toISOString(),
  );
  return token;
}
export function requestToken(request: Request): string | undefined {
  return request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
}
/** Shared by API requests and server-rendered pages. Database failures propagate. */
export function getSessionUser(token: string | undefined): PublicUser | null {
  if (!token || token.length > 100) return null;
  const row = getDb()
    .prepare(
      "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?",
    )
    .get(digest(token), new Date().toISOString()) as UserRow | undefined;
  return row ? publicUser(row) : null;
}
export function requireUser(request: Request): PublicUser {
  const token = requestToken(request);
  if (!token || token.length > 100) throw new HttpError(401, "로그인이 필요합니다.");
  const user = getSessionUser(token);
  if (!user) throw new HttpError(401, "로그인이 만료되었습니다. 다시 로그인해주세요.");
  return user;
}
export function logout(request: Request): void {
  const token = requestToken(request);
  if (token) getDb().prepare("DELETE FROM sessions WHERE token_hash=?").run(digest(token));
}
export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token ? SESSION_SECONDS : 0}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`;
}

export function checkOrigin(request: Request): void {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  if (request.headers.get("sec-fetch-site") === "cross-site")
    throw new HttpError(403, "허용되지 않은 요청입니다.");
  const origin = request.headers.get("origin");
  if (!origin) return; // Non-browser API clients have no ambient browser credentials.
  const allowed = new Set([new URL(request.url).origin]);
  if (process.env.APP_URL) {
    try {
      allowed.add(new URL(process.env.APP_URL).origin);
    } catch {
      /* invalid configuration is not trusted */
    }
  }
  if (!allowed.has(origin)) throw new HttpError(403, "허용되지 않은 요청입니다.");
}
