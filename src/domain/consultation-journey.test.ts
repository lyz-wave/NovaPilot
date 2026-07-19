import { describe, expect, it } from "vitest";
import {
  createCandidateKnowledge,
  evaluateReleaseGate,
  evaluateDataEgress,
  inferScenarioFromQuestion,
  promoteCandidateKnowledge,
  recordConsent,
  recordFeedback,
  runConsultationJourney,
} from "./consultation-journey";

describe("一次完整科研咨询旅程", () => {
  it("将证据充分的中文 FFPE/RNA 咨询发布为低风险正式科研决策卡", () => {
    const result = runConsultationJourney({
      scenario: "standard",
      locale: "zh",
      facts: { sampleCount: 24, dv200: 62, rnaInputNg: 20, material: "FFPE RNA" },
    });

    expect(result.card.status).toBe("formal");
    expect(result.card.risk.level).toBe("low");
    expect(result.card.recommendations).toHaveLength(2);
    expect(result.card.recommendations.every((item) => item.evidenceIds.length > 0)).toBe(true);
    expect(result.evidence.every((item) => item.validation === "verified")).toBe(true);
  });

  it("DV200 或 RNA 投入量未达到 SOP 双边界时不得生成正式建议", () => {
    const grayZone = runConsultationJourney({
      scenario: "standard",
      locale: "zh",
      facts: { sampleCount: 24, dv200: 45, rnaInputNg: 20, material: "FFPE RNA" },
    });
    const lowInput = runConsultationJourney({
      scenario: "standard",
      locale: "zh",
      facts: { sampleCount: 24, dv200: 62, rnaInputNg: 6, material: "FFPE RNA" },
    });

    expect(grayZone.card.status).toBe("provisional");
    expect(grayZone.card.recommendations).toEqual([]);
    expect(lowInput.card.status).toBe("provisional");
    expect(lowInput.card.recommendations).toEqual([]);
  });

  it("跨语言识别证据冲突和人工专家请求", () => {
    expect(
      inferScenarioFromQuestion("I need a human expert to review this", {}),
    ).toBe("manual-escalation");
    expect(
      inferScenarioFromQuestion("この案件を専門家に相談したい", {}),
    ).toBe("manual-escalation");
    expect(
      inferScenarioFromQuestion("The SOP contradicts the paper", {}),
    ).toBe("evidence-conflict");
  });

  it("缺少 DV200 时只提供条件性路径并提出最小必要追问", () => {
    const result = runConsultationJourney({
      scenario: "missing-dv200",
      locale: "zh",
      facts: { sampleCount: 24, material: "FFPE RNA" },
    });

    expect(result.card.status).toBe("needs-conditions");
    expect(result.clarifyingQuestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "dv200", blocksFinalRecommendation: true }),
        expect.objectContaining({ field: "rnaInputNg", blocksFinalRecommendation: true }),
      ]),
    );
    expect(result.card.prohibitedCtas).toContain("立即执行");
  });

  it("证据冲突时强制转接且不输出可执行最终方案", () => {
    const result = runConsultationJourney({
      scenario: "evidence-conflict",
      locale: "zh",
      facts: { sampleCount: 24, dv200: 38, material: "FFPE RNA" },
    });

    expect(result.card.status).toBe("expert-review");
    expect(result.card.risk.mandatoryEscalation).toBe(true);
    expect(result.expertCase?.handoff.evidenceConflict).toBe(true);
    expect(result.card.recommendations).toEqual([]);
    expect(result.card.alternatives).toEqual([]);
    expect(result.card.serviceFit).toBeNull();
  });

  it("不信任调用方的标准场景标签，极低 DV200 仍必须转接", () => {
    const result = runConsultationJourney({
      scenario: "standard",
      locale: "zh",
      facts: { sampleCount: 24, dv200: 12, material: "FFPE RNA" },
    });

    expect(result.card.status).toBe("expert-review");
    expect(result.card.risk.mandatoryEscalation).toBe(true);
    expect(result.card.risk.signals).toContain("极低质量样本");
  });

  it("材料缺失或不适用时不得套用 FFPE RNA 正式方案", () => {
    const missingMaterial = runConsultationJourney({
      scenario: "standard",
      locale: "zh",
      facts: { sampleCount: 24, dv200: 62, rnaInputNg: 20 },
    });
    const wrongMaterial = runConsultationJourney({
      scenario: "standard",
      locale: "zh",
      facts: {
        sampleCount: 24,
        dv200: 62,
        rnaInputNg: 20,
        material: "fresh frozen DNA",
      },
    });

    expect(missingMaterial.card.status).toBe("needs-conditions");
    expect(missingMaterial.card.recommendations).toEqual([]);
    expect(wrongMaterial.card.status).toBe("expert-review");
    expect(wrongMaterial.card.recommendations).toEqual([]);
  });

  it("在同一项目切换语言时保持科研实体、证据和风险一致", () => {
    const chinese = runConsultationJourney({
      scenario: "standard",
      locale: "zh",
      facts: { sampleCount: 24, dv200: 62, rnaInputNg: 20, material: "FFPE RNA" },
    });
    const japanese = runConsultationJourney({
      scenario: "standard",
      locale: "ja",
      facts: { sampleCount: 24, dv200: 62, rnaInputNg: 20, material: "FFPE RNA" },
    });

    expect(japanese.project.entityIds).toEqual(chinese.project.entityIds);
    expect(japanese.card.risk).toEqual(chinese.card.risk);
    expect(japanese.evidence.map((item) => item.id)).toEqual(
      chinese.evidence.map((item) => item.id),
    );
  });

  it("未授权咨询不创建 CRM 商机，主动授权后仅创建一次", () => {
    expect(recordConsent({ projectId: "NP-260719", granted: false }).crmOpportunity).toBeNull();
    expect(recordConsent({ projectId: "NP-260719", granted: true }).crmOpportunity).toBeNull();
    const granted = recordConsent({
      projectId: "NP-260719",
      granted: true,
      action: "request-quote",
      idempotencyKey: "consent-1",
    });
    expect(granted.crmOpportunity?.status).toBe("created");
    expect(granted.event.type).toBe("ConsentGranted");
    expect(granted.event.occurredAt).toBeTruthy();
    expect(granted.event.source).toBe("novapilot-decision-card");
    const repeated = recordConsent({
      projectId: "NP-260719",
      granted: true,
      action: "request-quote",
      idempotencyKey: "consent-1",
    });
    expect(repeated.crmOpportunity?.status).toBe("existing");
    const conflictingRetry = recordConsent({
      projectId: "NP-OTHER",
      granted: true,
      action: "book-expert",
      idempotencyKey: "consent-1",
    });
    expect(conflictingRetry.conflict).toBe(true);
    expect(conflictingRetry.crmOpportunity).toBeNull();

    const withdrawn = recordConsent({
      projectId: "NP-260719",
      granted: false,
      action: "request-quote",
      idempotencyKey: "consent-withdraw-1",
    });
    expect(withdrawn.event.type).toBe("ConsentWithdrawn");
    expect(withdrawn.revoked).toBe(true);

    recordConsent({
      projectId: "NP-RESERVED",
      granted: false,
      action: "allow-contact",
      idempotencyKey: "consent-reserved-1",
    });
    const reusedWithDifferentIntent = recordConsent({
      projectId: "NP-RESERVED",
      granted: true,
      action: "allow-contact",
      idempotencyKey: "consent-reserved-1",
    });
    expect(reusedWithDifferentIntent.conflict).toBe(true);
  });

  it("客户主动要求人工时保留真实转接原因而不伪造证据冲突", () => {
    const result = runConsultationJourney({
      scenario: "manual-escalation",
      locale: "zh",
      facts: { sampleCount: 24, dv200: 62, rnaInputNg: 20, material: "FFPE RNA" },
    });

    expect(result.expertCase?.handoff.evidenceConflict).toBe(false);
    expect(result.expertCase?.handoff.reason).toContain("要求");
  });

  it("低分反馈生成可追踪的质量事件", () => {
    const feedback = recordFeedback({
      projectId: "NP-260719",
      score: 1,
      reason: "citation",
    });

    expect(feedback.qualityEvent?.status).toBe("open");
    expect(feedback.qualityEvent?.owner).toBe("service-operations");
  });

  it("安全门禁退化时阻止灰度放量", () => {
    const gate = evaluateReleaseGate({
      citationValidity: 0.97,
      escalationRecall: 0.96,
      confidentWrongDelta: 0,
      p0Defects: 0,
      dataBoundaryIncidents: 0,
    });

    expect(gate.decision).toBe("stop");
    expect(gate.failed).toContain("citation-validity");
  });

  it("专家修改只生成候选知识，未经 Owner 与 NovaBench 不进入生产", () => {
    const candidate = createCandidateKnowledge({
      sourceCaseId: "CASE-2407",
      expertModification: "DV200 30–40% 时先进行两份代表样本试建库。",
      evidenceIds: ["E-SOP-042", "E-PMID-35361992"],
    });

    expect(candidate.status).toBe("candidate");
    expect(candidate.productionEligible).toBe(false);

    const promoted = promoteCandidateKnowledge(candidate, {
      ownerApproved: true,
      novaBenchPassed: true,
      grayValidationPassed: true,
      humanApproved: true,
    });
    expect(promoted.status).toBe("gray-active");
    expect(promoted.productionEligible).toBe(true);
    expect(promoted.auditTrail).toHaveLength(4);
    expect(promoted.rollbackVersion).toBe("KV-2026.07.18");
  });

  it("科研决策卡包含决策所需的完整项目状态", () => {
    const result = runConsultationJourney({
      scenario: "standard",
      locale: "zh",
      facts: { sampleCount: 24, dv200: 62, rnaInputNg: 20, material: "FFPE RNA" },
    });

    expect(result.project.factRecords.every((fact) => fact.confirmation === "confirmed")).toBe(true);
    expect(result.card.customerGoal).toBeTruthy();
    expect(result.card.confirmedConditions).toHaveLength(4);
    expect(result.card.budgetRange).toBeTruthy();
    expect(result.card.timelineRange).toBeTruthy();
    expect(result.card.pendingItems).toEqual([]);
    expect(result.card.expertStatus).toBe("not-required");
  });

  it("数据出域策略阻止敏感科研数据进入外部模型", () => {
    expect(
      evaluateDataEgress({
        containsCustomerFile: true,
        containsInternalSop: false,
        containsHumanIdentifiableData: false,
        deidentified: false,
      }),
    ).toEqual(expect.objectContaining({ allowed: false, route: "private-model" }));
  });
});
