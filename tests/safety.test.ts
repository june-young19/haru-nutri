import assert from "node:assert/strict";
import test from "node:test";
import { normalizeIngredient } from "../lib/domain";
import { analyzeSafety } from "../lib/safety";
import { referenceForAge, ulReferences } from "../lib/ul-reference";
import type { Ingredient, Supplement } from "../lib/types";

function product(id: string, ingredients: Ingredient[]): Supplement {
  return {
    id,
    name: `제품 ${id}`,
    brand: "",
    color: "mint",
    ingredients,
    schedules: [
      { id: `${id}-1`, time: "09:00" },
      { id: `${id}-2`, time: "20:00" },
    ],
  };
}
function one(name: string, amount: number, unit: string, age: number | null = 30) {
  return analyzeSafety([product("one", [{ name, amount, unit }])], age).items[0];
}

test("all supported UL references cover each integer age 1–120 exactly once and preserve sources", () => {
  assert.equal(Object.keys(ulReferences).length, 7);
  for (const [name, bands] of Object.entries(ulReferences)) {
    for (let age = 1; age <= 120; age++) {
      assert.equal(
        bands.filter((band) => age >= band.ageMin && age <= band.ageMax).length,
        1,
        `${name} at age ${age}`,
      );
      const reference = referenceForAge(name, age)!;
      assert.match(reference.sourceUrl, /^https:\/\/ods\.od\.nih\.gov\/factsheets\//);
      assert.match(reference.version, /^\d{4}-\d{2}-\d{2}$/);
      assert.equal(reference.year, Number(reference.version.slice(0, 4)));
      assert.ok(reference.notes.length > 0 && reference.scope.length > 0);
    }
  }
});

test("age bands change at their actual boundaries, not at arbitrary adulthood", () => {
  for (const [age, expected] of [
    [1, 400],
    [3, 400],
    [4, 650],
    [8, 650],
    [9, 1200],
    [13, 1200],
    [14, 1800],
    [18, 1800],
    [19, 2000],
    [120, 2000],
  ]) {
    assert.equal(referenceForAge("비타민 C", age)?.value, expected);
  }
  assert.equal(one("비타민 C", 500, "mg", 3).status, "exceeds");
  assert.equal(one("비타민 C", 500, "mg", 4).status, "within");
  assert.equal(referenceForAge("칼슘", 50)?.value, 2500);
  assert.equal(referenceForAge("칼슘", 51)?.value, 2000);
  assert.equal(one("칼슘", 2200, "mg", 50).status, "within");
  assert.equal(one("칼슘", 2200, "mg", 51).status, "exceeds");
  assert.equal(referenceForAge("철", 13)?.value, 40);
  assert.equal(referenceForAge("철", 14)?.value, 45);
  assert.equal(referenceForAge("아연", 18)?.value, 34);
  assert.equal(referenceForAge("아연", 19)?.value, 40);
  assert.equal(referenceForAge("셀레늄", 13)?.value, 280);
  assert.equal(referenceForAge("셀레늄", 14)?.value, 400);
});

test("single ingredients appear and daily mass totals convert g/mg/mcg/μg without schedule multiplication", () => {
  const result = analyzeSafety(
    [
      product("a", [{ name: "Vitamin C", amount: 1, unit: "g" }]),
      product("b", [{ name: "비타민 C", amount: 500000, unit: "mcg" }]),
      product("c", [
        { name: "비타민 C", amount: 500, unit: "mg" },
        { name: "아연", amount: 10, unit: "mg" },
      ]),
    ],
    30,
  );
  assert.equal(result.items.length, 2);
  const vitaminC = result.items.find((item) => item.key === "비타민 C")!;
  assert.equal(vitaminC.count, 3);
  assert.deepEqual(vitaminC.totals, [{ amount: 2000, unit: "mg" }]);
  assert.equal(vitaminC.status, "within");
  assert.equal(result.items.find((item) => item.key === "아연")?.count, 1);
  assert.equal(result.hasExceedance, false);
  assert.equal(one("Vitamin C", 2.0001, "g").status, "exceeds");
});

test("vitamin D combines IU and mass using only its official 40 IU per μg conversion", () => {
  const result = analyzeSafety(
    [
      product("a", [{ name: "  Vitamin-D3 ", amount: 2000, unit: "IU" }]),
      product("b", [{ name: "비타민 D", amount: 0.05, unit: "mg" }]),
    ],
    30,
  );
  assert.deepEqual(result.items[0].totals, [{ amount: 100, unit: "μg" }]);
  assert.equal(result.items[0].status, "within");
  assert.equal(one("비타민 D", 4001, "IU").status, "exceeds");
  assert.equal(one("비타민 C", 500, "IU").status, "unit_mismatch");
  assert.equal(one("마그네슘", 10, "IU").status, "unit_mismatch");
  assert.equal(one("비타민 D", 10, "mL").status, "unit_mismatch");
});

test("age 1–3 vitamin D preserves source rounding but compares against exactly 2500 IU", () => {
  assert.equal(one("비타민 D", 2500, "IU", 3).status, "within");
  assert.equal(one("비타민 D", 2501, "IU", 3).status, "exceeds");
  assert.equal(one("비타민 D", 62.5, "μg", 3).status, "within");
  assert.equal(one("비타민 D", 63, "μg", 3).status, "exceeds");
  const reference = referenceForAge("비타민 D", 3)!;
  assert.equal(reference.value, 62.5);
  assert.equal(reference.sourceDisplayValue, 63);
  assert.equal(reference.iuValue, 2500);
  assert.match(reference.notes, /반올림/);
  assert.equal(one("비타민 D", 3000, "IU", 4).status, "within");
  assert.equal(one("비타민 D", 3001, "IU", 4).status, "exceeds");
});

test("magnesium UL explicitly applies to supplements/medications, not food magnesium", () => {
  assert.equal(one("마그네슘", 66, "mg", 3).status, "exceeds");
  assert.equal(one("마그네슘", 66, "mg", 4).status, "within");
  const item = one("magnesium", 350, "mg");
  assert.equal(item.status, "within");
  assert.equal(item.reference?.scope, "보충제·의약품 유래 섭취량");
  assert.match(item.message, /식품 속 마그네슘은 제외/);
  assert.equal(one("magnesium oxide", 500, "mg").status, "form_required");
});

test("missing/invalid ages never silently use the adult UL", () => {
  for (const age of [null, 0, -1, 121, 3.5, NaN, Infinity]) {
    const result = analyzeSafety(
      [product("a", [{ name: "비타민 D", amount: 20, unit: "μg" }])],
      age,
    );
    assert.equal(result.age, null);
    assert.equal(result.items[0].status, "age_required");
    assert.equal(result.items[0].reference, null);
    assert.equal(result.hasExceedance, false);
  }
});

test("no-UL, unknown ingredients, and chemical-form requirements are never labeled safe", () => {
  for (const name of ["비타민 B12", "오메가3"]) {
    const item = one(name, 1000, "mg");
    assert.equal(item.status, "no_ul");
    assert.equal(item.reference, null);
    assert.ok(item.evidence?.sourceUrl);
    assert.match(item.message, /안전을 의미하지 않습니다/);
  }
  assert.equal(one("미등록 추출물", 10, "mg").status, "unknown");
  assert.equal(one("미등록 추출물", 10, "IU").status, "unknown");
  assert.equal(one("constructor", 10, "mg").status, "unknown");
  assert.equal(one("비타민 B12", 10, "IU").status, "unit_mismatch");
  for (const name of [
    "비타민 A",
    "retinol",
    "beta carotene",
    "비타민 E",
    "alpha tocopherol",
    "niacin",
    "nicotinic acid",
    "niacinamide",
    "엽산",
    "folic acid",
    "folate",
    "비타민 B군",
  ]) {
    assert.equal(one(name, 1000, "μg").status, "form_required", name);
  }
});

test("aliases preserve exact nutrient identity and do not erase important chemical forms", () => {
  assert.equal(normalizeIngredient(" VITAMIN d-3 "), "비타민 D");
  assert.equal(normalizeIngredient("비 타 민 D"), "비타민 D");
  assert.equal(normalizeIngredient("folate"), normalizeIngredient("엽산"));
  assert.equal(normalizeIngredient("folic acid"), normalizeIngredient("폴산"));
  assert.notEqual(normalizeIngredient("folic acid"), normalizeIngredient("folate"));
  assert.notEqual(normalizeIngredient("retinol"), normalizeIngredient("beta-carotene"));
  assert.notEqual(normalizeIngredient("nicotinic acid"), normalizeIngredient("niacinamide"));
  assert.notEqual(normalizeIngredient("비타민 B1"), normalizeIngredient("비타민 B12"));
});

test("addition preview provides current, proposed and combined totals without mutating inputs", () => {
  const products = [
    product("a", [{ name: "비타민 D", amount: 20, unit: "μg" }]),
    product("b", [{ name: "Vitamin D", amount: 25, unit: "μg" }]),
  ];
  const before = structuredClone(products);
  const result = analyzeSafety(products, 30, {
    name: "새 비타민 D",
    ingredients: [{ name: "비타민 D", amount: 80, unit: "μg" }],
  });
  const item = result.items[0];
  assert.deepEqual(item.currentTotals, [{ amount: 45, unit: "μg" }]);
  assert.deepEqual(item.proposedTotals, [{ amount: 80, unit: "μg" }]);
  assert.deepEqual(item.totals, [{ amount: 125, unit: "μg" }]);
  assert.equal(item.count, 3);
  assert.equal(item.status, "exceeds");
  assert.equal(result.hasExceedance, true);
  assert.deepEqual(products, before);
});

test("edit preview excludes the entire replaced product before adding the new ingredients", () => {
  const products = [
    product("a", [{ name: "비타민 D", amount: 20, unit: "μg" }]),
    product("b", [
      { name: "비타민 D", amount: 25, unit: "μg" },
      { name: "아연", amount: 10, unit: "mg" },
    ]),
  ];
  const result = analyzeSafety(products, 30, {
    id: "b",
    name: "교체 제품",
    ingredients: [{ name: "비타민 D", amount: 30, unit: "μg" }],
  });
  assert.equal(result.items.length, 1, "removed zinc must not remain in the edit preview");
  const item = result.items[0];
  assert.deepEqual(item.currentTotals, [{ amount: 20, unit: "μg" }]);
  assert.deepEqual(item.proposedTotals, [{ amount: 30, unit: "μg" }]);
  assert.deepEqual(item.totals, [{ amount: 50, unit: "μg" }]);
  assert.equal(item.count, 2);
  assert.equal(item.status, "within");
  assert.equal(item.products.find((entry) => entry.id === "b")?.name, "교체 제품");
});

test("invalid or incompatible amounts cannot produce an apparently complete within result", () => {
  for (const amount of [0, -1, NaN, Infinity])
    assert.equal(one("비타민 C", amount, "mg").status, "unknown");
  const mixed = analyzeSafety(
    [
      product("a", [{ name: "비타민 C", amount: 2000, unit: "mg" }]),
      product("b", [{ name: "비타민 C", amount: 1, unit: "IU" }]),
    ],
    30,
  ).items[0];
  assert.equal(mixed.status, "unit_mismatch");
  assert.deepEqual(mixed.totals, [
    { amount: 2000, unit: "mg" },
    { amount: 1, unit: "IU" },
  ]);
});
