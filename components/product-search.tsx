"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  LoaderCircle,
  Search,
} from "lucide-react";
import type { Product, ProductSearchResult } from "@/lib/products";
import type { RankResult, RankedProduct } from "@/lib/product-ranking";
import { SafetyResults } from "./safety-results";

type Request = <T>(
  path: string,
  body?: unknown,
  method?: string,
  signal?: AbortSignal,
) => Promise<T>;
const failureMessage = (error: unknown) =>
  error instanceof Error
    ? error.message
    : "현재 제품 정보를 불러올 수 없습니다. 직접 입력을 이용해주세요.";

export function ProductDetails({ product }: { product: Product }) {
  return (
    <div className="product-details">
      <dl className="product-facts">
        {[
          ["제조사", product.manufacturer],
          ["품목제조 신고번호", product.reportNumber],
          ["섭취방법", product.intakeMethod],
          ["확인된 하루 섭취 기준", product.dailyIntakeText],
          ["기능성 정보 (공식 원문)", product.functionality],
          ["섭취 시 주의사항", product.precautions],
          ["공식 자료 수정일", product.updatedAt],
        ].map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value || "정보 없음 · 제품 표시사항 확인 필요"}</dd>
          </div>
        ))}
      </dl>
      <h4>자동 입력 가능한 하루 성분량</h4>
      {product.ingredients.length ? (
        <ul className="product-ingredients">
          {product.ingredients.map((item) => (
            <li key={item.name}>
              <span>{item.name}</span>
              <strong>
                {item.amount.toLocaleString("ko-KR", { maximumFractionDigits: 6 })}
                {item.unit}
              </strong>
            </li>
          ))}
        </ul>
      ) : (
        <p className="field-help">
          자동으로 확정할 수 있는 함량이 없습니다. 성분과 하루 함량을 직접 입력해 주세요.
        </p>
      )}
      {product.parseStatus !== "complete" && (
        <p className="safety-warning">
          일부 성분 정보는 자동으로 확인할 수 없습니다. 제품 표시사항을 확인하여 직접 입력해주세요.
        </p>
      )}
      {product.issues.length > 0 && (
        <ul className="product-issues">
          {product.issues.map((issue, i) => (
            <li key={i}>{issue}</li>
          ))}
        </ul>
      )}
      {product.productionEnded && (
        <p className="safety-warning">
          공식 데이터에 생산 종료로 표시된 제품입니다. 가지고 있는 제품의 표시사항을 확인해 주세요.
        </p>
      )}
      <details className="safety-source">
        <summary>공식 성분 정보와 기준규격 원문</summary>
        <p>기능지표 성분: {product.rawMaterials || "정보 없음"}</p>
        <p className="product-raw">{product.rawStandards || "기준규격 정보 없음"}</p>
        <p>기준규격의 허용 비율·검사 수치를 하루 섭취량으로 사용하지 않습니다.</p>
        <a href={product.sourceUrl} target="_blank" rel="noreferrer">
          식품안전나라 I0030 출처 <ExternalLink size={12} />
        </a>
      </details>
    </div>
  );
}

export function ProductSearch({
  request,
  onImport,
}: {
  request: Request;
  onImport: (product: Product) => void;
}) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<ProductSearchResult | null>(null);
  const [selected, setSelected] = useState<Product | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    const report = new URLSearchParams(window.location.search).get("product");
    const controller = new AbortController();
    if (report && /^\d{1,30}$/.test(report)) {
      setBusy(true);
      request<Product>(
        `/products/${encodeURIComponent(report)}`,
        undefined,
        undefined,
        controller.signal,
      )
        .then(setSelected)
        .catch((error) => {
          if (!controller.signal.aborted) setError(failureMessage(error));
        })
        .finally(() => {
          if (!controller.signal.aborted) setBusy(false);
        });
    }
    return () => {
      controller.abort();
      pending.current?.abort();
    };
  }, [request]);
  async function search(page = 1) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setError("");
    setSelected(null);
    setConfirmed(false);
    try {
      const next = await request<ProductSearchResult>(
        `/products/search?q=${encodeURIComponent(query.trim())}&page=${page}`,
        undefined,
        undefined,
        controller.signal,
      );
      if (!controller.signal.aborted) {
        setResult(next);
        setQuery(next.query);
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setResult(null);
        setError(failureMessage(error));
      }
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    void search();
  }
  return (
    <section className="card product-search">
      <h2>
        <Search size={21} />
        공식 제품 정보 검색
      </h2>
      <p className="section-description">
        식품안전나라에 신고된 국내 건강기능식품을 찾아요. 현재 자동 검색은 건강기능식품을 대상으로
        지원합니다.
      </p>
      <form className="product-search-form" onSubmit={submit}>
        <label>
          제품명
          <input
            type="search"
            placeholder="예: 비타민, 마그네슘"
            minLength={2}
            maxLength={80}
            required
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button className="button primary" disabled={busy}>
          {busy ? <LoaderCircle className="spin" size={18} /> : <Search size={18} />}검색
        </button>
      </form>
      {error && (
        <div className="alert error" role="alert">
          {error} <p>검색을 사용할 수 없어도 ‘직접 입력’으로 등록할 수 있습니다.</p>
        </div>
      )}
      {result && !selected && (
        <div aria-live="polite">
          <p className="field-help">
            {result.source} · 검색 결과 {result.total.toLocaleString("ko-KR")}건 · {result.page}
            페이지
          </p>
          {result.notice && <p className="field-help">{result.notice}</p>}
          {result.products.length === 0 ? (
            <p className="product-empty">
              검색 결과가 없습니다. 제품명을 짧게 입력하거나 직접 입력을 이용해 주세요. 일반
              의약품·처방약은 자동 검색 대상이 아닙니다.
            </p>
          ) : (
            <div className="product-list">
              {result.products.map((product) => (
                <button
                  className="product-result"
                  type="button"
                  key={product.id}
                  onClick={() => {
                    setSelected(product);
                    setConfirmed(false);
                  }}
                >
                  <span>
                    <strong>{product.name}</strong>
                    <small>
                      {product.manufacturer || "제조사 정보 없음"} · 신고번호 {product.reportNumber}
                    </small>
                    <small>
                      {product.productionEnded ? "생산 종료 표시 · " : ""}
                      {product.parseStatus === "complete"
                        ? "하루 성분량 자동 입력 가능"
                        : "성분·함량 확인 필요"}
                    </small>
                  </span>
                  <ChevronRight size={19} />
                </button>
              ))}
            </div>
          )}
          <div className="product-pagination">
            <button
              type="button"
              className="button secondary small"
              disabled={busy || result.page <= 1 || query.trim() !== result.query}
              onClick={() => void search(result.page - 1)}
            >
              <ChevronLeft size={16} />
              이전
            </button>
            <button
              type="button"
              className="button secondary small"
              disabled={busy || !result.hasMore || query.trim() !== result.query}
              onClick={() => void search(result.page + 1)}
            >
              다음
              <ChevronRight size={16} />
            </button>
          </div>
        </div>
      )}
      {selected && (
        <div className="selected-product" aria-live="polite">
          <span className="badge blue-badge">제품 정보 확인</span>
          <h3>{selected.name}</h3>
          <ProductDetails product={selected} />
          <label className="checkbox-label product-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            <span>
              내 제품의 이름·제조사·섭취방법을 확인했습니다. 자동 입력 후 성분과 하루 함량을 다시
              확인하겠습니다.
            </span>
          </label>
          <button
            type="button"
            className="button primary full"
            disabled={!confirmed || busy}
            onClick={() => onImport(selected)}
          >
            이 제품을 등록 양식에 불러오기
            <ArrowRight size={17} />
          </button>
          <p className="field-help">
            아직 저장되지 않습니다. 복용 시간을 정하고 성분 검사 결과를 확인한 뒤 등록해 주세요.
          </p>
          <button
            type="button"
            className="text-link"
            onClick={() => {
              setSelected(null);
              setConfirmed(false);
            }}
          >
            다른 제품 선택하기
          </button>
        </div>
      )}
    </section>
  );
}

export type ProductMatchesResponse = RankResult & {
  interests: string[];
  source: string;
  notice: string;
  total: number;
  partial: boolean;
};

function Candidate({ item, interestCount }: { item: RankedProduct; interestCount: number }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <article
      className={`card product-candidate ${item.gate === "caution" ? "safety-exceeds" : ""}`}
    >
      <div className="section-title">
        <span className="badge blue-badge">
          관심 성분 {item.matched.length}/{interestCount} 일치
        </span>
        <span className="safety-count">일치도 {item.matchPercent}%</span>
      </div>
      <h3>{item.product.name}</h3>
      <p className="field-help">{item.product.manufacturer || "제조사 정보 없음"}</p>
      <div className="product-chips">
        {item.matched.map((name) => (
          <span key={name}>{name}</span>
        ))}
      </div>
      <dl className="candidate-facts">
        <div>
          <dt>기존 제품과 중복</dt>
          <dd>{item.overlap.length ? item.overlap.join(", ") : "확인된 성분 중 없음"}</dd>
        </div>
        <div>
          <dt>참고 상한선</dt>
          <dd>
            {item.exceeded.length
              ? `초과 항목: ${item.exceeded.map((value) => value.name).join(", ")}`
              : item.gate === "general"
                ? "등록 정보 기준 초과 항목 없음"
                : "현재 데이터만으로 전체 판단 불가"}
          </dd>
        </div>
        <div>
          <dt>하루 섭취</dt>
          <dd>
            {item.product.dailyFrequency
              ? `${item.product.dailyFrequency}회 (공식 섭취방법 기준)`
              : "횟수 직접 확인 필요"}
          </dd>
        </div>
      </dl>
      <ul className="product-reasons">
        {item.reasons.map((reason, index) => (
          <li key={index}>{reason}</li>
        ))}
      </ul>
      <div className="candidate-actions">
        <button
          type="button"
          className="button secondary small"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "상세 정보 접기" : "제품·성분 분석 보기"}
        </button>
        <Link
          className="button primary small"
          href={`/supplements/new?product=${encodeURIComponent(item.product.reportNumber)}`}
        >
          등록 전 확인
          <ArrowRight size={15} />
        </Link>
      </div>
      {expanded && (
        <>
          <ProductDetails product={item.product} />
          <SafetyResults analysis={item.analysis} preview />
        </>
      )}
    </article>
  );
}

export function ProductMatches({ request }: { request: Request }) {
  const [result, setResult] = useState<ProductMatchesResponse | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [limit, setLimit] = useState(12);
  const pending = useRef<AbortController | null>(null);
  async function load() {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const interest = new URLSearchParams(window.location.search).get("interest");
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const data = await request<ProductMatchesResponse>(
        `/products/matches${interest ? `?interest=${encodeURIComponent(interest)}` : ""}`,
        undefined,
        undefined,
        controller.signal,
      );
      if (!controller.signal.aborted) setResult(data);
    } catch (error) {
      if (!controller.signal.aborted) setError(failureMessage(error));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    void load();
    return () => pending.current?.abort();
  }, []);
  return (
    <div className="products-page">
      <Link href="/survey/results" className="back-link">
        <ChevronLeft size={16} />
        설문 결과로
      </Link>
      <div className="page-heading">
        <span className="eyebrow">EXPLORE YOUR INTERESTS</span>
        <h1>관심 성분 제품 찾기</h1>
        <p>설문 관심 성분과 일치하는 제품을 살펴보고, 기존 영양제와 함께 확인해요.</p>
      </div>
      <div className="notice">
        일치도는 관심 성분의 포함 비율이며 효과나 안전성을 뜻하지 않습니다. 실제 복용 적절성은 개인
        상태에 따라 다를 수 있습니다.
      </div>
      <div className="results-actions">
        <button className="button secondary" disabled={busy} onClick={() => void load()}>
          {busy ? <LoaderCircle className="spin" size={17} /> : <Search size={17} />}현재 등록
          정보로 다시 분석
        </button>
        <Link className="button secondary" href="/supplements/new">
          제품명 검색 · 직접 입력
        </Link>
      </div>
      {error && (
        <div className="alert error" role="alert">
          {error}
          <p>
            <Link href="/survey">설문 확인</Link> ·{" "}
            <Link href="/supplements/new">직접 입력으로 등록</Link>
          </p>
        </div>
      )}
      {busy && (
        <p role="status" className="product-empty">
          공식 제품 정보와 현재 영양제를 비교하고 있어요.
        </p>
      )}
      {result && (
        <>
          <div className="product-chips">
            {result.interests.map((name) => (
              <span key={name}>{name}</span>
            ))}
          </div>
          <p className="field-help">
            {result.source} · {result.notice}
          </p>
          {result.interests.includes("비타민 B군") && (
            <p className="field-help">
              비타민 B군은 관심 그룹입니다. 개별 B 성분 중 하나 이상 확인되면 1개 일치로 표시하며,
              전체 B군이 들어 있다는 뜻이 아닙니다. 함량과 상한선은 개별 성분으로 비교합니다.
            </p>
          )}
          <p className="field-help">
            각 그룹에서 관심 성분 수 → 기존 성분 중복이 적은 순 → 분석 가능한 정보 → 하루 섭취 횟수
            → 정보 완전성 순으로 정렬합니다. 일부 함량이 없으면 초과 없음으로 판정하지 않습니다.
          </p>
          {(
            [
              [
                "general",
                "일반 후보",
                "등록 정보에서 참고 상한선 초과가 확인되지 않은 후보입니다. 개인별 안전성 보장이 아닙니다.",
              ],
              [
                "needsReview",
                "추가 확인이 필요한 제품",
                "함량·단위·화학 형태 또는 공식 UL 자료가 부족해 전체 판단이 어려운 후보입니다.",
              ],
              [
                "caution",
                "참고 상한섭취량 확인이 필요한 제품",
                "현재 등록량과 합산 시 확인 가능한 성분이 참고 상한선을 초과합니다. 제품 표시와 실제 섭취량을 확인하고 필요하면 전문가와 상의하세요.",
              ],
            ] as const
          ).map(([key, title, description]) => (
            <section className="product-group" key={key}>
              <h2>
                {title}
                <span className="badge">{result[key].length}개</span>
              </h2>
              <p className="section-description">{description}</p>
              {result[key].length ? (
                <div className="product-candidate-grid">
                  {result[key].slice(0, limit).map((item) => (
                    <Candidate
                      key={item.product.id}
                      item={item}
                      interestCount={result.interestCount}
                    />
                  ))}
                </div>
              ) : (
                <p className="product-empty">현재 검색 범위에서 해당 후보가 없습니다.</p>
              )}
            </section>
          ))}
          {Math.max(result.general.length, result.needsReview.length, result.caution.length) >
            limit && (
            <button
              className="button secondary full"
              onClick={() => setLimit((value) => value + 12)}
            >
              후보 더 보기
            </button>
          )}
          <p className="field-help">
            공식 자료에서 관심 성분을 확인하지 못했거나 생산 종료로 분류되어 제외된 후보:{" "}
            {result.excludedCount}개. 새 제품을 저장할 때 최신 등록량으로 성분 검사를 다시
            진행합니다.
          </p>
        </>
      )}
    </div>
  );
}
