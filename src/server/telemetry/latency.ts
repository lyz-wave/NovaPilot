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
  /**
   * 这一次请求的收场。缺省 completed —— 非流式路由没有「中断」这个状态。
   * 流式路由必须显式传:开流时 started,收尾 completed / failed,
   * 消费端断开 aborted。
   */
  outcome?: LatencyOutcome;
  now: string;
}

export type LatencyOutcome = "started" | "completed" | "aborted" | "failed";

export function recordLatencySample(db: NovaDb, input: LatencySampleInput): void {
  try {
    db.prepare(
      `INSERT INTO latency_samples(id, trace_id, route, kind, card_status, duration_ms, outcome, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         duration_ms = excluded.duration_ms,
         card_status = excluded.card_status,
         outcome     = excluded.outcome,
         created_at  = excluded.created_at`,
    ).run(
      `LT-${input.traceId}-${input.route}`,
      input.traceId,
      input.route,
      input.kind,
      input.cardStatus ?? "",
      // 负数/小数都不该进 P95;Math.max(0, ...) 比丢样本好 —— 丢样本会让分母漂。
      Math.max(0, Math.round(input.durationMs)),
      input.outcome ?? "completed",
      input.now,
    );
  } catch (err) {
    console.warn("[telemetry] latency sample failed", err);
  }
}

/**
 * 只改收场,不动耗时。
 *
 * 中断场景下「这次请求花了多久」没有意义(它没跑完),但**开流那一刻**已经写进
 * 去的 started 行必须留着,否则分母里就少了一条 —— 那正是改造前的老毛病:
 * 采样写在 respond() 之后,中断的流一行不落,于是成功率恒等于 100%。
 */
export function markLatencyOutcome(
  db: NovaDb,
  input: { traceId: string; route: string; outcome: LatencyOutcome },
): void {
  try {
    db.prepare(
      // started 之外的收场是终态,不再被后来的帧改写:cancel() 与 finally 的
      // 触发顺序不保证,谁先到算谁 —— 但 aborted 不该被随后的 completed 洗掉。
      `UPDATE latency_samples SET outcome = ?
       WHERE id = ? AND outcome = 'started'`,
    ).run(input.outcome, `LT-${input.traceId}-${input.route}`);
  } catch (err) {
    console.warn("[telemetry] latency outcome failed", err);
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
  /** 流式成功率(第 8 节)。分母只含流式路由,非流式没有「中断」这个状态。 */
  stream: StreamOutcomeSummary;
}

export interface StreamOutcomeSummary {
  /** 开过的流总数(started 那一行就是分母,不管它后来怎么收场)。 */
  streams: number;
  completed: number;
  aborted: number;
  failed: number;
  /** 仍是 started 的行:进程被杀 / 服务重启,既没完成也没收到 cancel。 */
  inflight: number;
  /** completed / streams;没有流时为 null,不为 1。 */
  successRate: number | null;
}

/**
 * 分位数只统计 **completed** 的样本。
 *
 * 一条 aborted 行的 duration_ms 是「断开前跑了多久」,不是这次请求的耗时;
 * 把它算进 P95 会让「用户等不及点了取消」表现为延迟**下降**。
 * 所以两个数分开:延迟只看跑完的,成功率看全部。
 */

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
  let rows: Array<{ card_status: string; duration_ms: number; outcome: string; route: string }> = [];
  try {
    rows = queryAll<{ card_status: string; duration_ms: number; outcome: string; route: string }>(
      db,
      `SELECT card_status, duration_ms, outcome, route FROM latency_samples
       WHERE (? IS NULL OR created_at >= ?)`,
      sinceIso ?? null,
      sinceIso ?? null,
    );
  } catch (err) {
    console.warn("[telemetry] latency summary failed", err);
  }
  const done = rows.filter((r) => r.outcome === "completed");
  const groups = new Map<string, number[]>();
  for (const r of done) {
    const key = r.card_status || "chat";
    const bucket = groups.get(key) ?? [];
    bucket.push(r.duration_ms);
    groups.set(key, bucket);
  }
  const streamRows = rows.filter((r) => r.route.endsWith(":stream"));
  const count = (o: string) => streamRows.filter((r) => r.outcome === o).length;
  const streams = streamRows.length;
  return {
    overall: statsOf(done.map((r) => r.duration_ms)),
    byStatus: [...groups.entries()]
      .map(([status, values]) => ({ status, stats: statsOf(values) }))
      .sort((a, b) => b.stats.samples - a.stats.samples),
    stream: {
      streams,
      completed: count("completed"),
      aborted: count("aborted"),
      failed: count("failed"),
      inflight: count("started"),
      successRate: streams === 0 ? null : count("completed") / streams,
    },
  };
}
