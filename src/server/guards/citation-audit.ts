/**
 * 埋点 A · 引用号反查审计(指标体系 v1.1 第 12 节 / 4.1 节「证据绑定率」)。
 *
 * 出卡前把卡上**每一个**引用号拿回本轮检索结果里反查一遍:在不在、是不是
 * `verified`、有没有过期。三项全过才算「绑定成立」。
 *
 * 为什么要独立一层,而不是信 Critic 的放行结论:
 *
 *   证据绑定率是这个系统的生命线指标(目标 100%,硬性、非估算)。让生成链路自己
 *   报告「我的引用都是真的」,等于自己证明自己通过 —— Critic 有 bug、白名单构造
 *   有 bug、卡装配时引用号被换掉,任何一处出问题都会让它照样报「通过」。所以这一
 *   段代码刻意只依赖两个输入(卡 + 本轮证据),不看任何中间状态,不复用生成路径的
 *   任何判断。它和 Critic 得出同一结论时才是真的通过。
 *
 * 纯函数、无 IO、离线可复现。持久化由 `recordCitationAudit()` 负责,和判定分开,
 * 这样 NovaBench(不落库)与运行时(落库)可以共用同一段判定逻辑 —— 两条路径用
 * 同一把尺子,是这个指标可信的前提。
 */
import type { DecisionCard, Evidence } from "@/domain/consultation-journey";
import { queryAll, type NovaDb } from "../db/client";

export type CitationViolationReason =
  /** 引用号不在本轮检索结果里 —— 最严重的一种:凭空出现的证据。 */
  | "not-retrieved"
  /** 命中了,但那条证据本身是 conflict / expired 状态,不该被引用。 */
  | "not-verified"
  /** 命中且 verified,但已过有效期。 */
  | "expired";

export interface CitationViolation {
  /** 出问题的建议 id,便于在卡上定位。 */
  recommendationId: string;
  /** 被引用的证据 id。 */
  citation: string;
  reason: CitationViolationReason;
}

export interface CitationAudit {
  /** 卡上引用号总数(按出现次数计,同一条证据被两个建议引用算两次)。 */
  total: number;
  /** 反查成立的个数。 */
  bound: number;
  /**
   * 绑定率。`total === 0` 时记 1 —— 一张没有任何引用的卡(纯规则推导路径或
   * needs-conditions)不算违规,不该把分母为零的会话拉成 0% 污染指标。
   * 「该引用却没引用」是另一个问题,由 Critic 的建议核验负责,不在这里判。
   */
  bindingRate: number;
  violations: CitationViolation[];
}

/**
 * 反查审计。`today` 传 `YYYY-MM-DD`;有效期比较是字符串比较,所以摄取侧强制
 * `validUntil` 必须是这个格式(见 rag/ingest.ts 的 zod 校验)。
 */
export function auditCitations(
  card: Pick<DecisionCard, "recommendations">,
  evidence: readonly Evidence[],
  today: string,
): CitationAudit {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const violations: CitationViolation[] = [];
  let total = 0;

  for (const rec of card.recommendations) {
    for (const id of rec.evidenceIds) {
      total++;
      const ev = byId.get(id);
      if (!ev) {
        violations.push({ recommendationId: rec.id, citation: id, reason: "not-retrieved" });
      } else if (ev.validation !== "verified") {
        violations.push({ recommendationId: rec.id, citation: id, reason: "not-verified" });
      } else if (ev.validUntil < today) {
        violations.push({ recommendationId: rec.id, citation: id, reason: "expired" });
      }
    }
  }

  const bound = total - violations.length;
  return { total, bound, bindingRate: total === 0 ? 1 : bound / total, violations };
}

/**
 * 落一条审计记录。绑定率 < 100% 时**同时**落一条 quality_events —— 指标体系
 * 第 11 节把「证据绑定率 < 100%」定为 P0 告警路径(质量事件 + 冻结发版),所以它
 * 不能只是看板上一个变小的数字,必须触发那条既有的质量事件闭环。
 *
 * 写入失败不允许影响出卡:埋点是观测设施,观测设施坏了不该让主链路跟着断。
 * 所以整段包在 try 里,失败只告警。
 */
export function recordCitationAudit(
  db: NovaDb,
  input: {
    projectId: string;
    traceId: string;
    cardStatus: string;
    audit: CitationAudit;
    now: string;
  },
): void {
  try {
    const id = `CA-${input.traceId}`;
    db.prepare(
      `INSERT INTO citation_audits
         (id, project_id, trace_id, card_status, total, bound, binding_rate, violations, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         card_status = excluded.card_status, total = excluded.total, bound = excluded.bound,
         binding_rate = excluded.binding_rate, violations = excluded.violations,
         created_at = excluded.created_at`,
    ).run(
      id,
      input.projectId,
      input.traceId,
      input.cardStatus,
      input.audit.total,
      input.audit.bound,
      input.audit.bindingRate,
      JSON.stringify(input.audit.violations),
      input.now,
    );

    if (input.audit.bindingRate < 1) {
      const detail = input.audit.violations
        .map((v) => `${v.recommendationId}:${v.citation}(${v.reason})`)
        .join("、");
      db.prepare(
        `INSERT INTO quality_events(id, project_id, status, owner, reason, created_at)
         VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET reason = excluded.reason`,
      ).run(
        `QE-${id}`,
        input.projectId,
        "open",
        "quality",
        `P0 · 证据绑定率 ${(input.audit.bindingRate * 100).toFixed(1)}% < 100%:${detail}`,
        input.now,
      );
    }
  } catch (err) {
    console.warn(`[citation-audit] 埋点写入失败(不影响出卡): ${(err as Error).message}`);
  }
}

export interface BindingRateSummary {
  /** 审计过的卡数。 */
  cards: number;
  /** 引用号总数。 */
  citations: number;
  /** 绑定成立的引用号数。 */
  bound: number;
  /** 按引用号加权的绑定率(不是各卡绑定率的平均 —— 后者会让引用少的卡权重虚高)。 */
  bindingRate: number;
  /** 绑定率 < 100% 的卡数。每一张都是一个 P0。 */
  violatingCards: number;
}

/** 看板口径:按引用号加权汇总。`sinceIso` 可选,用来切自然周。 */
export function bindingRateSummary(db: NovaDb, sinceIso?: string): BindingRateSummary {
  const row = queryAll<{
    cards: number;
    citations: number;
    bound: number;
    violatingCards: number;
  }>(
    db,
    `SELECT COUNT(*) AS cards,
            COALESCE(SUM(total), 0) AS citations,
            COALESCE(SUM(bound), 0) AS bound,
            COALESCE(SUM(CASE WHEN binding_rate < 1 THEN 1 ELSE 0 END), 0) AS violatingCards
     FROM citation_audits
     WHERE (? IS NULL OR created_at >= ?)`,
    sinceIso ?? null,
    sinceIso ?? null,
  )[0]!;
  return {
    ...row,
    bindingRate: row.citations === 0 ? 1 : row.bound / row.citations,
  };
}
