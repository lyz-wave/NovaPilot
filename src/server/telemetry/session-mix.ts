/**
 * 会话口径(指标体系 v1.1 第 3 节:流量与会话)。
 *
 * 这一节四项此前是全维度里最低的一格(0.7/4),原因不是缺聚合,是**缺列** ——
 * conversations 表只有 id / title / 两个时间戳,没有角色,也没有闭环时刻。
 * v9 迁移补了 role 与 closed_at 两列,这个模块把四项算出来。
 *
 * 三处口径必须写在代码里,不能只写在文档里:
 *
 * 1. **分母是「当周有活动的会话」,不是「当周新建的会话」**(第 1.4 节)。
 *    后者会把跨周被唤醒的存量会话排除在分母外,而它们的解决又算进分子,
 *    解决率就虚高了。所以切窗切的是 updated_at。
 *
 * 2. **有效会话 = 用户消息 ≥2 轮且非空**(第 3 节原文)。判据取自 messages 表,
 *    只数 role='user' 且 trim 后非空的行 —— 助手的回复不能撑起「有效」。
 *
 * 3. **剔除测试账号**(第 3 节原文)。这里只剔除显式的 `test-` 前缀租户,
 *    **不剔除 novapilot-demo** —— 演示租户产生的是真实的完整链路会话,
 *    把它当测试数据剔掉会让看板在比赛期恒为空。口径写在 TEST_TENANT_RE 上。
 */
import type { NovaDb } from "../db/client";
import { queryAll, queryOne } from "../db/client";

/**
 * 测试账号的判据。刻意用前缀而不是「包含 test」:一个叫
 * `zhejiang-testing-lab` 的真实租户不该被静默剔除,而剔除是不可见的 ——
 * 分母悄悄变小,没有任何一格会亮红。
 */
const TEST_TENANT_RE = "test-%";

export interface SessionVolume {
  /** 当周有活动的会话数(含跨周唤醒的存量会话)。 */
  active: number;
  /** 其中当周新建的。active - created = 被唤醒的存量会话。 */
  created: number;
  /** 有效会话(用户消息 ≥2 轮且非空)。 */
  effective: number;
  /** effective / active;无会话时 null,不为 0。 */
  effectiveRate: number | null;
  /** 因测试租户被剔除的会话数。剔除量必须可见,否则分母是怎么变小的没人知道。 */
  excludedTestSessions: number;
}

export function sessionVolume(db: NovaDb, since: string | null): SessionVolume {
  const row = queryOne<{
    active: number;
    created: number;
    effective: number;
  }>(
    db,
    `WITH windowed AS (
       SELECT c.id AS id, c.created_at AS created_at
       FROM conversations c
       WHERE c.tenant_id NOT LIKE '${TEST_TENANT_RE}'
         AND (? IS NULL OR c.updated_at >= ?)
     ),
     user_turns AS (
       SELECT m.conversation_id AS id, COUNT(*) AS n
       FROM messages m
       WHERE m.role = 'user' AND TRIM(COALESCE(m.text, '')) <> ''
       GROUP BY m.conversation_id
     )
     SELECT
       COUNT(*) AS active,
       COALESCE(SUM(CASE WHEN ? IS NULL OR w.created_at >= ? THEN 1 ELSE 0 END), 0) AS created,
       COALESCE(SUM(CASE WHEN COALESCE(t.n, 0) >= 2 THEN 1 ELSE 0 END), 0) AS effective
     FROM windowed w
     LEFT JOIN user_turns t ON t.id = w.id`,
    since,
    since,
    since,
    since,
  );
  const excluded = queryOne<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM conversations
     WHERE tenant_id LIKE '${TEST_TENANT_RE}' AND (? IS NULL OR updated_at >= ?)`,
    since,
    since,
  );
  const active = row?.active ?? 0;
  const effective = row?.effective ?? 0;
  return {
    active,
    created: row?.created ?? 0,
    effective,
    effectiveRate: active === 0 ? null : effective / active,
    excludedTestSessions: excluded?.n ?? 0,
  };
}

/** 咨询者视角分布。未记录角色的会话单独成一档,不摊进四个角色里。 */
export interface RoleShare {
  role: string;
  sessions: number;
  share: number;
}

export function consultantLensMix(db: NovaDb, since: string | null): RoleShare[] {
  const rows = queryAll<{ role: string | null; n: number }>(
    db,
    `SELECT role AS role, COUNT(*) AS n
     FROM conversations
     WHERE tenant_id NOT LIKE '${TEST_TENANT_RE}' AND (? IS NULL OR updated_at >= ?)
     GROUP BY role`,
    since,
    since,
  );
  const total = rows.reduce((s, r) => s + r.n, 0);
  return rows
    // 「未记录」必须独立成档并计入分母:把它摊掉会让四个角色的占比看起来
    // 加总为 100%,而实际上大部分会话根本没有角色数据。
    .map((r) => ({ role: r.role ?? "未记录", sessions: r.n, share: total === 0 ? 0 : r.n / total }))
    .sort((a, b) => b.sessions - a.sessions);
}

/**
 * 系统四角色的活动量(第 3 节表格里的「四角色」指的是这一组:
 * 咨询者 / 专家 / 知识管理员 / 运营)。
 *
 * **口径与上面那份不同,不能混为一谈**:只有咨询者会产生 conversations 行,
 * 另外三类角色的工作不表现为「会话」。所以这里数的是各自的**动作数**,
 * 数据源是它们各自已有的表。单位不是会话,占比也就不是「会话占比」——
 * 字段名叫 actions 而不是 sessions,就是为了在类型层面挡住这次混淆。
 */
export interface SystemRoleActivity {
  role: "咨询者" | "专家" | "知识管理员" | "运营";
  actions: number;
  source: string;
}

export function systemRoleActivity(db: NovaDb, since: string | null): SystemRoleActivity[] {
  const count = (sql: string, label: string): number => {
    try {
      return queryOne<{ n: number }>(db, sql, since, since)?.n ?? 0;
    } catch (err) {
      console.error(`[session-mix] 口径缺格 · ${label} 查询失败`, err);
      return 0;
    }
  };
  return [
    {
      role: "咨询者",
      actions: count(
        `SELECT COUNT(*) AS n FROM conversations
         WHERE tenant_id NOT LIKE '${TEST_TENANT_RE}' AND (? IS NULL OR updated_at >= ?)`,
        "consultant",
      ),
      source: "conversations",
    },
    {
      role: "专家",
      actions: count(
        `SELECT COUNT(*) AS n FROM expert_cases
         WHERE claimed_at IS NOT NULL AND (? IS NULL OR claimed_at >= ?)`,
        "expert",
      ),
      source: "expert_cases.claimed_at",
    },
    {
      role: "知识管理员",
      actions: count(
        `SELECT COUNT(*) AS n FROM ingest_runs WHERE (? IS NULL OR created_at >= ?)`,
        "knowledge-admin",
      ),
      source: "ingest_runs",
    },
    {
      role: "运营",
      actions: count(
        `SELECT COUNT(*) AS n FROM eval_runs WHERE (? IS NULL OR created_at >= ?)`,
        "operations",
      ),
      source: "eval_runs",
    },
  ];
}

/**
 * 跨周唤醒会话占比(v1.1 第 1.4 节新增,第 11 节 P2 的第三项)。
 *
 * = 跨周闭环会话 / 当周闭环会话。「跨周」的判据是**创建于本窗口之前、闭环于
 * 本窗口之内** —— 一次咨询拖过了一个周界。
 *
 * 持续走高说明追问-补充链路过长,是体验问题。它是趋势信号,所以样本量太少时
 * 返回 null 而不是一个由两三条会话决定的比率(和 P1 跳过 null 是同一条纪律)。
 */
export interface WakeupSummary {
  closed: number;
  crossWeek: number;
  rate: number | null;
}

export function crossWeekWakeup(db: NovaDb, since: string | null): WakeupSummary {
  const row = queryOne<{ closed: number; cross: number }>(
    db,
    `SELECT
       COUNT(*) AS closed,
       COALESCE(SUM(CASE WHEN ? IS NOT NULL AND created_at < ? THEN 1 ELSE 0 END), 0) AS cross
     FROM conversations
     WHERE closed_at IS NOT NULL
       AND tenant_id NOT LIKE '${TEST_TENANT_RE}'
       AND (? IS NULL OR closed_at >= ?)`,
    since,
    since,
    since,
    since,
  );
  const closed = row?.closed ?? 0;
  return {
    closed,
    crossWeek: row?.cross ?? 0,
    rate: closed === 0 ? null : (row?.cross ?? 0) / closed,
  };
}

export interface SessionBoard {
  volume: SessionVolume;
  lensMix: RoleShare[];
  roleActivity: SystemRoleActivity[];
  wakeup: WakeupSummary;
}

export function sessionBoard(db: NovaDb, sinceIso?: string): SessionBoard {
  const since = sinceIso ?? null;
  const safe = <T>(fn: () => T, fallback: T, label: string): T => {
    try {
      return fn();
    } catch (err) {
      console.error(`[session-mix] 口径缺格 · ${label} 查询失败`, err);
      return fallback;
    }
  };
  return {
    volume: safe(
      () => sessionVolume(db, since),
      { active: 0, created: 0, effective: 0, effectiveRate: null, excludedTestSessions: 0 },
      "sessionVolume",
    ),
    lensMix: safe(() => consultantLensMix(db, since), [], "consultantLensMix"),
    roleActivity: safe(() => systemRoleActivity(db, since), [], "systemRoleActivity"),
    wakeup: safe(
      () => crossWeekWakeup(db, since),
      { closed: 0, crossWeek: 0, rate: null },
      "crossWeekWakeup",
    ),
  };
}

/**
 * P2 第三项:跨周唤醒占比趋势恶化。
 *
 * 阈值 40% 不是文档给的(第 11 节只说「趋势恶化」),所以它必须**带最小样本量**
 * 才报警 —— 一个没有目标值的指标上硬设阈值,唯一能做的就是别让它在样本量
 * 不足时说话。minClosed 与 P2 其余两项的 minRounds 是同一条纪律。
 */
export const P2_WAKEUP = { rate: 0.4, minClosed: 10 } as const;

export function wakeupBreaches(board: SessionBoard): string[] {
  const { rate, closed } = board.wakeup;
  if (rate == null || closed < P2_WAKEUP.minClosed) return [];
  if (rate <= P2_WAKEUP.rate) return [];
  return [
    `跨周唤醒会话占比 ${(rate * 100).toFixed(1)}% > ${P2_WAKEUP.rate * 100}%(${board.wakeup.crossWeek}/${closed},追问链路过长)`,
  ];
}
