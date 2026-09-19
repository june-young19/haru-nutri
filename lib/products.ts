import { ingredientCatalog, normalizeIngredient } from "./domain";
import type { Ingredient } from "./types";

export const productSource = "식품의약품안전처 · 식품안전나라 I0030";
export const productSourceUrl = "https://www.foodsafetykorea.go.kr/api/openApiInfo.do?svc_no=I0030";

/** Public, key-free product data. Amounts in ingredients are DAILY label amounts only. */
export interface Product {
  id: string;
  reportNumber: string;
  name: string;
  manufacturer: string;
  intakeMethod: string;
  dailyIntakeText: string;
  functionality: string;
  precautions: string;
  rawStandards: string;
  rawMaterials: string;
  ingredients: Ingredient[];
  declaredNutrients: string[];
  dailyFrequency: number | null;
  parseStatus: "complete" | "partial" | "unavailable";
  issues: string[];
  sourceUrl: string;
  updatedAt: string | null;
  productionEnded: boolean;
}

export interface ProductSearchResult {
  products: Product[];
  total: number;
  partial: boolean;
  source: string;
  notice: string;
  page: number;
  query: string;
  hasMore: boolean;
}

export type OfficialProductRow = Record<string, unknown>;
const knownNames = new Set<string>([
  ...ingredientCatalog,
  "엽산 (folic acid)",
  "레티놀",
  "베타카로틴",
  "니코틴산",
  "니코틴아미드",
  "알파토코페롤",
  "구리",
  "망간",
  "몰리브덴",
  "크롬",
  "요오드",
  "인",
  "칼륨",
]);

function text(value: unknown, max = 4_000): string {
  if (typeof value !== "string") return "";
  return value
    .slice(0, max)
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\r\n?/g, "\n")
    .trim();
}

/** Functional indicator names, not a substring search over excipients or raw materials. */
export function normalizeProductNutrient(value: string): string {
  const name = value.normalize("NFKC").trim();
  const compact = name.replace(/[\s\-]/g, "").toLowerCase();
  if (
    ["epa및dha함유유지", "epa와dha의합", "epa+dha", "오메가3지방산함유유지제품"].includes(compact)
  )
    return "오메가3";
  if (compact === "셀렌") return "셀레늄";
  const canonical = normalizeIngredient(name);
  return knownNames.has(canonical) ? canonical : name;
}

function splitDeclarations(value: string): string[] {
  const pieces: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") depth++;
    if (value[i] === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && /[,;\n]/.test(value[i])) {
      pieces.push(value.slice(start, i));
      start = i + 1;
    }
  }
  pieces.push(value.slice(start));
  return pieces
    .map((piece) => normalizeProductNutrient(piece))
    .filter(Boolean)
    .slice(0, 60);
}

const number = "(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?";
const amountPattern = new RegExp(`^(${number})\\s*(μg|µg|ug|mcg|mg|g|IU)$`, "i");
type Amount = { amount: number; unit: string };
function amount(value: string): Amount | null {
  const match = value.normalize("NFKC").trim().match(amountPattern);
  if (!match) return null;
  const parsed = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 10_000_000) return null;
  const unit = match[2].toLowerCase();
  return {
    amount: parsed,
    unit: ["μg", "µg", "ug", "mcg"].includes(unit) ? "μg" : unit === "iu" ? "IU" : unit,
  };
}
function mass(value: Amount): number | null {
  const factor =
    value.unit === "g" ? 1_000 : value.unit === "mg" ? 1 : value.unit === "μg" ? 0.001 : null;
  return factor === null ? null : value.amount * factor;
}

/** Reject alternatives/ranges rather than selecting the first apparent daily dose. */
function intakeBasis(value: string): {
  dailyMass: number | null;
  frequency: number | null;
  uncertain: boolean;
} {
  const normalized = value.normalize("NFKC");
  const frequencies = [...normalized.matchAll(/(?:1\s*일|일일|하루)\s*(\d+)\s*회/g)];
  const variable =
    new RegExp(
      `${number}\\s*(?:μg|µg|mg|g|ml|정|캡슐|캅셀|포|회)?\\s*(?:~|～|–|－|\\-|내지)\\s*${number}`,
      "i",
    ).test(normalized) ||
    /(?:원료로|원료용|적당량|필요에\s*따라|또는|혹은|성인|어린이|영유아|이상|이하|최대|최소)/.test(
      normalized,
    );
  const frequency =
    !variable && frequencies.length === 1 && +frequencies[0][1] >= 1 && +frequencies[0][1] <= 8
      ? +frequencies[0][1]
      : null;
  if (variable || frequencies.length > 1)
    return { dailyMass: null, frequency: null, uncertain: true };
  const explicit = [
    ...normalized.matchAll(
      new RegExp(
        `(?:1\\s*일|일일)\\s*섭취량\\s*[:：]?\\s*\\(?\\s*(${number}\\s*(?:μg|µg|mg|g))(?=\\s*(?:[(),.;]|[을를씩]|$))`,
        "gi",
      ),
    ),
  ];
  if (explicit.length === 1) {
    const parsed = amount(explicit[0][1]);
    return { dailyMass: parsed ? mass(parsed) : null, frequency, uncertain: false };
  }
  if (explicit.length > 1) return { dailyMass: null, frequency: null, uncertain: true };
  if (frequency === null) return { dailyMass: null, frequency, uncertain: false };
  const servings = [
    ...normalized.matchAll(
      new RegExp(
        `1\\s*회\\s*(${number})\\s*(정|캡슐|캅셀|포|병|스푼|정제)\\s*\\(\\s*(${number}\\s*(?:μg|µg|mg|g))\\s*\\)`,
        "gi",
      ),
    ),
  ];
  if (servings.length === 1) {
    // The parenthesized amount describes the complete "1회 N정(...)" serving.
    const parsed = amount(servings[0][3]);
    return {
      dailyMass: parsed ? (mass(parsed) ?? 0) * frequency : null,
      frequency,
      uncertain: false,
    };
  }
  const direct = [
    ...normalized.matchAll(
      new RegExp(`1\\s*회\\s*(${number}\\s*(?:μg|µg|mg|g))(?=\\s|[을를씩.,]|$)`, "gi"),
    ),
  ];
  const parsed = direct.length === 1 ? amount(direct[0][1]) : null;
  return {
    dailyMass: parsed ? (mass(parsed) ?? 0) * frequency : null,
    frequency,
    uncertain: false,
  };
}

function standardsLines(value: string): string[] {
  return value
    .replace(/[①-⑳]/g, "\n")
    .replace(/(^|\s)\(\d{1,2}\)\s*/g, "\n")
    .replace(/(^|\s)\d{1,2}[.)]\s+/g, "\n")
    .normalize("NFKC")
    .split(/[\n;]/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * I0030 STDR_STND is a specification, NOT a ready-made daily nutrition table.
 * Accept only an exact nutrient label + an explicit 표시량 numerator and a
 * denominator linked to the stated daily serving. Tolerances/contaminant limits
 * and activity-equivalent units never become ordinary mass amounts.
 * Source: https://www.foodsafetykorea.go.kr/api/openApiInfo.do?svc_no=I0030
 */
export function parseOfficialProduct(row: OfficialProductRow): Product | null {
  const reportNumber = text(row.PRDLST_REPORT_NO, 40);
  const name = text(row.PRDLST_NM, 200);
  if (!/^\d{6,30}$/.test(reportNumber) || !name) return null;
  const intakeMethod = text(row.NTK_MTHD);
  const rawStandards = text(row.STDR_STND, 24_000);
  const rawMaterials = text(row.RAWMTRL_NM, 8_000);
  const declared = new Set(splitDeclarations(rawMaterials));
  const basis = intakeBasis(intakeMethod);
  const parsed = new Map<string, Ingredient>();
  const seenLabels = new Set<string>();
  const ambiguous = new Set<string>();
  const issues: string[] = [];
  const rawOnly = /(?:건강기능식품\s*)?원료로\s*사용|원료용/.test(intakeMethod);
  for (const line of standardsLines(rawStandards)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const label = normalizeProductNutrient(line.slice(0, colon).trim());
    // Do not turn metal-contamination limits, disintegration times or microbial
    // counts into nutrition. Unknown functional indicators stay declared-only.
    if (!knownNames.has(label)) continue;
    declared.add(label);
    // A second conflicting/unparseable occurrence is still ambiguous. Never
    // keep the first amount merely because later occurrences failed parsing.
    if (seenLabels.has(label)) ambiguous.add(label);
    seenLabels.add(label);
    const details = line.slice(colon + 1);
    const labels = [...details.matchAll(/표시량\s*\(([^()]*)\)/g)];
    if (labels.length !== 1 || rawOnly || basis.uncertain) continue;
    const parts = labels[0][1].split("/");
    if (parts.length !== 2) continue;
    const numerator = amount(parts[0]);
    if (!numerator) continue;
    let multiplier: number | null = null;
    if (/^(?:1\s*일|일일)\s*섭취량(?:당)?$/.test(parts[1].trim())) multiplier = 1;
    else {
      const denominator = amount(parts[1]);
      const denominatorMass = denominator ? mass(denominator) : null;
      if (basis.dailyMass !== null && denominatorMass !== null && denominatorMass > 0)
        multiplier = basis.dailyMass / denominatorMass;
    }
    if (multiplier === null) continue;
    const dailyAmount = Number((numerator.amount * multiplier).toPrecision(12));
    if (!Number.isFinite(dailyAmount) || dailyAmount <= 0 || dailyAmount > 10_000_000) continue;
    if (parsed.has(label)) {
      ambiguous.add(label);
      continue;
    }
    parsed.set(label, { name: label, amount: dailyAmount, unit: numerator.unit });
  }
  for (const label of ambiguous) parsed.delete(label);
  const ingredients = [...parsed.values()];
  const declaredNutrients = [...declared].slice(0, 60);
  if (rawOnly)
    issues.push("섭취용 완제품이 아닌 원료용 신고 정보입니다. 제품 표시사항을 확인해주세요.");
  if (ambiguous.size)
    issues.push("같은 성분의 표시량이 여러 번 나타나 자동 함량 입력에서 제외했습니다.");
  if (basis.dailyMass === null && ingredients.length === 0)
    issues.push("기준규격의 기준량과 1일 섭취량을 연결할 수 없어 함량을 직접 입력해야 합니다.");
  const missing = declaredNutrients.filter((nutrient) => !parsed.has(nutrient));
  if (missing.length)
    issues.push(
      "일부 성분 정보는 자동으로 확인할 수 없습니다. 제품 표시사항을 확인하여 직접 입력해주세요.",
    );
  if (!declaredNutrients.length)
    issues.push("공식 데이터에 확인 가능한 기능지표 성분 정보가 없습니다.");
  if (!rawMaterials)
    issues.push("공식 기능지표 성분 목록이 없어 성분 정보의 완전성을 확인할 수 없습니다.");
  const truncated =
    (typeof row.STDR_STND === "string" && row.STDR_STND.length > 24_000) ||
    (typeof row.RAWMTRL_NM === "string" && row.RAWMTRL_NM.length > 8_000);
  if (truncated)
    issues.push("공식 성분 설명이 길어 일부만 표시했습니다. 전체 제품 표시사항을 확인해주세요.");
  const parseStatus =
    ingredients.length === 0
      ? "unavailable"
      : missing.length || ambiguous.size || !rawMaterials || truncated
        ? "partial"
        : "complete";
  const updated = text(row.LAST_UPDT_DTM, 40);
  return {
    id: reportNumber,
    reportNumber,
    name,
    manufacturer: text(row.BSSH_NM, 200),
    intakeMethod,
    dailyIntakeText: intakeMethod,
    functionality: text(row.PRIMARY_FNCLTY, 8_000),
    precautions: text(row.IFTKN_ATNT_MATR_CN, 8_000),
    rawStandards,
    rawMaterials,
    ingredients,
    declaredNutrients,
    dailyFrequency: basis.frequency,
    parseStatus,
    issues,
    sourceUrl: productSourceUrl,
    updatedAt: updated || null,
    productionEnded: /^(?:예|네|종료|생산종료|y|yes|1)$/i.test(text(row.PRODUCTION, 40)),
  };
}

/** These are product-NAME search hints, not upstream ingredient filters. */
export function interestSearchTerms(interests: string[]): string[] {
  const terms = new Set<string>();
  for (const interest of interests) {
    const name = normalizeProductNutrient(interest);
    if (/^비타민|^엽산|레티놀|베타카로틴|니코틴|토코페롤/.test(name)) terms.add("비타민");
    else if (name === "오메가3") terms.add("오메가");
    else if (name === "철") terms.add("철분");
    else if (name === "인") terms.add("미네랄");
    else if (knownNames.has(name)) terms.add(name);
  }
  if (terms.size === 0) return [];
  if (interests.length > 1 && terms.size < 4) terms.add("멀티");
  if (interests.length > 1 && terms.size < 4) terms.add("종합");
  return [...terms].slice(0, 4);
}
