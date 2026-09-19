import { randomUUID } from "node:crypto";
import { getDb, getToday, HttpError, scheduledInstant, shiftDate, transaction } from "./db";
import { emailMode } from "./service";

type Candidate = {
  date: string;
  schedule_id: string;
  supplement_id: string;
  user_id: string;
  user_name: string;
  time: string;
  name: string;
  email: string;
  delay_minutes: number;
  guardian_delay_minutes: number;
  guardian_email: string | null;
  guardian_enabled: number | null;
  consented_at: string | null;
};
type Channel = "user" | "guardian";
type Status = "processing" | "sent" | "captured" | "failed" | "skipped";
type LogRow = {
  id: string;
  schedule_id: string;
  recipient: string;
  subject: string;
  body: string;
  status: Status;
  claimed_at: string;
  created_at: string;
  sent_at: string | null;
  attempts: number;
  retryable: number;
};
type DeliveryClaim = Pick<LogRow, "id" | "schedule_id" | "recipient" | "subject" | "body">;
export type NotificationResult = {
  mode: "capture" | "brevo";
  checked: number;
  sent: number;
  captured: number;
  failed: number;
  skipped: number;
};

function configuredMode(): "capture" | "brevo" {
  const mode = emailMode();
  if (
    mode === "brevo" &&
    (!process.env.BREVO_API_KEY?.trim() || !process.env.EMAIL_FROM || !process.env.APP_URL)
  )
    throw new HttpError(
      503,
      "이메일 발송 환경변수 BREVO_API_KEY, EMAIL_FROM, APP_URL을 설정해주세요.",
    );
  if (mode === "brevo") {
    if (
      !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(process.env.EMAIL_FROM!) ||
      process.env.EMAIL_FROM!.length > 254
    )
      throw new HttpError(503, "EMAIL_FROM에는 인증된 발신 이메일 주소만 입력해주세요.");
    const fromName = process.env.EMAIL_FROM_NAME?.trim() || "하루영양";
    if (
      fromName.length > 100 ||
      /[\r\n]/.test(fromName) ||
      /[\r\n]/.test(process.env.BREVO_API_KEY!)
    )
      throw new HttpError(503, "이메일 발신자 설정을 확인해주세요.");
  }
  if (process.env.APP_URL) {
    try {
      if (!["http:", "https:"].includes(new URL(process.env.APP_URL).protocol)) throw new Error();
    } catch {
      throw new HttpError(503, "APP_URL에 올바른 서비스 주소를 설정해주세요.");
    }
  }
  return mode;
}

type BrevoConfiguration = { apiKey: string; fromEmail: string; fromName: string };
type BrevoOutcome =
  | { status: "accepted"; messageId: string }
  | { status: "rejected"; error: string }
  | { status: "uncertain"; error: string };

const uncertainDelivery =
  "이메일 전송 결과를 확인할 수 없어 자동 재발송을 중단했습니다. Brevo 전송 기록을 확인해주세요.";

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

/**
 * Brevo's UUID idempotency key belongs in the JSON body headers, not an HTTP
 * Idempotency-Key header. Its deduplication TTL is bounded; an uncertain result
 * therefore must NEVER be automatically replayed, even after worker restarts.
 * https://developers.brevo.com/docs/heterogenous-versions-batch-emails
 * API acceptance only means queued; inbox delivery must be verified separately.
 */
export async function sendBrevoEmail(
  delivery: Pick<DeliveryClaim, "id" | "recipient" | "subject" | "body">,
  configuration: BrevoConfiguration,
): Promise<BrevoOutcome> {
  try {
    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "api-key": configuration.apiKey,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sender: { email: configuration.fromEmail, name: configuration.fromName },
        to: [{ email: delivery.recipient }],
        subject: delivery.subject,
        textContent: delivery.body,
        htmlContent: `<html><body><div style="white-space:pre-wrap">${escapeHtml(delivery.body)}</div></body></html>`,
        headers: { idempotencyKey: delivery.id },
      }),
    });
    // Never persist raw provider bodies or exception messages: they may echo credentials.
    const payload = (await response.json().catch(() => null)) as {
      code?: unknown;
      messageId?: unknown;
    } | null;
    if (
      response.ok &&
      typeof payload?.messageId === "string" &&
      payload.messageId.trim() &&
      payload.messageId.length <= 500
    )
      return { status: "accepted", messageId: payload.messageId };
    if (
      response.status >= 400 &&
      response.status < 500 &&
      ![408, 409].includes(response.status) &&
      typeof payload?.code === "string" &&
      payload.code.trim().length > 0 &&
      payload.code !== "duplicate_parameter"
    )
      return {
        status: "rejected",
        error: `이메일 제공자가 요청을 거절했습니다 (HTTP ${response.status}). 발신자 인증·계정 한도·API 설정을 확인해주세요.`,
      };
    return { status: "uncertain", error: uncertainDelivery };
  } catch {
    return { status: "uncertain", error: uncertainDelivery };
  }
}

function message(candidate: Candidate, channel: Channel, date: string, now: Date) {
  const appUrl = process.env.APP_URL || "http://localhost:3000";
  const subject =
    channel === "user" ? "[하루영양] 복용 예정 시간이 지났어요 💊" : "[하루영양] 복용 확인 안내";
  const dateLabel = date === getToday(now) ? `오늘 ${date}` : date;
  const body =
    channel === "user"
      ? `안녕하세요, ${candidate.user_name}님.\n\n${dateLabel} ${candidate.time}에 예정된 ${candidate.name}의 복용 완료가 아직 확인되지 않았습니다.\n\n이미 복용하셨다면 하루영양에서 복용 완료를 체크해주세요.\n${appUrl}/history\n\n※ 하루영양은 복용 여부를 직접 확인할 수 없으므로 실제 미복용을 의미하지 않습니다.\n알림 설정: ${appUrl}/settings`
      : `사용자의 동의로 등록된 ${date} ${candidate.time} 복용 항목의 복용 완료가 아직 확인되지 않았습니다.\n\n이 알림은 서비스의 기록 상태에 대한 안내이며 실제 미복용을 의미하지 않습니다. 필요하다면 사용자에게 직접 확인해주세요.\n\n하루영양 ${appUrl}`;
  return { subject, body };
}

/** A product/time/date reminder retains its identity across historical schedule versions. */
function findLog(candidate: Candidate, channel: Channel, date: string): LogRow | undefined {
  return getDb()
    .prepare(
      `SELECT n.* FROM notification_logs n JOIN intake_schedules s ON s.id=n.schedule_id
    WHERE n.user_id=? AND s.supplement_id=? AND s.time=? AND n.date=? AND n.channel=?
    ORDER BY CASE n.status WHEN 'sent' THEN 0 WHEN 'captured' THEN 1 WHEN 'processing' THEN 2 ELSE 3 END,n.created_at
    LIMIT 1`,
    )
    .get(candidate.user_id, candidate.supplement_id, candidate.time, date, channel) as
    LogRow | undefined;
}

/** BEGIN IMMEDIATE serializes the logical identity lookup and claim across processes. */
function claim(
  candidate: Candidate,
  channel: Channel,
  date: string,
  recipient: string,
  now: Date,
): DeliveryClaim | null {
  const content = message(candidate, channel, date, now);
  return transaction((db) => {
    const existing = findLog(candidate, channel, date);
    if (existing && (existing.status === "sent" || existing.status === "captured")) return null;
    if (existing?.status === "processing") {
      if (now.getTime() - Date.parse(existing.claimed_at) >= 15 * 60_000)
        db.prepare(
          "UPDATE notification_logs SET status='failed',retryable=0,error=? WHERE id=?",
        ).run(uncertainDelivery, existing.id);
      return null;
    }
    if (existing?.status === "failed") {
      if (!existing.retryable || existing.attempts >= 3) return null;
      if (now.getTime() - Date.parse(existing.claimed_at) < 60_000) return null;
    }
    const stamp = now.toISOString();
    if (existing) {
      // Preserve the original recipient/payload/key after a confirmed rejection.
      // A changed guardian address must not receive a replay intended for the old address.
      if (existing.recipient !== recipient) return null;
      db.prepare(
        "UPDATE notification_logs SET status='processing',error=NULL,retryable=0,claimed_at=?,attempts=attempts+1 WHERE id=?",
      ).run(stamp, existing.id);
      return existing;
    }
    const id = randomUUID();
    db.prepare(
      "INSERT INTO notification_logs(id,user_id,schedule_id,date,channel,status,recipient,subject,body,created_at,claimed_at) VALUES(?,?,?,?,?,'processing',?,?,?,?,?)",
    ).run(
      id,
      candidate.user_id,
      candidate.schedule_id,
      date,
      channel,
      recipient,
      content.subject,
      content.body,
      stamp,
      stamp,
    );
    return { id, schedule_id: candidate.schedule_id, recipient, ...content };
  });
}

function stillEligible(
  candidate: Candidate,
  channel: Channel,
  date: string,
  recipient: string,
): boolean {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT u.reminder_enabled,g.enabled,g.email,g.consented_at
    FROM users u JOIN supplements p ON p.user_id=u.id JOIN intake_schedules s ON s.supplement_id=p.id
    LEFT JOIN guardian_settings g ON g.user_id=u.id
    WHERE u.id=? AND s.id=? AND p.archived_at IS NULL AND s.start_date<=? AND (s.end_date IS NULL OR s.end_date>=?)
    AND NOT EXISTS(SELECT 1 FROM intake_records r WHERE r.schedule_id=s.id AND r.date=? AND r.user_id=u.id)`,
    )
    .get(candidate.user_id, candidate.schedule_id, date, date, date) as
    | { reminder_enabled: number; enabled: number; email: string; consented_at: string | null }
    | undefined;
  if (!row?.reminder_enabled) return false;
  return channel === "user" || Boolean(row.enabled && row.consented_at && row.email === recipient);
}

async function deliver(
  candidate: Candidate,
  channel: Channel,
  date: string,
  mode: "capture" | "brevo",
  now: Date,
): Promise<"sent" | "captured" | "failed" | "skipped"> {
  const recipient = channel === "user" ? candidate.email : candidate.guardian_email;
  if (!recipient) return "skipped";
  const delivery = claim(candidate, channel, date, recipient, now);
  if (!delivery) return "skipped";
  const { id } = delivery;
  const db = getDb();
  if (!stillEligible(candidate, channel, date, recipient)) {
    db.prepare("UPDATE notification_logs SET status='skipped',error=? WHERE id=?").run(
      "발송 직전 복용 기록 또는 알림 동의가 변경되었습니다.",
      id,
    );
    return "skipped";
  }
  if (mode === "capture") {
    db.prepare(
      "UPDATE notification_logs SET status='captured',sent_at=NULL,error=NULL WHERE id=?",
    ).run(id);
    return "captured";
  }
  const outcome = await sendBrevoEmail(delivery, {
    apiKey: process.env.BREVO_API_KEY!,
    fromEmail: process.env.EMAIL_FROM!,
    fromName: process.env.EMAIL_FROM_NAME?.trim() || "하루영양",
  });
  if (outcome.status === "accepted") {
    db.prepare(
      "UPDATE notification_logs SET status='sent',provider_id=?,sent_at=?,error=NULL WHERE id=?",
    ).run(outcome.messageId, now.toISOString(), id);
    return "sent";
  }
  db.prepare(
    "UPDATE notification_logs SET status='failed',error=? || CASE WHEN ?=1 AND attempts>=3 THEN ' 재시도 한도(3회)에 도달해 자동 재발송을 중단했습니다.' ELSE '' END,retryable=CASE WHEN ?=1 AND attempts<3 THEN 1 ELSE 0 END WHERE id=?",
  ).run(
    outcome.error,
    outcome.status === "rejected" ? 1 : 0,
    outcome.status === "rejected" ? 1 : 0,
    id,
  );
  return "failed";
}

/**
 * Cron and a user's explicit preview share the same bounded rollover engine.
 * Inspect today and two preceding KST dates. User notices may start/retry only
 * within 24 hours of an occurrence. Guardian follow-ups may cross midnight but
 * expire after 52 hours (24h user window + 24h guardian delay + 4h worker grace).
 */
export async function runNotifications(
  options: { userId?: string; now?: Date } = {},
): Promise<NotificationResult> {
  const mode = configuredMode();
  const now = options.now || new Date();
  const today = getToday(now);
  const candidateQuery = getDb().prepare(
    `SELECT ? AS date,s.id AS schedule_id,p.id AS supplement_id,u.id AS user_id,u.name AS user_name,s.time,s.name_snapshot AS name,
    u.email,u.delay_minutes,u.guardian_delay_minutes,g.email AS guardian_email,g.enabled AS guardian_enabled,g.consented_at
    FROM intake_schedules s JOIN supplements p ON p.id=s.supplement_id JOIN users u ON u.id=p.user_id
    LEFT JOIN guardian_settings g ON g.user_id=u.id
    WHERE u.reminder_enabled=1 AND p.archived_at IS NULL AND s.start_date<=? AND (s.end_date IS NULL OR s.end_date>=?)
    AND (? IS NULL OR u.id=?)
    AND NOT EXISTS(SELECT 1 FROM intake_records r WHERE r.schedule_id=s.id AND r.date=? AND r.user_id=u.id)
    ORDER BY s.time,s.id`,
  );
  const candidates = [shiftDate(today, -2), shiftDate(today, -1), today]
    .flatMap(
      (date) =>
        candidateQuery.all(
          date,
          date,
          date,
          options.userId || null,
          options.userId || null,
          date,
        ) as Candidate[],
    )
    .filter(
      (candidate) =>
        now.getTime() - scheduledInstant(candidate.date, candidate.time).getTime() <=
        52 * 60 * 60_000,
    );
  const result: NotificationResult = {
    mode,
    checked: candidates.length,
    sent: 0,
    captured: 0,
    failed: 0,
    skipped: 0,
  };
  // Limit parallel outbound calls; SQLite claims also protect overlapping scheduler processes.
  let cursor = 0;
  async function worker() {
    while (cursor < candidates.length) {
      const candidate = candidates[cursor++];
      const date = candidate.date;
      const occurrenceAge = now.getTime() - scheduledInstant(date, candidate.time).getTime();
      const due =
        scheduledInstant(date, candidate.time).getTime() + candidate.delay_minutes * 60_000;
      if (now.getTime() < due) {
        result.skipped += 1;
        continue;
      }
      if (occurrenceAge <= 24 * 60 * 60_000)
        result[await deliver(candidate, "user", date, mode, now)] += 1;
      else result.skipped += 1;
      if (!candidate.guardian_enabled || !candidate.consented_at || !candidate.guardian_email)
        continue;
      const userLog = findLog(candidate, "user", date);
      // Captured reminders only lead to another capture. Switching to live mode never escalates a simulation.
      const base =
        userLog?.status === "sent"
          ? userLog.sent_at
          : mode === "capture" && userLog?.status === "captured"
            ? userLog.claimed_at
            : null;
      if (!base || now.getTime() < Date.parse(base) + candidate.guardian_delay_minutes * 60_000)
        continue;
      result[await deliver(candidate, "guardian", date, mode, now)] += 1;
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, () => worker()));
  return result;
}
