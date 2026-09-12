/**
 * §5 防线质量 —— 三层防线各层通过率（规则校验 / 语义复核 / NovaGuard）。
 *
 * 三层的「通过」发生在两种不同的自然单位上：规则校验与语义复核审的是
 * **建议粒度**（一次 review 里可能有好几条候选建议，各自过关或被拦）；
 * NovaGuard 审的是**答案粒度**（它决定的是这张卡最终放不放行，不是某一条
 * 建议）。硬把三层拗成同一个分母，会把「20 条建议全过关」和「1 条建议过
 * 关」算成同一个 100%，所以这里各按各的自然分母分别计。
 *
 * 数据源全部来自 checkpoints —— review / risk-gate 两个节点早就把 Critic
 * 的 findings、语义复核的丢弃数、NovaGuard 的逐项 checks 写进了 JSON 快照，
 * 缺的只是把它们聚合出来，不需要新埋点。
 *
 * checkpoints 主键是 (trace_id, node) + ON CONFLICT DO UPDATE —— 一次加深
 * 检索跑三轮，表里只留最后一轮的状态，天然就是「这次咨询的最终结果」，
 * 不必再挑 MAX(round)。
 */
import { queryAll, type NovaDb } from "../db/client";

interface CriticFindingLite {
  citationValid?: boolean;
  inScope?: boolean;
}
interface LoopTraceEntryLite {
  dropped?: number;
}
interface ReviewState {
  findings?: CriticFindingLite[];
  loopTrace?: LoopTraceEntryLite[];
}
interface GuardCheckLite {
  id?: string;
  passed?: boolean;
}
interface RiskGateState {
  checks?: GuardCheckLite[];
}

export interface DefenseLayerRow {
  layer: "规则校验" | "语义复核" | "scope-contract" | "NovaGuard";
  /** 该层实际经手的分母（建议数或答案数，视层而定）。 */
  measured: number;
  passed: number;
  /** measured 为 0 是「本窗口没有样本」，不是「0% 通过」。 */
  rate: number | null;
}

export interface DefenseLayerBoard {
  layers: DefenseLayerRow[];
  /** 参与统计的咨询 trace 数（有 review 检查点的那些）。 */
  traces: number;
}

function parseState<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function rate(passed: number, measured: number): number | null {
  return measured === 0 ? null : passed / measured;
}

/**
 * 规则校验 + 语义复核：两层都从 review 检查点的最终态里读。
 *
 * - 规则校验分母 = 该轮 Critic 过手的建议数（= findings.length，一条建议
 *   进 runCritic() 必留一条 finding）；分子 = 引用有效且在适用范围内的
 *   那些——原样复刻 runCritic() 里 approved 的判据，不是另起一套口径
 *   （见 actor-critic.ts 的 runCritic）。
 * - 语义复核只审「规则已经放行」的那些建议：分母 = 规则层的分子；分子 =
 *   分母减去语义复核判「证据不支撑结论」而丢弃的那些（loopTrace 最后
 *   一轮的 dropped，见 grounding-loop.ts 的 reviewNode）。规则层放行 0 条
 *   的那次咨询，语义层无样本可审，不计入语义层分母——否则会被记成语义层
 *   的「0% 通过」，而那本该是规则层的问题。
 */
function ruleAndSemanticLayers(
  db: NovaDb,
  since: string | null,
): { rule: DefenseLayerRow; semantic: DefenseLayerRow } {
  const rows = queryAll<{ state: string }>(
    db,
    `SELECT state FROM checkpoints WHERE node = 'review' AND (? IS NULL OR created_at >= ?)`,
    since,
    since,
  );

  let ruleMeasured = 0;
  let rulePassed = 0;
  let semanticMeasured = 0;
  let semanticPassed = 0;

  for (const row of rows) {
    const state = parseState<ReviewState>(row.state);
    const findings = state?.findings ?? [];
    if (findings.length === 0) continue; // 这一轮没有建议可审，两层都没有分母

    ruleMeasured += findings.length;
    const ruleVerified = findings.filter((f) => f.citationValid && f.inScope).length;
    rulePassed += ruleVerified;

    if (ruleVerified === 0) continue; // 规则层全拦，语义层无样本可审
    const dropped = state?.loopTrace?.at(-1)?.dropped ?? 0;
    semanticMeasured += ruleVerified;
    semanticPassed += Math.max(0, ruleVerified - dropped);
  }

  return {
    rule: { layer: "规则校验", measured: ruleMeasured, passed: rulePassed, rate: rate(rulePassed, ruleMeasured) },
    semantic: {
      layer: "语义复核",
      measured: semanticMeasured,
      passed: semanticPassed,
      rate: rate(semanticPassed, semanticMeasured),
    },
  };
}

/**
 * scope-contract 层：答案粒度，专从 risk-gate 检查点里提取 id="scope-contract"
 * 的那一项。分母与 NovaGuard 层相同（做出最终判定的答案数）；分子是「该项
 * check 单独 passed」的那些——把它从 NovaGuard 汇总中拆分出来，允许独立监控
 * 适用范围契约的合规率趋势，而不被 evidence-bound 等其他检查稀释。
 */
function scopeContractLayer(db: NovaDb, since: string | null): DefenseLayerRow {
  const rows = queryAll<{ state: string }>(
    db,
    `SELECT state FROM checkpoints WHERE node = 'risk-gate' AND (? IS NULL OR created_at >= ?)`,
    since,
    since,
  );

  let measured = 0;
  let passed = 0;
  for (const row of rows) {
    const checks = parseState<RiskGateState>(row.state)?.checks;
    if (!checks || checks.length === 0) continue;
    const sc = checks.find((c) => c.id === "scope-contract");
    if (!sc) continue;
    measured += 1;
    if (sc.passed) passed += 1;
  }
  return { layer: "scope-contract", measured, passed, rate: rate(passed, measured) };
}

/**
 * NovaGuard：答案粒度。分母是这一窗口内做出最终判定的咨询数（每个 trace
 * 一条 risk-gate 检查点），分子是「四项 checks 全部 passed」的那些——即这次
 * 判定没有触发任何一项拦截（证据绑定 / 风险分级审批 / 适用范围契约 / 写
 * 契约）。
 *
 * 口径提醒：risk-tier-approval 与 scope-contract 两项检查把「正确识别风险
 * 并转专家」也算作 passed（见 novaguard.ts 的 runNovaGuard）——所以这一行
 * 读的是「NovaGuard 全程没有发现任何异常」，不是「答案没被转专家」；转了
 * 专家但四项检查都合规的咨询，同样计入这一层的通过。
 */
function novaGuardLayer(db: NovaDb, since: string | null): DefenseLayerRow {
  const rows = queryAll<{ state: string }>(
    db,
    `SELECT state FROM checkpoints WHERE node = 'risk-gate' AND (? IS NULL OR created_at >= ?)`,
    since,
    since,
  );

  let measured = 0;
  let passed = 0;
  for (const row of rows) {
    const checks = parseState<RiskGateState>(row.state)?.checks;
    if (!checks || checks.length === 0) continue;
    measured += 1;
    if (checks.every((c) => c.passed)) passed += 1;
  }
  return { layer: "NovaGuard", measured, passed, rate: rate(passed, measured) };
}

/**
 * §5 三层防线看板。每层独立 try/catch，与 guardrail-board / retrieval-log
 * 同策略：老库缺 checkpoints 或某层数据形状变了，只降级那一层，不拖垮
 * 整块运营页。
 */
export function defenseLayerBoard(db: NovaDb, sinceIso?: string): DefenseLayerBoard {
  const since = sinceIso ?? null;
  const empty = (layer: DefenseLayerRow["layer"]): DefenseLayerRow => ({
    layer,
    measured: 0,
    passed: 0,
    rate: null,
  });
  const safe = <T>(label: string, fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch (err) {
      console.error(`[telemetry] 口径缺格 defense-layers:${label}`, err);
      return fallback;
    }
  };

  const { rule, semantic } = safe("rule+semantic", () => ruleAndSemanticLayers(db, since), {
    rule: empty("规则校验"),
    semantic: empty("语义复核"),
  });
  const scopeContract = safe("scope-contract", () => scopeContractLayer(db, since), empty("scope-contract"));
  const guard = safe("novaguard", () => novaGuardLayer(db, since), empty("NovaGuard"));
  const traces = safe(
    "traces",
    () =>
      queryAll<{ n: number }>(
        db,
        `SELECT COUNT(*) AS n FROM checkpoints WHERE node = 'review' AND (? IS NULL OR created_at >= ?)`,
        since,
        since,
      )[0]?.n ?? 0,
    0,
  );

  return { layers: [rule, semantic, scopeContract, guard], traces };
}
