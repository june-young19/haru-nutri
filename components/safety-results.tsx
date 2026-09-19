import Link from "next/link";
import { FlaskConical, Info } from "lucide-react";
import type { SafetyAnalysis } from "@/lib/safety";
import type { UnitAmount } from "@/lib/types";

const labels = {
  within: "참고 상한선 이내",
  exceeds: "참고 상한선 초과",
  no_ul: "공식 상한선 없음",
  unknown: "기준 확인 불가",
  unit_mismatch: "단위 문제로 비교 불가",
  age_required: "나이 입력 필요",
  form_required: "형태·별도 기준 확인 필요",
};
function amountText(amounts: UnitAmount[], incomplete = false) {
  return amounts.length
    ? amounts
        .map((a) => `${a.amount.toLocaleString("ko-KR", { maximumFractionDigits: 6 })}${a.unit}`)
        .join(" / ") + (incomplete ? " + 미확인 함량" : "")
    : incomplete
      ? "함량 미확인"
      : "0";
}

/** Uses the same server-computed analysis on the overview and before saving. */
export function SafetyResults({
  analysis,
  preview = false,
}: {
  analysis: SafetyAnalysis;
  preview?: boolean;
}) {
  return (
    <div className="safety-results">
      <div className="result-summary">
        <FlaskConical size={21} />
        <span>
          {analysis.age === null ? "등록 나이 없음" : `등록 만 나이 ${analysis.age}세`} ·{" "}
          {analysis.items.length}가지 성분 · 중복 {analysis.items.filter((i) => i.count > 1).length}
          가지
        </span>
      </div>
      {analysis.age === null && (
        <div className="alert info">
          <Link href="/settings">설정에서 나이를 입력하면</Link> 연령별 참고 상한선과 비교할 수
          있어요. 기존 계정의 나이는 임의로 추정하지 않습니다.
        </div>
      )}
      <div className="notice">
        <Info size={18} />
        <span>
          등록된 영양제의 하루 함량만 합산합니다. 음식·다른 보충제·의약품은 포함하지 않으며 실제
          복용 완료량과도 다릅니다. ‘참고 상한선 이내’는 개인의 의학적 안전성이나 적정량을 보장하지
          않습니다. 상한선은 목표 섭취량이 아닙니다.
        </span>
      </div>
      <div className={preview ? "safety-preview-grid" : "duplicate-grid"}>
        {analysis.items.map((item) => (
          <section
            key={item.key}
            className={`card duplicate-card safety-card ${item.status === "exceeds" ? "safety-exceeds" : ""}`}
          >
            <div className="section-title">
              <h2>{item.name}</h2>
              <span
                className={`badge ${item.status === "exceeds" ? "amber-badge" : item.status === "within" ? "blue-badge" : ""}`}
              >
                {labels[item.status]}
              </span>
            </div>
            <p className={`safety-count ${item.count > 1 ? "has-duplicate" : ""}`}>
              {item.count > 1 ? `중복 성분 있음 · ${item.count}개 제품에 포함` : "1개 제품에 포함"}
            </p>
            <div className="duplicate-products">
              {item.products.map((product) => (
                <div key={product.id}>
                  <span className="safety-product-name">{product.name}</span>
                  <strong>{amountText(product.amounts, !product.amounts.length)}</strong>
                </div>
              ))}
            </div>
            {preview && (
              <div className="safety-comparison">
                <div>
                  <span>현재 등록량</span>
                  <strong>{amountText(item.currentTotals, item.currentIncomplete)}</strong>
                </div>
                <div>
                  <span>추가·교체 예정</span>
                  <strong>{amountText(item.proposedTotals, item.proposedIncomplete)}</strong>
                </div>
              </div>
            )}
            <div className="duplicate-total">
              <span>
                {item.currentIncomplete || item.proposedIncomplete
                  ? "확인 가능한 부분합"
                  : preview
                    ? "등록 후 총량"
                    : "등록된 영양제 기준 총량"}
              </span>
              <strong>
                {amountText(item.totals, item.currentIncomplete || item.proposedIncomplete)}
              </strong>
            </div>
            {item.reference && (
              <div className="safety-reference">
                <span>
                  연령 구간 {item.reference.ageMin}~{item.reference.ageMax}세
                </span>
                <strong>
                  참고 상한섭취량 {item.reference.value.toLocaleString("ko-KR")}
                  {item.reference.unit} / 일
                </strong>
              </div>
            )}
            <p className="field-help">{item.message}</p>
            {item.status === "exceeds" && (
              <p className="safety-warning">
                등록된 영양제 기준 총량이 해당 연령대 참고 상한섭취량을 초과합니다. 실제 복용
                적절성은 개인 상태에 따라 달라질 수 있으므로 전문가 확인을 권장합니다.
              </p>
            )}
            {item.reference && (
              <details className="safety-source">
                <summary>기준 출처 · 적용 범위 확인</summary>
                <p>
                  <a href={item.reference.sourceUrl} target="_blank" rel="noreferrer">
                    {item.reference.sourceTitle} ↗
                  </a>
                  <br />
                  기준 버전: {item.reference.version}
                </p>
                <p>{item.reference.scope}</p>
                <p>{item.reference.notes}</p>
              </details>
            )}
            {!item.reference && item.evidence && (
              <details className="safety-source">
                <summary>상한선 미설정 근거 확인</summary>
                <p>
                  <a href={item.evidence.sourceUrl} target="_blank" rel="noreferrer">
                    {item.evidence.sourceTitle} ↗
                  </a>
                  <br />
                  기준 버전: {item.evidence.version}
                </p>
                <p>{item.evidence.notes}</p>
              </details>
            )}
          </section>
        ))}
      </div>
      <p className="field-help">
        미국 NIH ODS가 제공하는 FNB 식이섭취기준을 참고합니다. 한국 기준과 다를 수 있습니다.
        g·mg·μg(mcg)은 질량으로 환산하며 IU는 공식 환산 근거가 있는 비타민 D만 비교합니다. 성분의
        화학 형태나 단위가 불명확하면 자동 판정하지 않습니다.
      </p>
    </div>
  );
}
