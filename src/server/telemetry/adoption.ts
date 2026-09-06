/**
 * 埋点 D · 决策卡采纳动作(指标体系 v1.1 第 12 节 / 4.4 节「隐式采纳率」)。
 *
 * 复制、导出、同步到 LIMS —— 这三个动作的共同点是:用户**把卡片的内容带走了**。
 * 带走比点赞可信,因为它有代价(要去用),而点赞没有。所以它是「这张卡真的帮上忙
 * 了吗」的一个不用问用户就能拿到的信号。
 *
 * ⚠️ 边界条件(指标体系 4.4 节原文照抄):
 *
 *   「**隐式采纳率**只做体验对冲指标,**不进可信解决率计算链** —— 避免它本身
 *   成为可游戏化对象。」
 *
 * 所以这个模块**故意**不导出任何能被塞进可信解决率的东西,也不写 quality_events、
 * 不参与发版门禁。它只往看板上供一个数。理由很直接:一旦「导出数」进了核心指标,
 * 提高它最省力的办法是把导出按钮做得更醒目、或者干脆自动触发一次导出 —— 那时候
 * 这个数字还在涨,但它衡量的东西已经没了。把它钉在「对冲指标」这一格,是让它保持
 * 可信的唯一办法。
 *
 * 口径:分子分母都按**卡片**去重,不是按事件计数。一个人把同一张卡复制五次,是
 * 一张卡被采纳,不是五次采纳 —— 按事件计会让反复复制粘贴的重度用户单方面把率
 * 拉高。原始事件仍然逐条落库(`events` 字段能看到),只是不做率的分子。
 */
import { queryAll, type NovaDb } from "../db/client";

export type AdoptionAction =
  /** 复制卡片要点到剪贴板。 */
  | "copy"
  /** 导出 Markdown / JSON。 */
  | "export"
  /**
   * 同步到 LIMS / 项目系统（用户主动触发）。
   *
   * ⚠️ 区分：`graph.ts` 里的自动飞书双写（`syncDecisionCard`）**不**调用
   * `recordAdoptionEvent`——自动推送不代表用户采纳，混入会虚高采纳率。
   * 只有用户在 UI 上点击「同步」按钮时才落这一条。
   */
  | "sync";

export const ADOPTION_ACTIONS: readonly AdoptionAction[] = ["copy", "export", "sync"];

export interface AdoptionEventInput {
  projectId: string;
  cardId: string;
  action: AdoptionAction;
  /** 触发位置(如 `card-header` / `role-actions`),只用于诊断,不进任何指标。 */
  surface?: string;
  now: string;
}

/**
 * 落一条采纳事件。
 *
 * 不去重:同一张卡的多次动作都逐条记录(id 里带时间戳 + 随机后缀),因为「什么时候
 * 被再次导出」本身是有用的诊断信息。去重发生在读侧(`adoptionSummary`)。
 *
 * 和埋点 A 一样包在 try 里:采纳埋点写失败绝对不能让用户的导出/复制动作失败 ——
 * 观测设施的可用性优先级低于它观测的功能。
 */
export function recordAdoptionEvent(db: NovaDb, input: AdoptionEventInput): void {
  try {
    db.prepare(
      `INSERT INTO adoption_events(id, project_id, card_id, action, surface, created_at)
       VALUES(?, ?, ?, ?, ?, ?)`,
    ).run(
      `AD-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8)}`,
      input.projectId,
      input.cardId,
      input.action,
      input.surface ?? "",
      input.now,
    );
  } catch (err) {
    console.warn(`[adoption] 埋点写入失败(不影响用户动作): ${(err as Error).message}`);
  }
}

export interface AdoptionSummary {
  /** 出卡数(去重到卡片 id)—— 率的分母。 */
  cards: number;
  /** 有过至少一次采纳动作的卡片数 —— 率的分子。 */
  adoptedCards: number;
  /** 隐式采纳率。分母为 0 时记 0,不记 1 ——「还没出过卡」不该显示成 100% 采纳。 */
  adoptionRate: number;
  /** 原始事件总数(不去重),用于诊断「是少数人反复导出还是多数人各导一次」。 */
  events: number;
  /** 按动作分布的事件数。三个 key 恒定存在,没有的记 0(看板不要出现忽隐忽现的行)。 */
  byAction: Record<AdoptionAction, number>;
}

/**
 * 看板口径汇总。`sinceIso` 可选,用来切自然周;分子分母用同一个时间窗,否则
 * 「本周导出数 / 历史总出卡数」会得到一个恒定偏低且毫无意义的比率。
 */
export function adoptionSummary(db: NovaDb, sinceIso?: string): AdoptionSummary {
  const since = sinceIso ?? null;
  const cards = queryAll<{ n: number }>(
    db,
    `SELECT COUNT(DISTINCT id) AS n FROM decision_cards
     WHERE (? IS NULL OR created_at >= ?)`,
    since,
    since,
  )[0]!.n;

  const adopted = queryAll<{ adoptedCards: number; events: number }>(
    db,
    `SELECT COUNT(DISTINCT card_id) AS adoptedCards, COUNT(*) AS events
     FROM adoption_events
     WHERE (? IS NULL OR created_at >= ?)`,
    since,
    since,
  )[0]!;

  const rows = queryAll<{ action: string; n: number }>(
    db,
    `SELECT action, COUNT(*) AS n FROM adoption_events
     WHERE (? IS NULL OR created_at >= ?)
     GROUP BY action`,
    since,
    since,
  );
  const byAction: Record<AdoptionAction, number> = { copy: 0, export: 0, sync: 0 };
  for (const r of rows) {
    if ((ADOPTION_ACTIONS as readonly string[]).includes(r.action)) {
      byAction[r.action as AdoptionAction] = r.n;
    }
  }

  return {
    cards,
    adoptedCards: adopted.adoptedCards,
    // 采纳的卡有可能不在分母里(卡在窗口前出、窗口内才被导出),此时率会 > 1。
    // 夹到 1:一个「117% 采纳率」的看板只会让人不再相信这一格。
    adoptionRate: cards === 0 ? 0 : Math.min(1, adopted.adoptedCards / cards),
    events: adopted.events,
    byAction,
  };
}
