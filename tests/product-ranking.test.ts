import assert from "node:assert/strict";
import test from "node:test";
import { compareRankedProducts, rankProducts } from "../lib/product-ranking";
import type { RankedProduct } from "../lib/product-ranking";
import type { Product } from "../lib/products";
import type { Ingredient, Supplement } from "../lib/types";

const ingredient = (name: string, amount = 10, unit = "mg"): Ingredient => ({ name, amount, unit });
function candidate(id: string, ingredients: Ingredient[], changes: Partial<Product> = {}): Product {
  return {
    id,
    reportNumber: id,
    name: `가상 검사 제품 ${id}`,
    manufacturer: "가상 제조사",
    intakeMethod: "1일 1회",
    dailyIntakeText: "하루분",
    functionality: "검사용 정보",
    precautions: "표시사항 확인",
    rawStandards: "가상 데이터",
    rawMaterials: "",
    ingredients,
    declaredNutrients: ingredients.map((item) => item.name),
    dailyFrequency: 1,
    parseStatus: "complete",
    issues: [],
    sourceUrl: "https://example.com/fixture",
    updatedAt: null,
    productionEnded: false,
    ...changes,
  };
}
function existing(id: string, ingredients: Ingredient[]): Supplement {
  return {
    id,
    name: `기존 가상 제품 ${id}`,
    brand: "",
    color: "mint",
    ingredients,
    schedules: [{ id: `${id}-schedule`, time: "09:00" }],
  };
}
const four = () => [
  ingredient("비타민 C", 100),
  ingredient("비타민 D", 20, "μg"),
  ingredient("마그네슘", 100),
  ingredient("아연", 5),
];
function all(result: ReturnType<typeof rankProducts>) {
  return [...result.general, ...result.needsReview, ...result.caution];
}

test("independent numeric-UL fixture ranks A > B > C and separates exceeding D", () => {
  // Same interest sets necessarily overlap the same current interest nutrients.
  // B's two overlaps are EXTRA, non-interest nutrients, keeping this fixture coherent.
  const current = [existing("current", [ingredient("철", 10), ingredient("칼슘", 500)])];
  const a = candidate("A", four());
  const b = candidate("B", [...four(), ingredient("철", 5), ingredient("칼슘", 100)]);
  const c = candidate("C", four().slice(0, 3));
  const d = candidate("D", [
    ...four().slice(0, 1),
    ingredient("비타민 D", 120, "μg"),
    ...four().slice(2),
  ]);
  const result = rankProducts(
    [d, c, b, a],
    four().map((item) => item.name),
    current,
    30,
  );
  assert.deepEqual(
    result.general.map((item) => item.product.id),
    ["A", "B", "C"],
  );
  assert.deepEqual(
    result.general.map((item) => item.overlap.length),
    [0, 2, 0],
  );
  assert.deepEqual(
    result.general.map((item) => item.matchPercent),
    [100, 100, 75],
  );
  assert.deepEqual(
    result.caution.map((item) => item.product.id),
    ["D"],
  );
  assert.equal(result.caution[0].exceeded[0].name, "비타민 D");
  assert.equal(result.needsReview.length, 0);
});

test("actual A/B2/D/Mg interests retain form/no-numeric-UL review instead of faking general candidates", () => {
  const items = [
    ingredient("비타민 A", 500, "μg"),
    ingredient("비타민 B2", 1.5),
    ingredient("비타민 D", 20, "μg"),
    ingredient("마그네슘", 100),
  ];
  const result = rankProducts(
    [candidate("actual", items)],
    items.map((item) => item.name),
    [],
    30,
  );
  assert.equal(result.general.length, 0);
  assert.equal(result.needsReview[0].matchPercent, 100);
  assert.equal(
    result.needsReview[0].unknown.find((item) => item.key === "비타민 A")?.status,
    "form_required",
  );
  assert.ok(result.needsReview[0].unknown.some((item) => item.key === "비타민 B2"));
  assert.deepEqual(result.needsReview[0].coverage, { analyzable: 2, total: 4, ratio: 0.5 });
});

test("lexicographic comparator applies each key in order, then deterministic id", () => {
  const base = rankProducts([candidate("base", [ingredient("비타민 C")])], ["비타민 C"], [], 30)
    .general[0];
  const metric = (
    id: string,
    changes: Partial<RankedProduct> = {},
    productChanges: Partial<Product> = {},
  ) => ({ ...base, product: { ...base.product, id, ...productChanges }, ...changes });
  const pairs: [RankedProduct, RankedProduct][] = [
    [metric("z", { matched: ["a", "b"], overlap: ["c"] }), metric("a", { matched: ["a"] })],
    [
      metric("z", { overlap: [], coverage: { analyzable: 0, total: 1, ratio: 0 } }),
      metric("a", { overlap: ["a"] }),
    ],
    [
      metric("z", { coverage: { analyzable: 1, total: 1, ratio: 1 } }, { dailyFrequency: 3 }),
      metric("a", { coverage: { analyzable: 1, total: 2, ratio: 0.5 } }),
    ],
    [
      metric("z", { dataCompleteness: 0 }, { dailyFrequency: 1 }),
      metric("a", { dataCompleteness: 1 }, { dailyFrequency: 2 }),
    ],
    [metric("z", { dataCompleteness: 1 }), metric("a", { dataCompleteness: 0.5 })],
    [metric("a"), metric("z")],
  ];
  for (const [first, second] of pairs) {
    assert.ok(compareRankedProducts(first, second) < 0);
    assert.ok(compareRankedProducts(second, first) > 0);
  }
  assert.ok(
    compareRankedProducts(
      metric("z", {}, { dailyFrequency: 1 }),
      metric("a", {}, { dailyFrequency: null }),
    ) < 0,
  );
  assert.ok(
    compareRankedProducts(
      metric("a", {}, { dailyFrequency: null }),
      metric("z", {}, { dailyFrequency: null }),
    ) < 0,
  );
});

test("interest count and overlaps use distinct canonical nutrients, not aliases or row counts", () => {
  const result = rankProducts(
    [candidate("aliases", [ingredient("Vitamin-D3", 10, "μg"), ingredient("비타민 D", 10, "μg")])],
    ["비타민D", "Vitamin D", "비타민 D3"],
    [
      existing("one", [ingredient("Vitamin D", 10, "μg")]),
      existing("two", [ingredient("비타민D", 10, "μg")]),
    ],
    30,
  );
  assert.equal(result.interestCount, 1);
  assert.deepEqual(result.general[0].matched, ["비타민 D"]);
  assert.deepEqual(result.general[0].overlap, ["비타민 D"]);
  assert.deepEqual(result.general[0].coverage, { analyzable: 1, total: 1, ratio: 1 });
  assert.deepEqual(result.general[0].analysis.items[0].totals, [{ amount: 40, unit: "μg" }]);
});

test("only explicit B-family interest gets one grouped match without merging nutrient identities", () => {
  const product = candidate("b", [ingredient("리보플라빈", 1), ingredient("비타민 B6", 1)]);
  const current = [existing("b12", [ingredient("비타민 B12", 10, "μg")])];
  const grouped = rankProducts([product], ["비타민 B군"], current, 30).needsReview[0];
  assert.deepEqual(grouped.matched, ["비타민 B군"]);
  assert.equal(grouped.matchPercent, 100);
  assert.deepEqual(grouped.overlap, []);
  assert.match(grouped.reasons.join(" "), /비타민 B군 관심그룹: 비타민 B2, 비타민 B6/);
  assert.match(grouped.reasons.join(" "), /전체 B군을 포함한다는 뜻은 아닙니다/);
  assert.ok(grouped.analysis.items.some((item) => item.key === "비타민 B2"));
  assert.ok(grouped.analysis.items.some((item) => item.key === "비타민 B6"));
  assert.ok(!grouped.analysis.items.some((item) => item.key === "비타민 B군"));
  assert.equal(rankProducts([product], ["비타민 B1", "비타민 B12"], [], 30).excludedCount, 1);
});

test("declared nutrients without amounts never become a general or numeric comparison", () => {
  const missing = candidate("missing", [], {
    declaredNutrients: ["비타민 D"],
    parseStatus: "unavailable",
    issues: ["함량 없음"],
  });
  const result = rankProducts([missing], ["비타민 D"], [], 30);
  assert.equal(result.general.length, 0);
  const item = result.needsReview[0];
  assert.equal(item.unknown[0].status, "unknown");
  assert.equal(item.coverage.ratio, 0);
  assert.equal(item.matchPercent, 100);
  assert.deepEqual(item.product.ingredients, []);
  assert.deepEqual(item.analysis.items[0].totals, []);
});

test("partial parser information remains review even when all retained numeric nutrients are within", () => {
  for (const changes of [
    { parseStatus: "partial" as const },
    { issues: ["자동 변환되지 않은 표시"] },
  ]) {
    const result = rankProducts(
      [candidate("partial", [ingredient("비타민 C")], changes)],
      ["비타민 C"],
      [],
      30,
    );
    assert.equal(result.general.length, 0);
    assert.equal(result.needsReview[0].analysis.items[0].status, "within");
    assert.match(result.needsReview[0].reasons.join(" "), /불완전/);
  }
});

test("age, unsupported units, official no-UL and unknown ingredients each require review", () => {
  for (const [item, age] of [
    [ingredient("비타민 D", 10, "μg"), null],
    [ingredient("비타민 C", 100, "IU"), 30],
    [ingredient("비타민 B12", 10, "μg"), 30],
    [ingredient("가상 추출물", 10), 30],
  ] as const) {
    const result = rankProducts([candidate("review", [item])], [item.name], [], age);
    assert.equal(result.needsReview.length, 1);
    assert.equal(result.general.length, 0);
    assert.equal(result.needsReview[0].coverage.ratio, 0);
  }
});

test("existing-only unknown or empty product data also controls the full combined gate", () => {
  const product = candidate("c", [ingredient("비타민 C")]);
  const unknown = rankProducts(
    [product],
    ["비타민 C"],
    [existing("old", [ingredient("가상 추출물")])],
    30,
  ).needsReview[0];
  assert.match(unknown.reasons.join(" "), /기존 등록분 가상추출물/);
  assert.equal(
    unknown.coverage.ratio,
    1,
    "coverage concerns candidate nutrients, not completeness of all existing products",
  );
  const empty = rankProducts([product], ["비타민 C"], [existing("empty", [])], 30);
  assert.equal(empty.needsReview.length, 1);
  assert.match(empty.needsReview[0].reasons.join(" "), /성분이 비어 있는 기존/);
});

test("existing-only exceedance cannot promote an otherwise matching candidate to general", () => {
  const result = rankProducts(
    [candidate("c", [ingredient("비타민 C")])],
    ["비타민 C"],
    [existing("d", [ingredient("비타민 D", 125, "μg")])],
    30,
  );
  assert.equal(result.caution.length, 1);
  assert.deepEqual(result.caution[0].overlap, []);
  assert.match(result.caution[0].reasons.join(" "), /후보에 없는 기존 등록분의 비타민 D/);
});

test("known subtotal exceedance takes precedence over incomplete quantities and incompatible units", () => {
  const current = [existing("d", [ingredient("비타민 D", 125, "μg")])];
  for (const product of [
    candidate("missing", [], { declaredNutrients: ["비타민 D"], parseStatus: "partial" }),
    candidate("unit", [ingredient("비타민 D", 1, "mL")]),
    candidate("invalid", [ingredient("비타민 D", Number.NaN, "μg")]),
  ]) {
    const ranked = rankProducts([product], ["비타민 D"], current, 30).caution[0];
    assert.ok(ranked);
    assert.equal(ranked.unknown.length, 1);
    assert.equal(ranked.exceeded[0].name, "비타민 D");
    assert.equal(ranked.coverage.ratio, 0);
    assert.match(ranked.reasons.join(" "), /부분 합계만으로도/);
  }
});

test("candidate daily quantities are added once and do not replace same-id existing products", () => {
  const product = candidate("same", [ingredient("비타민 D", 25, "μg")], { dailyFrequency: 3 });
  const current = [existing("same", [ingredient("비타민 D", 20, "μg")])];
  const ranked = rankProducts([product], ["비타민 D"], current, 30).general[0];
  assert.deepEqual(ranked.analysis.items[0].totals, [{ amount: 45, unit: "μg" }]);
  assert.deepEqual(ranked.analysis.items[0].proposedTotals, [{ amount: 25, unit: "μg" }]);
});

test("query scope excludes no match, absent detail, and ended products without guessing from titles", () => {
  const products = [
    candidate("unrelated", [ingredient("아연")]),
    candidate("title-only", [], {
      name: "비타민 D 25μg",
      functionality: "비타민 D",
      parseStatus: "unavailable",
    }),
    candidate("ended", [ingredient("비타민 D", 20, "μg")], { productionEnded: true }),
  ];
  const result = rankProducts(products, ["비타민 D"], [], 30);
  assert.equal(all(result).length, 0);
  assert.equal(result.excludedCount, 3);
  assert.equal(rankProducts(products, [], [], 30).excludedCount, 3);
});

test("results are deterministic, leave inputs unchanged, and completeness breaks true ties", () => {
  const full = candidate("z", [ingredient("비타민 C")]);
  const sparse = candidate("a", [ingredient("비타민 C")], {
    manufacturer: "",
    precautions: "",
    dailyIntakeText: "",
  });
  const products = [sparse, full];
  const current = [existing("one", [ingredient("아연")])];
  const before = structuredClone({ products, current });
  const result = rankProducts(products, ["비타민 C"], current, 30);
  assert.deepEqual(
    result.general.map((item) => item.product.id),
    ["z", "a"],
  );
  assert.deepEqual({ products, current }, before);
  assert.deepEqual(result, rankProducts([...products].reverse(), ["비타민 C"], current, 30));
  for (const item of all(result)) {
    assert.ok(item.matchPercent >= 0 && item.matchPercent <= 100);
    assert.ok(item.coverage.ratio >= 0 && item.coverage.ratio <= 1);
    assert.ok(item.dataCompleteness >= 0 && item.dataCompleteness <= 1);
  }
});
