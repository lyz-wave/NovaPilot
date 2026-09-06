/**
 * 生命周期口径(指标体系 v1.1 第 6 节「专家协同」与第 7 节「知识演化」)。
 *
 * 这两节此前拿不到分,原因同第 3 节:**缺列**。expert_cases 只有一个 status,
 * 办结那一刻没有落时刻;candidates 只有 created_at,上线那一刻也没有落时刻。
 * 没有时刻就没有周期,「30 分钟认领 / 4 小时实质响应」这两条 SLA 只能靠人肉翻
 * payload。v9 迁移补了 claimed_at / resolved_at / published_at / gray_started_at,
 * 这个模块把周期算出来。
 *
 * 一条贯穿全文件的纪律:**分位数用 nearest-rank,不用平均**。
 * 平均办结时长会被一两条拖了三天的疑难案例拉到没法看,而 SLA 达标率问的是
 * 「大多数案子准时了吗」。均值也一并给出,但看板上排在分位数后面。
 */
import type { NovaDb } from "../db/client";
import { queryAll, queryOne } from "../db/client";
import type { ExpertCase } from "@/domain/consultation-journey";

/** 兜底 SLA:老数据的 payload 里没有 sla 字段时按这一组算(与 graph.ts 一致)。 */
const DEFAULT_SLA = { claimMinutes: 30, substantiveResponseHours: 4 } as const;

function minutesBetween(from: string, to: string): number | null {
  const a = Date.parse(from);
  const b = Date.parse(to);
  // 时刻不可解析、或办结早于建单(时钟回拨 / 手工补数据)时丢弃这条样本。
  // 一个负数的办结时长会让「达标率」凭空变好,那比少一条样本危险得多。
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return (b - a) / 60000;
}

/** nearest-rank 分位。与 latency.ts 同一实现口径:不插值,返回真实存在的样本。 */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? null;
}

export interface DurationStats {
  samples: number;
  p50: number | null;
  p90: number | null;
  max: number | null;
  mean: number | null;
}

function durationStats(values: number[]): DurationStats {
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    max: sorted.length === 0 ? null : (sorted[sorted.length - 1] ?? null),
    mean: sorted.length === 0 ? null : sorted.reduce((s, v) => s + v, 0) / sorted.length,
  };
}

export interface SlaCompliance {
  /** 有对应时刻、能参与判定的案子数。 */
  measured: number;
  /** 其中在 SLA 内完成的。 */
  met: number;
  /** met / measured;无样本时 null,不为 1。 */
  rate: number | null;
  /**
   * 还没走到这一步的案子数(未认领 / 未办结)。
   *
   * 必须单独给:把它们算进分母等于说「还没到期就算违约」,算进分子等于说
   * 「没办的都合规」。两种都会让这一格失真,所以它既不进分子也不进分母,
   * 而是自己占一格 —— 积压量本身就是要看的东西。
   */
  pending: number;
  /** 时长分布(分钟)。 */
  duration: DurationStats;
}

export interface ExpertSlaBoard {
  cases: number;
  /** 30 分钟认领 SLA(阈值取自每个案子自己的 sla.claimMinutes)。 */
  claim: SlaCompliance;
  /** 4 小时实质响应 SLA(阈值取自 sla.substantiveResponseHours)。 */
  substantive: SlaCompliance;
  /** 队列现状:三个状态各多少。 */
  byStatus: Array<{ status: string; count: number }>;
}

function parseSla(payload: string): { claimMinutes: number; substantiveResponseHours: number } {
  try {
    const parsed = JSON.parse(payload) as Partial<ExpertCase>;
    const sla = parsed.sla;
    if (
      sla &&
      Number.isFinite(sla.claimMinutes) &&
      Number.isFinite(sla.substantiveResponseHours)
    ) {
      return { claimMinutes: sla.claimMinutes, substantiveResponseHours: sla.substantiveResponseHours };
    }
  } catch {
    // payload 损坏时退回默认 SLA,而不是丢样本 —— 丢样本会让分母漂。
  }
  return { ...DEFAULT_SLA };
}

export function expertSlaBoard(db: NovaDb, sinceIso?: string): ExpertSlaBoard {
  const since = sinceIso ?? null;
  const rows = queryAll<{
    status: string;
    payload: string;
    created_at: string;
    claimed_at: string | null;
    resolved_at: string | null;
  }>(
    db,
    `SELECT status, payload, created_at, claimed_at, resolved_at
     FROM expert_cases WHERE (? IS NULL OR created_at >= ?)`,
    since,
    since,
  );

  const claimMinutes: number[] = [];
  const substantiveMinutes: number[] = [];
  let claimMet = 0;
  let substantiveMet = 0;
  let claimPending = 0;
  let substantivePending = 0;
  const statusCounts = new Map<string, number>();

  for (const row of rows) {
    statusCounts.set(row.status, (statusCounts.get(row.status) ?? 0) + 1);
    const sla = parseSla(row.payload);

    const claim = row.claimed_at ? minutesBetween(row.created_at, row.claimed_at) : null;
    if (claim == null) claimPending += 1;
    else {
      claimMinutes.push(claim);
      if (claim <= sla.claimMinutes) claimMet += 1;
    }

    const resolved = row.resolved_at ? minutesBetween(row.created_at, row.resolved_at) : null;
    if (resolved == null) substantivePending += 1;
    else {
      substantiveMinutes.push(resolved);
      if (resolved <= sla.substantiveResponseHours * 60) substantiveMet += 1;
    }
  }

  const compliance = (
    values: number[],
    met: number,
    pending: number,
  ): SlaCompliance => ({
    measured: values.length,
    met,
    rate: values.length === 0 ? null : met / values.length,
    pending,
    duration: durationStats(values),
  });

  return {
    cases: rows.length,
    claim: compliance(claimMinutes, claimMet, claimPending),
    substantive: compliance(substantiveMinutes, substantiveMet, substantivePending),
    byStatus: [...statusCounts.entries()]
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count),
  };
}

/**
 * 候选知识生命周期(第 7 节)。
 *
 * 文档里这一节叫「候选 → 全量周期」。本系统里 **gray-active 就是终态的生产
 * 可用状态,没有单独的「全量」状态**,所以这里如实命名为「候选 → 灰度生效
 * 周期」,并且把这句话放进类型注释而不是只放进 README —— 口径名与实现不符
 * 是最容易在评审里被追着问的一类问题,不如自己先说清楚。
 */
export interface KnowledgeLifecycle {
  candidates: number;
  /** 曾经上线过的候选数(published_at 非空;回滚不减,因为那次发布真实发生过)。 */
  published: number;
  /** 当前仍在灰度窗口内的候选数(gray_started_at 非空)。 */
  grayActive: number;
  /** 从建候选到首次灰度生效的耗时(小时)。 */
  timeToPublishHours: DurationStats;
  /** published / candidates;无候选时 null。 */
  publishRate: number | null;
  /** 回滚:曾发布过但当前已退出灰度的候选数。 */
  rolledBack: number;
  /** 入库门禁整批回滚次数(与候选回滚是两码事,并列给出)。 */
  ingestRollbacks: number;
  /** 灰度窗口开着的这段时间里新开的质量事件数。 */
  grayWindowIncidents: number;
}

export function knowledgeLifecycle(db: NovaDb, sinceIso?: string): KnowledgeLifecycle {
  const since = sinceIso ?? null;
  const rows = queryAll<{
    created_at: string;
    published_at: string | null;
    gray_started_at: string | null;
  }>(
    db,
    `SELECT created_at, published_at, gray_started_at
     FROM candidates WHERE (? IS NULL OR created_at >= ?)`,
    since,
    since,
  );

  const hours: number[] = [];
  let published = 0;
  let grayActive = 0;
  let rolledBack = 0;
  for (const row of rows) {
    if (row.gray_started_at) grayActive += 1;
    if (!row.published_at) continue;
    published += 1;
    // 发布过但灰度窗口已关 = 被回滚下线。published_at 只写一次,
    // gray_started_at 退出灰度时清空,两列的差正好把回滚露出来。
    if (!row.gray_started_at) rolledBack += 1;
    const minutes = minutesBetween(row.created_at, row.published_at);
    if (minutes != null) hours.push(minutes / 60);
  }

  const ingest = queryOne<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM ingest_runs
     WHERE outcome = 'rolled-back' AND (? IS NULL OR created_at >= ?)`,
    since,
    since,
  );

  // 灰度期问题率的分子:任一候选的灰度窗口开启之后新增的质量事件。
  // 用「最早的灰度窗口左端」当下界,而不是逐个候选归因 —— 质量事件记的是
  // project_id,没有候选 id,硬做归因是编的。这一点写在这里,也写在看板上。
  const earliestGray = queryOne<{ t: string | null }>(
    db,
    `SELECT MIN(gray_started_at) AS t FROM candidates WHERE gray_started_at IS NOT NULL`,
  )?.t;
  const incidents = earliestGray
    ? (queryOne<{ n: number }>(
        db,
        `SELECT COUNT(*) AS n FROM quality_events WHERE created_at >= ?`,
        earliestGray,
      )?.n ?? 0)
    : 0;

  return {
    candidates: rows.length,
    published,
    grayActive,
    timeToPublishHours: durationStats(hours),
    publishRate: rows.length === 0 ? null : published / rows.length,
    rolledBack,
    ingestRollbacks: ingest?.n ?? 0,
    grayWindowIncidents: incidents,
  };
}

export interface LifecycleBoard {
  expert: ExpertSlaBoard;
  knowledge: KnowledgeLifecycle;
}

export function lifecycleBoard(db: NovaDb, sinceIso?: string): LifecycleBoard {
  const safe = <T>(fn: () => T, fallback: T, label: string): T => {
    try {
      return fn();
    } catch (err) {
      console.error(`[lifecycle] 口径缺格 · ${label} 查询失败`, err);
      return fallback;
    }
  };
  const emptyDuration: DurationStats = { samples: 0, p50: null, p90: null, max: null, mean: null };
  const emptySla: SlaCompliance = {
    measured: 0,
    met: 0,
    rate: null,
    pending: 0,
    duration: emptyDuration,
  };
  return {
    expert: safe(
      () => expertSlaBoard(db, sinceIso),
      { cases: 0, claim: emptySla, substantive: emptySla, byStatus: [] },
      "expertSlaBoard",
    ),
    knowledge: safe(
      () => knowledgeLifecycle(db, sinceIso),
      {
        candidates: 0,
        published: 0,
        grayActive: 0,
        timeToPublishHours: emptyDuration,
        publishRate: null,
        rolledBack: 0,
        ingestRollbacks: 0,
        grayWindowIncidents: 0,
      },
      "knowledgeLifecycle",
    ),
  };
}
