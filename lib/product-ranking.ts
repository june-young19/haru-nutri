import { normalizedUnit, normalizeIngredient } from "./domain";
import type { Product } from "./products";
import { analyzeSafety } from "./safety";
import type { SafetyAnalysis, SafetyItem } from "./safety";
import type { Ingredient, Supplement } from "./types";

export type ProductGate = "general" | "needs_review" | "caution";

export interface RankedProduct {
  product: Product;
  gate: ProductGate;
  matched: string[];
  overlap: string[];
  unknown: SafetyItem[];
  exceeded: SafetyItem[];
  reasons: string[];
  /** Fraction of this candidate's distinct nutrients with a numeric UL comparison. */
  coverage: { analyzable: number; total: number; ratio: number };
  /** Interest match only, never a safety or nutritional adequacy score. */
  matchPercent: number;
  /** Fraction of the documented metadata/quantity fields that are available. */
  dataCompleteness: number;
  analysis: SafetyAnalysis;
}

export interface RankResult {
  general: RankedProduct[];
  needsReview: RankedProduct[];
  caution: RankedProduct[];
  excludedCount: number;
  interestCount: number;
}

const bGroup = "비타민 B군";
const bVitamins = new Set([
  "비타민 B1",
  "비타민 B2",
  "비타민 B3",
  "비타민 B5",
  "비타민 B6",
  "비타민 B7",
  "비타민 B9",
  "비타민 B12",
]);
const numeric = (item: SafetyItem) => item.status === "within" || item.status === "exceeds";
const validAmount = (ingredient: Ingredient) =>
  Number.isFinite(ingredient.amount) && ingredient.amount > 0;
const frequency = (product: Product) =>
  Number.isInteger(product.dailyFrequency) && product.dailyFrequency! > 0
    ? product.dailyFrequency!
    : Infinity;
const uniqueNames = (names: string[]) => [
  ...new Set(names.map(normalizeIngredient).filter(Boolean)),
];
const stableCompare = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** Shared comparator; gate separation happens before this lexicographic ordering. */
export function compareRankedProducts(left: RankedProduct, right: RankedProduct): number {
  return (
    right.matched.length - left.matched.length ||
    left.overlap.length - right.overlap.length ||
    right.coverage.ratio - left.coverage.ratio ||
    frequency(left.product) - frequency(right.product) ||
    right.dataCompleteness - left.dataCompleteness ||
    stableCompare(left.product.id, right.product.id)
  );
}

function completeness(product: Product, nutrients: string[]): number {
  const fields = [
    product.name,
    product.manufacturer,
    product.reportNumber,
    product.intakeMethod,
    product.dailyIntakeText,
    product.functionality,
    product.precautions,
    product.rawStandards,
    product.sourceUrl,
  ];
  const populated = fields.filter((value) => value.trim().length > 0).length;
  const knownQuantities = nutrients.filter((name) =>
    product.ingredients.some(
      (ingredient) =>
        normalizeIngredient(ingredient.name) === name &&
        validAmount(ingredient) &&
        ingredient.unit.trim(),
    ),
  ).length;
  return (
    (populated + Number(Number.isFinite(frequency(product))) + knownQuantities) /
    (fields.length + 1 + Math.max(1, nutrients.length))
  );
}

/**
 * A known mass subtotal may already exceed its UL even if a second amount is
 * missing/incompatible. Reuse the same analyzer for that lower bound; never
 * turn an incomplete subtotal into a "within" decision.
 */
function knownMassIngredients(ingredients: Ingredient[]): Ingredient[] {
  return ingredients.filter((ingredient) => {
    if (!validAmount(ingredient)) return false;
    const { bucket } = normalizedUnit(ingredient.unit);
    return (
      bucket === "mass" || (normalizeIngredient(ingredient.name) === "비타민 D" && bucket === "IU")
    );
  });
}

function rankOne(
  product: Product,
  interests: string[],
  current: Supplement[],
  age: number | null,
): RankedProduct {
  const nutrients = uniqueNames([
    ...product.declaredNutrients,
    ...product.ingredients.map((ingredient) => ingredient.name),
  ]);
  const nutrientSet = new Set(nutrients);
  const matchedB = nutrients.filter((name) => bVitamins.has(name));
  const matched = interests.filter(
    (name) => nutrientSet.has(name) || (name === bGroup && matchedB.length > 0),
  );
  const currentNames = new Set(
    uniqueNames(current.flatMap((item) => item.ingredients.map((ingredient) => ingredient.name))),
  );
  const overlap = nutrients.filter((name) => currentNames.has(name));
  const missingNames = nutrients.filter(
    (name) =>
      !product.ingredients.some((ingredient) => normalizeIngredient(ingredient.name) === name),
  );
  // Invalid amount sentinels exist only for analysis: they are not inferred
  // quantities, returned catalog ingredients, or values that may be persisted.
  const proposedIngredients = [
    ...product.ingredients,
    ...missingNames.map((name) => ({ name, amount: 0, unit: "" })),
  ];
  const analysis = analyzeSafety(current, age, {
    name: product.name,
    ingredients: proposedIngredients,
  });
  const known = analyzeSafety(
    current.map((item) => ({ ...item, ingredients: knownMassIngredients(item.ingredients) })),
    age,
    { name: product.name, ingredients: knownMassIngredients(product.ingredients) },
  );
  const exceededByKey = new Map(
    known.items.filter((item) => item.status === "exceeds").map((item) => [item.key, item]),
  );
  for (const item of analysis.items)
    if (item.status === "exceeds") exceededByKey.set(item.key, item);
  const exceeded = [...exceededByKey.values()];
  const unknown = analysis.items.filter((item) => !numeric(item));
  const analyzable = analysis.items.filter(
    (item) => nutrientSet.has(item.key) && numeric(item),
  ).length;
  const coverage = {
    analyzable,
    total: nutrients.length,
    ratio: nutrients.length ? analyzable / nutrients.length : 0,
  };
  const missingCurrent = current.filter((item) => item.ingredients.length === 0);
  const needsReview =
    analysis.age === null ||
    unknown.length > 0 ||
    nutrients.length === 0 ||
    product.parseStatus !== "complete" ||
    product.issues.length > 0 ||
    missingCurrent.length > 0;
  const gate: ProductGate = exceeded.length ? "caution" : needsReview ? "needs_review" : "general";
  const reasons = [
    `설문 관심 성분 ${matched.length}/${interests.length}개 일치`,
    overlap.length
      ? `현재 등록 제품과 중복되는 성분 ${overlap.length}개: ${overlap.join(", ")}`
      : "현재 등록 제품과 확인된 중복 성분 없음",
  ];
  if (matched.includes(bGroup) && matchedB.length)
    reasons.push(
      `비타민 B군 관심그룹: ${matchedB.join(", ")} 확인. 전체 B군을 포함한다는 뜻은 아닙니다.`,
    );
  for (const item of exceeded) {
    const partial = analysis.items.find((entry) => entry.key === item.key)?.status !== "exceeds";
    reasons.push(
      `${nutrientSet.has(item.key) ? "후보 추가 후" : "후보에 없는 기존 등록분의"} ${item.name}: ${partial ? "확인 가능한 함량의 부분 합계만으로도" : "등록된 하루 합계가"} 참고 상한섭취량을 초과합니다.`,
    );
  }
  for (const item of unknown)
    reasons.push(
      `${nutrientSet.has(item.key) ? "후보·합산" : "기존 등록분"} ${item.name}: ${item.message}`,
    );
  if (analysis.age === null)
    reasons.push("만 나이가 없어 연령별 참고 상한섭취량 확인이 필요합니다.");
  if (!nutrients.length) reasons.push("상세 성분 정보가 없어 직접 확인이 필요합니다.");
  if (product.parseStatus !== "complete" || product.issues.length)
    reasons.push(
      "공식 성분 정보가 불완전하거나 자동 변환되지 않은 항목이 있어 제품 표시사항 확인이 필요합니다.",
    );
  if (missingCurrent.length)
    reasons.push("성분이 비어 있는 기존 등록 제품이 있어 전체 합산을 확인할 수 없습니다.");
  if (gate === "general")
    reasons.push(
      "등록 정보 기준 참고 상한섭취량 초과 항목 없음. 개인별 안전이나 복용 필요성을 뜻하지 않습니다.",
    );
  reasons.push(
    `후보 성분 ${coverage.total}개 중 ${coverage.analyzable}개를 수치 기준으로 비교했습니다.`,
  );
  reasons.push(
    Number.isFinite(frequency(product))
      ? `하루 섭취 ${product.dailyFrequency}회`
      : "하루 섭취 횟수는 제품 표시사항 확인이 필요합니다.",
  );
  return {
    product,
    gate,
    matched,
    overlap,
    unknown,
    exceeded,
    reasons,
    coverage,
    matchPercent: interests.length ? Math.round((matched.length / interests.length) * 100) : 0,
    dataCompleteness: completeness(product, nutrients),
    analysis,
  };
}

/**
 * Catalog candidates are compared with active user products (caller supplies
 * only active rows). The full combined analysis, including existing-only
 * uncertainties/exceedances, controls the conservative gate. Nutrient names are
 * not guessed from product titles/function claims, and discontinued or zero-
 * interest matches are excluded. B-family matching is solely an interest group;
 * constituent identity, amounts, overlaps and UL checks remain separate.
 */
export function rankProducts(
  products: Product[],
  interests: string[],
  activeSupplements: Supplement[],
  age: number | null,
): RankResult {
  const normalizedInterests = uniqueNames(interests);
  const result: RankResult = {
    general: [],
    needsReview: [],
    caution: [],
    excludedCount: 0,
    interestCount: normalizedInterests.length,
  };
  for (const product of products) {
    if (product.productionEnded || normalizedInterests.length === 0) {
      result.excludedCount++;
      continue;
    }
    const ranked = rankOne(product, normalizedInterests, activeSupplements, age);
    if (!ranked.matched.length) {
      result.excludedCount++;
      continue;
    }
    if (ranked.gate === "caution") result.caution.push(ranked);
    else if (ranked.gate === "needs_review") result.needsReview.push(ranked);
    else result.general.push(ranked);
  }
  result.general.sort(compareRankedProducts);
  result.needsReview.sort(compareRankedProducts);
  result.caution.sort(compareRankedProducts);
  return result;
}
