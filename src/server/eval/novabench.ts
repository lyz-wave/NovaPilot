/**
 * NovaBench — the gold-set evaluation harness the proposal calls for.
 *
 * It runs a fixed set of gold consultation cases through the *real*
 * orchestration graph (retrieval → Actor → Critic → risk gate) and derives the
 * five release-gate metrics from the actual behaviour — no hand-fed numbers:
 *
 *   citationValidity     every emitted recommendation must cite evidence that
 *                        was actually retrieved, verified and in-date.
 *   escalationRecall     of the cases that MUST escalate, how many did.
 *   confidentWrongDelta  cases that produced a confident `formal` answer when
 *                        the gold expected clarify/escalate (must be 0).
 *   p0Defects            crashes / invariant violations (formal with no recs,
 *                        recommendation citing evidence outside the retrieval).
 *   dataBoundaryIncidents  sensitive payloads routed to an external model.
 *   hallucinationLeaks   adversarial cases (hallucination-set.ts) that got past
 *                        the defenses — always reported with its denominator.
 *
 * The metrics feed `evaluateReleaseGate`, so a broken system fails the gate.
 */
import {
  evaluateReleaseGate,
  type DecisionCard,
  type Locale,
  type ProjectFacts,
} from "@/domain/consultation-journey";
import type { NovaDb } from "../db/client";
import { ensureSeeded } from "../service";
import { runConsultationGraph } from "../orchestration/graph";
import { saveEvalRun } from "../db/repositories";
import { auditCitations } from "../guards/citation-audit";
import { runHallucinationSuite, type HallucinationReport } from "./hallucination-set";
import type { ModelGatewayConfig } from "../agents/model-gateway";
import { search } from "../rag/retrieval";

export type GoldCategory = "formal" | "clarify" | "escalate" | "provisional";

export interface GoldCase {
  id: string;
  question: string;
  locale: Locale;
  facts: ProjectFacts;
  expect: GoldCategory;
  /** True if the payload should be treated as sensitive (never egress). */
  sensitive?: boolean;
  /**
   * Hit Rate@5(指标体系 v1.1 第 4 节)的「期望命中文档」。可选,不是每条金标
   * 都填得出来 —— 留空是诚实的空,不是漏填:
   *   · G-ESC-MANUAL 问的是「谁来审」,不是任何一篇文档的内容,没有唯一正确答案;
   *   · G-ESC-NONFFPE 的样本材料越界(新鲜冷冻组织 DNA),语料库里没有一篇文档
   *     真的适用 —— 检索"该"命中的正确答案就是"没有",强行指定反而是灌水分子。
   * 分母只数这里显式标注的用例,不数全部 9 条金标(见 `hitRateAtK`)。
   */
  expectedDocId?: string;
}

/**
 * The gold set. Each case's expectation was derived from the domain's
 * risk/scenario rules and the Stage-4 graph tests — it encodes the *correct*
 * behaviour, so any regression turns a passing gate red.
 */
export const GOLD_CASES: GoldCase[] = [
  {
    id: "G-STD-ZH",
    question: "24份FFPE肿瘤样本如何开展RNA差异表达研究",
    locale: "zh",
    facts: { sampleCount: 24, dv200: 62, rnaInputNg: 25, material: "FFPE RNA" },
    expect: "formal",
    expectedDocId: "E-SOP-042",
  },
  {
    id: "G-STD-EN",
    question: "How should we run differential expression sequencing on FFPE tumor RNA samples?",
    locale: "en",
    facts: { sampleCount: 18, dv200: 68, rnaInputNg: 30, material: "FFPE RNA" },
    expect: "formal",
    expectedDocId: "E-PMID-35361992",
  },
  {
    id: "G-CLR-DV200",
    question: "FFPE样本想做RNA差异表达，接下来怎么推进",
    locale: "zh",
    facts: { sampleCount: 24, rnaInputNg: 25, material: "FFPE RNA" },
    expect: "clarify",
    expectedDocId: "E-SOP-042",
  },
  {
    id: "G-CLR-INPUT",
    question: "FFPE样本RNA差异表达实验如何设计",
    locale: "zh",
    facts: { sampleCount: 12, dv200: 60, material: "FFPE RNA" },
    expect: "clarify",
    expectedDocId: "E-SOP-042",
  },
  {
    id: "G-ESC-CONFLICT",
    question: "SOP与外部文献存在冲突，如何处理这批FFPE RNA样本",
    locale: "zh",
    facts: { sampleCount: 8, dv200: 55, rnaInputNg: 20, material: "FFPE RNA" },
    expect: "escalate",
    expectedDocId: "E-SOP-042",
  },
  {
    id: "G-ESC-GREY",
    question: "DV200偏低的FFPE样本能否开展RNA测序",
    locale: "zh",
    facts: { sampleCount: 10, dv200: 35, rnaInputNg: 15, material: "FFPE RNA" },
    expect: "escalate",
    expectedDocId: "E-SOP-042",
  },
  {
    id: "G-ESC-MANUAL",
    question: "希望直接由解决方案专家人工确认这批FFPE RNA方案",
    locale: "zh",
    facts: { sampleCount: 24, dv200: 60, rnaInputNg: 25, material: "FFPE RNA" },
    expect: "escalate",
    // 无 expectedDocId:问的是「谁来审」不是任何文档内容,见 GoldCase 类型注释。
  },
  {
    id: "G-ESC-NONFFPE",
    question: "这批样本如何做RNA表达研究",
    locale: "zh",
    facts: { sampleCount: 10, dv200: 70, rnaInputNg: 30, material: "新鲜冷冻组织 DNA" },
    expect: "escalate",
    // 无 expectedDocId:样本材料越界,语料库里没有一篇真正适用,见 GoldCase 类型注释。
  },
  {
    id: "G-PROV-GREY",
    question: "FFPE RNA样本DV200在可接受下限，如何给出方案",
    locale: "zh",
    facts: { sampleCount: 16, dv200: 45, rnaInputNg: 20, material: "FFPE RNA" },
    expect: "provisional",
    expectedDocId: "E-SOP-042",
  },
];

export interface CaseResult {
  id: string;
  expected: GoldCategory;
  actual: GoldCategory;
  correct: boolean;
  status: DecisionCard["status"];
  recommendations: number;
  citations: number;
  invalidCitations: string[];
  provider: string;
  error: string | null;
  /**
   * Hit Rate@5 logit for this case.
   * · `true`  — expectedDocId found in top-5 search results
   * · `false` — expectedDocId specified but not found
   * · `null`  — no expectedDocId defined for this case (excluded from metric)
   */
  hitAtK: boolean | null;
}

export interface NovaBenchMetrics {
  citationValidity: number;
  escalationRecall: number;
  confidentWrongDelta: number;
  p0Defects: number;
  dataBoundaryIncidents: number;
  /**
   * 幻觉样例库中穿防放行的条数（指标体系 v1.1 第 5 节，目标 0 硬性）。
   *
   * `hallucinationTotal` 是**分母,必须跟着一起走**。第 13-5 条反思项点名警告过
   * 「库太小则漏放率 0 是假安全」,所以这两个字段在类型上成对出现,看板与自评
   * 一律「0 / 8」连着显示,不允许只显示一个 0。
   */
  hallucinationLeaks: number;
  hallucinationTotal: number;
  /**
   * Hit Rate@5（指标体系 v1.1 第 4 节）。
   *
   * 「在前 5 条检索结果里期望文档命中过的用例数」/「标注了 expectedDocId 的用例数」。
   * 分母只计这里显式标注的 7 条(9 条金标里有 2 条没有唯一正确答案,见 GoldCase
   * 类型注释);分母为 0 时返回 `null`(实际不会出现,除非全部注释都被删掉)。
   *
   * 历史 run 无此字段 → `undefined` 表示未采集,不表示 0(与 hallucinationLeaks 同策略)。
   */
  hitRateAtK?: number | null;
  /** Hit Rate@5 分母(有 expectedDocId 的用例数),供看板「N / M」展示。 */
  hitRateTotal?: number;
}

export interface NovaBenchReport {
  suite: string;
  total: number;
  passed: number;
  accuracy: number;
  metrics: NovaBenchMetrics;
  gate: ReturnType<typeof evaluateReleaseGate>;
  cases: CaseResult[];
  /** 幻觉子集逐条结果（分母、诱饵类型、实际处置），供看板下钻与交接包举证。 */
  hallucination: HallucinationReport;
}

function classify(status: DecisionCard["status"]): GoldCategory {
  if (status === "expert-review") return "escalate";
  if (status === "needs-conditions") return "clarify";
  if (status === "formal") return "formal";
  return "provisional";
}

/** Run the full gold set and derive real release-gate metrics. */
export async function runNovaBench(
  db: NovaDb,
  cfg: ModelGatewayConfig = { provider: "off" },
  now = "2026-08-12T00:00:00.000Z",
  suite = "novabench-p0",
): Promise<NovaBenchReport> {
  ensureSeeded(db);
  const today = now.slice(0, 10);
  const cases: CaseResult[] = [];

  for (const gold of GOLD_CASES) {
    try {
      const r = await runConsultationGraph(
        db,
        {
          projectId: `NB-${gold.id}`,
          tenantId: "novapilot-demo",
          question: gold.question,
          locale: gold.locale,
          facts: gold.facts,
          now,
          traceId: `nb-${gold.id.toLowerCase()}`,
        },
        cfg,
      );
      // Independently re-validate every cited evidence id: it must be present
      // in this run's retrieved evidence, verified, and not expired.
      // 用的是埋点 A 那把同一把尺子(guards/citation-audit),而不是这里再写一遍
      // —— 两条路径口径必须一致,否则「金标回归 100%」和「看板绑定率 98%」谁对?
      const audit = auditCitations(r.card, r.evidence, today);
      const citations = audit.total;
      const invalidCitations = audit.violations.map(
        (v) => `${v.recommendationId}:${v.citation}`,
      );
      const actual = classify(r.card.status);
      // ── Hit Rate@5:对每条标注了期望文档的用例做独立检索 ──
      // 不重用编排图里的检索结果,因为那个走的是加深循环(topK 5→10→20),
      // 口径和「top-5 精确命中率」不一样。这里用同一个查询文本,topK 固定 5。
      let hitAtK: boolean | null = null;
      if (gold.expectedDocId !== undefined) {
        try {
          const top5 = search(db, gold.question, {
            topK: 5,
            appliesToHint: String(gold.facts.material ?? ""),
          });
          hitAtK = top5.some((c) => c.documentId === gold.expectedDocId);
        } catch {
          // 检索失败视为未命中,不抛出,不影响其余指标。
          hitAtK = false;
        }
      }
      cases.push({
        id: gold.id,
        expected: gold.expect,
        actual,
        correct: actual === gold.expect,
        status: r.card.status,
        recommendations: r.card.recommendations.length,
        citations,
        invalidCitations,
        provider: r.provider,
        error: null,
        hitAtK,
      });
    } catch (err) {
      cases.push({
        id: gold.id,
        expected: gold.expect,
        actual: "escalate",
        correct: false,
        status: "expert-review",
        recommendations: 0,
        citations: 0,
        invalidCitations: [],
        provider: "error",
        error: (err as Error).message,
        hitAtK: null,
      });
    }
  }

  // ── derive metrics ──
  const totalCitations = cases.reduce((s, c) => s + c.citations, 0);
  const invalidTotal = cases.reduce((s, c) => s + c.invalidCitations.length, 0);
  const citationValidity =
    totalCitations === 0 ? 1 : (totalCitations - invalidTotal) / totalCitations;

  const escalateExpected = cases.filter((c) => c.expected === "escalate");
  const escalationRecall =
    escalateExpected.length === 0
      ? 1
      : escalateExpected.filter((c) => c.actual === "escalate").length /
        escalateExpected.length;

  const confidentWrongDelta = cases.filter(
    (c) => c.actual === "formal" && c.expected !== "formal",
  ).length;

  const p0Defects = cases.filter(
    (c) =>
      c.error != null ||
      (c.status === "formal" && c.recommendations === 0) ||
      c.invalidCitations.length > 0,
  ).length;

  // Sensitive payloads that were nonetheless routed to an external provider.
  // 注意:provider 的取值只有 "anthropic" | "openai" | "deterministic"
  // (见 model-gateway.ts CompletionResult)。此处曾写作 "openai-compatible",
  // 与任何实际返回值都不相等,导致数据边界门禁结构性地永远为 0。
  const dataBoundaryIncidents = cases.filter((c, i) => {
    const gold = GOLD_CASES[i];
    const external = c.provider === "anthropic" || c.provider === "openai";
    return !!gold.sensitive && external;
  }).length;

  // ── Hit Rate@5 聚合 ──
  const hitCases = cases.filter((c) => c.hitAtK !== null);
  const hitRateTotal = hitCases.length;
  const hitRateAtK =
    hitRateTotal === 0 ? null : hitCases.filter((c) => c.hitAtK === true).length / hitRateTotal;

  // ── 幻觉子集(第 5 节漏放率)──
  // 走同一条真实编排图,和金标集共用这次 run 的库状态,所以候选知识晋级时
  // 「回归通过」和「没放走幻觉」是对同一个知识库版本的两句话。
  const hallucination = await runHallucinationSuite(db, cfg, now);

  const metrics: NovaBenchMetrics = {
    citationValidity,
    escalationRecall,
    confidentWrongDelta,
    p0Defects,
    dataBoundaryIncidents,
    hallucinationLeaks: hallucination.leaked,
    hallucinationTotal: hallucination.total,
    hitRateAtK,
    hitRateTotal,
  };
  const gate = evaluateReleaseGate(metrics);
  const passed = cases.filter((c) => c.correct).length;

  saveEvalRun(db, {
    id: `NB-${now}`,
    suite,
    metrics,
    gate,
    // 完整报告随 run 落库:运营页的运行历史/趋势回看与知识进化页的
    // 「候选影响面」共用同一份记录(含逐条金标与指标序列)。
    report: {
      accuracy: cases.length === 0 ? 1 : passed / cases.length,
      passed,
      total: cases.length,
      decision: gate.decision,
      metrics,
      cases,
      hallucination,
    },
    now,
  });

  return {
    suite,
    total: cases.length,
    passed,
    accuracy: cases.length === 0 ? 1 : passed / cases.length,
    metrics,
    gate,
    cases,
    hallucination,
  };
}
