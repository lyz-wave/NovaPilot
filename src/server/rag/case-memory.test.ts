import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type NovaDb } from "../db/client";
import { recordCaseMemory, searchSimilarCases, factsDigest } from "./case-memory";

const NOW = "2026-08-12T00:00:00.000Z";

describe("resolved-case memory · similar-case retrieval", () => {
  let db: NovaDb;
  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("returns [] when the memory is empty (safe no-op)", () => {
    const hits = searchSimilarCases(db, {
      tenantId: "t",
      question: "FFPE RNA 建库",
      facts: { material: "FFPE RNA", dv200: 60 },
    });
    expect(hits).toEqual([]);
  });

  it("recalls a similar past case and ranks it above an unrelated one", () => {
    recordCaseMemory(db, {
      projectId: "P-FFPE",
      tenantId: "t",
      question: "24份FFPE肿瘤样本如何开展RNA差异表达研究",
      scenario: "standard",
      facts: { sampleCount: 24, dv200: 62, rnaInputNg: 25, material: "FFPE RNA" },
      status: "formal",
      outcome: "链特异性总 RNA 文库 + Illumina",
      now: NOW,
    });
    recordCaseMemory(db, {
      projectId: "P-UNRELATED",
      tenantId: "t",
      question: "小鼠新鲜组织单细胞测序方案",
      scenario: "standard",
      facts: { material: "新鲜组织" },
      status: "formal",
      outcome: "10x 单细胞",
      now: NOW,
    });

    const hits = searchSimilarCases(db, {
      tenantId: "t",
      question: "FFPE 肿瘤样本 RNA 差异表达建库怎么做",
      facts: { material: "FFPE RNA", dv200: 58 },
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.projectId).toBe("P-FFPE");
  });

  it("excludes the current project so a re-run never recalls itself", () => {
    recordCaseMemory(db, {
      projectId: "P-SELF",
      tenantId: "t",
      question: "FFPE RNA 建库",
      scenario: "standard",
      facts: { material: "FFPE RNA" },
      status: "formal",
      outcome: "route",
      now: NOW,
    });
    const hits = searchSimilarCases(db, {
      tenantId: "t",
      question: "FFPE RNA 建库",
      facts: { material: "FFPE RNA" },
      excludeProjectId: "P-SELF",
    });
    expect(hits).toEqual([]);
  });

  it("scopes retrieval to the tenant", () => {
    recordCaseMemory(db, {
      projectId: "P-OTHER-TENANT",
      tenantId: "tenant-b",
      question: "FFPE RNA 建库",
      scenario: "standard",
      facts: { material: "FFPE RNA" },
      status: "formal",
      outcome: "route",
      now: NOW,
    });
    const hits = searchSimilarCases(db, {
      tenantId: "tenant-a",
      question: "FFPE RNA 建库",
      facts: { material: "FFPE RNA" },
    });
    expect(hits).toEqual([]);
  });

  it("factsDigest is a compact one-liner of the confirmed facts", () => {
    expect(factsDigest({ sampleCount: 24, dv200: 62, rnaInputNg: 25, material: "FFPE RNA" })).toContain(
      "FFPE RNA",
    );
    expect(factsDigest({})).toBe("(无量化事实)");
  });
});
