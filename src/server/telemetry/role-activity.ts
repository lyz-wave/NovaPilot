/**
 * §3 四角色活动量（v1.1 第 3 节，S1 修订）。
 *
 * **S1 前的代理口径**：`consultantLensMix` 按会话计咨询者内部画像分布，其余角色
 * 按各自表的行数计活动。两个维度混在看板同一节，分母不同源，横向比较会被误读。
 *
 * **S1 的修复**：四角色统一以「事件条数」为分母，每角色选其核心工作流的事件：
 *   咨询者    → conversations（每次咨询 = 一条会话事件）
 *   专家      → expert_cases.claimed_at（接单 = 一次专家服务事件）
 *   知识管理员 → ingest_runs（一次摄取批次 = 一次知识更新事件）
 *   运营       → eval_runs（一次评测运行 = 一次质量检验事件）
 *
 * 四角色的「事件」在量纲上不同（会话 vs 接单 vs 摄取批次 vs 评测运行），但在
 * **参与频率**维度上是可比的 —— 这是用来监控「各角色本周是否活跃」的指标，
 * 不是用来排座次的竞争指标。看板显示各自绝对数 + 总占比，口径说明随 tooltip。
 *
 * 统一条件：全部走同一时间窗口 `since`，全部剔除测试租户（咨询者）或无 since 条件时全取。
 */

import type { NovaDb } from "../db/client";
import { queryOne } from "../db/client";

const TEST_TENANT_RE = "test-%";

export type RoleActivityKind = "consultant" | "expert" | "knowledge-admin" | "operations";

export interface RoleActivity {
  role: RoleActivityKind;
  /** 角色的中文名，供看板直接使用 */
  label: string;
  /** 事件条数（见模块注释） */
  count: number;
  /** 事件来源表，供 tooltip 展示 */
  source: string;
}

const SQL: Record<RoleActivityKind, { sql: string; label: string; source: string }> = {
  consultant: {
    label: "咨询者",
    source: "conversations",
    sql: `SELECT COUNT(*) AS n FROM conversations
          WHERE tenant_id NOT LIKE '${TEST_TENANT_RE}'
            AND (? IS NULL OR updated_at >= ?)`,
  },
  expert: {
    label: "专家",
    source: "expert_cases.claimed_at",
    sql: `SELECT COUNT(*) AS n FROM expert_cases
          WHERE claimed_at IS NOT NULL
            AND (? IS NULL OR claimed_at >= ?)`,
  },
  "knowledge-admin": {
    label: "知识管理员",
    source: "ingest_runs",
    sql: `SELECT COUNT(*) AS n FROM ingest_runs WHERE (? IS NULL OR created_at >= ?)`,
  },
  operations: {
    label: "运营",
    source: "eval_runs",
    sql: `SELECT COUNT(*) AS n FROM eval_runs WHERE (? IS NULL OR created_at >= ?)`,
  },
};

/** 查询单个角色在时间窗口内的活动事件条数。 */
export function countActivities(
  db: NovaDb,
  role: RoleActivityKind,
  since: string | null,
): number {
  const { sql } = SQL[role];
  try {
    return queryOne<{ n: number }>(db, sql, since, since)?.n ?? 0;
  } catch (err) {
    console.error(`[role-activity] ${role} 查询失败`, err);
    return 0;
  }
}

/** 四角色统一活动分母，返回各角色绝对数 + 总和。 */
export function roleActivityMix(
  db: NovaDb,
  since: string | null,
): { roles: RoleActivity[]; total: number } {
  const kinds: RoleActivityKind[] = ["consultant", "expert", "knowledge-admin", "operations"];
  const roles: RoleActivity[] = kinds.map((kind) => ({
    role: kind,
    label: SQL[kind].label,
    count: countActivities(db, kind, since),
    source: SQL[kind].source,
  }));
  const total = roles.reduce((s, r) => s + r.count, 0);
  return { roles, total };
}
