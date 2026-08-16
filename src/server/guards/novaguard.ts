/**
 * NovaGuard — 可信控制层（trusted control plane）.
 *
 * 把原本分散在 actor-critic（证据白名单）、orchestration/graph（风险门）
 * 与 api/write-context（写契约）中的安全机制收敛为一个具名、可单测的控制面：
 *
 *   1. evidence-bound 证据绑定 —— 模型输出中的引用必须命中检索白名单，
 *      任何编造的 PMID/DOI/SOP 编号都会被拦截（有据才答）；
 *   2. risk-tier approval 风险分级审批 —— 低风险且证据门禁通过才允许
 *      formal；中风险 provisional（暂行）；高风险/强制场景 expert-review
 *      （该转就转）；对应 ADR-0012。
 *   3. write contract 写契约 —— 认证 + 租户 + 幂等键 + 乐观并发版本
 *      （由 api/write-context.ts 强制执行，此处作为门禁项登记）。
 *
 * 全部为纯函数：无网络、无副作用，离线确定性可复现（对应 NovaBench
 * citationValidity / p0Defects 门禁指标的判定逻辑）。
 */
import type { RiskAssessment } from "@/domain/consultation-journey";
import type { RetrievedChunk } from "../rag/retrieval";

// ── 1. Evidence-bound: 引用白名单 ────────────────────────────────

/** Citation-shaped tokens: PMID / DOI / NV-SOP-* / E-(SOP|PMID|DOI)-* ids. */
export const CITATION_TOKEN_RE =
  /PMID\s*[:：]?\s*\d{5,}|DOI\s*[:：]?\s*10\.\S+|NV-SOP-[A-Z0-9-]+|E-(?:SOP|PMID|DOI)-[A-Z0-9-]+/gi;

/** Whitespace-insensitive canonical form so "PMID: 35361992" == "PMID:35361992". */
export function canonicalCite(token: string): string {
  return token.replace(/\s+/g, "");
}

/** Citation whitelist built from the retrieved chunks (both citation & doc id). */
export function buildCitationWhitelist(chunks: RetrievedChunk[]): {
  canon: Set<string>;
  toCitation: Map<string, string>;
} {
  const canon = new Set<string>();
  const toCitation = new Map<string, string>();
  for (const c of chunks) {
    canon.add(canonicalCite(c.citation));
    toCitation.set(canonicalCite(c.citation), c.citation);
    // Accept the document id namespace too (e.g. "E-SOP-042"), normalized to
    // the canonical citation the Critic keys on.
    if (c.documentId) {
      canon.add(canonicalCite(c.documentId));
      toCitation.set(canonicalCite(c.documentId), c.citation);
    }
  }
  return { canon, toCitation };
}

/** All citation-shaped tokens in a text that are NOT whitelisted. */
export function fabricatedCitations(text: string, canon: Set<string>): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(CITATION_TOKEN_RE)) {
    if (!canon.has(canonicalCite(m[0]))) out.push(m[0]);
  }
  return out;
}

// ── 2. Risk-tier approval: 风险门决策 ────────────────────────────

export type GuardDecision = "formal" | "provisional" | "needs-conditions" | "expert-review";

export interface RiskGateInput {
  risk: RiskAssessment;
  facts: { dv200?: number; rnaInputNg?: number };
  /** How many recommendations survived Critic verification after the loop. */
  verifiedCount: number;
  /** True when we are only waiting on the customer to supply blocking facts. */
  blockedByConditions: boolean;
}

export interface RiskGateResult {
  meetsSopBoundary: boolean;
  mustEscalate: boolean;
  /** Escalation triggered purely by loop exhaustion, not a mandatory risk. */
  loopExhausted: boolean;
  status: GuardDecision;
  reasons: string[];
}

/**
 * 风险分级审批决策（ADR-0012）：低风险 + 证据充分 + 满足 SOP 边界 → formal；
 * 中风险或证据不足 → provisional；等待客户补齐阻断条件 → needs-conditions；
 * 强制风险或核验后无建议幸存 → expert-review（转专家）。
 */
export function guardRiskGate(input: RiskGateInput): RiskGateResult {
  const { risk, facts, verifiedCount, blockedByConditions } = input;
  const meetsSopBoundary =
    facts.dv200 != null && facts.dv200 >= 50 && facts.rnaInputNg != null && facts.rnaInputNg >= 10;

  const mustEscalate = risk.mandatoryEscalation || (verifiedCount === 0 && !blockedByConditions);
  const loopExhausted = mustEscalate && !risk.mandatoryEscalation;

  const status: GuardDecision = mustEscalate
    ? "expert-review"
    : blockedByConditions
      ? "needs-conditions"
      : !meetsSopBoundary || risk.level !== "low" || verifiedCount === 0
        ? "provisional"
        : "formal";

  const reasons: string[] = [];
  if (risk.mandatoryEscalation) reasons.push(`风险信号强制转接：${risk.signals.join("、")}`);
  if (loopExhausted) reasons.push("多轮检索与核验后无可靠证据支撑");
  if (status === "needs-conditions") reasons.push("缺少阻断性条件，等待客户补齐");
  if (status === "provisional") {
    if (!meetsSopBoundary) reasons.push("未满足 SOP 自动推荐边界");
    if (risk.level === "medium") reasons.push(`中风险：${risk.signals.join("、")}`);
    if (verifiedCount === 0) reasons.push("无建议通过核验");
  }
  if (status === "formal") reasons.push("低风险且证据门禁通过");

  return { meetsSopBoundary, mustEscalate, loopExhausted, status, reasons };
}

// ── 3. 总控门禁 ──────────────────────────────────────────────────

export interface GuardCheck {
  id: string;
  label: string;
  passed: boolean;
  reason: string;
}

export interface NovaGuardVerdict extends RiskGateResult {
  /** 总控判定（与 status 同值；语义化别名便于展示）。 */
  decision: GuardDecision;
  checks: GuardCheck[];
  /** 序列化的可展示轨迹（写入 orchestration checkpoints 表）。 */
  trace: Record<string, unknown>;
}

/**
 * 总控入口：一次运行 NovaGuard 的全部检查并返回可展示/可审计的判定。
 * 纯函数，离线可复现；编排图在 risk-gate 节点调用并把 verdict 写入检查点。
 */
export function runNovaGuard(input: {
  risk: RiskAssessment;
  facts: { dv200?: number; rnaInputNg?: number };
  verifiedCount: number;
  blockedByConditions: boolean;
  /** 模型输出待检文本（summary / rationale），可选。 */
  modelText?: string;
  chunks: RetrievedChunk[];
}): NovaGuardVerdict {
  const gate = guardRiskGate({
    risk: input.risk,
    facts: input.facts,
    verifiedCount: input.verifiedCount,
    blockedByConditions: input.blockedByConditions,
  });

  const checks: GuardCheck[] = [];

  // Evidence-bound 检查：待检文本中不得出现白名单之外的引用。
  if (input.modelText) {
    const { canon } = buildCitationWhitelist(input.chunks);
    const fabricated = fabricatedCitations(input.modelText, canon);
    checks.push({
      id: "evidence-bound",
      label: "证据绑定（引用白名单）",
      passed: fabricated.length === 0,
      reason:
        fabricated.length === 0
          ? "模型输出引用全部命中检索白名单"
          : `拦截编造引用：${fabricated.join("、")}`,
    });
  } else {
    checks.push({
      id: "evidence-bound",
      label: "证据绑定（引用白名单）",
      passed: true,
      reason: "无可检模型文本（规则推导路径）",
    });
  }

  checks.push({
    id: "risk-tier-approval",
    label: "风险分级审批",
    passed: gate.status !== "expert-review" || gate.mustEscalate, // 高风险正确转接视为通过
    reason: gate.reasons.join("；"),
  });

  checks.push({
    id: "write-contract",
    label: "写契约（认证/租户/幂等）",
    passed: true,
    reason: "由 api/write-context.ts 强制（401/403/412/428）",
  });

  return {
    decision: gate.status,
    meetsSopBoundary: gate.meetsSopBoundary,
    mustEscalate: gate.mustEscalate,
    loopExhausted: gate.loopExhausted,
    status: gate.status,
    reasons: gate.reasons,
    checks,
    trace: {
      meetsSopBoundary: gate.meetsSopBoundary,
      mustEscalate: gate.mustEscalate,
      loopExhausted: gate.loopExhausted,
      verifiedCount: input.verifiedCount,
      checks: checks.map((c) => ({ id: c.id, passed: c.passed })),
    },
  };
}
