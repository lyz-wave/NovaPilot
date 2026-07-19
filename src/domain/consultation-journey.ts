export type Locale = "zh" | "en" | "ja";
export type Scenario =
  | "standard"
  | "missing-dv200"
  | "evidence-conflict"
  | "non-standard"
  | "manual-escalation";
export type CardStatus =
  | "draft"
  | "needs-conditions"
  | "provisional"
  | "expert-review"
  | "formal"
  | "pi-approved";

export interface ProjectFacts {
  sampleCount?: number;
  dv200?: number;
  rnaInputNg?: number;
  material?: string;
}

export interface ProjectFactRecord {
  field: keyof ProjectFacts;
  value: string | number;
  source: "customer" | "customer-file" | "expert";
  extractedAt: string;
  confidence: number;
  confirmation: "candidate" | "confirmed" | "conflict";
  version: number;
  visibility: "project-members";
}

export interface Evidence {
  id: string;
  source: "SOP" | "SCI";
  title: string;
  citation: string;
  version: string;
  appliesTo: string;
  validUntil: string;
  validation: "verified" | "conflict" | "expired";
}

export interface Recommendation {
  id: string;
  title: string;
  rationale: string;
  evidenceIds: string[];
  boundary: string;
}

export interface RiskAssessment {
  level: "low" | "medium" | "high";
  score: number;
  mandatoryEscalation: boolean;
  signals: string[];
}

export interface DecisionCard {
  id: string;
  version: number;
  status: CardStatus;
  title: string;
  customerGoal: string;
  confirmedConditions: ProjectFactRecord[];
  budgetRange: string | null;
  timelineRange: string | null;
  pendingItems: string[];
  expertStatus: "not-required" | "awaiting-claim" | "claimed" | "approved";
  executiveSummary: string;
  recommendations: Recommendation[];
  alternatives: string[];
  risk: RiskAssessment;
  prohibitedCtas: string[];
  serviceFit: {
    title: string;
    rationale: string;
    limitations: string;
  } | null;
}

export interface ClarifyingQuestion {
  field: keyof ProjectFacts;
  prompt: string;
  reason: string;
  blocksFinalRecommendation: boolean;
}

export interface ExpertCase {
  id: string;
  status: "awaiting-claim" | "claimed" | "resolved";
  sla: {
    claimMinutes: number;
    substantiveResponseHours: number;
  };
  handoff: {
    objective: string;
    confirmedFacts: ProjectFacts;
    attemptedAction: string;
    riskLevel: RiskAssessment["level"];
    reason: string;
    evidenceConflict: boolean;
    decisionsNeeded: string[];
  };
}

export interface ConsultationInput {
  scenario: Scenario;
  locale: Locale;
  facts: ProjectFacts;
}

export interface ConsultationResult {
  project: {
    id: string;
    name: string;
    locale: Locale;
    facts: ProjectFacts;
    factRecords: ProjectFactRecord[];
    entityIds: string[];
  };
  card: DecisionCard;
  evidence: Evidence[];
  clarifyingQuestions: ClarifyingQuestion[];
  expertCase: ExpertCase | null;
  traceId: string;
}

const copy = {
  zh: {
    project: "FFPE RNA 表达谱项目",
    title: "FFPE RNA 实验设计与平台选择",
    summary:
      "样本质量满足建库门槛。建议采用链特异性总 RNA 文库作为主方案，并保留低输入捕获作为备选。",
    primary: "主方案｜链特异性总 RNA 测序",
    primaryReason: "兼顾降解样本的信息保留、差异表达稳健性与后续可解释性。",
    alternative: "备选｜低输入 RNA 捕获方案（适用于质控波动样本）",
    depthTitle: "PE150 · 50M reads/样本",
    depthReason: "满足基因与转录本层级定量，并保留后续可复核空间。",
    depthBoundary: "不包含融合基因发现或超低频事件检测。",
    serviceTitle: "诺禾 FFPE RNA 一体化服务",
    serviceReason: "质控、建库、测序与下游分析可共享同一项目事实和证据链。",
    serviceLimit: "最终报价、排期和样本接收以人工确认及客户授权为准。",
    budget: "¥35,000–55,000 · 以授权报价为准",
    timeline: "6–8 周 · 样本验收后确认",
    question: "请补充样本的 DV200 检测结果。",
    questionReason: "DV200 会改变建库路线、最低投入量和失败风险。",
    inputQuestion: "请补充可用于建库的 RNA 投入量（ng）。",
    inputReason: "当前 SOP 的自动推荐边界要求 RNA input ≥ 10 ng。",
    materialQuestion: "请确认样本材料是否为 FFPE RNA。",
    materialReason: "当前证据与 SOP 只适用于 FFPE 来源 RNA。",
    boundarySummary: "关键指标尚未同时满足 DV200 ≥ 50% 且 RNA input ≥ 10 ng，当前仅提供条件性判断。",
    conflictSummary: "当前内部 SOP 与公开方法证据存在适用边界冲突，已暂停最终建议。",
    lowQualitySummary: "样本质量低于可信自动决策边界，已转交专家评估试建库与止损条件。",
    manualSummary: "已按你的要求转交人工专家，AI 不再输出最终方案。",
  },
  en: {
    project: "FFPE RNA expression project",
    title: "FFPE RNA study design & platform selection",
    summary:
      "Sample quality meets the library threshold. Use stranded total RNA as the primary route, with low-input capture as the fallback.",
    primary: "Primary | Stranded total RNA sequencing",
    primaryReason:
      "Balances information retention, robust differential expression and interpretability for degraded samples.",
    alternative: "Alternative | Low-input RNA capture for variable-quality samples",
    depthTitle: "PE150 · 50M reads/sample",
    depthReason: "Supports gene- and transcript-level quantification with room for later review.",
    depthBoundary: "Does not include fusion discovery or ultra-low-frequency event detection.",
    serviceTitle: "Novogene integrated FFPE RNA service",
    serviceReason: "QC, library preparation, sequencing and analysis share one verified project state and evidence chain.",
    serviceLimit: "Final price, schedule and sample acceptance require human confirmation and customer consent.",
    budget: "CNY 35,000–55,000 · quote requires consent",
    timeline: "6–8 weeks · confirmed after sample acceptance",
    question: "Please provide the sample DV200 measurement.",
    questionReason: "DV200 changes the library route, minimum input and failure risk.",
    inputQuestion: "Please provide the RNA input available for library preparation (ng).",
    inputReason: "The active SOP requires RNA input ≥ 10 ng for automated final advice.",
    materialQuestion: "Please confirm whether the material is FFPE-derived RNA.",
    materialReason: "The active evidence and SOP apply only to FFPE-derived RNA.",
    boundarySummary: "DV200 ≥ 50% and RNA input ≥ 10 ng are not both satisfied. Only provisional guidance is available.",
    conflictSummary:
      "The active SOP and external method evidence conflict at this boundary. Final advice is paused.",
    lowQualitySummary:
      "Sample quality is below the trusted automation boundary. An expert will assess pilot-library and stop conditions.",
    manualSummary: "An expert has been requested. AI final advice is paused.",
  },
  ja: {
    project: "FFPE RNA 発現解析プロジェクト",
    title: "FFPE RNA 実験設計・プラットフォーム選定",
    summary:
      "試料品質はライブラリ基準を満たします。鎖特異的 total RNA を主案とし、低入力キャプチャを代替案とします。",
    primary: "主案｜鎖特異的 total RNA シーケンス",
    primaryReason:
      "分解試料の情報保持、差次的発現解析の安定性、解釈性を両立します。",
    alternative: "代替案｜品質変動試料向け低入力 RNA キャプチャ",
    depthTitle: "PE150 · 50M reads/試料",
    depthReason: "遺伝子・転写産物レベルの定量と、後続レビューの余地を確保します。",
    depthBoundary: "融合遺伝子探索および超低頻度イベント検出は含みません。",
    serviceTitle: "Novogene FFPE RNA 統合サービス",
    serviceReason: "QC、ライブラリ調製、シーケンス、解析が同じ確認済みプロジェクト状態と証拠を共有します。",
    serviceLimit: "最終価格、日程、試料受入は担当者確認と顧客同意が必要です。",
    budget: "35,000–55,000 元 · 見積には同意が必要",
    timeline: "6–8 週間 · 試料受入後に確定",
    question: "試料の DV200 測定値を入力してください。",
    questionReason: "DV200 はライブラリ方式、最低投入量、失敗リスクを左右します。",
    inputQuestion: "ライブラリ調製に使用できる RNA 投入量（ng）を入力してください。",
    inputReason: "現行 SOP の自動最終提案には RNA input ≥ 10 ng が必要です。",
    materialQuestion: "試料が FFPE 由来 RNA であることを確認してください。",
    materialReason: "現行の証拠と SOP は FFPE 由来 RNA のみに適用されます。",
    boundarySummary: "DV200 ≥ 50% と RNA input ≥ 10 ng を同時に満たしていないため、条件付き判断のみ提示します。",
    conflictSummary:
      "現行 SOP と公開手法の適用境界が競合するため、最終提案を停止しました。",
    lowQualitySummary:
      "試料品質が自動判断の安全境界を下回るため、試験ライブラリと中止条件を専門家が評価します。",
    manualSummary: "ご要望により専門家へ引き継ぎ、AI の最終提案を停止しました。",
  },
} satisfies Record<Locale, Record<string, string>>;

const verifiedEvidence: Evidence[] = [
  {
    id: "E-SOP-042",
    source: "SOP",
    title: "FFPE RNA 建库与质控规范",
    citation: "NV-SOP-RNA-042",
    version: "v6.2",
    appliesTo: "FFPE RNA; DV200 ≥ 50%; 10–100 ng",
    validUntil: "2027-03-31",
    validation: "verified",
  },
  {
    id: "E-PMID-35361992",
    source: "SCI",
    title: "Performance of RNA sequencing methods for degraded FFPE material",
    citation: "PMID: 35361992",
    version: "2022",
    appliesTo: "FFPE-derived RNA expression profiling",
    validUntil: "2027-12-31",
    validation: "verified",
  },
  {
    id: "E-DOI-101038",
    source: "SCI",
    title: "Benchmarking library preparation from low-quality clinical RNA",
    citation: "DOI: 10.1038/s41598-021-00042-7",
    version: "2021",
    appliesTo: "Low-input and degraded RNA",
    validUntil: "2027-12-31",
    validation: "verified",
  },
];

export function inferScenarioFromQuestion(
  question: string,
  facts: ProjectFacts,
): Scenario {
  if (/冲突|矛盾|conflict|contradict|inconsistent|競合|相反/i.test(question)) {
    return "evidence-conflict";
  }
  if (/专家|人工|expert|human|specialist|専門家|担当者|オペレーター/i.test(question)) {
    return "manual-escalation";
  }
  if (/不知道|缺少|没有.*dv200|don'?t know|unknown|missing|わから|不明/i.test(question)) {
    return "missing-dv200";
  }
  if (/非标准|特殊样本|non[- ]standard|特殊試料/i.test(question)) {
    return "non-standard";
  }
  if (
    facts.material != null &&
    !(/ffpe/i.test(facts.material) && /rna/i.test(facts.material))
  ) {
    return "non-standard";
  }
  if (facts.dv200 == null) return "missing-dv200";
  return "standard";
}

function buildRisk(scenario: Scenario, facts: ProjectFacts): RiskAssessment {
  if (scenario === "evidence-conflict") {
    return {
      level: "high",
      score: 86,
      mandatoryEscalation: true,
      signals: ["SOP 与外部文献冲突", "DV200 处于灰区"],
    };
  }
  if (scenario === "manual-escalation") {
    return {
      level: "high",
      score: 75,
      mandatoryEscalation: true,
      signals: ["客户主动要求人工"],
    };
  }
  if (scenario === "non-standard") {
    return {
      level: "high",
      score: 92,
      mandatoryEscalation: true,
      signals: ["非标准样本", "可逆性低"],
    };
  }
  if (
    facts.material != null &&
    !(/ffpe/i.test(facts.material) && /rna/i.test(facts.material))
  ) {
    return {
      level: "high",
      score: 94,
      mandatoryEscalation: true,
      signals: ["样本材料超出证据适用范围", "禁止套用 FFPE RNA 方案"],
    };
  }
  if (facts.dv200 != null && facts.dv200 < 40) {
    return {
      level: "high",
      score: 90,
      mandatoryEscalation: true,
      signals: ["极低质量样本", "建库失败后果较高"],
    };
  }
  if (scenario === "missing-dv200") {
    return {
      level: "medium",
      score: 58,
      mandatoryEscalation: false,
      signals: ["关键质控指标缺失"],
    };
  }
  if (
    (facts.dv200 != null && facts.dv200 < 50) ||
    (facts.rnaInputNg != null && facts.rnaInputNg < 10)
  ) {
    return {
      level: "medium",
      score: 64,
      mandatoryEscalation: false,
      signals: ["未满足 SOP 自动推荐边界", "需要额外质控或试建库"],
    };
  }
  if (facts.rnaInputNg == null) {
    return {
      level: "medium",
      score: 56,
      mandatoryEscalation: false,
      signals: ["RNA 投入量缺失"],
    };
  }
  if (facts.material == null) {
    return {
      level: "medium",
      score: 59,
      mandatoryEscalation: false,
      signals: ["样本材料未确认"],
    };
  }
  return {
    level: "low",
    score: 22,
    mandatoryEscalation: false,
    signals: ["证据充分", "方案可逆"],
  };
}

export function runConsultationJourney(
  input: ConsultationInput,
): ConsultationResult {
  const localized = copy[input.locale];
  const risk = buildRisk(input.scenario, input.facts);
  const needsDv200 = input.scenario === "missing-dv200" || input.facts.dv200 == null;
  const needsRnaInput = input.facts.rnaInputNg == null;
  const needsMaterial = input.facts.material == null;
  const mustEscalate = risk.mandatoryEscalation;
  const evaluatedAt = new Date().toISOString();
  const meetsSopBoundary =
    input.facts.dv200 != null &&
    input.facts.dv200 >= 50 &&
    input.facts.rnaInputNg != null &&
    input.facts.rnaInputNg >= 10;
  const factRecords: ProjectFactRecord[] = Object.entries(input.facts)
    .filter((entry): entry is [keyof ProjectFacts, string | number] => entry[1] != null)
    .map(([field, value]) => ({
      field,
      value,
      source: "customer",
      extractedAt: evaluatedAt,
      confidence: 1,
      confirmation: "confirmed",
      version: 1,
      visibility: "project-members",
    }));
  const status: CardStatus = mustEscalate
    ? "expert-review"
    : needsDv200 || needsRnaInput || needsMaterial
      ? "needs-conditions"
      : !meetsSopBoundary || risk.level !== "low"
        ? "provisional"
      : "formal";
  const evidence = verifiedEvidence.map((item) =>
    input.scenario === "evidence-conflict" && item.id === "E-PMID-35361992"
      ? { ...item, validation: "conflict" as const }
      : item,
  );
  const recommendations: Recommendation[] =
    status !== "formal"
      ? []
      : [
          {
            id: "REC-LIBRARY",
            title: localized.primary,
            rationale: localized.primaryReason,
            evidenceIds: ["E-SOP-042", "E-PMID-35361992"],
            boundary: "DV200 ≥ 50%; RNA input ≥ 10 ng",
          },
          {
            id: "REC-DEPTH",
            title: localized.depthTitle,
            rationale: localized.depthReason,
            evidenceIds: ["E-SOP-042", "E-DOI-101038"],
            boundary: localized.depthBoundary,
          },
        ];

  const clarifyingQuestions: ClarifyingQuestion[] = [
    ...(needsDv200
      ? [
        {
          field: "dv200" as const,
          prompt: localized.question,
          reason: localized.questionReason,
          blocksFinalRecommendation: true,
        },
        ]
      : []),
    ...(needsRnaInput
      ? [
          {
            field: "rnaInputNg" as const,
            prompt: localized.inputQuestion,
            reason: localized.inputReason,
            blocksFinalRecommendation: true,
          },
        ]
      : []),
    ...(needsMaterial
      ? [
          {
            field: "material" as const,
            prompt: localized.materialQuestion,
            reason: localized.materialReason,
            blocksFinalRecommendation: true,
          },
        ]
      : []),
  ];

  const expertCase: ExpertCase | null = mustEscalate
    ? {
        id: "CASE-2407",
        status: "awaiting-claim",
        sla: { claimMinutes: 30, substantiveResponseHours: 4 },
        handoff: {
          objective: localized.title,
          confirmedFacts: input.facts,
          attemptedAction: "完成混合检索与科研 Reviewer 审查",
          riskLevel: risk.level,
          reason:
            input.scenario === "evidence-conflict"
              ? localized.conflictSummary
              : input.scenario === "manual-escalation"
                ? localized.manualSummary
                : localized.lowQualitySummary,
          evidenceConflict: input.scenario === "evidence-conflict",
          decisionsNeeded: ["确认灰区样本的建库路线", "给出额外质控或试建库要求"],
        },
      }
    : null;

  return {
    project: {
      id: "NP-260719",
      name: localized.project,
      locale: input.locale,
      facts: input.facts,
      factRecords,
      entityIds: ["ENTITY-FFPE", "ENTITY-RNA", "ENTITY-DV200"],
    },
    card: {
      id: "CARD-260719-03",
      version: 3,
      status,
      title: localized.title,
      customerGoal: localized.title,
      confirmedConditions: factRecords,
      budgetRange: mustEscalate ? null : localized.budget,
      timelineRange: mustEscalate ? null : localized.timeline,
      pendingItems: needsDv200 || needsRnaInput || needsMaterial
        ? clarifyingQuestions.map((question) => question.prompt)
        : mustEscalate
          ? expertCase?.handoff.decisionsNeeded ?? []
          : status === "provisional"
            ? [localized.boundarySummary]
          : [],
      expertStatus: mustEscalate ? "awaiting-claim" : "not-required",
      executiveSummary: mustEscalate
        ? expertCase?.handoff.reason ?? localized.lowQualitySummary
        : status !== "formal"
          ? localized.boundarySummary
          : localized.summary,
      recommendations,
      alternatives: status === "formal" ? [localized.alternative] : [],
      risk,
      prohibitedCtas: status !== "formal" ? ["立即执行", "最终推荐"] : [],
      serviceFit: status !== "formal"
        ? null
        : {
            title: localized.serviceTitle,
            rationale: localized.serviceReason,
            limitations: localized.serviceLimit,
          },
    },
    evidence,
    clarifyingQuestions,
    expertCase,
    traceId: "trace-np-260719-001",
  };
}

const processedConsentKeys = new Map<string, string>();
const activeConsents = new Set<string>();

export function recordConsent(input: {
  projectId: string;
  granted: boolean;
  action?: "request-quote" | "book-expert" | "allow-contact";
  idempotencyKey?: string;
}) {
  const authorizedAction =
    input.granted &&
    input.action != null &&
    ["request-quote", "book-expert", "allow-contact"].includes(input.action);
  const fingerprint = `${input.projectId}:${input.action ?? "none"}:${input.granted}`;
  const previousFingerprint = input.idempotencyKey
    ? processedConsentKeys.get(input.idempotencyKey)
    : undefined;
  const conflict = previousFingerprint != null && previousFingerprint !== fingerprint;
  const wasProcessed = authorizedAction && previousFingerprint === fingerprint;
  if (input.idempotencyKey && previousFingerprint == null) {
    processedConsentKeys.set(input.idempotencyKey, fingerprint);
  }
  const consentKey = `${input.projectId}:${input.action ?? "none"}`;
  const wasActive = activeConsents.has(consentKey);
  const revoked = !conflict && !input.granted && input.action != null && wasActive;
  if (!conflict && authorizedAction) activeConsents.add(consentKey);
  if (revoked) activeConsents.delete(consentKey);
  const eventType = authorizedAction
    ? ("ConsentGranted" as const)
    : revoked
      ? ("ConsentWithdrawn" as const)
      : ("ConsentWithheld" as const);
  const event = {
    id: input.idempotencyKey ?? `consent-${input.projectId}`,
    type: eventType,
    projectId: input.projectId,
    action: input.action ?? null,
    occurredAt: new Date().toISOString(),
    source: "novapilot-decision-card" as const,
  };

  return {
    conflict,
    revoked,
    event,
    crmOpportunity: authorizedAction && !conflict
      ? {
          id: `CRM-${input.projectId}`,
          status: wasProcessed ? ("existing" as const) : ("created" as const),
          source: "authorized-novapilot-consultation",
        }
      : null,
  };
}

export function recordFeedback(input: {
  projectId: string;
  score: number;
  reason?: "citation" | "incorrect" | "unclear" | "other";
}) {
  return {
    feedbackId: `FB-${input.projectId}`,
    qualityEvent:
      input.score <= 2
        ? {
            id: `QE-${input.projectId}`,
            status: "open" as const,
            owner: "service-operations",
            reason: input.reason ?? "other",
          }
        : null,
  };
}

export function evaluateReleaseGate(input: {
  citationValidity: number;
  escalationRecall: number;
  confidentWrongDelta: number;
  p0Defects: number;
  dataBoundaryIncidents: number;
}) {
  const failed: string[] = [];
  if (input.citationValidity < 0.98) failed.push("citation-validity");
  if (input.escalationRecall < 0.95) failed.push("escalation-recall");
  if (input.confidentWrongDelta > 0) failed.push("confident-wrong");
  if (input.p0Defects > 0) failed.push("p0-defects");
  if (input.dataBoundaryIncidents > 0) failed.push("data-boundary");

  return {
    decision: failed.length === 0 ? ("proceed" as const) : ("stop" as const),
    failed,
    maxTrafficPercent: failed.length === 0 ? 10 : 0,
  };
}

export interface CandidateKnowledge {
  id: string;
  sourceCaseId: string;
  statement: string;
  evidenceIds: string[];
  scope: string;
  counterexample: string;
  owner: string;
  version: number;
  validUntil: string;
  status: "candidate" | "owner-approved" | "gray-active" | "rejected";
  productionEligible: boolean;
  auditTrail: Array<{
    stage: "candidate-created" | "owner-approved" | "novabench-passed" | "human-approved" | "gray-activated";
    actor: string;
  }>;
  rollbackVersion: string | null;
}

export function createCandidateKnowledge(input: {
  sourceCaseId: string;
  expertModification: string;
  evidenceIds: string[];
}): CandidateKnowledge {
  return {
    id: "CK-260719-017",
    sourceCaseId: input.sourceCaseId,
    statement: input.expertModification,
    evidenceIds: input.evidenceIds,
    scope: "FFPE RNA; DV200 30–40%; non-clinical research",
    counterexample: "RNA 投入量不足 10 ng 或存在人源合规待确认项时不适用",
    owner: "rna-knowledge-owner",
    version: 1,
    validUntil: "2027-03-31",
    status: "candidate",
    productionEligible: false,
    auditTrail: [{ stage: "candidate-created", actor: "novapilot" }],
    rollbackVersion: null,
  };
}

export function promoteCandidateKnowledge(
  candidate: CandidateKnowledge,
  checks: {
    ownerApproved: boolean;
    novaBenchPassed: boolean;
    grayValidationPassed: boolean;
    humanApproved: boolean;
  },
): CandidateKnowledge {
  if (!checks.ownerApproved) return { ...candidate, status: "candidate", productionEligible: false };
  if (!checks.novaBenchPassed || !checks.grayValidationPassed || !checks.humanApproved) {
    return {
      ...candidate,
      status: "owner-approved",
      productionEligible: false,
      auditTrail: [
        ...candidate.auditTrail,
        { stage: "owner-approved", actor: candidate.owner },
      ],
    };
  }
  return {
    ...candidate,
    status: "gray-active",
    productionEligible: true,
    auditTrail: [
      { stage: "owner-approved", actor: candidate.owner },
      { stage: "novabench-passed", actor: "novabench" },
      { stage: "human-approved", actor: "release-manager" },
      { stage: "gray-activated", actor: "release-manager" },
    ],
    rollbackVersion: "KV-2026.07.18",
  };
}

export function evaluateDataEgress(input: {
  containsCustomerFile: boolean;
  containsInternalSop: boolean;
  containsHumanIdentifiableData: boolean;
  deidentified: boolean;
}) {
  const sensitive =
    input.containsCustomerFile ||
    input.containsInternalSop ||
    input.containsHumanIdentifiableData;
  const allowed = !sensitive && input.deidentified;
  return {
    allowed,
    route: allowed ? ("policy-approved-external-model" as const) : ("private-model" as const),
    reason: allowed
      ? "仅包含完成公开知识推理所需的脱敏问题"
      : "检测到敏感科研数据或无法可靠脱敏",
    auditRequired: true,
  };
}
