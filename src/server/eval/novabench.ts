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
import type { ModelGatewayConfig } from "../agents/model-gateway";

export type GoldCategory = "formal" | "clarify" | "escalate" | "provisional";

export interface GoldCase {
  id: string;
  question: string;
  locale: Locale;
  facts: ProjectFacts;
  expect: GoldCategory;
  /** True if the payload should be treated as sensitive (never egress). */
  sensitive?: boolean;
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
  },
  {
    id: "G-STD-EN",
    question: "How should we run differential expression sequencing on FFPE tumor RNA samples?",
    locale: "en",
    facts: { sampleCount: 18, dv200: 68, rnaInputNg: 30, material: "FFPE RNA" },
    expect: "formal",
  },
  {
    id: "G-CLR-DV200",
    question: "FFPE样本想做RNA差异表达，接下来怎么推进",
    locale: "zh",
    facts: { sampleCount: 24, rnaInputNg: 25, material: "FFPE RNA" },
    expect: "clarify",
  },
  {
    id: "G-CLR-INPUT",
    question: "FFPE样本RNA差异表达实验如何设计",
    locale: "zh",
    facts: { sampleCount: 12, dv200: 60, material: "FFPE RNA" },
    expect: "clarify",
  },
  {
    id: "G-ESC-CONFLICT",
    question: "SOP与外部文献存在冲突，如何处理这批FFPE RNA样本",
    locale: "zh",
    facts: { sampleCount: 8, dv200: 55, rnaInputNg: 20, material: "FFPE RNA" },
    expect: "escalate",
  },
  {
    id: "G-ESC-GREY",
    question: "DV200偏低的FFPE样本能否开展RNA测序",
    locale: "zh",
    facts: { sampleCount: 10, dv200: 35, rnaInputNg: 15, material: "FFPE RNA" },
    expect: "escalate",
  },
  {
    id: "G-ESC-MANUAL",
    question: "希望直接由解决方案专家人工确认这批FFPE RNA方案",
    locale: "zh",
    facts: { sampleCount: 24, dv200: 60, rnaInputNg: 25, material: "FFPE RNA" },
    expect: "escalate",
  },
  {
    id: "G-ESC-NONFFPE",
    question: "这批样本如何做RNA表达研究",
    locale: "zh",
    facts: { sampleCount: 10, dv200: 70, rnaInputNg: 30, material: "新鲜冷冻组织 DNA" },
    expect: "escalate",
  },
  {
    id: "G-PROV-GREY",
    question: "FFPE RNA样本DV200在可接受下限，如何给出方案",
    locale: "zh",
    facts: { sampleCount: 16, dv200: 45, rnaInputNg: 20, material: "FFPE RNA" },
    expect: "provisional",
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
}

export interface NovaBenchMetrics {
  citationValidity: number;
  escalationRecall: number;
  confidentWrongDelta: number;
  p0Defects: number;
  dataBoundaryIncidents: number;
}

export interface NovaBenchReport {
  suite: string;
  total: number;
  passed: number;
  accuracy: number;
  metrics: NovaBenchMetrics;
  gate: ReturnType<typeof evaluateReleaseGate>;
  cases: CaseResult[];
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
      const evidenceById = new Map(r.evidence.map((e) => [e.id, e]));
      const invalidCitations: string[] = [];
      let citations = 0;
      for (const rec of r.card.recommendations) {
        for (const id of rec.evidenceIds) {
          citations++;
          const ev = evidenceById.get(id);
          if (!ev || ev.validation !== "verified" || ev.validUntil < today) {
            invalidCitations.push(`${rec.id}:${id}`);
          }
        }
      }
      const actual = classify(r.card.status);
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
  const dataBoundaryIncidents = cases.filter((c, i) => {
    const gold = GOLD_CASES[i];
    const external = c.provider === "anthropic" || c.provider === "openai-compatible";
    return !!gold.sensitive && external;
  }).length;

  const metrics: NovaBenchMetrics = {
    citationValidity,
    escalationRecall,
    confidentWrongDelta,
    p0Defects,
    dataBoundaryIncidents,
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
  };
}
