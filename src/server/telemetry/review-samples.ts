/**
 * 埋点 B · 拦截/未转样本复核队列(指标体系 v1.1 第 12 节 / 5.1 节)。
 *
 * 要量三个数,而这三个数**都拿不到自动真值**:
 *
 *   误拦截率     系统转了专家,但其实本来就能直接答 —— 系统自己不知道自己拦错了。
 *   该转未转率   系统直接答了,但其实该转专家 —— 这是最危险的那一类,而且它不会
 *                自己冒出来:用户拿着一份自信的错答案走了,没人会回来报错。
 *   judge 一致率  离线 LLM 预审和专家终审的吻合程度 —— 用来判断预审能不能扛量。
 *
 * 所以只能抽样送人复核。这个模块就是那条队列。
 *
 * 5.1 节写死的铁律(照抄):**judge 只做预筛不做终审,终审权在专家手里**。
 * 代码层面的落实方式是:`agreement` 只在两侧**都有**判定时才算 agree/disagree,
 * 任一侧缺失恒为 pending;误拦截率/该转未转率的分母**只统计有专家判定的样本**,
 * judge 判定一条都不进这两个率。judge 的价值只体现在一致率里 —— 一致率高到可信
 * 之后,才谈得上让它承担更大比例的预筛量,而那也是一个人来做的决定。
 *
 * 抽样必须**确定性**:抽样发生在运行时链路上,而这个系统的离线确定性约束要求同一
 * 输入重放必须得到同一结果。所以用 traceId 的稳定哈希取模,不用 Math.random ——
 * 否则同一条金标用例两次跑出的落库行数不同,NovaBench 的可复现性就没了。
 */
import { queryAll, type NovaDb } from "../db/client";

export type ReviewKind = "intercepted" | "not-escalated";

export type ReviewVerdict =
  /** 被拦样本:其实该直接放行(= 误拦截)。 */
  | "should-pass"
  /** 被拦样本:确实该拦。 */
  | "should-block"
  /** 未转样本:其实该转专家(= 该转未转)。 */
  | "should-escalate"
  /** 未转样本:确实不用转。 */
  | "should-not-escalate";

/** 每种样本类型允许的判定。判定和类型对不上的样本没有意义,直接拒。 */
const ALLOWED: Record<ReviewKind, readonly ReviewVerdict[]> = {
  intercepted: ["should-pass", "should-block"],
  "not-escalated": ["should-escalate", "should-not-escalate"],
};

/** 每种类型里「系统判错了」的那一侧 —— 误拦截率 / 该转未转率的分子。 */
const WRONG_SIDE: Record<ReviewKind, ReviewVerdict> = {
  intercepted: "should-pass",
  "not-escalated": "should-escalate",
};

export function verdictAllowed(kind: ReviewKind, verdict: string): verdict is ReviewVerdict {
  return (ALLOWED[kind] as readonly string[]).includes(verdict);
}

/**
 * traceId → [0, 1) 的稳定哈希(FNV-1a 32 位)。
 * 同一个 traceId 永远得到同一个值,所以抽样结果可复现。
 */
function stableUnit(traceId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < traceId.length; i++) {
    h ^= traceId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 0x100000000;
}

/**
 * 默认抽样率。
 *
 * 「未转」样本的抽样率刻意远高于「被拦」样本:被拦错了用户当场就会抱怨(有自然
 * 反馈通路),该转未转错了没有任何人会来报错 —— 只能靠抽样把它捞出来。给这两类
 * 同一个抽样率,等于把复核人力平均分给「已经有别的办法能发现的问题」和「除了抽样
 * 别无办法的问题」。
 */
export const DEFAULT_SAMPLE_RATES: Record<ReviewKind, number> = {
  intercepted: 0.2,
  "not-escalated": 1,
};

export interface ReviewSampleInput {
  kind: ReviewKind;
  projectId: string;
  traceId: string;
  /** 系统当时的处置,例如 `expert-review · 强制升级` / `formal · 3 条建议`。 */
  systemAction: string;
  /** 复核所需的上下文摘要(问题、事实、风险信号、引用号)。 */
  context: Record<string, unknown>;
  now: string;
  /** 覆盖抽样率(测试与离线回灌用)。传 1 表示必抽。 */
  sampleRate?: number;
}

/**
 * 按确定性抽样入队。返回是否真的落了一行。
 *
 * 和埋点 A/D 一样吞异常:复核队列写失败不该让用户拿不到卡。
 */
export function enqueueReviewSample(db: NovaDb, input: ReviewSampleInput): boolean {
  const rate = input.sampleRate ?? DEFAULT_SAMPLE_RATES[input.kind];
  if (rate < 1 && stableUnit(input.traceId) >= rate) return false;
  try {
    db.prepare(
      `INSERT INTO review_samples(id, kind, project_id, trace_id, system_action, context, agreement, created_at)
       VALUES(?, ?, ?, ?, ?, ?, 'pending', ?)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind, system_action = excluded.system_action,
         context = excluded.context, created_at = excluded.created_at`,
    ).run(
      `RS-${input.traceId}`,
      input.kind,
      input.projectId,
      input.traceId,
      input.systemAction,
      JSON.stringify(input.context),
      input.now,
    );
    return true;
  } catch (err) {
    console.warn(`[review-samples] 入队失败(不影响出卡): ${(err as Error).message}`);
    return false;
  }
}

export interface ReviewSample {
  id: string;
  kind: ReviewKind;
  projectId: string;
  traceId: string;
  systemAction: string;
  context: Record<string, unknown>;
  judgeVerdict: ReviewVerdict | null;
  judgeConfidence: number | null;
  judgeModel: string | null;
  expertVerdict: ReviewVerdict | null;
  expertNote: string | null;
  agreement: "agree" | "disagree" | "pending";
  createdAt: string;
}

interface SampleRow {
  id: string;
  kind: string;
  projectId: string;
  traceId: string;
  systemAction: string;
  context: string;
  judgeVerdict: string | null;
  judgeConfidence: number | null;
  judgeModel: string | null;
  expertVerdict: string | null;
  expertNote: string | null;
  agreement: string | null;
  createdAt: string;
}

const SELECT_COLS = `id, kind, project_id AS projectId, trace_id AS traceId,
       system_action AS systemAction, context,
       judge_verdict AS judgeVerdict, judge_confidence AS judgeConfidence,
       judge_model AS judgeModel, expert_verdict AS expertVerdict,
       expert_note AS expertNote, agreement, created_at AS createdAt`;

function mapSample(r: SampleRow): ReviewSample {
  return {
    ...r,
    kind: r.kind as ReviewKind,
    // 上下文是自己写进去的 JSON,但解析失败也不该让整个队列页 500 —— 退化成空对象,
    // 复核人至少还能看到 systemAction 和 traceId 去查原始 trace。
    context: safeJson(r.context),
    judgeVerdict: (r.judgeVerdict as ReviewVerdict | null) ?? null,
    expertVerdict: (r.expertVerdict as ReviewVerdict | null) ?? null,
    agreement:
      r.agreement === "agree" || r.agreement === "disagree" ? r.agreement : "pending",
  };
}

function safeJson(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 待专家复核的样本(专家判定为空),最新优先。 */
export function listPendingExpertReview(db: NovaDb, limit = 50): ReviewSample[] {
  return queryAll<SampleRow>(
    db,
    `SELECT ${SELECT_COLS} FROM review_samples
     WHERE expert_verdict IS NULL
     ORDER BY created_at DESC LIMIT ?`,
    limit,
  ).map(mapSample);
}

/** 待离线 judge 预审的样本(judge 判定为空)。给离线脚本用。 */
export function listPendingJudge(db: NovaDb, limit = 200): ReviewSample[] {
  return queryAll<SampleRow>(
    db,
    `SELECT ${SELECT_COLS} FROM review_samples
     WHERE judge_verdict IS NULL
     ORDER BY created_at ASC LIMIT ?`,
    limit,
  ).map(mapSample);
}

export function getReviewSample(db: NovaDb, id: string): ReviewSample | null {
  const rows = queryAll<SampleRow>(db, `SELECT ${SELECT_COLS} FROM review_samples WHERE id = ?`, id);
  return rows[0] ? mapSample(rows[0]) : null;
}

/**
 * 重算 agreement。
 *
 * 只在两侧都有判定时才给结论,否则恒为 pending —— 「judge 判了、专家没判」不是
 * 一致也不是分歧,把它算成 agree 会让一致率变成 judge 的自评。
 */
function agreementOf(judge: string | null, expert: string | null): "agree" | "disagree" | "pending" {
  if (!judge || !expert) return "pending";
  return judge === expert ? "agree" : "disagree";
}

export class InvalidVerdict extends Error {
  constructor(kind: string, verdict: string) {
    super(`判定 ${verdict} 不适用于 ${kind} 类样本`);
    this.name = "InvalidVerdict";
  }
}

/** 写入离线 judge 的预审结论。不吞异常:离线脚本要看到失败。 */
export function setJudgeVerdict(
  db: NovaDb,
  input: { id: string; verdict: ReviewVerdict; confidence: number; model: string; now: string },
): ReviewSample | null {
  const sample = getReviewSample(db, input.id);
  if (!sample) return null;
  if (!verdictAllowed(sample.kind, input.verdict)) throw new InvalidVerdict(sample.kind, input.verdict);
  db.prepare(
    `UPDATE review_samples
     SET judge_verdict = ?, judge_confidence = ?, judge_model = ?, judge_at = ?, agreement = ?
     WHERE id = ?`,
  ).run(
    input.verdict,
    input.confidence,
    input.model,
    input.now,
    agreementOf(input.verdict, sample.expertVerdict),
    input.id,
  );
  return getReviewSample(db, input.id);
}

/** 写入专家终审结论。这是唯一进入误拦截率/该转未转率的判定。 */
export function setExpertVerdict(
  db: NovaDb,
  input: { id: string; verdict: ReviewVerdict; note?: string; now: string },
): ReviewSample | null {
  const sample = getReviewSample(db, input.id);
  if (!sample) return null;
  if (!verdictAllowed(sample.kind, input.verdict)) throw new InvalidVerdict(sample.kind, input.verdict);
  db.prepare(
    `UPDATE review_samples
     SET expert_verdict = ?, expert_note = ?, expert_at = ?, agreement = ?
     WHERE id = ?`,
  ).run(
    input.verdict,
    input.note?.trim() ?? "",
    input.now,
    agreementOf(sample.judgeVerdict, input.verdict),
    input.id,
  );
  return getReviewSample(db, input.id);
}

export interface ReviewRate {
  /** 有专家判定的样本数 —— 分母。 */
  reviewed: number;
  /** 专家认定系统判错的样本数 —— 分子。 */
  wrong: number;
  /** 率。分母为 0 时记 null(不是 0)—— 「还没人复核过」和「复核了都对」必须能区分。 */
  rate: number | null;
  /** 入队但还没人复核的样本数。看板要显示它:欠复核量本身是一个健康度信号。 */
  pending: number;
}

export interface ReviewSampleSummary {
  /** 误拦截率(被拦样本中专家判 should-pass 的比例)。 */
  falseInterception: ReviewRate;
  /** 该转未转率(未转样本中专家判 should-escalate 的比例)。 */
  missedEscalation: ReviewRate;
  /** judge–专家一致率。两侧都有判定的样本里 agree 的比例;不足样本时 null。 */
  judgeAgreement: {
    compared: number;
    agreed: number;
    rate: number | null;
    /** Wilson 95% 置信区间下界。样本不足时（compared=0）为 null。 */
    wilsonLower: number | null;
    /** Wilson 95% 置信区间上界。 */
    wilsonUpper: number | null;
  };
}

/**
 * Wilson score interval（95% 置信度，z=1.96）。比正态近似区间在小样本下更
 * 稳健，不会在 n 小时把区间越界推到 [0,1] 之外。
 *
 * 用途：judge-专家一致率的点估计在样本量小时（如 n<30）单看百分比会误导——
 * 92% 可能只是 12/13。下界 < 85% 时看板应显示"样本不足以判定"（S3.3 要求）。
 */
export function wilsonInterval(
  successes: number,
  total: number,
  z = 1.96,
): { lower: number; upper: number } {
  if (total === 0) return { lower: 0, upper: 1 };
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const center = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return {
    lower: Math.max(0, (center - margin) / denom),
    upper: Math.min(1, (center + margin) / denom),
  };
}

function rateFor(db: NovaDb, kind: ReviewKind, since: string | null): ReviewRate {
  const row = queryAll<{ reviewed: number; wrong: number; pending: number }>(
    db,
    `SELECT
       COALESCE(SUM(CASE WHEN expert_verdict IS NOT NULL THEN 1 ELSE 0 END), 0) AS reviewed,
       COALESCE(SUM(CASE WHEN expert_verdict = ? THEN 1 ELSE 0 END), 0) AS wrong,
       COALESCE(SUM(CASE WHEN expert_verdict IS NULL THEN 1 ELSE 0 END), 0) AS pending
     FROM review_samples
     WHERE kind = ? AND (? IS NULL OR created_at >= ?)`,
    WRONG_SIDE[kind],
    kind,
    since,
    since,
  )[0]!;
  return { ...row, rate: row.reviewed === 0 ? null : row.wrong / row.reviewed };
}

/** 看板口径汇总。`sinceIso` 可选。 */
export function reviewSampleSummary(db: NovaDb, sinceIso?: string): ReviewSampleSummary {
  const since = sinceIso ?? null;
  const ag = queryAll<{ compared: number; agreed: number }>(
    db,
    `SELECT
       COALESCE(SUM(CASE WHEN agreement IN ('agree','disagree') THEN 1 ELSE 0 END), 0) AS compared,
       COALESCE(SUM(CASE WHEN agreement = 'agree' THEN 1 ELSE 0 END), 0) AS agreed
     FROM review_samples
     WHERE (? IS NULL OR created_at >= ?)`,
    since,
    since,
  )[0]!;
  const agRate = ag.compared === 0 ? null : ag.agreed / ag.compared;
  const wi = ag.compared === 0 ? null : wilsonInterval(ag.agreed, ag.compared);
  return {
    falseInterception: rateFor(db, "intercepted", since),
    missedEscalation: rateFor(db, "not-escalated", since),
    judgeAgreement: {
      ...ag,
      rate: agRate,
      wilsonLower: wi?.lower ?? null,
      wilsonUpper: wi?.upper ?? null,
    },
  };
}
