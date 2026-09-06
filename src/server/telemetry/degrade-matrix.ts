/**
 * 降级矩阵触发次数(指标体系 v1.1 第 8 节:「五开关各自触发次数」)。
 *
 * 这一格此前是**结构性取不到**,不是没做聚合:
 *
 *   开质量事件是按闸门去重的 —— 同一道闸门已经有一条未闭事件时,再次触发直接
 *   复用那一条,不落新行。去重对事件闭环是对的(一道一直失败的闸门不该堆出
 *   一百条待办),但它让「触发次数」这个数永远等于「有几道闸门出过问题」。
 *
 * 所以这里另开一张只追加的流水表。两个数必须并列上板,不能互相顶替:
 *   - 触发次数 → 抖动频次(第 8 节要的)
 *   - 未闭事件数 → 待办积压(第 11 节要的)
 *
 * 一道闸门触发 12 次但事件已闭,和触发 1 次事件还挂着,是完全不同的两种病。
 */
import type { NovaDb } from "../db/client";
import { queryAll } from "../db/client";

/** 第 8 节的「五开关」:运营台降级矩阵里的五道硬门禁,顺序与看板一致。 */
export const DEGRADE_GATES = [
  "escalation-recall",
  "citation-validity",
  "confident-wrong",
  "p0-defects",
  "data-boundary",
] as const;

export type DegradeSource = "console" | "runtime";

export function recordDegradeTrigger(
  db: NovaDb,
  input: {
    gateKey: string;
    label: string;
    /** console = 运营台手工注入(演示/演练);runtime = 系统自身降级。 */
    source: DegradeSource;
    /** 这一次触发是否被事件去重吃掉了(已有未闭事件)。 */
    deduped: boolean;
    now: string;
  },
): void {
  try {
    db.prepare(
      `INSERT INTO degrade_triggers(id, gate_key, label, source, deduped, created_at)
       VALUES(?, ?, ?, ?, ?, ?)`,
    ).run(
      // 只追加,主键必须每次都不同 —— 用 trace/gate 当主键就又变成去重了,
      // 那正是这张表要绕开的东西。
      `DT-${input.gateKey}-${crypto.randomUUID()}`,
      input.gateKey,
      input.label,
      input.source,
      input.deduped ? 1 : 0,
      input.now,
    );
  } catch (err) {
    console.warn("[telemetry] degrade trigger failed", err);
  }
}

export interface DegradeGateCount {
  gateKey: string;
  label: string;
  /** 总触发次数(含被事件去重吃掉的那些 —— 那些也是真的触发了)。 */
  triggers: number;
  /** 运营台手工注入(演示 / 演练)。 */
  console: number;
  /** 系统自身降级。 */
  runtime: number;
  /** 其中被事件去重复用了已有事件的次数。 */
  deduped: number;
  lastAt: string | null;
}

export interface DegradeMatrixSummary {
  /** 五道闸门恒定五行,没触发过的也占一行 —— 缺行会被读成「没有这道闸门」。 */
  gates: DegradeGateCount[];
  triggers: number;
  /** 只统计 runtime 的触发数:演示演练不该把真实降级次数冲高。 */
  runtimeTriggers: number;
}

const GATE_LABEL: Record<string, string> = {
  "escalation-recall": "高风险转接召回",
  "citation-validity": "引用有效率",
  "confident-wrong": "自信错答变化",
  "p0-defects": "P0 阻断缺陷",
  "data-boundary": "数据出域事件",
};

export function degradeMatrixSummary(db: NovaDb, sinceIso?: string): DegradeMatrixSummary {
  let rows: Array<{
    gate_key: string;
    label: string;
    source: string;
    deduped: number;
    n: number;
    last_at: string;
  }> = [];
  try {
    rows = queryAll(
      db,
      `SELECT gate_key, MAX(label) AS label, source, deduped,
              COUNT(*) AS n, MAX(created_at) AS last_at
       FROM degrade_triggers
       WHERE (? IS NULL OR created_at >= ?)
       GROUP BY gate_key, source, deduped`,
      sinceIso ?? null,
      sinceIso ?? null,
    );
  } catch (err) {
    console.error("[telemetry] 口径缺格 · degradeMatrixSummary 查询失败", err);
  }

  // 先按五道闸门铺满,再把查到的数填进去。空库时也是五行 0 ——
  // 「这道闸门本周没触发」和「看板上没有这道闸门」不是一回事。
  const byGate = new Map<string, DegradeGateCount>();
  const seen = [...new Set([...DEGRADE_GATES, ...rows.map((r) => r.gate_key)])];
  for (const gateKey of seen) {
    byGate.set(gateKey, {
      gateKey,
      label: GATE_LABEL[gateKey] ?? gateKey,
      triggers: 0,
      console: 0,
      runtime: 0,
      deduped: 0,
      lastAt: null,
    });
  }

  for (const row of rows) {
    const entry = byGate.get(row.gate_key);
    if (!entry) continue;
    entry.triggers += row.n;
    if (row.source === "runtime") entry.runtime += row.n;
    else entry.console += row.n;
    if (row.deduped) entry.deduped += row.n;
    if (row.label) entry.label = row.label;
    if (!entry.lastAt || row.last_at > entry.lastAt) entry.lastAt = row.last_at;
  }

  const gates = [...byGate.values()].sort(
    (a, b) => DEGRADE_GATES.indexOf(a.gateKey as never) - DEGRADE_GATES.indexOf(b.gateKey as never),
  );
  return {
    gates,
    triggers: gates.reduce((s, g) => s + g.triggers, 0),
    runtimeTriggers: gates.reduce((s, g) => s + g.runtime, 0),
  };
}
