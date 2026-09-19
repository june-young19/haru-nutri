import assert from "node:assert/strict";
import test from "node:test";
import {
  interestSearchTerms,
  normalizeProductNutrient,
  parseOfficialProduct,
  type OfficialProductRow,
} from "../lib/products";
import { createProductClient } from "../lib/server/products";

// Synthetic examples of the official I0030 schema and label syntax, not real
// product claims. Documentation: https://www.foodsafetykorea.go.kr/api/openApiInfo.do?svc_no=I0030
const fixture = (changes: OfficialProductRow = {}): OfficialProductRow => ({
  PRDLST_REPORT_NO: "200400000001",
  PRDLST_NM: "테스트 비타민 D",
  BSSH_NM: "가상 테스트 제조사",
  RAWMTRL_NM: "비타민 D, 비타민 C",
  NTK_MTHD: "1일 1회, 1회 2캡슐(2g)을 물과 함께 섭취하십시오.",
  STDR_STND:
    "1) 성상: 고유의 색\n2) 비타민D : 표시량(25μg/2g)의 80~180%\n3) 비타민C : 표시량(100mg/2g)의 80~150%\n4) 납(mg/kg): 1.0 이하\n5) 대장균군: 음성",
  PRIMARY_FNCLTY: "제품 기능성 설명",
  IFTKN_ATNT_MATR_CN: "제품 주의사항",
  LAST_UPDT_DTM: "20260919",
  PRODUCTION: "아니오",
  ...changes,
});
const response = (rows = [fixture()], total = rows.length) =>
  new Response(
    JSON.stringify({
      I0030: { total_count: String(total), row: rows, RESULT: { CODE: "INFO-000", MSG: "정상" } },
    }),
    { headers: { "Content-Type": "application/json;charset=utf-8" } },
  );
const clientOptions = { key: () => "fixture-key-not-a-real-key", consumeBudget: () => {} };

test("explicit daily mass maps label amounts without tolerance or contaminant values", () => {
  const product = parseOfficialProduct(fixture())!;
  assert.deepEqual(product.ingredients, [
    { name: "비타민 D", amount: 25, unit: "μg" },
    { name: "비타민 C", amount: 100, unit: "mg" },
  ]);
  assert.equal(product.parseStatus, "complete");
  assert.equal(product.dailyFrequency, 1);
  assert.deepEqual(product.declaredNutrients, ["비타민 D", "비타민 C"]);
  assert.equal(product.id, product.reportNumber);
  assert.ok(!product.sourceUrl.includes("/api/fixture"));
});

test("daily serving mass is scaled once and handles NFKC mass units", () => {
  const product = parseOfficialProduct(
    fixture({
      NTK_MTHD: "1일 2회, 1회 1정(500mg)을 섭취",
      RAWMTRL_NM: "Vitamin D",
      STDR_STND: "① 비타민D : 표시량(10㎍/0.5g)의 80~180%",
    }),
  )!;
  assert.deepEqual(product.ingredients, [{ name: "비타민 D", amount: 20, unit: "μg" }]);
  assert.equal(product.dailyFrequency, 2);
  const direct = parseOfficialProduct(
    fixture({
      NTK_MTHD: "1일 2회, 1회 1g을 섭취",
      RAWMTRL_NM: "비타민 C",
      STDR_STND: "비타민C: 표시량(50mg/1g)의 80~150%",
    }),
  )!;
  assert.equal(direct.ingredients[0].amount, 100);
});

test("a pill count does not imply the undisclosed mass of that pill", () => {
  const product = parseOfficialProduct(fixture({ NTK_MTHD: "1일 1회, 1회 1정 섭취" }))!;
  assert.equal(product.dailyFrequency, 1);
  assert.equal(product.parseStatus, "unavailable");
  assert.deepEqual(product.ingredients, []);
  assert.deepEqual(product.declaredNutrients, ["비타민 D", "비타민 C"]);
});

test("explicit per-day denominator works but variable and alternative servings remain unparsed", () => {
  const daily = {
    RAWMTRL_NM: "비타민 D",
    STDR_STND: "비타민D: 표시량(800IU/1일 섭취량)의 80~180%",
  };
  assert.deepEqual(parseOfficialProduct(fixture({ ...daily, NTK_MTHD: "" }))!.ingredients, [
    { name: "비타민 D", amount: 800, unit: "IU" },
  ]);
  for (const NTK_MTHD of [
    "1일 1~2회, 1회 1정(1g)",
    "1일 1회 1정(1g) 또는 2정(2g)",
    "성인 1일 1회, 어린이 1일 2회",
    "건강기능식품 원료로 사용",
  ]) {
    const product = parseOfficialProduct(fixture({ ...daily, NTK_MTHD }))!;
    assert.deepEqual(product.ingredients, []);
    assert.equal(product.parseStatus, "unavailable");
  }
});

test("RAE, alpha-TE, NE, ranges, percentages and plain unlabelled limits never become ordinary masses", () => {
  const product = parseOfficialProduct(
    fixture({
      RAWMTRL_NM: "비타민 A, 비타민 E, 나이아신, 비타민 D, 비타민 C, 아연",
      STDR_STND:
        "비타민A: 표시량(700μgRAE/2g)의 80~150%\n비타민E: 표시량(11mg α-TE/2g)의 80~150%\n나이아신: 표시량(15mgNE/2g)의 80~150%\n비타민D: 표시량(10~20μg/2g)의 80~180%\n비타민C: 20%\n아연: 10mg 이하",
    }),
  )!;
  assert.deepEqual(product.ingredients, []);
  assert.equal(product.parseStatus, "unavailable");
  assert.ok(product.declaredNutrients.includes("비타민 B3"));
});

test("unknown functional indicators and missing declaration list prevent complete status", () => {
  const partial = parseOfficialProduct(fixture({ RAWMTRL_NM: "비타민 D, 비타민 C, 홍삼" }))!;
  assert.equal(partial.parseStatus, "partial");
  assert.ok(partial.declaredNutrients.includes("홍삼"));
  assert.equal(parseOfficialProduct(fixture({ RAWMTRL_NM: "" }))!.parseStatus, "partial");
  assert.equal(normalizeProductNutrient("스테아린산마그네슘"), "스테아린산마그네슘");
  assert.notEqual(normalizeProductNutrient("비타민 B1"), normalizeProductNutrient("비타민 B12"));
});

test("duplicate conflicting labels are withheld and source metadata is key-free", () => {
  const product = parseOfficialProduct(
    fixture({
      STDR_STND: "비타민D: 표시량(25μg/2g)의 80~180%\nVitamin D: 표시량(50μg/2g)의 80~180%",
    }),
  )!;
  assert.deepEqual(product.ingredients, []);
  assert.ok(product.issues.some((issue) => issue.includes("여러 번")));
  assert.equal(parseOfficialProduct(fixture({ PRDLST_REPORT_NO: "../../secret" })), null);
  assert.equal(parseOfficialProduct(fixture({ PRODUCTION: "예" }))!.productionEnded, true);
});

test("daily serving ranges with units, open limits and compound units are not truncated to the first mass", () => {
  for (const NTK_MTHD of [
    "1일 섭취량: 2g~4g",
    "1일 섭취량: 2 g - 4 g",
    "1일 섭취량: 2g 내지 4g",
    "1일 섭취량: 2g 이상",
    "1일 섭취량: 2g/kg",
    "1일 섭취량: 2mg α-TE",
  ]) {
    const product = parseOfficialProduct(
      fixture({
        NTK_MTHD,
        RAWMTRL_NM: "비타민 D",
        STDR_STND: "비타민D: 표시량(60μg/2g)의 80~180%",
      }),
    )!;
    assert.deepEqual(product.ingredients, [], NTK_MTHD);
    assert.equal(product.parseStatus, "unavailable", NTK_MTHD);
  }
  assert.equal(
    parseOfficialProduct(fixture({ NTK_MTHD: "1일 섭취량: 2g (1포)" }))!.ingredients[0].amount,
    25,
  );
});

test("one parseable and one unparseable occurrence of the same nutrient cannot produce complete daily data", () => {
  for (const second of [
    "Vitamin D: 표시량(100~120μg/2g)의 80~180%",
    "비타민D: 함량 확인 필요",
    "비타민D: 표시량(20μgRAE/2g)의 80~180%",
  ]) {
    const product = parseOfficialProduct(
      fixture({
        RAWMTRL_NM: "비타민 D",
        STDR_STND: `비타민D: 표시량(25μg/2g)의 80~180%\n${second}`,
      }),
    )!;
    assert.deepEqual(product.ingredients, []);
    assert.equal(product.parseStatus, "unavailable");
    assert.ok(product.issues.some((issue) => issue.includes("여러 번")));
  }
});

test("interest terms are bounded product-name hints and not substring nutrient matches", () => {
  assert.deepEqual(interestSearchTerms(["비타민 D", "마그네슘", "오메가3"]), [
    "비타민",
    "마그네슘",
    "오메가",
    "멀티",
  ]);
  assert.deepEqual(interestSearchTerms(["unknown"]), []);
  assert.deepEqual(interestSearchTerms(["unknown", "other unknown"]), []);
  assert.deepEqual(interestSearchTerms(["철"]), ["철분"]);
  assert.equal(interestSearchTerms(["칼슘", "철", "아연", "마그네슘", "비타민 C"]).length, 4);
});

test("missing/sample keys fail closed before network or budget use", async () => {
  for (const value of [undefined, "", "sample", "SAMPLE"]) {
    const client = createProductClient({
      key: () => value,
      fetchImpl: async () => {
        assert.fail("must not fetch");
      },
      consumeBudget: () => assert.fail("must not consume"),
    });
    await assert.rejects(
      client.searchProducts("비타민"),
      (error: unknown) => (error as { status: number }).status === 503,
    );
  }
});

test("HTTPS query, response mapping, TTL cache, mutation isolation, and key rotation", async () => {
  let key = "fixture-key-not-a-real-key";
  let time = 0;
  let calls = 0;
  const budgets: string[] = [];
  const client = createProductClient({
    key: () => key,
    now: () => time,
    consumeBudget: (hash) => budgets.push(hash),
    fetchImpl: async (url, init) => {
      calls++;
      assert.ok(String(url).startsWith("https://openapi.foodsafetykorea.go.kr/api/"));
      assert.ok(String(url).includes("/I0030/json/1/100/PRDLST_NM="));
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal);
      return response();
    },
  });
  const first = await client.searchProducts("비타민");
  first.products[0].ingredients[0].amount = 9999;
  assert.equal((await client.searchProducts("비타민")).products[0].ingredients[0].amount, 25);
  assert.equal(calls, 1);
  time = 3_600_001;
  await client.searchProducts("비타민");
  assert.equal(calls, 2);
  key = "different-fixture-key";
  await client.searchProducts("비타민");
  assert.equal(calls, 3);
  assert.notEqual(budgets[0], budgets[2]);
  assert.ok(budgets.every((hash) => /^[a-f0-9]{64}$/.test(hash)));
  assert.ok(!JSON.stringify(first).includes("fixture-key"));
});

test("simultaneous identical searches share one upstream request", async () => {
  let release!: () => void;
  let calls = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client = createProductClient({
    ...clientOptions,
    fetchImpl: async () => {
      calls++;
      await gate;
      return response();
    },
  });
  const first = client.searchProducts("비타민");
  const second = client.searchProducts("비타민");
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test("provider errors, malformed bodies and oversized responses fail without exposing upstream details", async () => {
  const privateMessage = "fixture-key-not-a-real-key /private/provider/error";
  for (const makeResponse of [
    () =>
      new Response(JSON.stringify({ RESULT: { CODE: "INFO-100", MSG: privateMessage } }), {
        headers: { "Content-Type": "application/json" },
      }),
    () => new Response(privateMessage, { status: 500 }),
    () => new Response("{invalid", { headers: { "Content-Type": "application/json" } }),
    () =>
      new Response("{}", {
        headers: { "Content-Type": "application/json", "Content-Length": "4000000" },
      }),
    () =>
      new Response(" ".repeat(3 * 1024 * 1024 + 1), {
        headers: { "Content-Type": "application/json" },
      }),
  ]) {
    const client = createProductClient({ ...clientOptions, fetchImpl: async () => makeResponse() });
    await assert.rejects(client.searchProducts("비타민"), (error: unknown) => {
      assert.equal((error as { status: number }).status, 503);
      assert.ok(!(error as Error).message.includes(privateMessage));
      return true;
    });
  }
});

test("budget denial prevents upstream fetch; validation rejects control/filter injection", async () => {
  const client = createProductClient({
    ...clientOptions,
    consumeBudget: () => {
      throw new Error("budget exhausted");
    },
    fetchImpl: async () => assert.fail("must not fetch"),
  });
  await assert.rejects(
    client.searchProducts("비타민"),
    (error: unknown) => (error as { status: number }).status === 429,
  );
  for (const query of ["", "A", "비타민&CHNG_DT=20200101", "../other", "비타민%", "비타민\u0000"])
    await assert.rejects(
      client.searchProducts(query),
      (error: unknown) => (error as { status: number }).status === 400,
    );
  await assert.rejects(
    client.searchProducts("비타민", 0),
    (error: unknown) => (error as { status: number }).status === 400,
  );
});

test("empty results are valid; ended products remain searchable while invalid and duplicate rows are omitted", async () => {
  const emptyClient = createProductClient({
    ...clientOptions,
    fetchImpl: async () =>
      new Response(JSON.stringify({ RESULT: { CODE: "INFO-200" } }), {
        headers: { "Content-Type": "application/json" },
      }),
  });
  assert.equal((await emptyClient.searchProducts("비타민")).products.length, 0);
  const client = createProductClient({
    ...clientOptions,
    fetchImpl: async () =>
      response([
        fixture(),
        fixture(),
        fixture({ PRDLST_REPORT_NO: "200400000002", PRODUCTION: "예" }),
        fixture({ PRDLST_REPORT_NO: "bad" }),
      ]),
  });
  const result = await client.searchProducts("비타민");
  assert.equal(result.products.length, 2);
  assert.equal(result.partial, true);
  assert.equal(result.products[1].productionEnded, true);
  assert.equal((await client.getProduct("200400000001")).reportNumber, "200400000001");
  await assert.rejects(
    client.getProduct("200400000003"),
    (error: unknown) => (error as { status: number }).status === 404,
  );
});

test("interest candidates are deduplicated, visibly partial, and match functional declarations only", async () => {
  let calls = 0;
  const client = createProductClient({
    ...clientOptions,
    fetchImpl: async () => {
      calls++;
      return response([
        fixture(),
        fixture({
          PRDLST_REPORT_NO: "200400000002",
          RAWMTRL_NM: "스테아린산마그네슘",
          STDR_STND: "",
          PRDLST_NM: "마그네슘이라는 제품명만 존재",
        }),
      ]);
    },
  });
  const result = await client.candidateProducts(["비타민 D", "마그네슘"]);
  assert.ok(calls <= 4);
  assert.equal(result.products.length, 1);
  assert.equal(result.partial, true);
  assert.match(result.notice, /전체 제품을 조사한 순위가 아니/);
});
