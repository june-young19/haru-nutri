import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const schema = `
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 name TEXT NOT NULL, age INTEGER CHECK(age IS NULL OR (typeof(age)='integer' AND age BETWEEN 1 AND 120)),
 password_hash TEXT NOT NULL,
 onboarded INTEGER NOT NULL DEFAULT 0, onboarding_choice TEXT,
 survey_answers TEXT, reminder_enabled INTEGER NOT NULL DEFAULT 1,
 delay_minutes INTEGER NOT NULL DEFAULT 30,
 guardian_delay_minutes INTEGER NOT NULL DEFAULT 120,
 timezone TEXT NOT NULL DEFAULT 'Asia/Seoul', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS auth_attempts (
 bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS supplements (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL, brand TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT 'mint',
 created_at TEXT NOT NULL, archived_at TEXT
);
CREATE INDEX IF NOT EXISTS supplements_user ON supplements(user_id,archived_at);
CREATE TABLE IF NOT EXISTS supplement_ingredients (
 id TEXT PRIMARY KEY, supplement_id TEXT NOT NULL REFERENCES supplements(id) ON DELETE CASCADE,
 name TEXT NOT NULL, amount REAL NOT NULL CHECK(amount > 0),
 unit TEXT NOT NULL CHECK(unit IN ('mg','μg','IU','g'))
);
CREATE INDEX IF NOT EXISTS ingredients_supplement ON supplement_ingredients(supplement_id);
CREATE TABLE IF NOT EXISTS intake_schedules (
 id TEXT PRIMARY KEY, supplement_id TEXT NOT NULL REFERENCES supplements(id) ON DELETE CASCADE,
 time TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT,
 name_snapshot TEXT NOT NULL, brand_snapshot TEXT NOT NULL DEFAULT '', color_snapshot TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS schedules_supplement ON intake_schedules(supplement_id,start_date,end_date);
CREATE TABLE IF NOT EXISTS intake_records (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 schedule_id TEXT NOT NULL REFERENCES intake_schedules(id), date TEXT NOT NULL,
 completed_at TEXT NOT NULL, UNIQUE(schedule_id,date)
);
CREATE INDEX IF NOT EXISTS records_user_date ON intake_records(user_id,date);
CREATE TABLE IF NOT EXISTS guardian_settings (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 email TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 0,
 consented_at TEXT
);
CREATE TABLE IF NOT EXISTS notification_logs (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 schedule_id TEXT NOT NULL REFERENCES intake_schedules(id), date TEXT NOT NULL,
 channel TEXT NOT NULL CHECK(channel IN ('user','guardian')),
 status TEXT NOT NULL CHECK(status IN ('processing','sent','captured','failed','skipped')),
 recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
 provider_id TEXT, error TEXT, created_at TEXT NOT NULL, sent_at TEXT,
 claimed_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 1,
 retryable INTEGER NOT NULL DEFAULT 0 CHECK(retryable IN (0,1)),
 UNIQUE(schedule_id,date,channel)
);
CREATE INDEX IF NOT EXISTS notifications_user ON notification_logs(user_id,created_at);
`;

let database: DatabaseSync | undefined;
let databasePath: string | undefined;

/** SQLite contains private account data; only the server imports this module. */
export function getDb(): DatabaseSync {
  const requested = process.env.DATABASE_PATH || "./data/haru.db";
  const filename = requested === ":memory:" ? requested : resolve(requested);
  if (database && databasePath === filename) return database;
  if (database) database.close();
  if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
  database = new DatabaseSync(filename);
  databasePath = filename;
  database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  database.exec("BEGIN IMMEDIATE");
  try {
    const version = database.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version > 3)
      throw new Error("This database needs a newer version of Haru Nutri.");
    database.exec(schema);
    const columns = database.prepare("PRAGMA table_info(users)").all() as { name: string }[];
    const names = new Set(columns.map((column) => column.name));
    // v1 -> v2 is an in-place migration: keep IDs, password hashes, sessions,
    // schedules, histories and notification logs. Legacy ages remain unknown.
    if (!names.has("name") && names.has("nickname"))
      database.exec("ALTER TABLE users RENAME COLUMN nickname TO name");
    if (!names.has("age"))
      database.exec(
        "ALTER TABLE users ADD COLUMN age INTEGER CHECK(age IS NULL OR (typeof(age)='integer' AND age BETWEEN 1 AND 120))",
      );
    const notificationColumns = database.prepare("PRAGMA table_info(notification_logs)").all() as {
      name: string;
    }[];
    // v2 -> v3 preserves every log. Old failed/unfinished requests have an unknown
    // delivery outcome, so switching providers must never automatically replay them.
    if (!notificationColumns.some((column) => column.name === "retryable"))
      database.exec(
        "ALTER TABLE notification_logs ADD COLUMN retryable INTEGER NOT NULL DEFAULT 0 CHECK(retryable IN (0,1))",
      );
    database.exec("PRAGMA user_version = 3; COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK");
    database.close();
    database = undefined;
    databasePath = undefined;
    throw error;
  }
  return database;
}

export function transaction<T>(work: (db: DatabaseSync) => T): T {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work(db);
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function closeDatabase(): void {
  database?.close();
  database = undefined;
  databasePath = undefined;
}

export function getToday(now = new Date()): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function scheduledInstant(date: string, time: string): Date {
  return new Date(`${date}T${time}:00+09:00`);
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
