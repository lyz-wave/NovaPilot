import { describe, it, expect, beforeEach } from "vitest";
import { createDb, queryAll, type NovaDb } from "../db/client";
import { recordCaseMemory, searchSimilarCases, factsDigest } from "./case-memory";
import { COLD_START_CASES, seedColdStartCases } from "./seed-cases";

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

  it("转专家的案例也可召回 —— 「该转就转」需要有先例", () => {
    recordCaseMemory(db, {
      projectId: "P-ESCALATED",
      tenantId: "t",
      question: "陈旧蜡块 DV200 24% 还能做全转录组吗",
      scenario: "manual-escalation",
      facts: { dv200: 24, material: "FFPE RNA" },
      status: "expert-review",
      outcome: "低于 30% 硬阈值,转解决方案专家",
      now: NOW,
    });
    const hits = searchSimilarCases(db, {
      tenantId: "t",
      question: "陈旧蜡块 DV200 很低还能做转录组吗",
      facts: { dv200: 26, material: "FFPE RNA" },
    });
    expect(hits.map((h) => h.projectId)).toContain("P-ESCALATED");
  });

  it("needs-conditions 不召回 —— 那是等用户补信息的半成品,不是先例", () => {
    recordCaseMemory(db, {
      projectId: "P-PENDING",
      tenantId: "t",
      question: "FFPE RNA 建库",
      scenario: "missing-dv200",
      facts: { material: "FFPE RNA" },
      status: "needs-conditions",
      outcome: "缺 DV200,待补",
      now: NOW,
    });
    expect(
      searchSimilarCases(db, {
        tenantId: "t",
        question: "FFPE RNA 建库",
        facts: { material: "FFPE RNA" },
      }),
    ).toEqual([]);
  });
});

describe("B3-4 · 案例记忆冷启动", () => {
  let db: NovaDb;
  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("植入三条样例,全部标记 cold-start", () => {
    expect(seedColdStartCases(db)).toBe(3);
    const rows = queryAll<{ id: string; provenance: string }>(
      db,
      "SELECT id, provenance FROM case_memory ORDER BY id",
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.provenance === "cold-start")).toBe(true);
    expect(rows.every((r) => r.id.startsWith("CS-"))).toBe(true);
  });

  it("幂等:反复调用不产生重复行", () => {
    seedColdStartCases(db);
    seedColdStartCases(db);
    expect(queryAll<{ n: number }>(db, "SELECT COUNT(*) AS n FROM case_memory")[0]!.n).toBe(3);
  });

  it("库里已有真实办结记录时不再植入 —— 有真实先例后样例自然退场", () => {
    recordCaseMemory(db, {
      projectId: "P-REAL",
      tenantId: "novapilot-demo",
      question: "真实咨询",
      scenario: "standard",
      facts: { material: "FFPE RNA" },
      status: "formal",
      outcome: "route",
      now: NOW,
    });
    expect(seedColdStartCases(db)).toBe(0);
    expect(queryAll<{ n: number }>(db, "SELECT COUNT(*) AS n FROM case_memory")[0]!.n).toBe(1);
  });

  it("样例可被召回,并如实带回 provenance —— 前端据此标注待复核", () => {
    seedColdStartCases(db);
    const hits = searchSimilarCases(db, {
      tenantId: "novapilot-demo",
      question: "肺腺癌 FFPE 蜡块做转录组差异表达可以走常规建库吗",
      facts: { sampleCount: 24, dv200: 60, rnaInputNg: 20, material: "FFPE RNA" },
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.projectId).toBe("CS-LUAD-FFPE-01");
    expect(hits.every((h) => h.provenance === "cold-start")).toBe(true);
  });

  it("三条样例覆盖标准 / 条件可行 / 转专家三条路线", () => {
    expect(COLD_START_CASES.map((c) => c.status).sort()).toEqual([
      "expert-review",
      "formal",
      "provisional",
    ]);
  });

  it("真实办结记录的 provenance 是 resolved(缺省值)", () => {
    recordCaseMemory(db, {
      projectId: "P-REAL",
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
    });
    expect(hits[0]!.provenance).toBe("resolved");
  });
});
