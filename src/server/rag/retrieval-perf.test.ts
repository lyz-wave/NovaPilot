/**
 * B1-4 · 检索性能门禁。
 *
 * 对应验收清单「千条 chunk 下检索 P95 耗时较全扫版本可测得下降」。
 * 全扫路径要为每个 chunk 反序列化一次 embedding JSON,代价随库线性增长;
 * FTS 预筛把进入打分的候选压到 FTS_LIMIT(50)以内,代价基本恒定。
 *
 * 阈值取得很宽松(本机实测 FTS P95 ≈ 4ms / 全扫 ≈ 32ms,约 8.7 倍),这里只要求
 * 2 倍以上,目的是抓住「预筛失效退化成全扫」这类回归,而不是卡具体毫秒数。
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { createDb, type NovaDb } from "../db/client";
import { indexDocument, searchWithDiagnostics } from "./retrieval";

const DOCS = 50;
const PASSAGES_PER_DOC = 20; // 共 1000 个 chunk
const SAMPLES = 40;
/** 方案 4.5 给的绝对目标:千条 chunk 下检索 P95 < 200ms。 */
const P95_BUDGET_MS = 200;
/** 预筛相对全扫至少要快这么多倍,否则视为预筛失效。 */
const MIN_SPEEDUP = 2;

const QUERY = "极低质量 建库补测 超微量";

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
}

function measure(db: NovaDb, query: string) {
  const samples: number[] = [];
  let channel = "";
  for (let i = 0; i < SAMPLES; i++) {
    const { diagnostics } = searchWithDiagnostics(db, query);
    samples.push(diagnostics.elapsedMs);
    channel = diagnostics.channel;
  }
  samples.sort((a, b) => a - b);
  return { p50: percentile(samples, 0.5), p95: percentile(samples, 0.95), channel };
}

describe("B1-4 · 千条 chunk 下的检索性能", () => {
  let db: NovaDb;

  beforeAll(() => {
    db = createDb(":memory:");
    for (let d = 0; d < DOCS; d++) {
      indexDocument(db, {
        id: `E-SOP-PERF-${d}`,
        source: "SOP",
        title: `性能测试文档 ${d}`,
        citation: `NV-SOP-PERF-${d}`,
        version: "v1.0",
        appliesTo: "性能测试",
        validUntil: "2030-01-01",
        lang: "zh",
        validation: "verified",
        passages: Array.from(
          { length: PASSAGES_PER_DOC },
          (_, i) =>
            `文档 ${d} 第 ${i} 段:极低质量样本的建库补测判定条件与超微量投入量阈值说明。`,
        ),
      });
    }
  });

  afterEach(() => {
    delete process.env.NP_DISABLE_FTS;
  });

  it("builds the expected corpus size", () => {
    const { diagnostics } = searchWithDiagnostics(db, QUERY);
    expect(diagnostics.channel).toBe("fts");
    // 预筛生效时进入打分的候选数远小于全库。
    expect(diagnostics.candidateCount).toBeLessThanOrEqual(50);
  });

  it("FTS P95 stays inside the 200ms budget and beats the full scan measurably", () => {
    const fts = measure(db, QUERY);
    expect(fts.channel).toBe("fts");

    process.env.NP_DISABLE_FTS = "1";
    const full = measure(db, QUERY);
    delete process.env.NP_DISABLE_FTS;
    expect(full.channel).toBe("fallback");

    // 绝对预算
    expect(fts.p95).toBeLessThan(P95_BUDGET_MS);
    // 相对下降 —— 这条才是防「预筛静默失效」的回归网
    expect(full.p95 / fts.p95).toBeGreaterThan(MIN_SPEEDUP);
  });

  it("still returns evidence-bearing hits on the fast path", () => {
    const { hits, diagnostics } = searchWithDiagnostics(db, QUERY);
    expect(diagnostics.channel).toBe("fts");
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.citation).toBeTruthy();
      expect(h.validUntil).toBeTruthy();
    }
  });
});
