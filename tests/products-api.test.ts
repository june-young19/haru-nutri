import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { handleApi } from "../lib/server/api";
import { closeDatabase } from "../lib/server/db";
import type { Product, ProductSearchResult, OfficialProductRow } from "../lib/products";
import type { RankResult } from "../lib/product-ranking";
import type { SafetyAnalysis } from "../lib/safety";
import type { Dashboard, DayHistory, Supplement, User } from "../lib/types";

// Synthetic I0030 rows travel through the production parser and authenticated API.
// No real Food Safety API, Brevo request, .env file or account database is accessed.
describe("authenticated official product API", () => {
  const environmentKeys = [
    "DATABASE_PATH",
    "EMAIL_MODE",
    "FOOD_SAFETY_API_KEY",
    "APP_URL",
    "TRUST_PROXY",
  ] as const;
  const originalFetch = globalThis.fetch;
  let saved: Record<string, string | undefined>;
  let directory: string;
  let calls: { url: string; options: RequestInit | undefined }[];
  let rows: OfficialProductRow[];
  const reportNumber = "200400000001";
  const fixture = (changes: OfficialProductRow = {}): OfficialProductRow => ({
    PRDLST_REPORT_NO: reportNumber,
    PRDLST_NM: "가상 비타민 D 제품",
    BSSH_NM: "가상 제조사",
    RAWMTRL_NM: "비타민 D",
    NTK_MTHD: "1일 2회, 1회 1캡슐(1g)을 물과 함께 섭취",
    STDR_STND: "비타민D : 표시량(25μg/2g)의 80~180%\n납(mg/kg): 1.0 이하",
    PRIMARY_FNCLTY: "공식 기능성 필드의 합성 테스트 문구",
    IFTKN_ATNT_MATR_CN: "제품 표시사항을 확인하세요.",
    LAST_UPDT_DTM: "20260919",
    PRODUCTION: "아니오",
    ...changes,
  });
  beforeEach(() => {
    closeDatabase();
    saved = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
    environmentKeys.forEach((key) => delete process.env[key]);
    directory = mkdtempSync(join(tmpdir(), "haru-product-api-test-"));
    process.env.DATABASE_PATH = join(directory, "products.sqlite");
    process.env.EMAIL_MODE = "capture";
    // Unique synthetic keys isolate the production adapter's in-memory cache between tests.
    process.env.FOOD_SAFETY_API_KEY = `fixture-products-key-${randomUUID()}`;
    process.env.APP_URL = "http://localhost:3000";
    calls = [];
    rows = [fixture()];
    globalThis.fetch = async (url, options) => {
      const address = String(url);
      if (!address.startsWith("https://openapi.foodsafetykorea.go.kr/"))
        throw new Error("Unexpected external request in product API test");
      calls.push({ url: address, options });
      const report = decodeURIComponent(address).match(/PRDLST_REPORT_NO=(\d+)$/)?.[1];
      const selected = report ? rows.filter((row) => row.PRDLST_REPORT_NO === report) : rows;
      return new Response(
        JSON.stringify({
          I0030: {
            total_count: String(selected.length),
            row: selected,
            RESULT: { CODE: "INFO-000", MSG: "정상" },
          },
        }),
        { headers: { "Content-Type": "application/json;charset=utf-8" } },
      );
    };
  });
  afterEach(() => {
    closeDatabase();
    globalThis.fetch = originalFetch;
    environmentKeys.forEach((key) => {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    });
    rmSync(directory, { recursive: true, force: true });
  });

  async function api<T = Record<string, unknown>>(
    path: string,
    options: { method?: string; cookie?: string; body?: unknown } = {},
  ) {
    const headers = new Headers({ origin: "http://localhost:3000" });
    if (options.cookie) headers.set("cookie", options.cookie);
    if (options.body !== undefined) headers.set("content-type", "application/json");
    const response = await handleApi(
      new Request(`http://localhost:3000/api${path}`, {
        method: options.method || "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      }),
    );
    assert.match(response.headers.get("cache-control")!, /no-store/);
    return { response, payload: (await response.json()) as { data: T; error?: string } };
  }
  async function account(email = "member@example.test") {
    const result = await api<{ user: User }>("/auth/signup", {
      method: "POST",
      body: { email, password: "product-api-test-password", name: "테스트 회원", age: 30 },
    });
    assert.equal(result.response.status, 201);
    return {
      cookie: result.response.headers.get("set-cookie")!.split(";")[0],
      user: result.payload.data.user,
    };
  }
  const draft = (product: Product) => ({
    name: product.name,
    brand: product.manufacturer,
    color: "mint",
    ingredients: product.ingredients,
    times: ["09:00", "20:00"],
  });
  async function addBaseline(cookie: string, amount: number) {
    const result = await api<Supplement>("/supplements", {
      method: "POST",
      cookie,
      body: {
        name: "기존 비타민 D",
        color: "mint",
        ingredients: [{ name: "비타민 D", amount, unit: "μg" }],
        times: ["08:00"],
      },
    });
    assert.equal(result.response.status, 201);
    return result.payload.data;
  }
  async function dSurvey(cookie: string) {
    const result = await api("/onboarding", {
      method: "POST",
      cookie,
      body: { choice: "survey", answers: [1, 0, 0, 0, 1, 0, 0] },
    });
    assert.equal(result.response.status, 200);
  }
  const allRanked = (result: RankResult) => [
    ...result.general,
    ...result.needsReview,
    ...result.caution,
  ];

  test("search, detail and matches require a session before checking credentials or fetching", async () => {
    delete process.env.FOOD_SAFETY_API_KEY;
    for (const path of [
      "/products/search?q=비타민",
      `/products/${reportNumber}`,
      "/products/matches",
    ])
      assert.equal((await api(path)).response.status, 401);
    assert.equal(calls.length, 0);
  });

  test("missing official credentials report unavailability without preventing manual registration", async () => {
    const owner = await account();
    delete process.env.FOOD_SAFETY_API_KEY;
    const result = await api("/products/search?q=비타민", owner);
    assert.equal(result.response.status, 503);
    assert.match(result.payload.error!, /인증키|직접 입력/);
    assert.equal(calls.length, 0);
    await addBaseline(owner.cookie, 20);
    assert.equal((await api<Supplement[]>("/supplements", owner)).payload.data.length, 1);
  });

  test("authenticated official search and detail use the real parser while returning only key-free data", async () => {
    const owner = await account();
    const searched = await api<ProductSearchResult>("/products/search?q=비타민&page=1", owner);
    assert.equal(searched.response.status, 200);
    assert.equal(searched.payload.data.products.length, 1);
    assert.match(searched.payload.data.source, /I0030/);
    const product = searched.payload.data.products[0];
    assert.equal(product.parseStatus, "complete");
    assert.deepEqual(product.ingredients, [{ name: "비타민 D", amount: 25, unit: "μg" }]);
    assert.equal(product.dailyFrequency, 2);
    assert.match(product.sourceUrl, /^https:\/\/www\.foodsafetykorea\.go\.kr\//);
    assert.equal(
      JSON.stringify(searched.payload).includes(process.env.FOOD_SAFETY_API_KEY!),
      false,
    );
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/I0030\/json\/1\/100\/PRDLST_NM=/);
    assert.equal(calls[0].options?.redirect, "error");
    const detail = await api<Product>(`/products/${reportNumber}`, owner);
    assert.equal(detail.response.status, 200);
    assert.deepEqual(detail.payload.data, product);
    assert.equal(
      (await api<Supplement[]>("/supplements", owner)).payload.data.length,
      0,
      "viewing a product does not register it",
    );
    assert.equal((await api("/products/999999999999", owner)).response.status, 404);
    assert.equal((await api("/products/search?q=x", owner)).response.status, 400);
    assert.equal((await api("/products/search?q=비타민&page=0", owner)).response.status, 400);
  });

  test("parsed daily amounts flow through duplicate and UL preview, acknowledged save, intake and archive", async () => {
    const owner = await account();
    rows = [fixture({ STDR_STND: "비타민D : 표시량(90μg/2g)의 80~180%" })];
    const base = await addBaseline(owner.cookie, 20);
    const official = (await api<Product>(`/products/${reportNumber}`, owner)).payload.data;
    const proposed = draft(official);
    const preview = await api<SafetyAnalysis>("/safety/preview", {
      method: "POST",
      cookie: owner.cookie,
      body: proposed,
    });
    assert.equal(preview.response.status, 200);
    const vitaminD = preview.payload.data.items.find((item) => item.name === "비타민 D")!;
    assert.equal(vitaminD.count, 2);
    assert.deepEqual(vitaminD.currentTotals, [{ amount: 20, unit: "μg" }]);
    assert.deepEqual(vitaminD.proposedTotals, [{ amount: 90, unit: "μg" }]);
    assert.deepEqual(vitaminD.totals, [{ amount: 110, unit: "μg" }]);
    assert.equal(vitaminD.status, "exceeds");
    assert.equal(preview.payload.data.hasExceedance, true);
    assert.equal(
      (await api("/supplements", { method: "POST", cookie: owner.cookie, body: proposed })).response
        .status,
      409,
    );
    const created = await api<Supplement>("/supplements", {
      method: "POST",
      cookie: owner.cookie,
      body: { ...proposed, safetyAcknowledged: true },
    });
    assert.equal(created.response.status, 201);
    assert.equal(
      created.payload.data.ingredients[0].amount,
      90,
      "daily quantity is not multiplied by two reminders",
    );
    const dashboard = (await api<Dashboard>("/dashboard", owner)).payload.data;
    assert.equal(dashboard.total, 3);
    await api("/intakes", {
      method: "PUT",
      cookie: owner.cookie,
      body: {
        scheduleId: created.payload.data.schedules[0].id,
        date: dashboard.date,
        completed: true,
      },
    });
    assert.equal(
      (
        await api(`/supplements/${created.payload.data.id}`, {
          method: "DELETE",
          cookie: owner.cookie,
        })
      ).response.status,
      200,
    );
    assert.deepEqual(
      (await api<Supplement[]>("/supplements", owner)).payload.data.map((item) => item.id),
      [base.id],
    );
    const after = (await api<SafetyAnalysis>("/safety", owner)).payload.data.items[0];
    assert.equal(after.count, 1);
    assert.deepEqual(after.totals, [{ amount: 20, unit: "μg" }]);
    assert.equal((await api<Dashboard>("/dashboard", owner)).payload.data.total, 1);
    const history = (await api<{ days: DayHistory[] }>("/history", owner)).payload.data.days.at(
      -1,
    )!;
    const archived = history.items.find((item) => item.supplementId === created.payload.data.id)!;
    assert.equal(archived.archived, true);
    assert.ok(archived.completedAt);
  });

  test("shared official candidates are ranked against each user's own holdings and archive changes only that user", async () => {
    const first = await account("a@example.test");
    const second = await account("b@example.test");
    const existing = await addBaseline(first.cookie, 90);
    await dSurvey(first.cookie);
    await dSurvey(second.cookie);
    const firstRank = await api<RankResult & { interests: string[] }>(
      `/products/matches?interest=Vitamin%20D&userId=${second.user.id}`,
      first,
    );
    const secondRank = await api<RankResult & { interests: string[] }>("/products/matches", second);
    assert.equal(firstRank.response.status, 200);
    assert.equal(firstRank.payload.data.caution.length, 1);
    assert.deepEqual(firstRank.payload.data.caution[0].overlap, ["비타민 D"]);
    assert.equal(secondRank.payload.data.general.length, 1);
    assert.deepEqual(secondRank.payload.data.general[0].overlap, []);
    assert.equal(
      calls.length,
      1,
      "the public catalog cache must not cache user-specific ranking results",
    );
    for (const method of ["GET", "PUT", "DELETE"])
      assert.equal(
        (
          await api(`/supplements/${existing.id}`, {
            method,
            cookie: second.cookie,
            body: method === "PUT" ? { name: "타인 제품 변경" } : undefined,
          })
        ).response.status,
        404,
      );
    const product = allRanked(secondRank.payload.data)[0].product;
    assert.equal(
      (
        await api("/safety/preview", {
          method: "POST",
          cookie: second.cookie,
          body: { ...draft(product), excludeSupplementId: existing.id },
        })
      ).response.status,
      404,
    );
    await api(`/supplements/${existing.id}`, { method: "DELETE", cookie: first.cookie });
    const after = (await api<RankResult>("/products/matches", first)).payload.data;
    assert.equal(after.caution.length, 0);
    assert.equal(after.general.length, 1);
    assert.deepEqual((await api<Supplement[]>("/supplements", second)).payload.data, []);
  });

  test("matches derive interests from the stored survey and reject caller-selected unrelated interests", async () => {
    const owner = await account();
    const other = await account("other@example.test");
    assert.equal((await api("/products/matches?interest=비타민%20D", owner)).response.status, 400);
    assert.equal(calls.length, 0);
    await dSurvey(owner.cookie);
    const rejected = await api("/products/matches?interest=마그네슘", owner);
    assert.equal(rejected.response.status, 400);
    assert.equal(calls.length, 0);
    const ranked = await api<RankResult & { interests: string[] }>(
      "/products/matches?interests=마그네슘&age=1",
      owner,
    );
    assert.equal(ranked.response.status, 200);
    assert.deepEqual(ranked.payload.data.interests, ["비타민 D"]);
    assert.deepEqual(allRanked(ranked.payload.data)[0].matched, ["비타민 D"]);
    assert.equal(allRanked(ranked.payload.data)[0].analysis.age, 30);
    assert.equal(
      (await api(`/products/matches?userId=${owner.user.id}`, other)).response.status,
      400,
    );
    await api("/onboarding", {
      method: "POST",
      cookie: owner.cookie,
      body: { choice: "survey", answers: [0, 0, 0, 0, 1, 0, 0] },
    });
    assert.equal((await api("/products/matches", owner)).response.status, 400);
  });

  test("upstream failure returns a neutral manual-entry error and never exposes an upstream key or body", async () => {
    const owner = await account();
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ detail: process.env.FOOD_SAFETY_API_KEY }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    const failed = await api("/products/search?q=실패테스트", owner);
    assert.equal(failed.response.status, 503);
    assert.match(failed.payload.error!, /직접 입력/);
    assert.equal(JSON.stringify(failed.payload).includes(process.env.FOOD_SAFETY_API_KEY!), false);
  });
});
