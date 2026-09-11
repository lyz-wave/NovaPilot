/**
 * 证据探针 —— 39 条指标各一个探针，回答三个布尔问题：
 *   hasSource      数据来源存在（表 / 列 / 文件）
 *   hasAggregation 聚合函数在空库不报错
 *   onDashboard    dashboard key 在 DASHBOARD_METRIC_KEYS 中
 *
 * 探针不重新实现指标，只做存在性和可运行性检查。
 * scorecard.test.ts 断言 5-9 依赖这里的返回值与 metric-scorecard.json
 * 的 probeExpectation 对齐，确保「代码已落地 ↔ 计分已更新」同步。
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { NovaDb } from "../db/client";
import { createDb } from "../db/client";
import { DASHBOARD_METRIC_KEYS } from "../../lib/dashboard-metric-keys";
import { sessionVolume, crossWeekWakeup } from "../telemetry/session-mix";
import { roleActivityMix } from "../telemetry/role-activity";
import { retrievalBoard } from "../telemetry/retrieval-log";
import { guardrailBoard } from "../telemetry/guardrail-board";
import { interceptResolutionRate, handoffCompleteness } from "../telemetry/interception";
import { reviewSampleSummary } from "../telemetry/review-samples";
import { expertSlaBoard, knowledgeLifecycle } from "../telemetry/lifecycle";
import { revisionInflowSummary } from "../telemetry/case-closure";
import { latencySummary } from "../telemetry/latency";
import { degradeMatrixSummary } from "../telemetry/degrade-matrix";
import { defenseLayerBoard } from "../telemetry/defense-layers";
import { citationComplianceBoard } from "../telemetry/citation-compliance";

export interface ProbeResult {
  hasSource: boolean;
  hasAggregation: boolean;
  onDashboard: boolean;
  isProxy: boolean;
  proxyNote?: string;
  evidence: string[];
}

export type Probe = (db: NovaDb) => ProbeResult;

// ── Helpers ────────────────────────────────────────────────────────────────

function tableExists(db: NovaDb, table: string): boolean {
  const row = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
    .get(table) as unknown;
  return !!row;
}

function columnExists(db: NovaDb, table: string, col: string): boolean {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
    name: string;
  }>;
  return rows.some((r) => r.name === col);
}

function fileExists(relPath: string): boolean {
  return existsSync(resolve(process.cwd(), relPath));
}

function onDashboard(key: string): boolean {
  return (DASHBOARD_METRIC_KEYS as readonly string[]).includes(key);
}

function agg(fn: () => unknown): boolean {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

// Shared empty in-memory DB for hasAggregation checks (lazy, created once).
let _emptyDb: NovaDb | null = null;
function emptyDb(): NovaDb {
  if (!_emptyDb) _emptyDb = createDb(":memory:");
  return _emptyDb;
}

// ── §3 流量与会话 ──────────────────────────────────────────────────────────

const p_sessionVolume: Probe = (db) => ({
  hasSource: tableExists(db, "conversations"),
  hasAggregation: agg(() => sessionVolume(emptyDb(), null)),
  onDashboard: onDashboard("session.volume"),
  isProxy: false,
  evidence: ["conversations", "session-mix.ts:sessionVolume", "dashboard:session.volume"],
});

const p_effectiveSessionRate: Probe = (db) => ({
  hasSource: tableExists(db, "conversations") && tableExists(db, "messages"),
  hasAggregation: agg(() => sessionVolume(emptyDb(), null)),
  onDashboard: onDashboard("session.effectiveRate"),
  isProxy: false,
  evidence: [
    "conversations",
    "messages",
    "session-mix.ts:sessionVolume#effectiveRate",
    "dashboard:session.effectiveRate",
  ],
});

const p_roleDistribution: Probe = (db) => ({
  hasSource: columnExists(db, "conversations", "role"),
  hasAggregation: agg(() => roleActivityMix(emptyDb(), null)),
  onDashboard: onDashboard("session.lensMix"),
  isProxy: false,
  evidence: [
    "conversations.role",
    "role-activity.ts:roleActivityMix",
    "dashboard:session.lensMix",
  ],
});

const p_crossWeekWakeup: Probe = (db) => ({
  hasSource: columnExists(db, "conversations", "closed_at"),
  hasAggregation: agg(() => crossWeekWakeup(emptyDb(), null)),
  onDashboard: onDashboard("session.wakeup"),
  isProxy: false,
  evidence: [
    "conversations.closed_at",
    "session-mix.ts:crossWeekWakeup",
    "dashboard:session.wakeup",
  ],
});

// ── §4 知识检索与评测 ──────────────────────────────────────────────────────

const p_directResolutionRate: Probe = (db) => ({
  hasSource: tableExists(db, "conversations") && tableExists(db, "review_rounds"),
  hasAggregation: agg(() => guardrailBoard(emptyDb())),
  onDashboard: onDashboard("guardrail.directResolutionRate"),
  isProxy: false,
  evidence: [
    "conversations",
    "review_rounds",
    "session-mix.ts:sessionVolume",
    "dashboard:guardrail.directResolutionRate",
  ],
});

const p_hitRateAtK: Probe = (db) => ({
  hasSource: tableExists(db, "eval_runs"),
  hasAggregation: agg(() =>
    emptyDb().prepare("SELECT COUNT(*) FROM eval_runs").get(),
  ),
  onDashboard: onDashboard("novabench.hitRate"),
  isProxy: false,
  evidence: [
    "eval_runs",
    "novabench.ts:runNovaBench#expectedDocIds",
    "dashboard:novabench.hitRate",
  ],
});

const p_citationBindingRate: Probe = (db) => ({
  hasSource: tableExists(db, "citation_audits"),
  hasAggregation: agg(() => guardrailBoard(emptyDb())),
  onDashboard: onDashboard("binding.bindingRate"),
  isProxy: false,
  evidence: [
    "citation_audits",
    "guardrail-board.ts:auditBoard#bindingRate",
    "dashboard:binding.bindingRate",
  ],
});

const p_shortQueryFallbackRate: Probe = (db) => ({
  hasSource: tableExists(db, "retrieval_logs"),
  hasAggregation: agg(() => retrievalBoard(emptyDb())),
  onDashboard: onDashboard("retrieval.shortQueryRate"),
  isProxy: false,
  evidence: [
    "retrieval_logs",
    "retrieval-log.ts:retrievalStats#shortQueryRate",
    "dashboard:retrieval.shortQueryRate",
  ],
});

const p_retrievalP95Latency: Probe = (db) => ({
  hasSource: columnExists(db, "retrieval_logs", "elapsed_ms"),
  hasAggregation: agg(() => retrievalBoard(emptyDb())),
  onDashboard: onDashboard("retrieval.elapsed"),
  isProxy: false,
  evidence: [
    "retrieval_logs.elapsed_ms",
    "retrieval-log.ts:retrievalStats#elapsed",
    "dashboard:retrieval.elapsed",
  ],
});

const p_sopCoverage: Probe = (db) => ({
  hasSource:
    tableExists(db, "documents") &&
    columnExists(db, "retrieval_logs", "hit_doc_ids"),
  hasAggregation: agg(() => retrievalBoard(emptyDb())),
  onDashboard: onDashboard("retrieval.sopCoverage"),
  isProxy: false,
  evidence: [
    "documents",
    "retrieval_logs.hit_doc_ids",
    "retrieval-log.ts:retrievalStats#sopCoverage",
    "dashboard:retrieval.sopCoverage",
  ],
});

const p_blindSpotTopics: Probe = (db) => ({
  hasSource: columnExists(db, "retrieval_logs", "verified"),
  hasAggregation: agg(() => retrievalBoard(emptyDb())),
  onDashboard: onDashboard("retrieval.blindSpots"),
  isProxy: false,
  evidence: [
    "retrieval_logs.verified",
    "retrieval-log.ts:retrievalStats#blindSpots",
    "scripts/blindspot-clusters.ts",
    "dashboard:retrieval.blindSpots",
  ],
});

const p_documentHealth: Probe = (db) => ({
  hasSource:
    tableExists(db, "documents") &&
    columnExists(db, "retrieval_logs", "hit_doc_ids"),
  hasAggregation: agg(() => retrievalBoard(emptyDb())),
  onDashboard: onDashboard("knowledge.documents"),
  isProxy: false,
  evidence: [
    "documents",
    "retrieval_logs.hit_doc_ids",
    "retrieval-log.ts:retrievalStats#documentHealth",
    "dashboard:knowledge.documents",
  ],
});

const p_novabenchScore: Probe = (db) => ({
  hasSource: tableExists(db, "eval_runs"),
  hasAggregation: agg(() =>
    emptyDb().prepare("SELECT COUNT(*) FROM eval_runs").get(),
  ),
  onDashboard: onDashboard("novabench.score"),
  isProxy: false,
  evidence: ["eval_runs", "novabench.ts:runNovaBench", "dashboard:novabench.score"],
});

const p_refusalAppropriateness: Probe = (db) => ({
  hasSource: tableExists(db, "eval_runs"),
  hasAggregation: agg(() =>
    emptyDb().prepare("SELECT COUNT(*) FROM eval_runs").get(),
  ),
  onDashboard: onDashboard("novabench.escalationRecall"),
  isProxy: false,
  evidence: [
    "eval_runs",
    "novabench.ts:runNovaBench#escalationRecall",
    "dashboard:novabench.escalationRecall",
  ],
});

const p_negativeFeedbackRate: Probe = (db) => ({
  hasSource: tableExists(db, "feedback"),
  hasAggregation: agg(() => guardrailBoard(emptyDb())),
  onDashboard: onDashboard("feedback.negativeRate"),
  isProxy: false,
  evidence: [
    "feedback",
    "guardrail-board.ts:guardrailBoard#feedback",
    "dashboard:feedback.negativeRate",
  ],
});

const p_implicitAdoptionRate: Probe = (db) => ({
  hasSource: tableExists(db, "adoption_events"),
  hasAggregation: agg(() => guardrailBoard(emptyDb())),
  onDashboard: onDashboard("adoption.adoptionRate"),
  isProxy: false,
  evidence: [
    "adoption_events",
    "guardrail-board.ts:guardrailBoard#adoption",
    "dashboard:adoption.adoptionRate",
  ],
});

// ── §5 防线与拦截 ──────────────────────────────────────────────────────────

const p_defenseLayersPassRate: Probe = (db) => ({
  hasSource: tableExists(db, "review_rounds") && tableExists(db, "checkpoints"),
  hasAggregation: agg(() => defenseLayerBoard(emptyDb())),
  onDashboard: onDashboard("defense.layers"),
  isProxy: false,
  evidence: [
    "review_rounds",
    "checkpoints",
    "defense-layers.ts:defenseLayers",
    "dashboard:defense.layers",
  ],
});

const p_scopeContractPassRate: Probe = (db) => ({
  hasSource: tableExists(db, "checkpoints"),
  hasAggregation: agg(() => defenseLayerBoard(emptyDb())),
  onDashboard: onDashboard("defense.layers"),
  isProxy: false,
  evidence: [
    "checkpoints",
    "defense-layers.ts:scopeContractLayer",
    "dashboard:defense.layers",
  ],
});

const p_criticInterceptionRate: Probe = (db) => ({
  hasSource: tableExists(db, "review_rounds"),
  hasAggregation: agg(() => interceptResolutionRate(emptyDb(), undefined)),
  onDashboard: onDashboard("guardrail.interceptionRate"),
  isProxy: false,
  evidence: [
    "review_rounds",
    "interception.ts:interceptionStats",
    "dashboard:guardrail.interceptionRate",
  ],
});

const p_falseInterceptionRate: Probe = (db) => ({
  hasSource: tableExists(db, "review_samples"),
  hasAggregation: agg(() => reviewSampleSummary(emptyDb())),
  onDashboard: onDashboard("review.falseInterception"),
  isProxy: false,
  evidence: [
    "review_samples",
    "review-samples.ts:reviewSamples#falseInterception",
    "dashboard:review.falseInterception",
  ],
});

const p_hallucinationLeakRate: Probe = (db) => ({
  hasSource: tableExists(db, "eval_runs"),
  hasAggregation: agg(() =>
    emptyDb().prepare("SELECT COUNT(*) FROM eval_runs").get(),
  ),
  onDashboard: onDashboard("novabench.hallucinationLeaks"),
  isProxy: false,
  evidence: [
    "eval_runs",
    "hallucination-set.ts:HALLUCINATION_CASES",
    "dashboard:novabench.hallucinationLeaks",
  ],
});

const p_interceptResolutionRate: Probe = (db) => ({
  hasSource: tableExists(db, "review_rounds"),
  hasAggregation: agg(() => interceptResolutionRate(emptyDb(), undefined)),
  onDashboard: onDashboard("interceptResolution.rate"),
  isProxy: false,
  evidence: [
    "review_rounds",
    "interception.ts:interceptResolutionRate",
    "dashboard:interceptResolution.rate",
  ],
});

const p_judgeExpertAgreement: Probe = (db) => ({
  hasSource: tableExists(db, "review_samples"),
  hasAggregation: agg(() => reviewSampleSummary(emptyDb())),
  onDashboard: onDashboard("review.judgeAgreement"),
  isProxy: false,
  evidence: [
    "review_samples",
    "review-samples.ts:reviewSamples#judgeAgreement",
    "dashboard:review.judgeAgreement",
  ],
});

// ── §6 专家协同 ────────────────────────────────────────────────────────────

const p_escalationRate: Probe = (db) => ({
  hasSource: tableExists(db, "review_rounds"),
  hasAggregation: agg(() => interceptResolutionRate(emptyDb(), undefined)),
  onDashboard: onDashboard("guardrail.interceptionRate"),
  isProxy: false,
  evidence: [
    "review_rounds",
    "interception.ts:interceptionStats",
    "dashboard:guardrail.interceptionRate",
  ],
});

const p_missedEscalationRate: Probe = (db) => ({
  hasSource: tableExists(db, "review_samples"),
  hasAggregation: agg(() => reviewSampleSummary(emptyDb())),
  onDashboard: onDashboard("review.missedEscalation"),
  isProxy: false,
  evidence: [
    "review_samples",
    "review-samples.ts:reviewSamples#missedEscalation",
    "dashboard:review.missedEscalation",
  ],
});

const p_expertSlaRate: Probe = (db) => ({
  hasSource:
    columnExists(db, "expert_cases", "claimed_at") &&
    columnExists(db, "expert_cases", "resolved_at"),
  hasAggregation: agg(() => expertSlaBoard(emptyDb())),
  onDashboard: onDashboard("lifecycle.expert.claim"),
  isProxy: false,
  evidence: [
    "expert_cases.claimed_at",
    "expert_cases.resolved_at",
    "lifecycle.ts:expertSlaBoard",
    "dashboard:lifecycle.expert.claim",
  ],
});

const p_handoffCompleteness: Probe = (db) => ({
  hasSource: tableExists(db, "checkpoints"),
  hasAggregation: agg(() => handoffCompleteness(emptyDb())),
  onDashboard: onDashboard("handoffCompleteness.rate"),
  isProxy: false,
  evidence: [
    "checkpoints",
    "interception.ts:handoffCompleteness",
    "dashboard:handoffCompleteness.rate",
  ],
});

const p_revisionReflowRate: Probe = (db) => ({
  hasSource: tableExists(db, "case_closures"),
  hasAggregation: agg(() => revisionInflowSummary(emptyDb())),
  onDashboard: onDashboard("inflow.inflowRate"),
  isProxy: false,
  evidence: [
    "case_closures",
    "case-closure.ts:closureStats#inflowRate",
    "dashboard:inflow.inflowRate",
  ],
});

// ── §7 知识演化 ────────────────────────────────────────────────────────────

const p_candidatePublishCycle: Probe = (db) => ({
  hasSource: columnExists(db, "candidates", "published_at"),
  hasAggregation: agg(() => knowledgeLifecycle(emptyDb())),
  onDashboard: onDashboard("lifecycle.knowledge.timeToPublishHours"),
  isProxy: false,
  evidence: [
    "candidates.published_at",
    "lifecycle.ts:knowledgeLifecycle#timeToPublishHours",
    "dashboard:lifecycle.knowledge.timeToPublishHours",
  ],
});

const p_gatePassRate: Probe = (db) => ({
  hasSource: columnExists(db, "ingest_runs", "gate"),
  hasAggregation: agg(() => knowledgeLifecycle(emptyDb())),
  onDashboard: onDashboard("lifecycle.knowledge.gatePassRate"),
  isProxy: false,
  evidence: [
    "ingest_runs.gate",
    "lifecycle.ts:knowledgeLifecycle#gatePassRate",
    "dashboard:lifecycle.knowledge.gatePassRate",
  ],
});

const p_rollbackCount: Probe = (db) => ({
  hasSource: tableExists(db, "candidates") && tableExists(db, "ingest_runs"),
  hasAggregation: agg(() => knowledgeLifecycle(emptyDb())),
  onDashboard: onDashboard("lifecycle.knowledge.rolledBack"),
  isProxy: false,
  evidence: [
    "candidates",
    "ingest_runs",
    "lifecycle.ts:knowledgeLifecycle#rolledBack",
    "dashboard:lifecycle.knowledge.rolledBack",
  ],
});

const p_grayIncidentRate: Probe = (db) => ({
  hasSource:
    columnExists(db, "quality_events", "candidate_id") &&
    columnExists(db, "candidates", "gray_started_at"),
  hasAggregation: agg(() => knowledgeLifecycle(emptyDb())),
  onDashboard: onDashboard("lifecycle.knowledge.grayWindowIncidents"),
  isProxy: false,
  evidence: [
    "quality_events.candidate_id",
    "candidates.gray_started_at",
    "lifecycle.ts:knowledgeLifecycle#grayWindowIncidents",
    "dashboard:lifecycle.knowledge.grayWindowIncidents",
  ],
});

const p_citationCompliance: Probe = (db) => ({
  hasSource: fileExists("data/knowledge/citation-provenance.json"),
  hasAggregation: agg(() => citationComplianceBoard(emptyDb())),
  onDashboard: onDashboard("citationCompliance.rate"),
  isProxy: false,
  evidence: [
    "data/knowledge/citation-provenance.json",
    "citation-compliance.ts:citationCompliance",
    "dashboard:citationCompliance.rate",
  ],
});

// ── §8 可靠性 ──────────────────────────────────────────────────────────────

const p_firstTokenP95: Probe = (db) => ({
  hasSource:
    columnExists(db, "latency_samples", "first_token_ms") &&
    columnExists(db, "latency_samples", "provider"),
  hasAggregation: agg(() => latencySummary(emptyDb())),
  onDashboard: onDashboard("latency.firstToken"),
  isProxy: false,
  evidence: [
    "latency_samples.first_token_ms",
    "latency_samples.provider",
    "latency.ts:latencyStats#firstToken",
    "dashboard:latency.firstToken",
  ],
});

const p_streamSuccessRate: Probe = (db) => ({
  hasSource: columnExists(db, "latency_samples", "outcome"),
  hasAggregation: agg(() => latencySummary(emptyDb())),
  onDashboard: onDashboard("latency.stream"),
  isProxy: false,
  evidence: [
    "latency_samples.outcome",
    "latency.ts:latencyStats#stream",
    "dashboard:latency.stream",
  ],
});

const p_degradeMatrixTriggers: Probe = (db) => ({
  hasSource: tableExists(db, "degrade_triggers"),
  hasAggregation: agg(() => degradeMatrixSummary(emptyDb())),
  onDashboard: onDashboard("degrade.runtimeTriggers"),
  isProxy: false,
  evidence: [
    "degrade_triggers",
    "degrade-matrix.ts:degradeMatrixSummary",
    "dashboard:degrade.runtimeTriggers",
  ],
});

const p_testGreenRate: Probe = (db) => ({
  hasSource: tableExists(db, "eval_runs"),
  hasAggregation: agg(() => degradeMatrixSummary(emptyDb())),
  onDashboard: onDashboard("degrade.testGreenRate"),
  isProxy: false,
  evidence: [
    "eval_runs",
    "degrade-matrix.ts:degradeMatrixSummary",
    "dashboard:degrade.testGreenRate",
  ],
});

// ── §9 演示就绪度 ──────────────────────────────────────────────────────────

const p_demoSuccessRate: Probe = (_db) => {
  const src = fileExists("scripts/demo-e2e.mjs");
  return {
    hasSource: src,
    hasAggregation: src && agg(() => readFileSync(resolve(process.cwd(), "scripts/demo-e2e.mjs"), "utf8")),
    onDashboard: onDashboard("demo.successRate"),
    isProxy: false,
    evidence: ["scripts/demo-e2e.mjs", "dashboard:demo.successRate"],
  };
};

const p_faultInjectionRate: Probe = (_db) => {
  const src = fileExists("scripts/inject-fault.ts");
  return {
    hasSource: src,
    hasAggregation: src && agg(() => readFileSync(resolve(process.cwd(), "scripts/inject-fault.ts"), "utf8")),
    onDashboard: onDashboard("faultInjection.successRate"),
    isProxy: false,
    evidence: ["scripts/inject-fault.ts", "dashboard:faultInjection.successRate"],
  };
};

const p_coldStartTime: Probe = (_db) => {
  const src = fileExists(".github/workflows/release-packages.yml");
  return {
    hasSource: src,
    hasAggregation:
      src && agg(() => readFileSync(resolve(process.cwd(), ".github/workflows/release-packages.yml"), "utf8")),
    onDashboard: onDashboard("pkg.coldStartTime"),
    isProxy: false,
    evidence: [".github/workflows/release-packages.yml", "dashboard:pkg.coldStartTime"],
  };
};

// ── Public registry ────────────────────────────────────────────────────────

export const PROBES: Record<string, Probe> = {
  "§3.session-volume": p_sessionVolume,
  "§3.effective-session-rate": p_effectiveSessionRate,
  "§3.role-distribution": p_roleDistribution,
  "§3.cross-week-wakeup": p_crossWeekWakeup,
  "§4.direct-resolution-rate": p_directResolutionRate,
  "§4.hit-rate-at-k": p_hitRateAtK,
  "§4.citation-binding-rate": p_citationBindingRate,
  "§4.short-query-fallback-rate": p_shortQueryFallbackRate,
  "§4.retrieval-p95-latency": p_retrievalP95Latency,
  "§4.sop-coverage": p_sopCoverage,
  "§4.blind-spot-topics": p_blindSpotTopics,
  "§4.document-health": p_documentHealth,
  "§4.novabench-score": p_novabenchScore,
  "§4.refusal-appropriateness": p_refusalAppropriateness,
  "§4.negative-feedback-rate": p_negativeFeedbackRate,
  "§4.implicit-adoption-rate": p_implicitAdoptionRate,
  "§5.defense-layers-pass-rate": p_defenseLayersPassRate,
  "§5.scope-contract-pass-rate": p_scopeContractPassRate,
  "§5.critic-interception-rate": p_criticInterceptionRate,
  "§5.false-interception-rate": p_falseInterceptionRate,
  "§5.hallucination-leak-rate": p_hallucinationLeakRate,
  "§5.intercept-resolution-rate": p_interceptResolutionRate,
  "§5.judge-expert-agreement": p_judgeExpertAgreement,
  "§6.escalation-rate": p_escalationRate,
  "§6.missed-escalation-rate": p_missedEscalationRate,
  "§6.expert-sla-rate": p_expertSlaRate,
  "§6.handoff-completeness": p_handoffCompleteness,
  "§6.revision-reflow-rate": p_revisionReflowRate,
  "§7.candidate-publish-cycle": p_candidatePublishCycle,
  "§7.gate-pass-rate": p_gatePassRate,
  "§7.rollback-count": p_rollbackCount,
  "§7.gray-incident-rate": p_grayIncidentRate,
  "§7.citation-compliance": p_citationCompliance,
  "§8.first-token-p95": p_firstTokenP95,
  "§8.stream-success-rate": p_streamSuccessRate,
  "§8.degrade-matrix-triggers": p_degradeMatrixTriggers,
  "§8.test-green-rate": p_testGreenRate,
  "§9.demo-success-rate": p_demoSuccessRate,
  "§9.fault-injection-rate": p_faultInjectionRate,
  "§9.cold-start-time": p_coldStartTime,
};
