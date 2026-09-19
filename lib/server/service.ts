import { randomUUID } from "node:crypto";
import { getDb, getToday, HttpError, shiftDate, transaction } from "./db";
import { validAge, validEmail, validName } from "./auth";
import { normalizeIngredient } from "../domain";

export type IngredientInput = { name: string; amount: number; unit: string };
export type SupplementInput = {
  name: string;
  brand: string;
  color: string;
  ingredients: IngredientInput[];
  times: string[];
};
type SupplementRow = {
  id: string;
  user_id: string;
  name: string;
  brand: string;
  color: string;
  created_at: string;
  archived_at: string | null;
};
type ScheduleRow = { id: string; time: string; start_date: string; end_date: string | null };
export type TodayItem = {
  scheduleId: string;
  supplementId: string;
  name: string;
  brand: string;
  color: string;
  time: string;
  completedAt: string | null;
  archived: boolean;
};

function stringInput(value: unknown, label: string, max: number, optional = false): string {
  if (optional && (value === undefined || value === null)) return "";
  if (typeof value !== "string" || (!optional && !value.trim()) || value.trim().length > max)
    throw new HttpError(400, `${label}을(를) ${optional ? "0" : "1"}~${max}자로 입력해주세요.`);
  return value.trim();
}
export function validateSupplement(input: Record<string, unknown>): SupplementInput {
  const name = stringInput(input.name, "영양제 이름", 80);
  const brand = stringInput(input.brand, "제품명 또는 제조사", 100, true);
  const colors = [
    "mint",
    "peach",
    "lavender",
    "blue",
    "yellow",
    "pink",
    "green",
    "orange",
    "purple",
  ];
  const color =
    typeof input.color === "string" && colors.includes(input.color) ? input.color : "mint";
  if (
    !Array.isArray(input.times) ||
    input.times.length < 1 ||
    input.times.length > 8 ||
    input.times.some(
      (time) => typeof time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time),
    ) ||
    new Set(input.times).size !== input.times.length
  )
    throw new HttpError(400, "복용 시간은 중복 없이 1~8개 등록해주세요.");
  if (
    !Array.isArray(input.ingredients) ||
    input.ingredients.length < 1 ||
    input.ingredients.length > 20
  )
    throw new HttpError(400, "성분은 1~20개 등록해주세요.");
  const ingredients = input.ingredients.map((raw: unknown): IngredientInput => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new HttpError(400, "성분 정보를 확인해주세요.");
    const ingredient = raw as Record<string, unknown>;
    const ingredientName = stringInput(ingredient.name, "성분 이름", 60);
    if (
      typeof ingredient.amount !== "number" ||
      !Number.isFinite(ingredient.amount) ||
      ingredient.amount <= 0 ||
      ingredient.amount > 10_000_000
    )
      throw new HttpError(400, "성분 함량은 0보다 크고 10,000,000 이하인 숫자로 입력해주세요.");
    const unit = ingredient.unit === "µg" || ingredient.unit === "mcg" ? "μg" : ingredient.unit;
    if (typeof unit !== "string" || !["mg", "μg", "IU", "g"].includes(unit))
      throw new HttpError(400, "지원하는 단위는 mg, μg, IU, g입니다.");
    return { name: ingredientName, amount: ingredient.amount, unit };
  });
  const keys = ingredients.map((item) => normalizeIngredient(item.name));
  if (new Set(keys).size !== keys.length)
    throw new HttpError(400, "같은 성분은 한 제품에 한 번만 입력해주세요.");
  return { name, brand, color, ingredients, times: [...input.times].sort() as string[] };
}

function ownSupplement(userId: string, id: string): SupplementRow {
  const row = getDb()
    .prepare("SELECT * FROM supplements WHERE id=? AND user_id=? AND archived_at IS NULL")
    .get(id, userId) as SupplementRow | undefined;
  if (!row) throw new HttpError(404, "영양제를 찾을 수 없습니다.");
  return row;
}
function serializeSupplement(row: SupplementRow) {
  const db = getDb();
  const ingredients = db
    .prepare(
      "SELECT id,name,amount,unit FROM supplement_ingredients WHERE supplement_id=? ORDER BY rowid",
    )
    .all(row.id) as Array<IngredientInput & { id: string }>;
  const schedules = db
    .prepare(
      "SELECT id,time,start_date,end_date FROM intake_schedules WHERE supplement_id=? AND start_date=(SELECT MAX(start_date) FROM intake_schedules WHERE supplement_id=? AND (end_date IS NULL OR end_date>=start_date)) AND (end_date IS NULL OR end_date>=start_date) ORDER BY time",
    )
    .all(row.id, row.id) as ScheduleRow[];
  return {
    id: row.id,
    name: row.name,
    brand: row.brand,
    color: row.color,
    createdAt: row.created_at,
    ingredients,
    times: schedules.map((schedule) => schedule.time),
    schedules: schedules.map((schedule) => ({
      id: schedule.id,
      time: schedule.time,
      startDate: schedule.start_date,
      endDate: schedule.end_date,
    })),
    scheduleChangeEffectiveDate: schedules[0]?.start_date ?? getToday(),
  };
}
export function listSupplements(userId: string) {
  return (
    getDb()
      .prepare(
        "SELECT * FROM supplements WHERE user_id=? AND archived_at IS NULL ORDER BY created_at DESC",
      )
      .all(userId) as SupplementRow[]
  ).map(serializeSupplement);
}
export function getSupplement(userId: string, id: string) {
  return serializeSupplement(ownSupplement(userId, id));
}

export function saveSupplement(userId: string, raw: Record<string, unknown>, id?: string) {
  const input = validateSupplement(raw);
  if (id) ownSupplement(userId, id);
  const supplementId = id || randomUUID();
  const now = new Date().toISOString();
  const today = getToday();
  transaction((db) => {
    let effectiveDate = today;
    let recreateSchedules = true;
    if (id) {
      const current = serializeSupplement(ownSupplement(userId, id));
      recreateSchedules =
        current.name !== input.name ||
        current.brand !== input.brand ||
        current.color !== input.color ||
        JSON.stringify(current.times) !== JSON.stringify(input.times);
      if (recreateSchedules) {
        const completed = db
          .prepare(
            "SELECT r.id FROM intake_records r JOIN intake_schedules s ON s.id=r.schedule_id WHERE s.supplement_id=? AND r.user_id=? AND r.date=? LIMIT 1",
          )
          .get(id, userId, today);
        if (completed) effectiveDate = shiftDate(today, 1);
        db.prepare(
          "UPDATE intake_schedules SET end_date=? WHERE supplement_id=? AND (end_date IS NULL OR end_date>=?)",
        ).run(shiftDate(effectiveDate, -1), id, effectiveDate);
      }
      db.prepare("UPDATE supplements SET name=?,brand=?,color=? WHERE id=? AND user_id=?").run(
        input.name,
        input.brand,
        input.color,
        id,
        userId,
      );
      db.prepare("DELETE FROM supplement_ingredients WHERE supplement_id=?").run(id);
    } else {
      db.prepare(
        "INSERT INTO supplements(id,user_id,name,brand,color,created_at) VALUES(?,?,?,?,?,?)",
      ).run(supplementId, userId, input.name, input.brand, input.color, now);
    }
    const ingredientStatement = db.prepare(
      "INSERT INTO supplement_ingredients(id,supplement_id,name,amount,unit) VALUES(?,?,?,?,?)",
    );
    input.ingredients.forEach((ingredient) =>
      ingredientStatement.run(
        randomUUID(),
        supplementId,
        ingredient.name,
        ingredient.amount,
        ingredient.unit,
      ),
    );
    if (recreateSchedules) {
      const scheduleStatement = db.prepare(
        "INSERT INTO intake_schedules(id,supplement_id,time,start_date,name_snapshot,brand_snapshot,color_snapshot,created_at) VALUES(?,?,?,?,?,?,?,?)",
      );
      input.times.forEach((time) =>
        scheduleStatement.run(
          randomUUID(),
          supplementId,
          time,
          effectiveDate,
          input.name,
          input.brand,
          input.color,
          now,
        ),
      );
    }
  });
  return getSupplement(userId, supplementId);
}

export function archiveSupplement(userId: string, id: string) {
  ownSupplement(userId, id);
  const today = getToday();
  transaction((db) => {
    db.prepare("UPDATE supplements SET archived_at=? WHERE id=? AND user_id=?").run(
      new Date().toISOString(),
      id,
      userId,
    );
    // Completed slots remain available to read-only history, never today's active timeline.
    db.prepare(
      "UPDATE intake_schedules SET end_date=CASE WHEN id IN (SELECT schedule_id FROM intake_records WHERE user_id=? AND date=?) THEN ? ELSE ? END WHERE supplement_id=? AND (end_date IS NULL OR end_date>=?)",
    ).run(userId, today, today, shiftDate(today, -1), id, today);
  });
  return { archived: true };
}

export function dailyItems(
  userId: string,
  date: string,
  mode: "operational" | "history" = "operational",
): TodayItem[] {
  const includeHistory = mode === "history" ? 1 : 0;
  const rows = getDb()
    .prepare(
      `SELECT s.id AS scheduleId, p.id AS supplementId,
    s.name_snapshot AS name,s.brand_snapshot AS brand,s.color_snapshot AS color,
    s.time,r.completed_at AS completedAt, CASE WHEN p.archived_at IS NULL THEN 0 ELSE 1 END AS archived
    FROM intake_schedules s JOIN supplements p ON p.id=s.supplement_id
    LEFT JOIN intake_records r ON r.schedule_id=s.id AND r.date=? AND r.user_id=?
    WHERE p.user_id=?
    AND ((s.start_date<=? AND (s.end_date IS NULL OR s.end_date>=?)) OR (?=1 AND r.completed_at IS NOT NULL))
    AND (p.archived_at IS NULL OR (?=1 AND (r.completed_at IS NOT NULL OR ? < date(p.archived_at,'+9 hours'))))
    ORDER BY s.time,s.name_snapshot,s.id`,
    )
    .all(date, userId, userId, date, date, includeHistory, includeHistory, date) as Array<
    Omit<TodayItem, "archived"> & { archived: number }
  >;
  return rows.map((row) => ({ ...row, archived: Boolean(row.archived) }));
}

export function streak(userId: string, today = getToday()): number {
  const db = getDb();
  const first = db
    .prepare(
      "SELECT MIN(s.start_date) AS first FROM intake_schedules s JOIN supplements p ON p.id=s.supplement_id WHERE p.user_id=?",
    )
    .get(userId) as { first: string | null };
  if (!first.first) return 0;
  let date = today;
  let count = 0;
  while (date >= first.first && count < 36_600) {
    const items = dailyItems(userId, date, "history");
    const complete = items.length > 0 && items.every((item) => Boolean(item.completedAt));
    if (date === today && !complete) {
      date = shiftDate(date, -1);
      continue;
    }
    if (!complete) break;
    count += 1;
    date = shiftDate(date, -1);
  }
  return count;
}

export function dashboard(userId: string) {
  const date = getToday();
  const items = dailyItems(userId, date);
  const user = getDb().prepare("SELECT name,age FROM users WHERE id=?").get(userId) as {
    name: string;
    age: number | null;
  };
  return {
    date,
    name: user.name,
    age: user.age,
    items,
    completed: items.filter((item) => item.completedAt).length,
    total: items.length,
    streak: streak(userId, date),
  };
}
export function history(userId: string) {
  const today = getToday();
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = shiftDate(today, index - 6);
    const items = dailyItems(userId, date, "history");
    const completed = items.filter((item) => item.completedAt).length;
    return {
      date,
      total: items.length,
      completed,
      rate: items.length ? Math.round((completed / items.length) * 100) : 0,
      items,
    };
  });
  return { days, streak: streak(userId, today) };
}

export function setIntake(userId: string, raw: Record<string, unknown>) {
  const today = getToday();
  const date = typeof raw.date === "string" ? raw.date : "";
  const parsedDate = Date.parse(`${date}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(parsedDate) ||
    new Date(parsedDate).toISOString().slice(0, 10) !== date ||
    date < shiftDate(today, -6) ||
    date > today ||
    typeof raw.completed !== "boolean" ||
    typeof raw.scheduleId !== "string"
  )
    throw new HttpError(400, "오늘을 포함한 최근 7일의 복용 기록만 수정할 수 있습니다.");
  return transaction((db) => {
    const schedule = db
      .prepare(
        "SELECT s.id FROM intake_schedules s JOIN supplements p ON p.id=s.supplement_id WHERE s.id=? AND p.user_id=? AND p.archived_at IS NULL AND s.start_date<=? AND (s.end_date IS NULL OR s.end_date>=?)",
      )
      .get(raw.scheduleId as string, userId, date, date);
    if (!schedule) throw new HttpError(404, "복용 일정을 찾을 수 없습니다.");
    if (raw.completed)
      db.prepare(
        "INSERT INTO intake_records(id,user_id,schedule_id,date,completed_at) VALUES(?,?,?,?,?) ON CONFLICT(schedule_id,date) DO NOTHING",
      ).run(randomUUID(), userId, raw.scheduleId as string, date, new Date().toISOString());
    else
      db.prepare("DELETE FROM intake_records WHERE user_id=? AND schedule_id=? AND date=?").run(
        userId,
        raw.scheduleId as string,
        date,
      );
    const record = db
      .prepare(
        "SELECT completed_at AS completedAt FROM intake_records WHERE user_id=? AND schedule_id=? AND date=?",
      )
      .get(userId, raw.scheduleId as string, date) as { completedAt: string } | undefined;
    return {
      scheduleId: raw.scheduleId,
      date,
      completedAt: record?.completedAt ?? null,
      completed: Boolean(record),
    };
  });
}

export function emailMode(): "capture" | "resend" {
  return process.env.EMAIL_MODE === "resend" ? "resend" : "capture";
}
export function settings(userId: string) {
  const row = getDb()
    .prepare(
      `SELECT u.name,u.age,u.email,u.reminder_enabled,u.delay_minutes,u.guardian_delay_minutes,u.timezone,
    g.email AS guardian_email,g.enabled AS guardian_enabled,g.consented_at
    FROM users u LEFT JOIN guardian_settings g ON g.user_id=u.id WHERE u.id=?`,
    )
    .get(userId) as {
    name: string;
    age: number | null;
    email: string;
    reminder_enabled: number;
    delay_minutes: number;
    guardian_delay_minutes: number;
    timezone: string;
    guardian_email: string | null;
    guardian_enabled: number | null;
    consented_at: string | null;
  };
  return {
    name: row.name,
    age: row.age,
    email: row.email,
    reminderEnabled: Boolean(row.reminder_enabled),
    delayMinutes: row.delay_minutes,
    guardianDelayMinutes: row.guardian_delay_minutes,
    guardianEmail: row.guardian_email || "",
    guardianEnabled: Boolean(row.guardian_enabled),
    guardianConsentedAt: row.consented_at,
    timezone: row.timezone,
    emailMode: emailMode(),
  };
}
function booleanSetting(raw: Record<string, unknown>, name: string, current: boolean): boolean {
  if (!(name in raw)) return current;
  if (typeof raw[name] !== "boolean") throw new HttpError(400, "알림 설정 값을 확인해주세요.");
  return raw[name] as boolean;
}
function minutesSetting(
  raw: Record<string, unknown>,
  name: string,
  current: number,
  maximum: number,
): number {
  if (!(name in raw)) return current;
  const value = raw[name];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 5 || value > maximum)
    throw new HttpError(400, `알림 대기 시간은 5~${maximum}분으로 설정해주세요.`);
  return value;
}
export function updateSettings(userId: string, raw: Record<string, unknown>) {
  const current = settings(userId);
  const name = "name" in raw ? validName(raw.name) : current.name;
  const age = "age" in raw ? validAge(raw.age) : current.age;
  const reminderEnabled = booleanSetting(raw, "reminderEnabled", current.reminderEnabled);
  const delayMinutes = minutesSetting(raw, "delayMinutes", current.delayMinutes, 240);
  const guardianDelayMinutes = minutesSetting(
    raw,
    "guardianDelayMinutes",
    current.guardianDelayMinutes,
    1440,
  );
  let guardianEmail = current.guardianEmail;
  if ("guardianEmail" in raw)
    guardianEmail = raw.guardianEmail === "" ? "" : validEmail(raw.guardianEmail);
  let guardianEnabled = booleanSetting(raw, "guardianEnabled", current.guardianEnabled);
  let consentedAt = current.guardianConsentedAt;
  if (guardianEmail !== current.guardianEmail) consentedAt = null;
  if (!guardianEmail) {
    guardianEnabled = false;
    consentedAt = null;
  }
  if (raw.guardianConsent === false) {
    guardianEnabled = false;
    consentedAt = null;
  }
  if (guardianEnabled) {
    if (raw.guardianConsent === true) consentedAt = new Date().toISOString();
    if (!consentedAt) throw new HttpError(400, "보호자 이메일 제공 및 알림 전송에 동의해주세요.");
    if (guardianEmail === current.email)
      throw new HttpError(400, "보호자 이메일은 본인 이메일과 다르게 입력해주세요.");
  } else {
    consentedAt = null;
  }
  transaction((db) => {
    db.prepare(
      "UPDATE users SET name=?,age=?,reminder_enabled=?,delay_minutes=?,guardian_delay_minutes=? WHERE id=?",
    ).run(name, age, Number(reminderEnabled), delayMinutes, guardianDelayMinutes, userId);
    db.prepare(
      "INSERT INTO guardian_settings(user_id,email,enabled,consented_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,enabled=excluded.enabled,consented_at=excluded.consented_at",
    ).run(userId, guardianEmail, Number(guardianEnabled), consentedAt);
  });
  return settings(userId);
}

export function completeOnboarding(userId: string, raw: Record<string, unknown>) {
  if (raw.choice !== "survey" && raw.choice !== "direct")
    throw new HttpError(400, "시작 방법을 선택해주세요.");
  if (
    raw.choice === "survey" &&
    (!Array.isArray(raw.answers) ||
      raw.answers.length !== 7 ||
      raw.answers.some(
        (answer) =>
          typeof answer !== "number" || !Number.isInteger(answer) || answer < 0 || answer > 2,
      ))
  )
    throw new HttpError(400, "설문 7개 항목에 답해주세요.");
  getDb()
    .prepare("UPDATE users SET onboarded=1,onboarding_choice=?,survey_answers=? WHERE id=?")
    .run(raw.choice, raw.choice === "survey" ? JSON.stringify(raw.answers) : null, userId);
  return { onboarded: true };
}

export function getOnboarding(userId: string) {
  const row = getDb()
    .prepare("SELECT onboarded,onboarding_choice,survey_answers FROM users WHERE id=?")
    .get(userId) as {
    onboarded: number;
    onboarding_choice: string | null;
    survey_answers: string | null;
  };
  return {
    onboarded: Boolean(row.onboarded),
    choice: row.onboarding_choice,
    answers: row.survey_answers ? (JSON.parse(row.survey_answers) as number[]) : null,
  };
}

export function listNotifications(userId: string) {
  return getDb()
    .prepare(
      "SELECT id,schedule_id AS scheduleId,date,channel,status,recipient,subject,body,provider_id AS providerId,error,created_at AS createdAt,sent_at AS sentAt FROM notification_logs WHERE user_id=? ORDER BY created_at DESC LIMIT 100",
    )
    .all(userId);
}
