import type { DayHistory, DuplicateGroup, Supplement, SurveyResult, UnitAmount } from "./types";

export const ingredientCatalog = [
  "비타민 A",
  "비타민 B1",
  "비타민 B2",
  "비타민 B3",
  "비타민 B5",
  "비타민 B6",
  "비타민 B7",
  "비타민 B9",
  "비타민 B12",
  "비타민 B군",
  "비타민 C",
  "비타민 D",
  "비타민 E",
  "비타민 K",
  "마그네슘",
  "오메가3",
  "아연",
  "칼슘",
  "철",
  "셀레늄",
] as const;

function compact(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s\-‐‑–—]+/g, "");
}

const aliases: Record<string, string> = {
  magnesium: "마그네슘",
  omega3: "오메가3",
  ω3: "오메가3",
  zinc: "아연",
  calcium: "칼슘",
  iron: "철",
  철분: "철",
  selenium: "셀레늄",
  thiamin: "비타민 B1",
  thiamine: "비타민 B1",
  티아민: "비타민 B1",
  riboflavin: "비타민 B2",
  리보플라빈: "비타민 B2",
  niacin: "비타민 B3",
  나이아신: "비타민 B3",
  판토텐산: "비타민 B5",
  pantothenicacid: "비타민 B5",
  pyridoxine: "비타민 B6",
  피리독신: "비타민 B6",
  biotin: "비타민 B7",
  비오틴: "비타민 B7",
  // Folic acid and food folate have different DFE relationships. Keep explicit
  // chemical forms separate rather than treating their raw masses as equivalent.
  folicacid: "엽산 (folic acid)",
  폴산: "엽산 (folic acid)",
  "엽산(folicacid)": "엽산 (folic acid)",
  folate: "비타민 B9",
  엽산: "비타민 B9",
  retinol: "레티놀",
  레티놀: "레티놀",
  betacarotene: "베타카로틴",
  βcarotene: "베타카로틴",
  베타카로틴: "베타카로틴",
  nicotinicacid: "니코틴산",
  니코틴산: "니코틴산",
  nicotinamide: "니코틴아미드",
  niacinamide: "니코틴아미드",
  나이아신아미드: "니코틴아미드",
  니코틴아미드: "니코틴아미드",
  alphatocopherol: "알파토코페롤",
  αtocopherol: "알파토코페롤",
  알파토코페롤: "알파토코페롤",
  cobalamin: "비타민 B12",
  코발라민: "비타민 B12",
  bcomplex: "비타민 B군",
  vitaminbcomplex: "비타민 B군",
  vitaminb: "비타민 B군",
  비타민b: "비타민 B군",
  비타민b군: "비타민 B군",
  비타민b복합체: "비타민 B군",
};

for (const name of ingredientCatalog) aliases[compact(name)] = name;
for (const vitamin of ["a", "b1", "b2", "b3", "b5", "b6", "b7", "b9", "b12", "c", "d", "e", "k"]) {
  aliases[`vitamin${vitamin}`] = `비타민 ${vitamin.toUpperCase()}`;
  aliases[`vit${vitamin}`] = `비타민 ${vitamin.toUpperCase()}`;
}
// D2/D3 are forms of vitamin D. Do not extend this to generic IU conversions.
for (const form of ["d2", "d3"]) {
  aliases[`비타민${form}`] = "비타민 D";
  aliases[`vitamin${form}`] = "비타민 D";
  aliases[`vit${form}`] = "비타민 D";
}

/** A common display name for known ingredients, a compact key for unknown labels. */
export function normalizeIngredient(name: string): string {
  const key = compact(name);
  return Object.hasOwn(aliases, key) ? aliases[key] : key;
}

export function normalizedUnit(unit: string): { bucket: string; factor: number } {
  const key = compact(unit).replace(/µ/g, "μ");
  if (["μg", "ug", "mcg", "마이크로그램"].includes(key)) return { bucket: "mass", factor: 1 };
  if (["mg", "밀리그램"].includes(key)) return { bucket: "mass", factor: 1_000 };
  if (["g", "그램"].includes(key)) return { bucket: "mass", factor: 1_000_000 };
  if (["iu", "국제단위"].includes(key)) return { bucket: "IU", factor: 1 };
  return { bucket: key || "단위 미입력", factor: 1 };
}

const rounded = (value: number) => Number(value.toPrecision(12));

/**
 * Ingredient overlap is a label comparison, never a judgment about safety.
 * Daily amounts are summed once per product; reminders do not multiply them.
 * Activity-based units (IU, mg NE, μg DFE, etc.) stay in distinct buckets.
 */
export function duplicateGroups(supplements: Supplement[]): DuplicateGroup[] {
  type Product = { id: string; name: string; color: string; buckets: Map<string, number> };
  const groups = new Map<string, { name: string; products: Map<string, Product> }>();
  for (const supplement of supplements) {
    for (const ingredient of supplement.ingredients) {
      const key = normalizeIngredient(ingredient.name);
      if (!key || !Number.isFinite(ingredient.amount) || ingredient.amount < 0) continue;
      let group = groups.get(key);
      if (!group) {
        group = {
          name: Object.hasOwn(aliases, compact(ingredient.name))
            ? aliases[compact(ingredient.name)]
            : ingredient.name.trim(),
          products: new Map(),
        };
        groups.set(key, group);
      }
      let product = group.products.get(supplement.id);
      if (!product) {
        product = {
          id: supplement.id,
          name: supplement.name,
          color: supplement.color,
          buckets: new Map(),
        };
        group.products.set(supplement.id, product);
      }
      const { bucket, factor } = normalizedUnit(ingredient.unit);
      product.buckets.set(bucket, (product.buckets.get(bucket) ?? 0) + ingredient.amount * factor);
    }
  }
  return [...groups.entries()]
    .filter(([, group]) => group.products.size > 1)
    .map(([key, group]) => {
      const totals = new Map<string, number>();
      for (const product of group.products.values()) {
        for (const [bucket, amount] of product.buckets)
          totals.set(bucket, (totals.get(bucket) ?? 0) + amount);
      }
      // All product rows use the same mass unit as their group's total.
      const useMg = (totals.get("mass") ?? 0) >= 1_000;
      const display = (buckets: Map<string, number>): UnitAmount[] =>
        [...buckets].map(([bucket, amount]) => ({
          amount: rounded(bucket === "mass" && useMg ? amount / 1_000 : amount),
          unit: bucket === "mass" ? (useMg ? "mg" : "μg") : bucket,
        }));
      return {
        key,
        name: group.name,
        count: group.products.size,
        products: [...group.products.values()].map(({ buckets, ...product }) => ({
          ...product,
          amounts: display(buckets),
        })),
        totals: display(totals),
        incompatibleUnits: totals.size > 1,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));
}

export const surveyQuestions = [
  {
    id: "sunlight",
    title: "평소 바깥에서 햇빛을 접하나요?",
    hint: "일상적인 야외 활동을 떠올려 주세요. 햇빛 노출을 늘리라는 의미는 아니에요.",
    options: ["자주 그래요", "가끔 그래요", "거의 없어요"],
  },
  {
    id: "meals",
    title: "식사를 규칙적으로 하나요?",
    hint: "최근 2주 동안의 식사 습관을 기준으로 답해 주세요.",
    options: ["대체로 규칙적이에요", "가끔 거르는 편이에요", "불규칙한 편이에요"],
  },
  {
    id: "produce",
    title: "채소와 과일을 자주 먹나요?",
    hint: "평소 식탁에 채소와 과일이 얼마나 자주 있는지 떠올려 보세요.",
    options: ["자주 먹어요", "가끔 먹어요", "거의 안 먹어요"],
  },
  {
    id: "fish",
    title: "생선을 자주 먹나요?",
    hint: "고등어, 연어 등 생선이 포함된 식사를 떠올려 주세요.",
    options: ["자주 먹어요", "가끔 먹어요", "거의 안 먹어요"],
  },
  {
    id: "fatigue",
    title: "최근 피로감을 자주 느끼나요?",
    hint: "피로감에는 다양한 원인이 있어요. 이 답변으로 영양 상태를 판단하지 않아요.",
    options: ["자주 느껴요", "가끔 느껴요", "거의 없어요"],
  },
  {
    id: "exercise",
    title: "규칙적으로 운동하나요?",
    hint: "산책을 포함해 몸을 움직이는 일상 습관을 돌아보세요.",
    options: ["규칙적으로 해요", "가끔 해요", "거의 안 해요"],
  },
  {
    id: "sleep",
    title: "수면 시간이 규칙적인가요?",
    hint: "잠드는 시간과 일어나는 시간이 일정한지 떠올려 보세요.",
    options: ["대체로 규칙적이에요", "가끔 달라져요", "불규칙한 편이에요"],
  },
] as const;

/**
 * Transparent editorial matching for education, not a validated clinical screen.
 * 0/1/2 = often/sometimes/rarely; fatigue has the opposite direction.
 * Exercise and sleep invite reflection only and do not diagnose nutrient needs.
 */
export function surveyResults(answers: number[]): SurveyResult[] {
  if (
    answers.length !== surveyQuestions.length ||
    answers.some((answer) => !Number.isInteger(answer) || answer < 0 || answer > 2)
  )
    return [];
  const results: SurveyResult[] = [];
  if (answers[0] >= 1)
    results.push({
      name: "비타민 D",
      reason:
        "야외 활동 항목을 바탕으로 비타민 D에 관한 참고 자료를 골랐어요. 답변만으로 영양 상태나 필요한 섭취량을 알 수는 없어요.",
      food: "연어·고등어 같은 생선과 비타민 D가 강화된 식품의 표시를 살펴볼 수 있어요.",
      sourceUrl: "https://ods.od.nih.gov/factsheets/VitaminD-Consumer/",
    });
  if (answers[1] >= 1 || answers[4] === 0)
    results.push({
      name: "비타민 B군",
      reason:
        "식사 또는 피로 항목을 돌아보는 참고 자료예요. 피로감만으로 특정 영양소 상태를 알 수 없으며, B군의 각 성분은 서로 달라요.",
      food: "B군마다 식품 공급원이 달라요. 예를 들어 B12는 생선·육류·달걀·유제품 등에 들어 있어요.",
      sourceUrl: "https://ods.od.nih.gov/factsheets/VitaminB12-Consumer/",
    });
  if (answers[2] >= 1)
    results.push({
      name: "마그네슘",
      reason:
        "채소와 과일 항목을 계기로, 다양한 식품에서 마그네슘을 어떻게 접할 수 있는지 살펴보세요. 이는 섭취 필요성에 대한 판단이 아니에요.",
      food: "콩류·견과류·통곡물·녹색 잎채소 등에 들어 있어요.",
      sourceUrl: "https://ods.od.nih.gov/factsheets/Magnesium-Consumer/",
    });
  if (answers[3] >= 1)
    results.push({
      name: "오메가3",
      reason:
        "생선 섭취 항목을 바탕으로 오메가3의 식품 공급원을 살펴보도록 안내해요. 제품을 추가하기 전에 평소 식사를 함께 확인해 보세요.",
      food: "생선에는 EPA·DHA가, 호두·아마씨 등에는 ALA가 들어 있어요. 오메가3의 종류를 구분해 제품 표시를 확인해 보세요.",
      sourceUrl: "https://ods.od.nih.gov/factsheets/Omega3FattyAcids-Consumer/",
    });
  return results;
}

/** YYYY-MM-DD for a fixed time zone, independent of the browser/server locale. */
export function dateKey(now: Date = new Date(), timezone = "Asia/Seoul"): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function today(timezone = "Asia/Seoul", now: Date = new Date()): string {
  return dateKey(now, timezone);
}

export function addDays(date: string, offset: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    Number.isNaN(value.valueOf()) ||
    value.toISOString().slice(0, 10) !== date ||
    !Number.isInteger(offset)
  ) {
    throw new Error("유효한 날짜와 정수 일수 차이가 필요합니다.");
  }
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

export function completionRate(completed: number, total: number): number {
  if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.round((Math.max(0, Math.min(completed, total)) / total) * 100);
}

/** Today may still be in progress; yesterday's streak remains until the day ends. */
export function calculateStreak(
  days: Pick<DayHistory, "date" | "completed" | "total">[],
  todayDate: string,
): number {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const isComplete = (date: string) => {
    const day = byDate.get(date);
    return !!day && day.total > 0 && day.completed >= day.total;
  };
  let cursor = isComplete(todayDate) ? todayDate : addDays(todayDate, -1);
  let count = 0;
  while (isComplete(cursor)) {
    count++;
    cursor = addDays(cursor, -1);
  }
  return count;
}
