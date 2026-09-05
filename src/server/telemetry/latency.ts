/**
 * 端到端延迟采样。
 *
 * 补的是指标体系第 10 节护栏对里唯一没有数据源的一格:
 *
 *   | 激励指标 | 游戏化路径 | 护栏指标 |
 *   | P95 延迟 | 省防线 / 降模型 | 防线通过率结构 + NovaBench 得分 |
 *
 * 「优化延迟不得以防线为代价」这句话要能被验证,延迟数必须**带处置状态**落库。
 * 只有一个全局 P95 是验证不了的:把该转专家的会话直接答掉,P95 一定会漂亮地降,
 * 而那正是这条护栏要防的事。所以这里按 card_status 分组出数,看板上把
 * formal / expert-review 两条延迟并排放 —— 前者变快后者消失,一眼能看出来。
 *
 * 口径:墙上时钟毫秒,量在 API 边界(含检索、生成、落库),不含网络往返。
 * 和埋点 A/B/D 一致,写入失败只告警 —— 采样挂掉不该让咨询本身失败。
 */
import type { NovaDb } from "../db/client";
import { queryAll } from "../db/client";

export interface LatencySampleInput {
  traceId: string;
  /** consultations | consultations:stream */
  route: string;
  kind: "card" | "chat";
  /** 研究型会话的处置状态;闲聊轮为空串。 */
  cardStatus?: string;
  durationMs: number;
  now: string;
}

export function recordLatencySample(db: NovaDb, input: LatencySampleInput): void {
  try {
    db.prepare(
      `INSERT INTO latency_samples(id, trace_id, route, kind, card_status, duration_ms, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         duration_ms = excluded.duration_ms,
         card_status = excluded.card_status,
         created_at  = excluded.created_at`,
    ).run(
      `LT-${input.traceId}-${input.route}`,
      input.traceId,
      input.route,
      input.kind,
      input.cardStatus ?? "",
      // 负数/小数都不该进 P95;Math.max(0, ...) 比丢样本好 —— 丢样本会让分母漂。
      Math.max(0, Math.round(input.durationMs)),
      input.now,
    );
  } catch (err) {
    console.warn("[telemetry] latency sample failed", err);
  }
}

/** 一组延迟样本的分位数。样本数为 0 时 p50/p95 记 null,不记 0。 */
export interface LatencyStats {
  samples: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export interface LatencySummary {
  overall: LatencyStats;
  /**
   * 按处置状态分组。这是护栏的实际观察口径 —— 只看 overall 的话,
   * 「把该转的直接答掉」和「真的变快了」在数字上长得一模一样。
   */
  byStatus: Array<{ status: string; stats: LatencyStats }>;
}

/**
 * 最近邻分位(nearest-rank),不做线性插值。
 *
 * 样本量小的时候插值会造出一个没人经历过的延迟值 —— 3 条样本插出来的 P95
 * 是算术产物,不是任何一次真实请求的耗时。宁可返回真实存在的那一条。
 */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

function statsOf(values: number[]): LatencyStats {
  const sorted = values.slice().sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.length === 0 ? null : sorted[sorted.length - 1]!,
  };
}

export function latencySummary(db: NovaDb, sinceIso?: string): LatencySummary {
  let rows: Array<{ card_status: string; duration_ms: number }> = [];
  try {
    rows = queryAll<{ card_status: string; duration_ms: number }>(
      db,
      `SELECT card_status, duration_ms FROM latency_samples
       WHERE (? IS NULL OR created_at >= ?)`,
      sinceIso ?? null,
      sinceIso ?? null,
    );
  } catch (err) {
    console.warn("[telemetry] latency summary failed", err);
  }
  const groups = new Map<string, number[]>();
  for (const r of rows) {
    const key = r.card_status || "chat";
    const bucket = groups.get(key) ?? [];
    bucket.push(r.duration_ms);
    groups.set(key, bucket);
  }
  return {
    overall: statsOf(rows.map((r) => r.duration_ms)),
    byStatus: [...groups.entries()]
      .map(([status, values]) => ({ status, stats: statsOf(values) }))
      .sort((a, b) => b.stats.samples - a.stats.samples),
  };
}
