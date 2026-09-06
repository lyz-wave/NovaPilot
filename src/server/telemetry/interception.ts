/**
 * §4.3 拦截→解决转化率 + §4.7 交接包完整度。
 *
 * 拦截→解决转化率：
 *   分母 = 有至少一轮 critic 阻拦的 trace_id 数（verdict='blocked'）
 *   分子 = 其中最终 outcome='formal' 的 trace_id 数
 *   这两个数是「同批」：同一个窗口里，被拦过的咨询有多少最终变成了正式卡。
 *
 * 交接包完整度：
 *   分母 = 全部转专家案例数（expert_cases 表）
 *   分子 = 其中 defenseTrail 不为空数组的案例数（防线摘要已填）
 *   前端展示：「N/M 交接包带防线摘要」
 */
import { queryAll, type NovaDb } from "../db/client";

export function recordReviewRound(
  db: NovaDb,
  input: {
    traceId: string;
    round: number;
    criticVerdict: "approved" | "blocked";
    droppedCount: number;
    now: string;
  },
): void {
  db.prepare(
    `INSERT INTO review_rounds(id, trace_id, round, critic_verdict, dropped_count, outcome, created_at)
     VALUES(?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    `RR-${input.traceId}-${input.round}`,
    input.traceId,
    input.round,
    input.criticVerdict,
    input.droppedCount,
    input.now,
  );
}

/** 回填最终结局:图运行完成后由 graph.ts 写入同 trace 的所有轮次。 */
export function finalizeReviewRounds(db: NovaDb, traceId: string, outcome: string): void {
  try {
    db.prepare(
      `UPDATE review_rounds SET outcome = ? WHERE trace_id = ?`,
    ).run(outcome, traceId);
  } catch {}
}

export interface InterceptionResolution {
  intercepted: number;
  resolved: number;
  rate: number | null;
}

/**
 * 拦截→解决转化率。
 * 分母：有至少一轮 critic 阻拦（verdict='blocked'）的 trace_id 数
 * 分子：其中 outcome='formal' 的 trace_id 数
 */
export function interceptResolutionRate(
  db: NovaDb,
  sinceIso?: string,
): InterceptionResolution {
  const since = sinceIso ?? null;
  try {
    const row = queryAll<{ intercepted: number }>(
      db,
      `SELECT COUNT(DISTINCT trace_id) AS intercepted
       FROM review_rounds
       WHERE critic_verdict = 'blocked'
         AND (? IS NULL OR created_at >= ?)`,
      since,
      since,
    )[0];
    const intercepted = row?.intercepted ?? 0;

    const row2 = queryAll<{ resolved: number }>(
      db,
      `SELECT COUNT(DISTINCT trace_id) AS resolved
       FROM review_rounds
       WHERE critic_verdict = 'blocked'
         AND outcome = 'formal'
         AND (? IS NULL OR created_at >= ?)`,
      since,
      since,
    )[0];
    const resolved = row2?.resolved ?? 0;

    return { intercepted, resolved, rate: intercepted === 0 ? null : resolved / intercepted };
  } catch {
    return { intercepted: 0, resolved: 0, rate: null };
  }
}

export interface HandoffCompleteness {
  total: number;
  complete: number;
  rate: number | null;
}

/**
 * 交接包完整度：转专家案例中，防线摘要（defenseTrail）不为空的比例。
 * defenseTrail 存储在 expert_cases.payload 的 JSON 中，用 json_array_length 提取。
 */
export function handoffCompleteness(
  db: NovaDb,
  sinceIso?: string,
): HandoffCompleteness {
  const since = sinceIso ?? null;
  try {
    const totRow = queryAll<{ total: number }>(
      db,
      `SELECT COUNT(*) AS total FROM expert_cases
       WHERE (? IS NULL OR created_at >= ?)`,
      since,
      since,
    )[0];
    const total = totRow?.total ?? 0;

    const compRow = queryAll<{ complete: number }>(
      db,
      `SELECT COUNT(*) AS complete FROM expert_cases
       WHERE (? IS NULL OR created_at >= ?)
         AND json_array_length(json_extract(payload, '$.handoff.defenseTrail')) > 0`,
      since,
      since,
    )[0];
    const complete = compRow?.complete ?? 0;

    return { total, complete, rate: total === 0 ? null : complete / total };
  } catch {
    return { total: 0, complete: 0, rate: null };
  }
}
