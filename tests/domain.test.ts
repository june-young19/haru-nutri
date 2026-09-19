import assert from "node:assert/strict";
import test from "node:test";
import {
  addDays,
  calculateStreak,
  completionRate,
  dateKey,
  duplicateGroups,
  normalizeIngredient,
  surveyResults,
} from "../lib/domain";
import type { Ingredient, Supplement } from "../lib/types";

const product = (id: string, ingredients: Ingredient[], schedules = 1): Supplement => ({
  id,
  name: `제품 ${id}`,
  brand: "",
  color: "green",
  ingredients,
  schedules: Array.from({ length: schedules }, (_, i) => ({ id: `${id}-${i}`, time: "09:00" })),
});

test("common Korean and English ingredient aliases normalize without conflating B vitamins", () => {
  assert.equal(normalizeIngredient("  Vitamin-D  "), "비타민 D");
  assert.equal(normalizeIngredient("비타민 D3"), "비타민 D");
  assert.equal(normalizeIngredient("Omega-3"), "오메가3");
  assert.equal(normalizeIngredient("MAGNESIUM"), "마그네슘");
  assert.equal(normalizeIngredient(" vitamin b-12 "), "비타민 B12");
  assert.notEqual(normalizeIngredient("비타민 B군"), normalizeIngredient("비타민 B12"));
  assert.notEqual(normalizeIngredient("비타민 B1"), normalizeIngredient("비타민 B12"));
});

test("two-product vitamin D example totals 45 μg; schedules do not multiply daily amounts", () => {
  const groups = duplicateGroups([
    product("a", [{ name: "비타민 D", amount: 20, unit: "μg" }], 3),
    product("b", [{ name: "Vitamin D", amount: 25, unit: "mcg" }]),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 2);
  assert.deepEqual(groups[0].totals, [{ amount: 45, unit: "μg" }]);
  assert.equal(groups[0].incompatibleUnits, false);
});

test("mass units normalize consistently and identical rows in one product aggregate", () => {
  const [group] = duplicateGroups([
    product("a", [
      { name: "마그네슘", amount: 0.1, unit: "g" },
      { name: "magnesium", amount: 50, unit: "mg" },
    ]),
    product("b", [{ name: "마그네슘", amount: 50000, unit: "µg" }]),
  ]);
  assert.deepEqual(group.totals, [{ amount: 200, unit: "mg" }]);
  assert.deepEqual(group.products[0].amounts, [{ amount: 150, unit: "mg" }]);
  assert.deepEqual(group.products[1].amounts, [{ amount: 50, unit: "mg" }]);
});

test("IU and activity-based units never receive a generic mass conversion", () => {
  const [group] = duplicateGroups([
    product("a", [{ name: "비타민 D", amount: 20, unit: "μg" }]),
    product("b", [{ name: "비타민 D", amount: 1000, unit: "iu" }]),
  ]);
  assert.equal(group.incompatibleUnits, true);
  assert.deepEqual(group.totals, [
    { amount: 20, unit: "μg" },
    { amount: 1000, unit: "IU" },
  ]);
  const [folate] = duplicateGroups([
    product("a", [{ name: "엽산", amount: 400, unit: "μg DFE" }]),
    product("b", [{ name: "엽산", amount: 200, unit: "μg" }]),
  ]);
  assert.equal(folate.incompatibleUnits, true);
});

test("single-product repeats and different B vitamins are not cross-product duplicates", () => {
  assert.deepEqual(
    duplicateGroups([
      product("a", [
        { name: "비타민 D", amount: 20, unit: "μg" },
        { name: "vitamin-d", amount: 25, unit: "μg" },
      ]),
    ]),
    [],
  );
  assert.deepEqual(
    duplicateGroups([
      product("a", [{ name: "비타민 B군", amount: 10, unit: "mg" }]),
      product("b", [{ name: "비타민 B12", amount: 10, unit: "μg" }]),
      product("c", [{ name: "비타민 B1", amount: 10, unit: "mg" }]),
    ]),
    [],
  );
});

test("invalid entries cannot contaminate otherwise valid totals", () => {
  const [group] = duplicateGroups([
    product("a", [
      { name: "아연", amount: 10, unit: "mg" },
      { name: "아연", amount: NaN, unit: "mg" },
    ]),
    product("b", [
      { name: "아연", amount: 5, unit: "mg" },
      { name: "아연", amount: -1, unit: "mg" },
    ]),
  ]);
  assert.deepEqual(group.totals, [{ amount: 15, unit: "mg" }]);
});

test("survey is deterministic, bounded, and does not mistake rarely fatigued for often fatigued", () => {
  assert.deepEqual(surveyResults([0, 0, 0, 0, 2, 0, 0]), []);
  assert.deepEqual(
    surveyResults([0, 0, 0, 0, 0, 0, 0]).map((result) => result.name),
    ["비타민 B군"],
  );
  const results = surveyResults([2, 2, 2, 2, 0, 2, 2]);
  assert.equal(results.length, 4);
  assert.deepEqual(results, surveyResults([2, 2, 2, 2, 0, 2, 2]));
  assert.ok(results.every((result) => result.sourceUrl.startsWith("https://ods.od.nih.gov/")));
  assert.ok(results.every((result) => !/결핍이다|복용해야|치료가 필요|mg|μg/.test(result.reason)));
  assert.deepEqual(surveyResults([2]), []);
  assert.deepEqual(surveyResults([0, 0, 0, 0, 0, 0, 5]), []);
});

test("Korea local date and calendar arithmetic survive UTC midnight and year boundaries", () => {
  assert.equal(dateKey(new Date("2026-09-18T15:00:00Z")), "2026-09-19");
  assert.equal(dateKey(new Date("2026-09-18T14:59:59Z")), "2026-09-18");
  assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(addDays("2024-02-28", 1), "2024-02-29");
  assert.throws(() => addDays("2026-02-30", 1));
});

test("completion rate is bounded and empty days are zero", () => {
  assert.equal(completionRate(2, 3), 67);
  assert.equal(completionRate(0, 0), 0);
  assert.equal(completionRate(9, 3), 100);
  assert.equal(completionRate(-1, 3), 0);
});

test("streak keeps yesterday while today is in progress and stops on missing/empty days", () => {
  const history = [
    { date: "2026-09-19", total: 3, completed: 1 },
    { date: "2026-09-18", total: 3, completed: 3 },
    { date: "2026-09-17", total: 3, completed: 3 },
    { date: "2026-09-16", total: 0, completed: 0 },
    { date: "2026-09-15", total: 3, completed: 3 },
  ];
  assert.equal(calculateStreak(history, "2026-09-19"), 2);
  history[0].completed = 3;
  assert.equal(calculateStreak(history, "2026-09-19"), 3);
  assert.equal(
    calculateStreak(
      history.filter((day) => day.date !== "2026-09-18"),
      "2026-09-19",
    ),
    1,
  );
});
