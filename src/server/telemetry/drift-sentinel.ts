/**
 * S3.4 漂移哨兵 —— 检测指标分子/分母的异常变化，防止 KPI 静默失真。
 *
 * 三条告警规则（均为窗口环比）：
 *   R1  denominator-drop-50pct：分母相比上周期下降 > 50%（数据管道断裂）
 *   R2  two-week-zero-numerator：连续 2 个统计窗口分子为 0（功能静默失效）
 *   R3  co-spike：分子分母在同一窗口内都超过 3× 上周期（突发爆量，须人工核查）
 *
 * 使用方式：在定时任务里调 `runDriftSentinel(db, metrics)`，指标列表由
 * operations-dashboard 的看板聚合函数提供。不依赖外部 alerting 系统，只把
 * alert_fired=1 写进 metric_snapshots，供看板拉取或运维脚本扫描。
 */
import { queryAll, type NovaDb } from "../db/client";

export interface MetricReading {
  metricId: string;
  windowStart: string;
  windowEnd: string;
  numerator: number;
  denominator: number;
}

export interface DriftAlert {
  metricId: string;
  windowStart: string;
  rule: "denominator-drop-50pct" | "two-week-zero-numerator" | "co-spike";
  detail: string;
}

function snapId(metricId: string, windowStart: string): string {
  return `snap-${metricId}-${windowStart.replace(/\D/g, "")}`;
}

function prevSnaps(
  db: NovaDb,
  metricId: string,
  windowStart: string,
  limit: number,
): Array<{ numerator: number; denominator: number; window_start: string }> {
  return queryAll<{ numerator: number; denominator: number; window_start: string }>(
    db,
    `SELECT numerator, denominator, window_start
     FROM metric_snapshots
     WHERE metric_id = ? AND window_start < ?
     ORDER BY window_start DESC
     LIMIT ?`,
    metricId,
    windowStart,
    limit,
  );
}

function checkRules(
  current: MetricReading,
  history: Array<{ numerator: number; denominator: number; window_start: string }>,
): DriftAlert | null {
  if (history.length === 0) return null;
  const prev = history[0];

  // R1 分母下降 >50%
  if (prev.denominator > 0 && current.denominator < prev.denominator * 0.5) {
    return {
      metricId: current.metricId,
      windowStart: current.windowStart,
      rule: "denominator-drop-50pct",
      detail: `分母从 ${prev.denominator} 降至 ${current.denominator}（降幅 ${(1 - current.denominator / prev.denominator) * 100 | 0}%）`,
    };
  }

  // R3 分子分母同步激增 >3×（在 R1 之前判，避免分母骤降被 R3 误判）
  if (
    prev.denominator > 0 &&
    prev.numerator > 0 &&
    current.denominator > prev.denominator * 3 &&
    current.numerator > prev.numerator * 3
  ) {
    return {
      metricId: current.metricId,
      windowStart: current.windowStart,
      rule: "co-spike",
      detail: `分子 ${prev.numerator}→${current.numerator}，分母 ${prev.denominator}→${current.denominator}（均超 3× 上周期）`,
    };
  }

  // R2 连续 2 个窗口分子为 0
  if (current.numerator === 0 && history.length >= 1 && history[0].numerator === 0) {
    const hasTwo = current.numerator === 0 && history[0].numerator === 0;
    if (hasTwo) {
      return {
        metricId: current.metricId,
        windowStart: current.windowStart,
        rule: "two-week-zero-numerator",
        detail: `连续 ${history.filter((h) => h.numerator === 0).length + 1} 个窗口分子为 0`,
      };
    }
  }

  return null;
}

/**
 * 对一批指标读数运行三条规则，将快照写入 metric_snapshots，
 * 返回本次触发的告警列表。
 */
export function runDriftSentinel(db: NovaDb, readings: MetricReading[]): DriftAlert[] {
  const alerts: DriftAlert[] = [];
  const now = new Date().toISOString();

  for (const r of readings) {
    const history = prevSnaps(db, r.metricId, r.windowStart, 2);
    const alert = checkRules(r, history);
    const rate = r.denominator === 0 ? null : r.numerator / r.denominator;

    db.prepare(
      `INSERT OR REPLACE INTO metric_snapshots
         (id, metric_id, window_start, window_end, numerator, denominator, rate,
          alert_fired, alert_rule, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      snapId(r.metricId, r.windowStart),
      r.metricId,
      r.windowStart,
      r.windowEnd,
      r.numerator,
      r.denominator,
      rate,
      alert ? 1 : 0,
      alert?.rule ?? null,
      now,
    );

    if (alert) alerts.push(alert);
  }

  return alerts;
}

/**
 * 查询最近 N 个窗口内已触发的告警。供看板或运维脚本扫描。
 */
export function recentAlerts(db: NovaDb, limit = 20): DriftAlert[] {
  const rows = queryAll<{
    metric_id: string;
    window_start: string;
    alert_rule: string;
    denominator: number;
    numerator: number;
  }>(
    db,
    `SELECT metric_id, window_start, alert_rule, numerator, denominator
     FROM metric_snapshots
     WHERE alert_fired = 1
     ORDER BY window_start DESC
     LIMIT ?`,
    limit,
  );
  return rows.map((row) => ({
    metricId: row.metric_id,
    windowStart: row.window_start,
    rule: row.alert_rule as DriftAlert["rule"],
    detail: `numerator=${row.numerator}, denominator=${row.denominator}`,
  }));
}
