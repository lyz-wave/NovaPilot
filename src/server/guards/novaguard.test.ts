import { describe, it, expect } from "vitest";
import { createDb } from "../db/client";
import { seedKnowledgeBase, search } from "../rag/retrieval";
import {
  canonicalCite,
  buildCitationWhitelist,
  fabricatedCitations,
  guardRiskGate,
  runNovaGuard,
} from "./novaguard";
import type { RiskAssessment } from "@/domain/consultation-journey";

const LOW: RiskAssessment = {
  level: "low",
  score: 22,
  mandatoryEscalation: false,
  signals: ["证据充分"],
};
const MEDIUM: RiskAssessment = {
  level: "medium",
  score: 58,
  mandatoryEscalation: false,
  signals: ["关键质控指标缺失"],
};
const HIGH: RiskAssessment = {
  level: "high",
  score: 90,
  mandatoryEscalation: true,
  signals: ["极低质量样本"],
};

describe("NovaGuard · evidence-bound 引用白名单", () => {
  const db = createDb(":memory:");
  seedKnowledgeBase(db);
  const chunks = search(db, "FFPE RNA 建库 DV200 门槛", { appliesToHint: "FFPE RNA" });

  it("whitelist accepts both citation and document-id namespaces", () => {
    const { canon, toCitation } = buildCitationWhitelist(chunks);
    const sop = chunks.find((c) => c.source === "SOP")!;
    expect(canon.has(canonicalCite(sop.citation))).toBe(true);
    expect(canon.has(canonicalCite(sop.documentId))).toBe(true);
    // doc id normalizes back to the canonical citation
    expect(toCitation.get(canonicalCite(sop.documentId))).toBe(sop.citation);
  });

  it("flags fabricated PMID/DOI/NV-SOP tokens in model text", () => {
    const { canon } = buildCitationWhitelist(chunks);
    const bad = fabricatedCitations("见 PMID: 12345678 与 DOI: 10.9999/x.y 及 NV-SOP-FAKE-1", canon);
    expect(bad.map(canonicalCite)).toEqual([
      "PMID:12345678",
      "DOI:10.9999/x.y",
      "NV-SOP-FAKE-1",
    ]);
    // real citations from the retrieved set are NOT flagged
    const good = fabricatedCitations(`依据 ${chunks[0].citation} 与 ${chunks[1].citation}`, canon);
    expect(good).toEqual([]);
  });
});

describe("NovaGuard · risk-tier 分级审批 (ADR-0012)", () => {
  it("low risk + within SOP boundary + verified → formal", () => {
    const r = guardRiskGate({
      risk: LOW,
      facts: { dv200: 60, rnaInputNg: 50 },
      verifiedCount: 1,
      blockedByConditions: false,
    });
    expect(r.status).toBe("formal");
    expect(r.mustEscalate).toBe(false);
  });

  it("medium risk → provisional (暂不发布正式卡)", () => {
    const r = guardRiskGate({
      risk: MEDIUM,
      facts: { dv200: 45, rnaInputNg: 50 },
      verifiedCount: 1,
      blockedByConditions: false,
    });
    expect(r.status).toBe("provisional");
    expect(r.reasons.join("")).toMatch(/SOP 自动推荐边界/);
  });

  it("blocking conditions missing → needs-conditions", () => {
    const r = guardRiskGate({
      risk: MEDIUM,
      facts: {},
      verifiedCount: 1,
      blockedByConditions: true,
    });
    expect(r.status).toBe("needs-conditions");
  });

  it("mandatory risk → expert-review (转专家)", () => {
    const r = guardRiskGate({
      risk: HIGH,
      facts: { dv200: 25, rnaInputNg: 50 },
      verifiedCount: 1,
      blockedByConditions: false,
    });
    expect(r.status).toBe("expert-review");
    expect(r.mustEscalate).toBe(true);
  });

  it("loop exhausted with no verified recommendation → expert-review", () => {
    const r = guardRiskGate({
      risk: LOW,
      facts: { dv200: 60, rnaInputNg: 50 },
      verifiedCount: 0,
      blockedByConditions: false,
    });
    expect(r.status).toBe("expert-review");
    expect(r.loopExhausted).toBe(true);
  });
});

describe("NovaGuard · 总控门禁 runNovaGuard", () => {
  const db = createDb(":memory:");
  seedKnowledgeBase(db);
  const chunks = search(db, "FFPE RNA 建库", { appliesToHint: "FFPE RNA" });

  it("returns a full audit trail for a formal decision", () => {
    const v = runNovaGuard({
      risk: LOW,
      facts: { dv200: 60, rnaInputNg: 50 },
      verifiedCount: 2,
      blockedByConditions: false,
      modelText: `建议采用链特异性建库（${chunks[0].citation}）。`,
      chunks,
    });
    expect(v.decision).toBe("formal");
    expect(v.checks.map((c) => c.id)).toEqual([
      "evidence-bound",
      "risk-tier-approval",
      "scope-contract",
      "write-contract",
    ]);
    expect(v.checks[0].passed).toBe(true);
    expect(v.trace.mustEscalate).toBe(false);
  });

  it("blocks fabricated citations in the model summary", () => {
    const v = runNovaGuard({
      risk: LOW,
      facts: { dv200: 60, rnaInputNg: 50 },
      verifiedCount: 2,
      blockedByConditions: false,
      modelText: "推荐该路线（PMID: 12345678）。",
      chunks,
    });
    const evidenceCheck = v.checks.find((c) => c.id === "evidence-bound")!;
    expect(evidenceCheck.passed).toBe(false);
    expect(evidenceCheck.reason).toMatch(/拦截编造引用/);
  });
});

describe("NovaGuard · scope-contract 适用范围契约", () => {
  const CANINE = [
    { kind: "species" as const, demand: "犬", reason: "知识库未声明覆盖犬类。" },
  ];

  it("越界强制转专家 —— 即使证据充分、风险低、SOP 边界满足", () => {
    const gate = guardRiskGate({
      risk: LOW,
      facts: { dv200: 60, rnaInputNg: 50 },
      verifiedCount: 2,
      blockedByConditions: false,
      scopeViolations: CANINE,
    });
    // 三层防线都判「这条建议有据可依」,但请求本身不在服务范围内。
    // 「有据」和「该答」是两件事,这一条就是把它们分开。
    expect(gate.status).toBe("expert-review");
    expect(gate.mustEscalate).toBe(true);
    expect(gate.outOfScope).toBe(true);
    expect(gate.reasons.join("")).toContain("犬");
  });

  it("越界不是「三轮耗尽」—— 交接语境不同,不能混成一个标签", () => {
    const outOfScope = guardRiskGate({
      risk: LOW,
      facts: { dv200: 60, rnaInputNg: 50 },
      verifiedCount: 2,
      blockedByConditions: false,
      scopeViolations: CANINE,
    });
    expect(outOfScope.loopExhausted).toBe(false);

    // 对照组:同样转专家,但原因是检索三轮后无建议幸存。
    const exhausted = guardRiskGate({
      risk: LOW,
      facts: { dv200: 60, rnaInputNg: 50 },
      verifiedCount: 0,
      blockedByConditions: false,
    });
    expect(exhausted.loopExhausted).toBe(true);
    expect(exhausted.outOfScope).toBe(false);
  });

  it("越界优先于「等客户补条件」—— 补齐 DV200 也不会让越界请求变成范围内请求", () => {
    const gate = guardRiskGate({
      risk: LOW,
      facts: {},
      verifiedCount: 0,
      blockedByConditions: true,
      scopeViolations: CANINE,
    });
    expect(gate.status).toBe("expert-review");
    expect(gate.status).not.toBe("needs-conditions");
  });

  it("未检出越界时不改变任何既有判定", () => {
    const withEmpty = guardRiskGate({
      risk: LOW,
      facts: { dv200: 60, rnaInputNg: 50 },
      verifiedCount: 2,
      blockedByConditions: false,
      scopeViolations: [],
    });
    const without = guardRiskGate({
      risk: LOW,
      facts: { dv200: 60, rnaInputNg: 50 },
      verifiedCount: 2,
      blockedByConditions: false,
    });
    expect(withEmpty).toEqual(without);
    expect(withEmpty.status).toBe("formal");
  });

  it("门禁项在正确拦截时算通过,并把越界项写进 reason 与 trace", () => {
    const v = runNovaGuard({
      risk: LOW,
      facts: { dv200: 60, rnaInputNg: 50 },
      verifiedCount: 2,
      blockedByConditions: false,
      chunks: [],
      scopeViolations: CANINE,
    });
    const check = v.checks.find((c) => c.id === "scope-contract")!;
    expect(check.passed).toBe(true); // 正确拦截视为通过,与 risk-tier-approval 同口径
    expect(check.reason).toContain("拦截越界需求");
    expect(v.trace.scopeViolations).toEqual(["species:犬"]);
  });

  it("无越界时的 reason 明说这不是「范围内证明」", () => {
    const v = runNovaGuard({
      risk: LOW,
      facts: { dv200: 60, rnaInputNg: 50 },
      verifiedCount: 2,
      blockedByConditions: false,
      chunks: [],
    });
    const check = v.checks.find((c) => c.id === "scope-contract")!;
    // 本体之外的物种/检测类型检不出来。把「没检出」写成「在范围内」就是又造一个
    // 恒真指示灯,这条测试钉住那句免责说明必须在。
    expect(check.reason).toContain("非范围内证明");
  });
});
