import { createHash } from "node:crypto";
import {
  interestSearchTerms,
  normalizeProductNutrient,
  parseOfficialProduct,
  productSource,
  type Product,
  type ProductSearchResult,
} from "../products";
import { rateLimit } from "./auth";
import { HttpError } from "./db";

const origin = "https://openapi.foodsafetykorea.go.kr";
const ttl = 60 * 60_000;
const maxResponseBytes = 3 * 1024 * 1024;
const maxCacheBytes = 12 * 1024 * 1024;
const pageSize = 100;
const unavailable = "현재 제품 정보를 불러올 수 없습니다. 직접 입력을 이용해주세요.";
const searchNotice =
  "국내 건강기능식품 신고 정보입니다. 제품 표시사항과 1일 섭취량을 확인한 뒤 등록해주세요.";
const candidateNotice =
  "관심 성분과 관련된 제품명 검색어의 일부 검색 결과를 비교했습니다. 전체 제품을 조사한 순위가 아니며, 실제 복용 적절성은 개인 상태에 따라 달라질 수 있습니다.";

interface ClientOptions {
  fetchImpl?: typeof fetch;
  key?: () => string | undefined;
  now?: () => number;
  consumeBudget?: (keyHash: string) => void;
}

/** Injected transport/budget are used by isolated tests; production always uses HTTPS + a persistent budget. */
export function createProductClient(options: ClientOptions = {}) {
  const fetchImpl: typeof fetch = options.fetchImpl ?? ((...args) => fetch(...args));
  const keyValue = options.key ?? (() => process.env.FOOD_SAFETY_API_KEY);
  const now = options.now ?? Date.now;
  const consumeBudget =
    options.consumeBudget ?? ((keyHash: string) => rateLimit(`food-safety:${keyHash}`, 80, 3600));
  const cache = new Map<string, { expires: number; bytes: number; result: ProductSearchResult }>();
  const inflight = new Map<string, Promise<ProductSearchResult>>();
  let cacheBytes = 0;

  function configuredKey(): string {
    const key = keyValue()?.trim();
    if (!key || key.toLowerCase() === "sample" || !/^[a-zA-Z0-9_-]{8,256}$/.test(key))
      throw new HttpError(
        503,
        "제품 검색용 공식 데이터 인증키가 설정되지 않았습니다. 직접 입력을 이용해주세요.",
      );
    return key;
  }
  function putCache(cacheKey: string, result: ProductSearchResult): void {
    const bytes = Buffer.byteLength(JSON.stringify(result));
    if (bytes > maxCacheBytes) return;
    const previous = cache.get(cacheKey);
    if (previous) {
      cacheBytes -= previous.bytes;
      cache.delete(cacheKey);
    }
    for (const [key, value] of cache) {
      if (value.expires <= now()) {
        cacheBytes -= value.bytes;
        cache.delete(key);
      }
    }
    while (cache.size >= 32 || cacheBytes + bytes > maxCacheBytes) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cacheBytes -= cache.get(oldest)!.bytes;
      cache.delete(oldest);
    }
    cache.set(cacheKey, { expires: now() + ttl, bytes, result });
    cacheBytes += bytes;
  }
  async function readBody(response: Response): Promise<unknown> {
    if (!response.ok || !/\bjson\b/i.test(response.headers.get("content-type") ?? ""))
      throw new HttpError(503, unavailable);
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > maxResponseBytes) throw new HttpError(503, unavailable);
    if (!response.body) throw new HttpError(503, unavailable);
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxResponseBytes) {
          await reader.cancel();
          throw new HttpError(503, unavailable);
        }
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally {
      reader.releaseLock();
    }
  }
  async function request(
    field: "PRDLST_NM" | "PRDLST_REPORT_NO",
    value: string,
    page: number,
  ): Promise<ProductSearchResult> {
    const key = configuredKey();
    const keyHash = createHash("sha256").update(key).digest("hex");
    const cacheKey = `${keyHash}:${field}:${value}:${page}`;
    const hit = cache.get(cacheKey);
    if (hit && hit.expires > now()) return structuredClone(hit.result);
    if (inflight.has(cacheKey)) return structuredClone(await inflight.get(cacheKey)!);
    if (inflight.size >= 8) throw new HttpError(503, unavailable);
    const task = (async () => {
      try {
        consumeBudget(keyHash);
      } catch {
        throw new HttpError(
          429,
          "제품 검색 요청이 많습니다. 잠시 후 다시 시도하거나 직접 입력을 이용해주세요.",
        );
      }
      const start = (page - 1) * pageSize + 1;
      const end = start + pageSize - 1;
      // Key is server-only and must never appear in public source links or logs.
      const url = `${origin}/api/${encodeURIComponent(key)}/I0030/json/${start}/${end}/${field}=${encodeURIComponent(value)}`;
      let payload: unknown;
      try {
        const response = await fetchImpl(url, {
          method: "GET",
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
        });
        payload = await readBody(response);
      } catch {
        throw new HttpError(503, unavailable);
      }
      const root =
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? (payload as Record<string, unknown>)
          : {};
      const service =
        root.I0030 && typeof root.I0030 === "object" && !Array.isArray(root.I0030)
          ? (root.I0030 as Record<string, unknown>)
          : {};
      const resultValue = service.RESULT ?? root.RESULT;
      const result =
        resultValue && typeof resultValue === "object"
          ? (resultValue as Record<string, unknown>)
          : {};
      if (result.CODE === "INFO-200") {
        const empty = {
          products: [],
          total: 0,
          partial: false,
          source: productSource,
          notice: searchNotice,
          page,
          query: value,
          hasMore: false,
        };
        putCache(cacheKey, empty);
        return empty;
      }
      if (
        result.CODE !== "INFO-000" ||
        !Array.isArray(service.row) ||
        service.row.length > pageSize
      )
        throw new HttpError(503, unavailable);
      const total = Number(service.total_count);
      if (!Number.isSafeInteger(total) || total < 0) throw new HttpError(503, unavailable);
      const products: Product[] = [];
      const seen = new Set<string>();
      for (const row of service.row) {
        if (!row || typeof row !== "object" || Array.isArray(row)) continue;
        const product = parseOfficialProduct(row as Record<string, unknown>);
        if (!product || seen.has(product.id)) continue;
        seen.add(product.id);
        products.push(product);
      }
      const data: ProductSearchResult = {
        products,
        total,
        partial: total > end || page > 1 || products.length !== service.row.length,
        source: productSource,
        notice: searchNotice,
        page,
        query: value,
        hasMore: total > end && page < 20,
      };
      putCache(cacheKey, data);
      return data;
    })();
    inflight.set(cacheKey, task);
    try {
      return structuredClone(await task);
    } finally {
      inflight.delete(cacheKey);
    }
  }

  async function searchProducts(query: string, page = 1): Promise<ProductSearchResult> {
    if (typeof query !== "string") throw new HttpError(400, "제품명을 입력해주세요.");
    const normalized = query.normalize("NFKC").trim().replace(/\s+/g, " ");
    if (
      normalized.length < 2 ||
      normalized.length > 80 ||
      /[\u0000-\u001f\u007f/%?&#=]/.test(normalized)
    )
      throw new HttpError(400, "제품명은 특수 검색기호 없이 2~80자로 입력해주세요.");
    if (!Number.isInteger(page) || page < 1 || page > 20)
      throw new HttpError(400, "검색 페이지를 확인해주세요.");
    return request("PRDLST_NM", normalized, page);
  }
  async function getProduct(reportNumber: string): Promise<Product> {
    if (typeof reportNumber !== "string" || !/^\d{6,30}$/.test(reportNumber))
      throw new HttpError(400, "제품 신고번호를 확인해주세요.");
    const result = await request("PRDLST_REPORT_NO", reportNumber, 1);
    const product = result.products.find((item) => item.reportNumber === reportNumber);
    if (!product)
      throw new HttpError(404, "현재 조회할 수 있는 건강기능식품 신고 정보를 찾지 못했습니다.");
    return product;
  }
  async function candidateProducts(interests: string[]): Promise<ProductSearchResult> {
    if (
      !Array.isArray(interests) ||
      interests.length < 1 ||
      interests.length > 20 ||
      interests.some((item) => typeof item !== "string" || item.length > 80)
    )
      throw new HttpError(400, "탐색할 관심 성분을 선택해주세요.");
    const wanted = new Set(interests.map(normalizeProductNutrient));
    const terms = interestSearchTerms([...wanted]);
    if (!terms.length) throw new HttpError(400, "지원하는 관심 영양성분을 선택해주세요.");
    const products = new Map<string, Product>();
    let succeeded = 0;
    let failed = false;
    for (const term of terms) {
      try {
        const result = await searchProducts(term);
        succeeded++;
        for (const product of result.products) {
          if (product.productionEnded) continue;
          const matches = product.declaredNutrients.some(
            (name) =>
              wanted.has(name) ||
              (wanted.has("비타민 B군") && /^비타민 B(?:1|2|3|5|6|7|9|12)$/.test(name)),
          );
          if (matches) products.set(product.id, product);
        }
      } catch (error) {
        if (error instanceof HttpError && error.status === 400) throw error;
        failed = true;
      }
    }
    if (!succeeded) throw new HttpError(503, unavailable);
    return {
      products: [...products.values()],
      total: products.size,
      partial: true,
      source: productSource,
      notice: candidateNotice + (failed ? " 일부 검색 요청은 완료하지 못했습니다." : ""),
      page: 1,
      query: terms.join(", "),
      hasMore: false,
    };
  }
  return { searchProducts, getProduct, candidateProducts };
}

const client = createProductClient();
export const searchProducts = client.searchProducts;
export const getProduct = client.getProduct;
export const candidateProducts = client.candidateProducts;
