/**
 * 护栏对看板口径(指标体系 v1.1 第 10 节)。
 *
 * 第 10 节给了一张表,六行,每行「激励指标 / 游戏化路径 / 护栏指标 / 判定」。
 * 这个模块只做一件事:把那六行的数**成对**算出来,并且把「判定」原样带上。
 *
 * 为什么要成对算而不是各算各的、让看板自己拼:
 *
 *   只有激励指标有数、护栏指标没数的看板,比没有看板更危险,因为它会让人以为
 *   自己在被约束。
 *
 * 如果护栏侧和激励侧来自两次独立查询、两个不同时间窗,那么「成对」只是排版上的
 * 成对 —— 有人优化了激励指标,护栏侧还显示着上周的数,看板会给他一个通过。
 * 所以这里一次查询、同一个 `sinceIso` 切窗,六对同源同窗。
 *
 * 关于 null:所有率在没有样本时返回 null,不返回 0。看板把 null 渲染成「—」。
 * 一个写着 0% 误拦率的空队列会让人以为系统已经被验证过了 —— 那比没有这一格更糟。
 */
import type { NovaDb } from "../db/client";
import { queryAll, queryOne } from "../db/client";
import { bindingRateSummary, type BindingRateSummary } from "../guards/citation-audit";
import { reviewSampleSummary, type ReviewSampleSummary } from "./review-samples";
import { revisionInflowSummary, type RevisionInflowSummary } from "./case-closure";
import { adoptionSummary, type AdoptionSummary } from "./adoption";
import { latencySummary, type LatencySummary } from "./latency";

/** 会话处置分布。分母是**会话数**,不是卡版本数 —— 见 countSessions()。 */
export interface SessionMix {
  sessions: number;
  formal: number;
  expertReview: number;
  needsConditions: number;
  other: number;
}

export interface KnowledgeVolume {
  /** 窗口内**成功提交**的入库文档数(入库量是流量指标,数据源是 ingest_runs)。 */
  documents: number;
  /** 窗口内成功提交的入库切片数。 */
  chunks: number;
  /**
   * 窗口内被金标回归门禁拦下、整批回滚的入库次数。
   *
   * 这是「灌水入库」的直接观测量:门禁挡住了几批。它不是失败指标 ——
   * 回滚数为 0 且入库量很大,才是需要问一句「门禁真的在跑吗」的信号。
   */
  rolledBackRuns: number;
  candidatesApproved: number;
  candidatesPending: number;
  /**
   * 全库累计文档 / 切片数,不切窗。
   *
   * 单看窗口内的「+0 篇」会被读成「知识库是空的」,而实际是「本周没新增」——
   * 这两件事的处置完全不同(前者是故障,后者是常态)。所以两个数必须同时给。
   * documents 表本身没有时间戳(见 schema),所以累计量只能是全量计数 ——
   * 种子库那 15 篇没有对应的 ingest_run,它们只会出现在累计数里。
   */
  documentsTotal: number;
  chunksTotal: number;
}

export interface FeedbackMix {
  total: number;
  /** score ≤ 2(与前端 nova-workspace 的负反馈判定同阈值)。 */
  negative: number;
  negativeRate: number | null;
}

export interface GuardrailBoard {
  /** 切窗起点;null = 全量。 */
  since: string | null;
  sessions: SessionMix;
  /** 直接解决率 = formal / 会话数。激励指标,护栏是该转未转率。 */
  directResolutionRate: number | null;
  /** Critic 拦截率 = expert-review / 会话数。激励指标,护栏是误拦截率。 */
  interceptionRate: number | null;
  /**
   * 可信解决率 = (formal 且引用绑定率 = 100%) / 会话数。
   * 注意它**不含**隐式采纳率 —— 4.4 节明确要求采纳率不进这条计算链。
   */
  trustedResolutionRate: number | null;
  binding: BindingRateSummary;
  review: ReviewSampleSummary;
  inflow: RevisionInflowSummary;
  adoption: AdoptionSummary;
  latency: LatencySummary;
  knowledge: KnowledgeVolume;
  feedback: FeedbackMix;
}

/**
 * 会话数,不是卡版本数。
 *
 * decision_cards 主键是 (id, version):同一个咨询改一次事实重出一版,就多一行。
 * 拿行数当分母的话,一个反复修参数的用户会把分母冲大、解决率冲低,而他其实只
 * 咨询了一件事。所以按 trace_id 去重 —— 一次图运行 = 一次会话 = 一个 trace。
 * trace_id 为空的历史行退回 id+version,不静默丢弃(丢样本会让分母漂)。
 */
function sessionKey(alias = "c"): string {
  return `COALESCE(${alias}.trace_id, ${alias}.id || ':' || ${alias}.version)`;
}

function sessionMix(db: NovaDb, since: string | null): SessionMix {
  const row = queryOne<{
    sessions: number;
    formal: number;
    expert_review: number;
    needs_conditions: number;
  }>(
    db,
    `SELECT
       COUNT(DISTINCT ${sessionKey()}) AS sessions,
       COUNT(DISTINCT CASE WHEN c.status = 'formal' THEN ${sessionKey()} END) AS formal,
       COUNT(DISTINCT CASE WHEN c.status = 'expert-review' THEN ${sessionKey()} END) AS expert_review,
       COUNT(DISTINCT CASE WHEN c.status = 'needs-conditions' THEN ${sessionKey()} END) AS needs_conditions
     FROM decision_cards c
     WHERE (? IS NULL OR c.created_at >= ?)`,
    since,
    since,
  );
  const sessions = row?.sessions ?? 0;
  const formal = row?.formal ?? 0;
  const expertReview = row?.expert_review ?? 0;
  const needsConditions = row?.needs_conditions ?? 0;
  return {
    sessions,
    formal,
    expertReview,
    needsConditions,
    other: Math.max(0, sessions - formal - expertReview - needsConditions),
  };
}

/**
 * 可信解决率的分子:formal 且**独立审计**判定引用全绑定的会话。
 *
 * 用 citation_audits 而不是 Critic 的放行结论:Critic 放行不等于绑定成立,
 * 自己证明自己通过没有意义(埋点 A 存在的全部理由)。
 * 没有审计记录的 formal 卡不计入分子 —— 「没审过」不能当「审过且合格」。
 */
function trustedFormalSessions(db: NovaDb, since: string | null): number {
  const row = queryOne<{ n: number }>(
    db,
    `SELECT COUNT(DISTINCT ${sessionKey()}) AS n
     FROM decision_cards c
     JOIN citation_audits a ON a.trace_id = c.trace_id
     WHERE c.status = 'formal' AND a.binding_rate >= 1.0
       AND (? IS NULL OR c.created_at >= ?)`,
    since,
    since,
  );
  return row?.n ?? 0;
}

function knowledgeVolume(db: NovaDb, since: string | null): KnowledgeVolume {
  // 入库量的数据源是 ingest_runs,不是 documents —— documents 表没有时间戳,
  // 而「本周入库了多少」是个流量问题。顺带得到门禁回滚数:那是「灌水入库」
  // 这条游戏化路径的直接观测量,和入库量必须同框。
  const runs = queryOne<{ documents: number; chunks: number; rolled_back: number }>(
    db,
    `SELECT
       COALESCE(SUM(CASE WHEN outcome = 'committed' THEN doc_count   ELSE 0 END), 0) AS documents,
       COALESCE(SUM(CASE WHEN outcome = 'committed' THEN chunk_count ELSE 0 END), 0) AS chunks,
       COALESCE(SUM(CASE WHEN outcome = 'rolled-back' THEN 1 ELSE 0 END), 0) AS rolled_back
     FROM ingest_runs WHERE (? IS NULL OR created_at >= ?)`,
    since,
    since,
  );
  // 状态取值必须和 CandidateKnowledge 的枚举对齐:
  // 'candidate' | 'owner-approved' | 'gray-active' | 'rejected'。
  // 这里原先写的是 status = 'approved' —— 一个本系统从不写入的值,于是
  // candidatesApproved 恒为 0,而 pending 把已上线的 gray-active 也算成了待审。
  // 两格都是「看起来有数、实际恒定」的死格,正是 catch 兜底最容易掩盖的那类错。
  const cands = queryOne<{ approved: number; pending: number }>(
    db,
    `SELECT
       COALESCE(SUM(CASE WHEN status IN ('owner-approved','gray-active') THEN 1 ELSE 0 END), 0) AS approved,
       COALESCE(SUM(CASE WHEN status = 'candidate' THEN 1 ELSE 0 END), 0) AS pending
     FROM candidates WHERE (? IS NULL OR created_at >= ?)`,
    since,
    since,
  );
  return {
    documents: runs?.documents ?? 0,
    chunks: runs?.chunks ?? 0,
    rolledBackRuns: runs?.rolled_back ?? 0,
    candidatesApproved: cands?.approved ?? 0,
    candidatesPending: cands?.pending ?? 0,
    documentsTotal: queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM documents`)?.n ?? 0,
    chunksTotal: queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM chunks`)?.n ?? 0,
  };
}

function feedbackMix(db: NovaDb, since: string | null): FeedbackMix {
  const row = queryOne<{ total: number; negative: number }>(
    db,
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN score <= 2 THEN 1 ELSE 0 END), 0) AS negative
     FROM feedback WHERE (? IS NULL OR created_at >= ?)`,
    since,
    since,
  );
  const total = row?.total ?? 0;
  return {
    total,
    negative: row?.negative ?? 0,
    // 显式负反馈本身是自选样本(v1.1 新增的那一行就是在说这件事):
    // 满意的人默默复制走,不满的人才点差评。所以它必须和隐式采纳率成对读。
    negativeRate: total === 0 ? null : (row?.negative ?? 0) / total,
  };
}

/** 六对护栏一次算完,同源同窗。任一子查询失败都不该让整页 500 —— 各自兜底。 */
export function guardrailBoard(db: NovaDb, sinceIso?: string): GuardrailBoard {
  const since = sinceIso ?? null;
  // 单格降级:老库缺表时不该让整页 500。
  //
  // 但这个 try/catch 有个陷阱,已经踩过一次:一个写错的列名会被它吞成「这一格是 0」,
  // 而 0 在看板上和真实的 0 长得一模一样。所以两条对策 ——
  //   1) 用 console.error 而不是 warn,并带上「口径缺格」字样,起服务时看得见;
  //   2) 每个子查询都必须有单测直接调用它(见 guardrail-board.test.ts)。
  // 光靠 catch 兜底等于把口径错误静音,那正是这张看板要防的事情本身。
  const safe = <T>(fn: () => T, fallback: T, label: string): T => {
    try {
      return fn();
    } catch (err) {
      console.error(`[guardrail-board] 口径缺格 · ${label} 查询失败`, err);
      return fallback;
    }
  };

  const sessions = safe(
    () => sessionMix(db, since),
    { sessions: 0, formal: 0, expertReview: 0, needsConditions: 0, other: 0 },
    "sessionMix",
  );
  const trusted = safe(() => trustedFormalSessions(db, since), 0, "trustedFormalSessions");
  const rate = (numerator: number) =>
    sessions.sessions === 0 ? null : numerator / sessions.sessions;

  return {
    since,
    sessions,
    directResolutionRate: rate(sessions.formal),
    interceptionRate: rate(sessions.expertReview),
    trustedResolutionRate: rate(trusted),
    binding: safe(
      () => bindingRateSummary(db, sinceIso),
      { cards: 0, citations: 0, bound: 0, bindingRate: 1, violatingCards: 0 },
      "bindingRateSummary",
    ),
    review: safe(
      () => reviewSampleSummary(db, sinceIso),
      {
        falseInterception: { reviewed: 0, wrong: 0, rate: null, pending: 0 },
        missedEscalation: { reviewed: 0, wrong: 0, rate: null, pending: 0 },
        judgeAgreement: { compared: 0, agreed: 0, rate: null },
      },
      "reviewSampleSummary",
    ),
    inflow: safe(
      () => revisionInflowSummary(db, sinceIso),
      { closures: 0, withCandidate: 0, inflowRate: 0, noCandidateReasons: [] },
      "revisionInflowSummary",
    ),
    adoption: safe(
      () => adoptionSummary(db, sinceIso),
      {
        cards: 0,
        adoptedCards: 0,
        adoptionRate: 0,
        events: 0,
        byAction: { copy: 0, export: 0, sync: 0 },
      },
      "adoptionSummary",
    ),
    latency: safe(
      () => latencySummary(db, sinceIso),
      {
        overall: { samples: 0, p50: null, p95: null, max: null },
        byStatus: [],
        stream: {
          streams: 0,
          completed: 0,
          aborted: 0,
          failed: 0,
          inflight: 0,
          // 兜底也必须是 null:一个查询失败的降级格显示「成功率 100%」,
          // 恰好是这张看板存在的理由的反面。
          successRate: null,
        },
        firstToken: [],
      },
      "latencySummary",
    ),
    knowledge: safe(
      () => knowledgeVolume(db, since),
      {
        documents: 0,
        chunks: 0,
        rolledBackRuns: 0,
        candidatesApproved: 0,
        candidatesPending: 0,
        documentsTotal: 0,
        chunksTotal: 0,
      },
      "knowledgeVolume",
    ),
    feedback: safe(
      () => feedbackMix(db, since),
      { total: 0, negative: 0, negativeRate: null },
      "feedbackMix",
    ),
  };
}

/** 本自然周起点(周一 00:00 UTC)。第 11 节的复盘节奏是周会,切窗默认按周。 */
export function weekStart(nowIso: string): string {
  const d = new Date(nowIso);
  const day = d.getUTCDay(); // 0 = 周日
  const backTo = day === 0 ? 6 : day - 1;
  const monday = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - backTo),
  );
  return monday.toISOString();
}

/**
 * P0 判定(第 11 节):漏放率 > 0、证据绑定率 < 100% → 质量事件 + 冻结发版。
 *
 * 「漏放」在本系统的可观测形态就是绑定率破口:一条没有真实证据支撑的引用号
 * 出现在正式卡上,就是幻觉样例穿过了防线。所以这两条判定共用 violatingCards。
 * 返回原因列表而不是布尔值 —— 冻结发版这种动作,必须能说出是哪一条触发的。
 */
export function p0Breaches(board: GuardrailBoard): string[] {
  const reasons: string[] = [];
  if (board.binding.violatingCards > 0) {
    reasons.push(
      `证据绑定率 < 100%:${board.binding.violatingCards} 张卡存在未绑定引用号(第 11 节 P0)`,
    );
  }
  if (board.binding.cards > 0 && board.binding.bindingRate < 1) {
    reasons.push(
      `按引用号加权绑定率 ${(board.binding.bindingRate * 100).toFixed(1)}%,未达 100%(生命线指标)`,
    );
  }
  return reasons;
}

/**
 * P1 判定(第 11 节):误拦截率 / 该转未转率超阈、judge–专家一致率 < 85% → 周会复盘。
 *
 * 阈值取自第 11 节;这里刻意**不**在没有复核样本时报警 —— rate 为 null 是
 * 「还没人复核」,那是欠复核问题(单独一格显示 pending),不是超阈问题。
 * 把 null 当 0 处理会静默地把一个没被验证过的系统标成健康。
 */
export const P1_THRESHOLDS = {
  falseInterception: 0.1,
  missedEscalation: 0.05,
  judgeAgreement: 0.85,
} as const;

export function p1Breaches(board: GuardrailBoard): string[] {
  const reasons: string[] = [];
  const fi = board.review.falseInterception.rate;
  const me = board.review.missedEscalation.rate;
  const ja = board.review.judgeAgreement.rate;
  if (fi != null && fi > P1_THRESHOLDS.falseInterception) {
    reasons.push(`误拦截率 ${(fi * 100).toFixed(1)}% > ${P1_THRESHOLDS.falseInterception * 100}%`);
  }
  if (me != null && me > P1_THRESHOLDS.missedEscalation) {
    reasons.push(`该转未转率 ${(me * 100).toFixed(1)}% > ${P1_THRESHOLDS.missedEscalation * 100}%`);
  }
  if (ja != null && ja < P1_THRESHOLDS.judgeAgreement) {
    reasons.push(
      `judge–专家一致率 ${(ja * 100).toFixed(1)}% < ${P1_THRESHOLDS.judgeAgreement * 100}%`,
    );
  }
  return reasons;
}

/** 欠复核量:入队但没人审的样本数。不是超阈报警,是「这些率还不可信」的提示。 */
export function pendingReviewLoad(board: GuardrailBoard): number {
  return (
    board.review.falseInterception.pending + board.review.missedEscalation.pending
  );
}

/** 便于测试与看板调试:列出所有非空表的行数(不含内容)。 */
export function telemetryRowCounts(db: NovaDb): Record<string, number> {
  const tables = [
    "citation_audits",
    "review_samples",
    "case_closures",
    "adoption_events",
    "latency_samples",
  ];
  const out: Record<string, number> = {};
  for (const t of tables) {
    try {
      out[t] = queryAll<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${t}`)[0]?.n ?? 0;
    } catch {
      out[t] = 0;
    }
  }
  return out;
}
