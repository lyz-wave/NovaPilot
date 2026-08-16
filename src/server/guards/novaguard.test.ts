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
    expect(v.checks.map((c) => c.id)).toEqual(["evidence-bound", "risk-tier-approval", "write-contract"]);
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
