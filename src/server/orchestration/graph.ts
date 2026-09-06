/**
 * Consultation orchestration graph (LangGraph replacement).
 *
 * A deterministic state machine that wires together the real subsystems built
 * in Stages 1–3:
 *
 *   ingest → infer-scenario → risk → clarify? → retrieve → draft(Actor)
 *          → review(Critic) → risk-gate → (escalate | finalize)
 *
 * Every node writes a checkpoint to the DB (`checkpoints` table) so a run is
 * inspectable and resumable — this is the "有状态智能体中枢 + 任务检查点".
 *
 * The graph produces the same ConsultationResult shape the frontend already
 * consumes, but the recommendations/evidence now come from live retrieval +
 * Actor/Critic verification instead of hardcoded arrays.
 */
import {
  buildRisk,
  inferScenarioFromQuestion,
  type ConsultationResult,
  type DecisionCard,
  type Evidence,
  type Locale,
  type ProjectFacts,
  type ProjectFactRecord,
  type Recommendation,
  type Scenario,
} from "@/domain/consultation-journey";
import { queryAll, type NovaDb } from "../db/client";
import {
  upsertProject,
  saveFacts,
  saveDecisionCard,
  saveExpertCase,
} from "../db/repositories";
import {
  backfillSemanticVectors,
  chunkCount,
  type RetrievedChunk,
} from "../rag/retrieval";
import { seedKnowledgeWithIngestion } from "../rag/ingest";
import { auditCitations, recordCitationAudit } from "../guards/citation-audit";
import { enqueueReviewSample } from "../telemetry/review-samples";
import {
  MAX_ROUNDS,
  runGroundingLoop,
  type ActorResult,
  type CriticResult,
} from "./grounding-loop";
import { embedSemantic } from "../rag/semantic";
import { syncDecisionCard } from "../feishu/bitable";
import {
  searchSimilarCases,
  recordCaseMemory,
  type SimilarCase,
} from "../rag/case-memory";
import { deriveScopeHint } from "../agents/actor-critic";
import { runNovaGuard } from "../guards/novaguard";
import {
  buildCapabilityManifest,
  checkScopeContract,
  describeScopeViolations,
} from "../guards/scope-contract";
import type { ChatMessage, ModelGatewayConfig } from "../agents/model-gateway";

export interface GraphInput {
  projectId: string;
  tenantId: string;
  question: string;
  locale: Locale;
  facts: ProjectFacts;
  now: string;
  traceId: string;
  /** Recent conversation turns (oldest first) so the Actor answers in context. */
  history?: ChatMessage[];
  /**
   * When true, a grounded (formal/provisional) outcome is written back to the
   * resolved-case memory for future similar-case retrieval. Off by default so
   * eval/tests don't cross-contaminate; the live service turns it on.
   */
  recordMemory?: boolean;
}

export type GraphNode =
  | "ingest"
  | "infer-scenario"
  | "risk"
  | "clarify"
  /** 适用范围契约:物种/检测类型/能力边界越界检查(仅在检出越界时落点)。 */
  | "scope-contract"
  | "retrieve"
  | "draft"
  | "review"
  | "risk-gate"
  | "escalate"
  | "finalize"
  /** 埋点 A:出卡前引用号反查审计(指标体系 v1.1 第 12 节)。 */
  | "citation-audit"
  /** 埋点 B:抽样入复核队列(误拦截率 / 该转未转率的唯一真值来源)。 */
  | "review-sample";

export interface GraphResult extends ConsultationResult {
  path: GraphNode[];
  scenario: Scenario;
  criticApproved: boolean;
  provider: string;
}

function checkpoint(
  db: NovaDb,
  traceId: string,
  node: GraphNode,
  state: unknown,
  now: string,
): void {
  db.prepare(
    `INSERT INTO checkpoints(trace_id, node, state, created_at)
     VALUES(?, ?, ?, ?)
     ON CONFLICT(trace_id, node) DO UPDATE SET state = excluded.state, created_at = excluded.created_at`,
  ).run(traceId, node, JSON.stringify(state ?? null), now);
}

function chunkToEvidence(c: RetrievedChunk): Evidence {
  return {
    id: c.chunkId,
    source: c.source,
    title: c.title,
    citation: c.citation,
    version: c.version,
    appliesTo: c.appliesTo,
    validUntil: c.validUntil,
    validation: c.validation as Evidence["validation"],
  };
}

const CLARIFY_COPY: Record<Locale, { dv200: string; input: string; material: string }> = {
  zh: {
    dv200: "请补充样本的 DV200 检测结果。",
    input: "请补充可用于建库的 RNA 投入量（ng）。",
    material: "请确认样本材料是否为 FFPE RNA。",
  },
  en: {
    dv200: "Please provide the sample DV200 measurement.",
    input: "Please provide the RNA input available for library preparation (ng).",
    material: "Please confirm whether the material is FFPE-derived RNA.",
  },
  ja: {
    dv200: "試料の DV200 測定値を入力してください。",
    input: "ライブラリ調製に使用できる RNA 投入量（ng）を入力してください。",
    material: "試料が FFPE 由来 RNA であることを確認してください。",
  },
};

const ESCALATE_COPY: Record<Locale, string> = {
  zh: "已携带完整上下文转交解决方案专家，AI 暂停输出最终方案。",
  en: "Escalated to a solution expert with full context. AI final advice is paused.",
  ja: "完全なコンテキストと共に専門家へ引き継ぎました。AI の最終提案を停止します。",
};

// Reason recorded when the grounding loop exhausts its round budget without any
// recommendation surviving verification — a graceful "insufficient evidence"
// handoff rather than shipping an unverifiable answer.
const LOOP_EXHAUSTED_COPY: Record<Locale, string> = {
  zh: "多轮加深检索与核验后仍无可靠证据支撑，已携带完整论证过程转交解决方案专家。",
  en: "After several deepened retrieval and verification rounds no reliably grounded recommendation emerged; escalated to a solution expert with the full reasoning trail.",
  ja: "検索と検証を複数回深掘りしても十分な根拠が得られなかったため、全推論過程と共に専門家へ引き継ぎました。",
};

// 越界转接的措辞。刻意和 LOOP_EXHAUSTED_COPY 分开:「找了三轮没找到」和「这件事
// 不该由这个通道回答」是两种不同的交接语境,而且越界必须**当面说出越界在哪**
// (具体理由由 describeScopeViolations 追加在后面),否则客户只会看到一句
// 无信息量的「已转专家」,并不知道该去问谁。
const OUT_OF_SCOPE_COPY: Record<Locale, string> = {
  zh: "该请求越出了本知识库声明的适用范围或服务能力边界，已转交解决方案专家，AI 不就此给出方案：",
  en: "This request falls outside the applicability scope declared by this knowledge base, or outside the service capability boundary; escalated to a solution expert and no AI recommendation is issued:",
  ja: "本ナレッジベースが宣言する適用範囲、またはサービス能力の境界を超える依頼のため、専門家へ引き継ぎ、AI からの提案は行いません：",
};

// Grounding-loop round budget lives with the loop itself (grounding-loop.ts) so
// both orchestrators share one definition; re-exported here for callers that
// used to read it off this module.
export { MAX_ROUNDS };

/**
 * Run the consultation graph end-to-end. Persists project, facts, checkpoints,
 * decision card and (if escalated) the expert case.
 */
export async function runConsultationGraph(
  db: NovaDb,
  input: GraphInput,
  cfg: ModelGatewayConfig = {},
): Promise<GraphResult> {
  const path: GraphNode[] = [];
  const visit = (n: GraphNode, state: unknown) => {
    path.push(n);
    checkpoint(db, input.traceId, n, state, input.now);
  };

  // 检索前确保知识库已就绪:无论先访问哪个页面(如专家工作台),交接包
  // 都必须带真实证据链,而不是空检索。幂等,已加载时零成本。
  if (chunkCount(db) === 0) seedKnowledgeWithIngestion(db);
  // 再补一次语义向量。不能只在「刚种库」时补 —— 首页的 ensureSeeded() 是同步
  // 的(React server component 里不适合等 24MB 模型),它先种完库,这里
  // chunkCount 就不为 0 了;存量 v2 库升级上来同理。所以按「缺哪条补哪条」
  // 做,而不是按「是否刚建库」。空缺为零时只是一次 0 行查询。
  await backfillSemanticVectors(db);

  // ── ingest ──
  upsertProject(db, {
    id: input.projectId,
    tenantId: input.tenantId,
    name: input.question.slice(0, 60) || "科研咨询项目",
    locale: input.locale,
    now: input.now,
  });
  const factRecords: ProjectFactRecord[] = Object.entries(input.facts)
    .filter((e): e is [keyof ProjectFacts, string | number] => e[1] != null)
    .map(([field, value]) => ({
      field,
      value,
      source: "customer" as const,
      extractedAt: input.now,
      confidence: 1,
      confirmation: "confirmed" as const,
      version: 1,
      visibility: "project-members" as const,
    }));
  saveFacts(db, input.projectId, factRecords);
  visit("ingest", { facts: input.facts });

  // ── infer scenario + risk ──
  const scenario = inferScenarioFromQuestion(input.question, input.facts);
  visit("infer-scenario", { scenario });
  const risk = buildRisk(scenario, input.facts);
  visit("risk", risk);

  // ── clarify (blocking questions) ──
  const needsDv200 = scenario === "missing-dv200" || input.facts.dv200 == null;
  const needsInput = input.facts.rnaInputNg == null;
  const needsMaterial = input.facts.material == null;
  const clarifyingQuestions = buildClarifying(input.locale, needsDv200, needsInput, needsMaterial);
  if (clarifyingQuestions.length > 0) visit("clarify", clarifyingQuestions.map((q) => q.field));

  // ── grounding loop: retrieve → draft(Actor) → review(Critic), deepening the
  //    search each round until a recommendation survives verification, we are
  //    blocked waiting on the customer, or the round budget is exhausted. ──
  const baseHint = deriveScopeHint(scenario, input.facts);
  const blockedByConditions = needsDv200 || needsInput || needsMaterial;
  const sensitive = false; // deidentified consult question

  // ── 适用范围契约(NovaGuard 第 3 项)──
  // 拿**问题本身**去比对知识库各文档声明的 appliesTo。刻意不用 baseHint:hint 是从
  // facts 推出来的(material=FFPE RNA),所以「FFPE 样本改做单细胞」这种问法在 hint
  // 层面完全合规 —— 那正是实测漏放 7/8 的根因。检查放在检索之前,越界请求不必再
  // 白跑三轮加深检索。
  const scopeViolations = checkScopeContract(input.question, buildCapabilityManifest(db));
  if (scopeViolations.length > 0) visit("scope-contract", scopeViolations);

  // Similar resolved cases from prior consultations — context for the Actor,
  // never citable evidence. Empty (a no-op) until the memory has been populated.
  const similarCases = searchSimilarCases(db, {
    tenantId: input.tenantId,
    question: input.question,
    facts: input.facts,
    excludeProjectId: input.projectId,
  });

  let chunks: RetrievedChunk[] = [];
  let actor!: ActorResult;
  let critic!: CriticResult;

  // 查询侧语义向量只算一次 —— 三轮加深检索用的是同一句查询文本,变的只有
  // hint 与 topK。模型不可用时为 null,检索自动退回哈希向量空间。
  const retrievalQuery = `${input.question} ${scenario}`;
  const semanticQueryVector = await embedSemantic(retrievalQuery);

  // 循环本体在 grounding-loop.ts:同一组节点函数,两种编排方式(原生 for 循环 /
  // 真实 LangGraph StateGraph)。默认原生,`NP_ORCHESTRATOR=langgraph` 切换。
  const loop = await runGroundingLoop({
    db,
    traceId: input.traceId,
    projectId: input.projectId,
    question: input.question,
    locale: input.locale,
    facts: input.facts,
    history: input.history,
    now: input.now,
    baseHint,
    blockedByConditions,
    sensitive,
    similarCases,
    retrievalQuery,
    semanticQueryVector,
    cfg,
    visit,
  });
  chunks = loop.chunks;
  actor = loop.actor;
  critic = loop.critic;
  const loopTrace = loop.loopTrace;

  // ── risk-gate (NovaGuard): escalate or finalize ──
  // 风险分级审批收敛在 NovaGuard 可信控制层（ADR-0012）：低风险且证据充分 →
  // formal；中风险/证据不足 → provisional；等待客户 → needs-conditions；
  // 强制风险或核验后无建议幸存 → expert-review。
  const guard = runNovaGuard({
    risk,
    facts: input.facts,
    verifiedCount: critic.verified.length,
    blockedByConditions,
    modelText: actor.summary,
    chunks,
    scopeViolations,
  });
  const { meetsSopBoundary, mustEscalate, loopExhausted, outOfScope } = guard;
  const status = guard.decision;
  visit("risk-gate", guard.trace);

  const evidence = chunks.map(chunkToEvidence);
  const recommendations: Recommendation[] =
    status === "formal"
      ? critic.verified.map((r) => ({
          id: r.id,
          title: r.title,
          rationale: r.rationale,
          evidenceIds: r.evidenceIds
            .map((cit) => chunks.find((c) => c.citation === cit)?.chunkId)
            .filter((x): x is string => !!x),
          boundary: r.boundary,
        }))
      : [];

  // ── hypothesis-driven confirmations (Point 2) ──
  // Instead of a fixed clarify list, derive the next-step confirmations from the
  // *recommended route's own applicability boundary* + evidence, intersected
  // with the confirmed facts. These refine a grounded answer (they never block
  // it), so they only accompany a formal card.
  const advisoryConfirmations =
    status === "formal"
      ? deriveConfirmations(input.locale, recommendations, chunks, input.facts)
      : [];

  const card: DecisionCard = {
    id: `CARD-${input.projectId}`,
    // The demo's write-context contract pins the optimistic-concurrency token to
    // "v3" (see api/write-context.ts). The card echoes that version so the client
    // round-trips a matching If-Match on its next write.
    version: 3,
    status,
    title: input.question.slice(0, 80) || "科研方案决策卡",
    customerGoal: input.question,
    confirmedConditions: factRecords,
    budgetRange: mustEscalate ? null : status === "formal" ? "¥35,000–55,000 · 以授权报价为准" : null,
    timelineRange: mustEscalate ? null : status === "formal" ? "18 天(≤30 样本) · 样本验收后确认" : null,
    // 越界时**不**追问 DV200/起始量 —— 客户补齐条件也不会让越界请求变成范围内
    // 请求;要专家决定的是「这件事我们做不做、转给谁」。
    // 待决项**必须连着理由一起写**:只写「请判定 SOP-FFPE-2099」会把一个查不到的
    // 编号裸放在卡面上,客户会以为它是真的(幻觉子集的 echo 检查就是照这个判的)。
    pendingItems: outOfScope
      ? scopeViolations.map((v) => `请专家判定是否受理 · ${v.demand}:${v.reason}`)
      : blockedByConditions
        ? clarifyingQuestions.map((q) => q.prompt)
        : mustEscalate
          ? ["确认灰区样本的建库路线", "给出额外质控或试建库要求"]
          : [],
    advisoryConfirmations: advisoryConfirmations.length ? advisoryConfirmations : undefined,
    expertStatus: mustEscalate ? "awaiting-claim" : "not-required",
    executiveSummary: mustEscalate
      ? outOfScope
        ? `${OUT_OF_SCOPE_COPY[input.locale]}${describeScopeViolations(scopeViolations)}`
        : loopExhausted
          ? LOOP_EXHAUSTED_COPY[input.locale]
          : ESCALATE_COPY[input.locale]
      : status === "formal"
        ? actor.summary || recommendations[0]?.rationale || ""
        : clarifyingQuestions[0]?.reason ?? "当前仅提供条件性判断。",
    recommendations,
    alternatives: status === "formal" && critic.verified[1] ? [critic.verified[1].title] : [],
    risk,
    prohibitedCtas: status !== "formal" ? ["立即执行", "最终推荐"] : [],
    serviceFit:
      status === "formal"
        ? {
            title: "医学转录组测序 · NovaPilot 一体化服务",
            rationale: "对齐官方医学转录组口径(0.4 μg 起始、Illumina PE150、Q30 ≥ 85%),质控、建库、测序与下游分析共享同一项目事实和证据链。",
            limitations: "最终报价、排期和样本接收以人工确认及客户授权为准。",
          }
        : null,
  };
  saveDecisionCard(db, input.projectId, card, input.traceId, input.now);
  // 飞书多维表格双写(凭证缺失时 no-op,不阻塞主流程)。
  void syncDecisionCard(card).catch(() => {});

  let expertCase: GraphResult["expertCase"] = null;
  if (mustEscalate) {
    expertCase = {
      id: `CASE-${input.projectId}`,
      status: "awaiting-claim",
      sla: { claimMinutes: 30, substantiveResponseHours: 4 },
      handoff: {
        objective: card.title,
        confirmedFacts: input.facts,
        attemptedAction: outOfScope
          ? "适用范围契约检查判定越界，未进入证据检索"
          : "完成多轮混合检索与科研 Reviewer 论证核验",
        riskLevel: risk.level,
        reason: outOfScope
          ? `越出适用范围/能力边界：${describeScopeViolations(scopeViolations)}`
          : loopExhausted
            ? LOOP_EXHAUSTED_COPY[input.locale]
            : critic.approved
              ? ESCALATE_COPY[input.locale]
              : "证据核查未通过或存在冲突",
        evidenceConflict: scenario === "evidence-conflict",
        decisionsNeeded: card.pendingItems,
        evidence,
      },
    };
    saveExpertCase(db, input.projectId, expertCase, input.now);
    visit("escalate", { caseId: expertCase.id });
  } else {
    visit("finalize", { status });
    // Write the grounded outcome back to the resolved-case memory so future
    // similar consultations can retrieve it (opt-in; off in eval/tests).
    if (input.recordMemory && (status === "formal" || status === "provisional")) {
      recordCaseMemory(db, {
        projectId: input.projectId,
        tenantId: input.tenantId,
        question: input.question,
        scenario,
        facts: input.facts,
        status,
        outcome: recommendations[0]?.title || card.executiveSummary.slice(0, 120),
        now: input.now,
      });
    }
  }

  // ── 埋点 A · 出卡前引用号反查审计 ────────────────────────────────
  // 落在 return 之前、所有分支之后:转专家的卡也要审 —— 「转专家」不等于「没引用」,
  // 交接包里带着的证据链同样要绑定成立,否则专家拿到的是一份看起来有据的空壳。
  const citationAudit = auditCitations(card, evidence, input.now.slice(0, 10));
  recordCitationAudit(db, {
    projectId: input.projectId,
    traceId: input.traceId,
    cardStatus: status,
    audit: citationAudit,
    now: input.now,
  });
  visit("citation-audit", {
    total: citationAudit.total,
    bound: citationAudit.bound,
    bindingRate: citationAudit.bindingRate,
    violations: citationAudit.violations,
  });

  // ── 埋点 B · 抽样入人工复核队列 ──────────────────────────────────
  // 只有两类会话有复核价值:转了专家的(可能拦错了)和给了正式结论的(可能该转
  // 未转)。needs-conditions 不入队 —— 那是还在问用户补信息,系统还没做处置判断,
  // 拿去让专家判「应放还是应拦」是让人给一个尚未发生的决定打分。
  // 抽样只在 recordMemory 打开时进行(= 真实用户会话)。NovaBench 与单测跑的是
  // 同一段图,但它们的 9 条金标会把队列灌满假样本,而金标本身已经有确定的期望值,
  // 不需要人来复核。
  if (input.recordMemory && (status === "expert-review" || status === "formal")) {
    const sampled = enqueueReviewSample(db, {
      kind: status === "expert-review" ? "intercepted" : "not-escalated",
      projectId: input.projectId,
      traceId: input.traceId,
      systemAction:
        status === "expert-review"
          ? `expert-review · ${risk.mandatoryEscalation ? "强制升级" : "核验未通过"} · 风险 ${risk.score}`
          : `formal · ${recommendations.length} 条建议 · 风险 ${risk.score}`,
      // 复核人需要的是「当时系统看到了什么」,不是整张卡:问题、已确认事实、风险
      // 信号、引用号。够他判断「换我会不会也这么处置」,又不至于把全文塞进一行。
      context: {
        question: input.question,
        facts: input.facts,
        scenario,
        riskLevel: risk.level,
        riskScore: risk.score,
        riskSignals: risk.signals,
        citations: card.recommendations.flatMap((r) => r.evidenceIds),
        criticApproved: critic.approved,
      },
      now: input.now,
    });
    if (sampled) visit("review-sample", { kind: status === "expert-review" ? "intercepted" : "not-escalated" });
  }

  return {
    project: {
      id: input.projectId,
      name: card.title,
      locale: input.locale,
      facts: input.facts,
      factRecords,
      entityIds: ["ENTITY-FFPE", "ENTITY-RNA", "ENTITY-DV200"],
    },
    card,
    evidence,
    clarifyingQuestions,
    expertCase,
    traceId: input.traceId,
    path,
    scenario,
    criticApproved: critic.approved,
    provider: actor.provider,
  };
}

function buildClarifying(
  locale: Locale,
  needsDv200: boolean,
  needsInput: boolean,
  needsMaterial: boolean,
): ConsultationResult["clarifyingQuestions"] {
  const c = CLARIFY_COPY[locale];
  const out: ConsultationResult["clarifyingQuestions"] = [];
  if (needsDv200)
    out.push({ field: "dv200", prompt: c.dv200, reason: "DV200 会改变建库路线与失败风险。", blocksFinalRecommendation: true });
  if (needsInput)
    out.push({ field: "rnaInputNg", prompt: c.input, reason: "SOP 要求 RNA input ≥ 10 ng。", blocksFinalRecommendation: true });
  if (needsMaterial)
    out.push({ field: "material", prompt: c.material, reason: "证据与 SOP 只适用于 FFPE RNA。", blocksFinalRecommendation: true });
  return out;
}

// Localized templates for the hypothesis-driven confirmations. Each is a
// function of the value(s) parsed out of the recommended route's boundary so
// the copy references the *actual* threshold, not a hardcoded one.
const CONFIRM_COPY: Record<
  Locale,
  {
    dv200: (n: string) => string;
    input: (range: string) => string;
    replicates: (n: number) => string;
    purpose: string;
  }
> = {
  zh: {
    dv200: (n) => `逐样本复核 DV200：确认全部样本均满足推荐路线要求的 DV200 ≥ ${n}%（当前仅有代表值）。`,
    input: (range) => `确认每个样本可用于建库的 RNA 投入量均落在 ${range} 区间内。`,
    replicates: (n) => `确认 ${n} 个样本的分组与生物学重复设计（差异表达建议每组 ≥ 3 个重复）。`,
    purpose: "确认样本物种来源与研究目的（标准差异表达或特殊设计），以锁定参考基因组与下游分析流程。",
  },
  en: {
    dv200: (n) => `Re-check DV200 per sample: confirm every sample meets the route's DV200 ≥ ${n}% (only a representative value is on file).`,
    input: (range) => `Confirm each sample's RNA input for library prep falls within ${range}.`,
    replicates: (n) => `Confirm the grouping and biological replicates for the ${n} samples (≥ 3 replicates per group is recommended for DE).`,
    purpose: "Confirm the sample species and research goal (standard DE vs a special design) to lock the reference genome and downstream pipeline.",
  },
  ja: {
    dv200: (n) => `試料ごとに DV200 を再確認：全試料が推奨経路の DV200 ≥ ${n}% を満たすことを確認してください（現在は代表値のみ）。`,
    input: (range) => `各試料のライブラリ調製用 RNA 投入量が ${range} の範囲内であることを確認してください。`,
    replicates: (n) => `${n} 試料のグループ分けと生物学的反復設計を確認してください（発現差解析では各群 ≥ 3 反復を推奨）。`,
    purpose: "試料の生物種と研究目的（標準的な発現差解析か特殊設計か）を確認し、参照ゲノムと下流解析を確定してください。",
  },
};

/**
 * Derive next-step confirmations from the recommended route's applicability
 * boundary (+ evidence) intersected with the confirmed facts. This is the
 * hypothesis-driven counterpart to the fixed clarify list: the boundary states
 * the conditions the route depends on (e.g. "DV200 ≥ 50%", "10–100 ng"), so we
 * ask the customer to confirm those conditions hold across all samples — even
 * when a representative value already passed the SOP gate.
 */
function deriveConfirmations(
  locale: Locale,
  recommendations: Recommendation[],
  chunks: RetrievedChunk[],
  facts: ProjectFacts,
): string[] {
  const copy = CONFIRM_COPY[locale];
  // Search the recommended route's boundary plus its cited evidence scopes.
  const boundary = [
    ...recommendations.map((r) => r.boundary),
    ...chunks.map((c) => c.appliesTo),
  ].join(" ; ");
  const out: string[] = [];

  const dv200Threshold = boundary.match(/DV200[^0-9]{0,6}(\d{1,3})/i)?.[1];
  if (dv200Threshold && facts.dv200 != null) out.push(copy.dv200(dv200Threshold));

  const inputRange = boundary.match(/(\d+)\s*[–\-~]\s*(\d+)\s*ng/i);
  if (inputRange && facts.rnaInputNg != null) out.push(copy.input(`${inputRange[1]}–${inputRange[2]} ng`));

  if (facts.sampleCount != null) out.push(copy.replicates(facts.sampleCount));

  out.push(copy.purpose);
  return out;
}

/** Read the ordered checkpoint trail for a trace (for inspection / resume). */
export function getCheckpoints(
  db: NovaDb,
  traceId: string,
): Array<{ node: string; state: unknown }> {
  const rows = queryAll<{ node: string; state: string }>(
    db,
    "SELECT node, state FROM checkpoints WHERE trace_id = ? ORDER BY rowid",
    traceId,
  );
  return rows.map((r) => ({ node: r.node, state: JSON.parse(r.state) }));
}
