import { normalizedUnit, normalizeIngredient } from "./domain";
import type { Ingredient, Supplement, UnitAmount } from "./types";
import { noULSources, referenceForAge, ulReferences } from "./ul-reference";
import type { ReferenceSource, ULReference } from "./ul-reference";

export type { ULReference } from "./ul-reference";
export type SafetyStatus =
  "within" | "exceeds" | "no_ul" | "unknown" | "unit_mismatch" | "age_required" | "form_required";

export interface SafetyItem {
  key: string;
  name: string;
  products: { id: string; name: string; color: string; amounts: UnitAmount[] }[];
  count: number;
  totals: UnitAmount[];
  currentTotals: UnitAmount[];
  proposedTotals: UnitAmount[];
  status: SafetyStatus;
  reference: ULReference | null;
  message: string;
  /** Missing quantities make displayed amounts partial sums, never zero doses. */
  currentIncomplete?: boolean;
  proposedIncomplete?: boolean;
  /** Source for an explicit no-UL statement; no numeric UL is fabricated. */
  evidence?: ReferenceSource;
}

export interface SafetyAnalysis {
  age: number | null;
  items: SafetyItem[];
  hasExceedance: boolean;
}

export interface ProposedSupplement {
  id?: string;
  name: string;
  ingredients: Ingredient[];
  color?: string;
}

type Amounts = Map<string, number>;
type ProductAmounts = { id: string; name: string; color: string; amounts: Amounts };
type Group = {
  key: string;
  name: string;
  products: Map<string, ProductAmounts>;
  current: Amounts;
  proposed: Amounts;
  combined: Amounts;
  invalidAmount: boolean;
  currentIncomplete: boolean;
  proposedIncomplete: boolean;
};

const formNames = new Set([
  "비타민 A",
  "레티놀",
  "베타카로틴",
  "비타민 E",
  "알파토코페롤",
  "비타민 B3",
  "니코틴산",
  "니코틴아미드",
  "비타민 B9",
  "엽산 (folic acid)",
  "비타민 B군",
]);

function requiresForm(name: string): boolean {
  if (formNames.has(name)) return true;
  // These explicit chemical-form labels cannot be assumed to be elemental or
  // vitamin-activity amounts merely because their unit is mg or μg.
  return (
    /tocopherol|토코페롤|retinyl|레티닐|methylfolate|메틸폴레이트|메틸엽산|5mthf|magnesium|마그네슘|calcium|칼슘|zinc|아연|ferrous|ferric|selenite|selenate/i.test(
      name,
    ) && !Object.hasOwn(ulReferences, name)
  );
}

function add(amounts: Amounts, bucket: string, amount: number): void {
  amounts.set(bucket, (amounts.get(bucket) ?? 0) + amount);
}

const tidy = (value: number): number => Number(value.toPrecision(12));

/**
 * Compares daily LABEL amounts against a reviewed FNB UL snapshot.
 * It does not estimate diet, diagnose toxicity, determine a dose, or infer safety.
 * In an edit preview, current excludes the product with proposed.id; combined is
 * this retained current set plus the replacement, never both old and new values.
 */
export function analyzeSafety(
  products: Supplement[],
  age: number | null,
  proposed?: ProposedSupplement,
): SafetyAnalysis {
  const validAge =
    typeof age === "number" && Number.isInteger(age) && age >= 1 && age <= 120 ? age : null;
  const groups = new Map<string, Group>();
  const retained = proposed?.id
    ? products.filter((product) => product.id !== proposed.id)
    : products;

  function collect(
    product: { id: string; name: string; color: string; ingredients: Ingredient[] },
    isProposed: boolean,
  ): void {
    for (const ingredient of product.ingredients) {
      const key = normalizeIngredient(ingredient.name) || "성분 이름 미입력";
      let group = groups.get(key);
      if (!group) {
        group = {
          key,
          name: key,
          products: new Map(),
          current: new Map(),
          proposed: new Map(),
          combined: new Map(),
          invalidAmount: false,
          currentIncomplete: false,
          proposedIncomplete: false,
        };
        groups.set(key, group);
      }
      let row = group.products.get(product.id);
      if (!row) {
        row = { id: product.id, name: product.name, color: product.color, amounts: new Map() };
        group.products.set(product.id, row);
      }
      if (!Number.isFinite(ingredient.amount) || ingredient.amount <= 0) {
        group.invalidAmount = true;
        if (isProposed) group.proposedIncomplete = true;
        else group.currentIncomplete = true;
        continue;
      }
      let { bucket, factor } = normalizedUnit(ingredient.unit);
      // NIH ODS explicitly supports this conversion for D only. Never infer a
      // general IU-to-mass conversion for A, E, or any other substance.
      if (key === "비타민 D" && bucket === "IU") {
        bucket = "mass";
        factor = 1 / 40;
      }
      const amount = ingredient.amount * factor;
      if (!Number.isFinite(amount)) {
        group.invalidAmount = true;
        if (isProposed) group.proposedIncomplete = true;
        else group.currentIncomplete = true;
        continue;
      }
      add(row.amounts, bucket, amount);
      add(isProposed ? group.proposed : group.current, bucket, amount);
      add(group.combined, bucket, amount);
    }
  }

  retained.forEach((product) => collect(product, false));
  if (proposed) {
    let candidateId = proposed.id || "__proposed__";
    while (retained.some((product) => product.id === candidateId)) candidateId += "_";
    collect({ ...proposed, id: candidateId, color: proposed.color || "mint" }, true);
  }

  const items = [...groups.values()]
    .map((group): SafetyItem => {
      const supported = Object.hasOwn(ulReferences, group.key);
      const reference = validAge === null ? null : referenceForAge(group.key, validAge);
      // Known ingredients always display in the reference's unit, even when age
      // has not been supplied. Current, proposed and combined use the SAME unit.
      const standardUnit = ulReferences[group.key]?.[0]?.unit;
      const massUnit = standardUnit || ((group.combined.get("mass") ?? 0) >= 1000 ? "mg" : "μg");
      const display = (amounts: Amounts): UnitAmount[] =>
        [...amounts.entries()].map(([bucket, amount]) => ({
          amount: tidy(bucket === "mass" && massUnit === "mg" ? amount / 1000 : amount),
          unit: bucket === "mass" ? massUnit : bucket,
        }));
      const item: SafetyItem = {
        key: group.key,
        name: group.name,
        products: [...group.products.values()].map((product) => ({
          ...product,
          amounts: display(product.amounts),
        })),
        count: group.products.size,
        totals: display(group.combined),
        currentTotals: display(group.current),
        proposedTotals: display(group.proposed),
        currentIncomplete: group.currentIncomplete,
        proposedIncomplete: group.proposedIncomplete,
        status: "unknown",
        reference,
        message:
          "이 성분은 등록된 UL 비교 자료가 없어 판정할 수 없습니다. 안전하다는 뜻이 아닙니다.",
      };
      if (
        group.invalidAmount ||
        [...group.combined.values()].some((value) => !Number.isFinite(value))
      ) {
        item.message =
          "함량이 비어 있거나 유효하지 않아 전체 합계와 UL을 비교할 수 없습니다. 제품의 하루 섭취분 표시를 확인해주세요.";
      } else if (requiresForm(group.key)) {
        item.status = "form_required";
        item.message =
          "화학형태·영양소 자체 함량·당량(예: RAE, DFE, NE) 확인이 필요하여 UL을 판정하지 않습니다. 표시된 단순 질량 합계는 영양학적 환산값이 아닙니다.";
      } else if (supported && validAge === null) {
        item.status = "age_required";
        item.message =
          "연령별 UL 비교를 위해 만 나이(1–120세)를 설정해주세요. 나이가 없으면 성인 기준을 임의로 적용하지 않습니다.";
      } else if (
        (supported || Object.hasOwn(noULSources, group.key)) &&
        (group.combined.size !== 1 || !group.combined.has("mass"))
      ) {
        item.status = "unit_mismatch";
        item.message =
          "표시 단위를 UL 기준 단위로 환산할 근거가 없어 비교할 수 없습니다. IU 환산은 비타민 D에만 적용하며 다른 단위는 따로 표시합니다.";
      } else if (reference) {
        const total = (group.combined.get("mass") ?? 0) / (reference.unit === "mg" ? 1000 : 1);
        // Display rounding is never used in the comparison. The small tolerance
        // covers only IEEE-754 noise, not label rounding or a clinical margin.
        const exceeds =
          total - reference.value > Number.EPSILON * Math.max(1, total, reference.value) * 8;
        item.status = exceeds ? "exceeds" : "within";
        item.message = exceeds
          ? "등록된 하루분 합계가 이 연령의 미국 FNB UL을 초과합니다. 개인의 위험도·치료 필요성을 뜻하지 않으며, 제품 표시와 실제 섭취량을 확인하고 필요하면 전문가와 상의하세요."
          : "등록된 하루분 합계는 이 연령의 미국 FNB UL 이하입니다. 권장 섭취량이나 개인별 안전 보장이 아니며, 식사·미등록 제품·개인 상태는 반영하지 않습니다.";
        if (reference.scope === "보충제·의약품 유래 섭취량") {
          item.message +=
            " 이 기준은 보충제·의약품 유래 마그네슘에만 적용하며 식품 속 마그네슘은 제외합니다.";
        }
      } else if (Object.hasOwn(noULSources, group.key)) {
        item.status = "no_ul";
        item.evidence = { ...noULSources[group.key] };
        item.message =
          "미국 FNB의 UL이 설정되지 않은 성분입니다. 초과 여부를 수치로 판단할 수 없으며, 무제한 섭취나 개인별 안전을 의미하지 않습니다.";
      }
      return item;
    })
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));

  return { age: validAge, items, hasExceedance: items.some((item) => item.status === "exceeds") };
}
