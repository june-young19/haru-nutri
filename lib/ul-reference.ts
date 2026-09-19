/**
 * Reviewed NIH ODS tables reporting the U.S. Food and Nutrition Board (FNB) ULs.
 * This is a versioned reference snapshot, not a dosing recommendation.
 * References were checked on 2026-09-19. Only ages 1–120 are supported by the app.
 * The source's adult open-ended bands are capped at 120 for input validation.
 */
export interface ReferenceSource {
  sourceTitle: string;
  sourceUrl: string;
  /** Source page's published revision, distinct from this app's retrieval date. */
  version: string;
  year: number;
  reviewedAt: string;
  notes: string;
}

export interface ULReference extends ReferenceSource {
  ageMin: number;
  ageMax: number;
  value: number;
  unit: "mg" | "μg";
  scope: "식품·음료·보충제를 포함한 총섭취량" | "보충제·의약품 유래 섭취량";
  /** Preserve rounded source presentation separately from a precise comparison. */
  sourceDisplayValue?: number;
  sourceDisplayUnit?: "mg" | "μg";
  iuValue?: number;
}

const totalScope = "식품·음료·보충제를 포함한 총섭취량" as const;
const supplementScope = "보충제·의약품 유래 섭취량" as const;
const reviewedAt = "2026-09-19";
const totalNotes =
  "미국 FNB의 일반 인구 대상 UL입니다. 등록한 제품의 하루분만 합산하며, 식사·음료·미등록 제품은 포함하지 않습니다. UL은 권장 섭취량이나 개인별 안전 보장이 아닙니다.";

function source(factSheet: string, title: string, version: string, notes: string): ReferenceSource {
  return {
    sourceTitle: `NIH ODS · ${title} (FNB 기준)`,
    sourceUrl: `https://ods.od.nih.gov/factsheets/${factSheet}/`,
    version,
    year: Number(version.slice(0, 4)),
    reviewedAt,
    notes,
  };
}

type Band = readonly [ageMin: number, ageMax: number, value: number];
function rows(
  sourceInfo: ReferenceSource,
  unit: ULReference["unit"],
  bands: readonly Band[],
  scope: ULReference["scope"] = totalScope,
): ULReference[] {
  return bands.map(([ageMin, ageMax, value]) => ({
    ...sourceInfo,
    ageMin,
    ageMax,
    value,
    unit,
    scope,
  }));
}

const vitaminDSource = source(
  "VitaminD-HealthProfessional",
  "Vitamin D · Table 4",
  "2025-06-27",
  `${totalNotes} 비타민 D만 1μg = 40IU로 환산합니다.`,
);

export const ulReferences: Readonly<Record<string, readonly ULReference[]>> = {
  "비타민 C": rows(
    source("VitaminC-Consumer", "Vitamin C · Upper Limits", "2021-03-22", totalNotes),
    "mg",
    [
      [1, 3, 400],
      [4, 8, 650],
      [9, 13, 1200],
      [14, 18, 1800],
      [19, 120, 2000],
    ],
  ),
  "비타민 D": [
    {
      ...vitaminDSource,
      ageMin: 1,
      ageMax: 3,
      value: 62.5,
      unit: "μg",
      scope: totalScope,
      sourceDisplayValue: 63,
      sourceDisplayUnit: "μg",
      iuValue: 2500,
      notes: `${vitaminDSource.notes} 1–3세 원문은 63μg(2,500IU)로 반올림 표기됩니다. 이 서비스는 2,500IU ÷ 40 = 62.5μg를 비교 기준으로 사용하여 2,500IU를 넘는 입력을 놓치지 않습니다.`,
    },
    {
      ...vitaminDSource,
      ageMin: 4,
      ageMax: 8,
      value: 75,
      unit: "μg",
      scope: totalScope,
      iuValue: 3000,
    },
    {
      ...vitaminDSource,
      ageMin: 9,
      ageMax: 120,
      value: 100,
      unit: "μg",
      scope: totalScope,
      iuValue: 4000,
    },
  ],
  칼슘: rows(
    source(
      "Calcium-Consumer",
      "Calcium · Upper Limits",
      "2023-09-14",
      `${totalNotes} 제품에 표시된 칼슘 자체의 함량을 입력해야 하며, 탄산칼슘 등 화합물 전체의 질량을 입력하면 비교할 수 없습니다.`,
    ),
    "mg",
    [
      [1, 8, 2500],
      [9, 18, 3000],
      [19, 50, 2500],
      [51, 120, 2000],
    ],
  ),
  철: rows(
    source(
      "Iron-Consumer",
      "Iron · Upper Limits",
      "2023-08-17",
      `${totalNotes} 철 자체의 표시 함량을 사용합니다. 전문가의 지시에 따른 치료 용량을 변경하는 근거로 사용하지 마세요.`,
    ),
    "mg",
    [
      [1, 13, 40],
      [14, 120, 45],
    ],
  ),
  아연: rows(
    source(
      "Zinc-Consumer",
      "Zinc · Upper Limits",
      "2022-10-04",
      `${totalNotes} 원문은 의약품 유래 아연도 포함합니다. 아연 자체의 표시 함량을 입력하세요.`,
    ),
    "mg",
    [
      [1, 3, 7],
      [4, 8, 12],
      [9, 13, 23],
      [14, 18, 34],
      [19, 120, 40],
    ],
  ),
  셀레늄: rows(
    source(
      "Selenium-HealthProfessional",
      "Selenium · Table 3",
      "2025-09-04",
      `${totalNotes} 이 표는 미국 FNB 기준입니다. 같은 NIH 자료에 소개된 유럽 EFSA 2023 기준(성인 255μg/일 등)과 다르므로 국가·기관별 기준을 혼합하지 않습니다. 셀레늄 자체의 표시 함량을 사용하세요.`,
    ),
    "μg",
    [
      [1, 3, 90],
      [4, 8, 150],
      [9, 13, 280],
      [14, 120, 400],
    ],
  ),
  마그네슘: rows(
    source(
      "Magnesium-Consumer",
      "Magnesium · Upper Limits",
      "2021-03-22",
      "미국 FNB UL은 보충제와 의약품 유래 마그네슘에만 적용하며, 일반 식품·음료에 자연적으로 포함된 마그네슘은 제외합니다. 등록한 제품의 마그네슘 자체 함량만 합산하므로 미등록 보충제·약물은 별도로 확인해야 합니다. UL은 권장량이나 개인별 안전 보장이 아닙니다.",
    ),
    "mg",
    [
      [1, 3, 65],
      [4, 8, 110],
      [9, 120, 350],
    ],
    supplementScope,
  ),
};

/** Explicitly documented absence of an FNB UL, never equivalent to zero risk. */
export const noULSources: Readonly<Record<string, ReferenceSource>> = {
  "비타민 B12": source(
    "VitaminB12-HealthProfessional",
    "Vitamin B12 · Health Risks from Excessive Vitamin B12",
    "2025-07-02",
    "FNB는 비타민 B12의 UL을 설정하지 않았습니다. UL 미설정은 무제한 섭취가 적절하다는 뜻이 아니며 개인별 상태·약물 등을 판단하지 않습니다.",
  ),
  오메가3: source(
    "Omega3FattyAcids-HealthProfessional",
    "Omega-3 Fatty Acids · Safety of Omega-3s",
    "2025-08-22",
    "IOM/FNB는 오메가3의 UL을 설정하지 않았습니다. 다른 기관의 EPA·DHA 관련 안전성 평가 수치를 모든 오메가3의 UL로 사용하지 않습니다. UL 미설정은 안전 보장이 아닙니다.",
  ),
};

export function referenceForAge(name: string, age: number): ULReference | null {
  if (!Number.isInteger(age) || age < 1 || age > 120) return null;
  if (!Object.hasOwn(ulReferences, name)) return null;
  const reference = ulReferences[name]?.find((item) => age >= item.ageMin && age <= item.ageMax);
  return reference ? { ...reference } : null;
}
