import { timingSafeEqual } from "node:crypto";
import { checkOrigin, login, logout, rateLimit, requireUser, sessionCookie, signup } from "./auth";
import { getDb, HttpError } from "./db";
import {
  accountDeletionCookie,
  cancelAccountDeletion,
  completeAccountDeletion,
  verifyAccountDeletion,
} from "./account-deletion";
import { runNotifications } from "./notifications";
import {
  completePasswordReset,
  passwordResetCookie,
  passwordResetToken,
  processPasswordResetRequests,
  requestPasswordReset,
  verifyPasswordReset,
} from "./password-reset";
import { analyzeSafety } from "../safety";
import { normalizeIngredient, surveyResults } from "../domain";
import { rankProducts } from "../product-ranking";
import { candidateProducts, getProduct, searchProducts } from "./products";
import {
  archiveSupplement,
  completeOnboarding,
  dashboard,
  emailMode,
  getOnboarding,
  getSupplement,
  history,
  listNotifications,
  listSupplements,
  saveSupplement,
  setIntake,
  settings,
  updateSettings,
  validateSupplement,
} from "./service";

function previewSafety(
  userId: string,
  age: number | null,
  raw: Record<string, unknown>,
  id?: string,
) {
  if (id) getSupplement(userId, id); // Never allow a draft to exclude someone else's product.
  const draft = validateSupplement(raw);
  return analyzeSafety(listSupplements(userId), age, { ...draft, id });
}
function saveWithSafety(
  userId: string,
  age: number | null,
  raw: Record<string, unknown>,
  id?: string,
) {
  const analysis = previewSafety(userId, age, raw, id);
  if (analysis.hasExceedance && raw.safetyAcknowledged !== true)
    throw new HttpError(
      409,
      "등록 후 총량이 참고 상한선을 초과합니다. 성분 검사 결과를 확인하고 ‘내용을 확인했습니다’를 선택해주세요.",
    );
  return saveSupplement(userId, raw, id);
}

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  const result = new Headers(headers);
  result.set("Content-Type", "application/json; charset=utf-8");
  result.set("Cache-Control", "no-store, private");
  result.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify({ data }), { status, headers: result });
}
async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
    throw new HttpError(415, "JSON 형식으로 요청해주세요.");
  if (Number(request.headers.get("content-length")) > 65_536)
    throw new HttpError(413, "입력 데이터가 너무 큽니다.");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "입력 내용을 확인해주세요.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 65_536) {
      await reader.cancel();
      throw new HttpError(413, "입력 데이터가 너무 큽니다.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  chunks.forEach((chunk) => {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  });
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "입력 내용을 확인해주세요.");
  }
}
function checkCron(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 24)
    throw new HttpError(503, "24자 이상의 CRON_SECRET을 설정해주세요.");
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.get("authorization") || "");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    throw new HttpError(401, "예약 실행 인증에 실패했습니다.");
}

/** Web-standard Request/Response makes the real API directly integration-testable without a browser. */
export async function handleApi(
  request: Request,
  options: { scheduleResetDelivery?: (task: () => Promise<void>) => void } = {},
): Promise<Response> {
  try {
    checkOrigin(request);
    const path = new URL(request.url).pathname.replace(/\/$/, "");
    const method = request.method.toUpperCase();
    const clientKey =
      process.env.TRUST_PROXY === "true"
        ? request.headers.get("x-real-ip") ||
          request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
          "unknown"
        : "local";
    if (path === "/api/health" && method === "GET") {
      getDb().prepare("SELECT 1").get();
      return json({ status: "ok" });
    }
    if (path === "/api/cron/notifications" && (method === "GET" || method === "POST")) {
      checkCron(request);
      // Queue recovery must not delay or suppress scheduled intake reminders.
      const recovery = processPasswordResetRequests({ limit: 4 }).catch(() => {
        console.error("[password-reset] Queue recovery failed.");
      });
      const reminders = await runNotifications();
      await recovery;
      return json(reminders);
    }
    if (path === "/api/auth/password-reset/request" && method === "POST") {
      const result = await requestPasswordReset(await body(request), clientKey);
      options.scheduleResetDelivery?.(async () => {
        await processPasswordResetRequests({ requestId: result.requestId });
      });
      return json(result, 202, { "Set-Cookie": passwordResetCookie("") });
    }
    if (path === "/api/auth/password-reset/verify" && method === "POST") {
      const result = await verifyPasswordReset(await body(request), clientKey);
      return json({ verified: true, expiresIn: result.expiresIn }, 200, {
        "Set-Cookie": passwordResetCookie(result.token),
      });
    }
    if (path === "/api/auth/password-reset/complete" && method === "POST") {
      const result = await completePasswordReset(
        await body(request),
        passwordResetToken(request),
        clientKey,
      );
      const headers = new Headers();
      headers.append("Set-Cookie", passwordResetCookie(""));
      headers.append("Set-Cookie", sessionCookie(""));
      headers.append("Set-Cookie", accountDeletionCookie(""));
      return json(result, 200, headers);
    }
    if (path === "/api/auth/signup" && method === "POST") {
      const result = await signup(await body(request), clientKey);
      const headers = new Headers();
      headers.append("Set-Cookie", sessionCookie(result.token));
      headers.append("Set-Cookie", passwordResetCookie(""));
      headers.append("Set-Cookie", accountDeletionCookie(""));
      return json({ user: result.user }, 201, headers);
    }
    if (path === "/api/auth/login" && method === "POST") {
      const result = await login(await body(request), clientKey);
      const headers = new Headers();
      headers.append("Set-Cookie", sessionCookie(result.token));
      headers.append("Set-Cookie", passwordResetCookie(""));
      headers.append("Set-Cookie", accountDeletionCookie(""));
      return json({ user: result.user }, 200, headers);
    }
    if (path === "/api/auth/logout" && method === "POST") {
      logout(request);
      const headers = new Headers();
      headers.append("Set-Cookie", sessionCookie(""));
      headers.append("Set-Cookie", passwordResetCookie(""));
      headers.append("Set-Cookie", accountDeletionCookie(""));
      return json({ loggedOut: true }, 200, headers);
    }
    const user = requireUser(request);
    if (path === "/api/account/deletion/verify" && method === "POST") {
      const result = await verifyAccountDeletion(request, await body(request), clientKey);
      return json({ verified: true, expiresIn: result.expiresIn }, 200, {
        "Set-Cookie": accountDeletionCookie(result.token),
      });
    }
    if (path === "/api/account/deletion/complete" && method === "POST") {
      const result = completeAccountDeletion(request, await body(request), clientKey);
      const headers = new Headers();
      headers.append("Set-Cookie", sessionCookie(""));
      headers.append("Set-Cookie", passwordResetCookie(""));
      headers.append("Set-Cookie", accountDeletionCookie(""));
      return json(result, 200, headers);
    }
    if (path === "/api/account/deletion/cancel" && method === "POST") {
      const result = cancelAccountDeletion(request);
      return json(result, 200, { "Set-Cookie": accountDeletionCookie("") });
    }
    if (path.startsWith("/api/products") && method === "GET") {
      rateLimit(`products-user:${user.id}`, 30, 60, `user:${user.id}`);
      const query = new URL(request.url).searchParams;
      if (path === "/api/products/search")
        return json(await searchProducts(query.get("q") || "", Number(query.get("page") || "1")));
      if (path === "/api/products/matches") {
        const answers = getOnboarding(user.id).answers;
        const allInterests = answers ? surveyResults(answers).map((result) => result.name) : [];
        if (!allInterests.length)
          throw new HttpError(400, "먼저 생활습관 설문에서 관심 성분을 확인해주세요.");
        const selected = query.get("interest");
        const interests = selected
          ? allInterests.filter(
              (name) => normalizeIngredient(name) === normalizeIngredient(selected),
            )
          : allInterests;
        if (!interests.length)
          throw new HttpError(400, "설문 결과에서 확인된 관심 성분을 선택해주세요.");
        const candidates = await candidateProducts(interests);
        return json({
          ...rankProducts(candidates.products, interests, listSupplements(user.id), user.age),
          interests,
          source: candidates.source,
          notice: candidates.notice,
          total: candidates.total,
          partial: candidates.partial,
        });
      }
      const productMatch = path.match(/^\/api\/products\/(\d{6,30})$/);
      if (productMatch) return json(await getProduct(productMatch[1]));
    }
    if (path === "/api/me" && method === "GET")
      return json({ user, mode: "local", emailMode: emailMode() });
    if (path === "/api/safety" && method === "GET")
      return json(analyzeSafety(listSupplements(user.id), user.age));
    if (path === "/api/safety/preview" && method === "POST") {
      const raw = await body(request);
      if (
        raw.excludeSupplementId !== undefined &&
        (typeof raw.excludeSupplementId !== "string" || !raw.excludeSupplementId)
      )
        throw new HttpError(400, "수정할 영양제 정보를 확인해주세요.");
      return json(
        previewSafety(user.id, user.age, raw, raw.excludeSupplementId as string | undefined),
      );
    }
    if (path === "/api/supplements") {
      if (method === "GET") return json(listSupplements(user.id));
      if (method === "POST")
        return json(saveWithSafety(user.id, user.age, await body(request)), 201);
    }
    const supplementMatch = path.match(/^\/api\/supplements\/([a-zA-Z0-9-]+)$/);
    if (supplementMatch) {
      if (method === "GET") return json(getSupplement(user.id, supplementMatch[1]));
      if (method === "PUT")
        return json(saveWithSafety(user.id, user.age, await body(request), supplementMatch[1]));
      if (method === "DELETE") return json(archiveSupplement(user.id, supplementMatch[1]));
    }
    if (path === "/api/dashboard" && method === "GET") return json(dashboard(user.id));
    if (path === "/api/intakes" && method === "PUT")
      return json(setIntake(user.id, await body(request)));
    if (path === "/api/history" && method === "GET") return json(history(user.id));
    if (path === "/api/settings") {
      if (method === "GET") return json(settings(user.id));
      if (method === "PATCH") return json(updateSettings(user.id, await body(request)));
    }
    if (path === "/api/onboarding" && method === "POST")
      return json(completeOnboarding(user.id, await body(request)));
    if (path === "/api/onboarding" && method === "GET") return json(getOnboarding(user.id));
    if (path === "/api/notifications" && method === "GET") return json(listNotifications(user.id));
    if (path === "/api/notifications/preview" && method === "POST") {
      rateLimit(`notification-preview:${user.id}`, 12, 60, `user:${user.id}`);
      return json(await runNotifications({ userId: user.id }));
    }
    throw new HttpError(404, "요청한 API를 찾을 수 없습니다.");
  } catch (error) {
    const known = error instanceof HttpError;
    if (!known)
      console.error(
        "Haru API request failed:",
        error instanceof Error ? error.name : "UnknownError",
      );
    return new Response(
      JSON.stringify({
        error: known ? error.message : "요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.",
      }),
      {
        status: known ? error.status : 500,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store, private",
          "X-Content-Type-Options": "nosniff",
        },
      },
    );
  }
}
