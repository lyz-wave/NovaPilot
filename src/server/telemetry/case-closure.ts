/**
 * 埋点 C · 专家办结的「是否产出候选知识」标记(指标体系 v1.1 第 12 节 / 修订回流率)。
 *
 * 想量的东西:专家在这个系统里花掉的时间,有多少沉淀成了下一次能自动答对的知识,
 * 有多少只是把这一单答完就结束了。这个比例(修订回流率)是判断「人机协同是在积累
 * 资产还是在做人力外包」的唯一硬数据。
 *
 * 为什么必须**强制**填理由:
 *
 *   办结时勾一个「本次无可沉淀知识」是零成本的,所以如果不要求理由,这一格会被
 *   无脑勾满,回流率就永远是 0%,而看板会以为知识库真的没东西可长。反过来无脑
 *   勾「有」也一样失真。要求写一句话之后,事后能分辨这两种情况:「这一单是客户
 *   自己搞错了样本类型,没有方法学结论」是一个合法的「无」;「太忙了」不是。
 *
 * 所以 `recordCaseClosure()` 在 `producedCandidate === false` 且没有理由时**抛错**
 * —— 这一处刻意和埋点 A/D 相反,不吞异常。埋点 A/D 是被动观测(观测失败不该拖垮
 * 主链路),这里是办结流程本身的一个必填项,静默放过等于让指标失真,还不如让办结
 * 请求返回 400 让专家补一句话。
 */
import { queryAll, type NovaDb } from "../db/client";

export interface CaseClosureInput {
  caseId: string;
  projectId: string;
  /** 办结人。演示环境固定为专家台账号,真实部署接 SSO。 */
  owner: string;
  /** 办结结论(专家的修订正文)。 */
  resolution: string;
  producedCandidate: boolean;
  /** 产出时指向 candidates.id。 */
  candidateId?: string | null;
  /** `producedCandidate === false` 时必填。 */
  noCandidateReason?: string;
  now: string;
}

export class MissingNoCandidateReason extends Error {
  constructor() {
    super("办结时选择「未产出候选知识」必须填写原因");
    this.name = "MissingNoCandidateReason";
  }
}

/**
 * 落一条办结记录。按 caseId upsert —— 一个案例的办结是一个终态事实,专家改了措辞
 * 重新提交不该在回流率的分母里多出一个案例。
 */
export function recordCaseClosure(db: NovaDb, input: CaseClosureInput): void {
  const reason = (input.noCandidateReason ?? "").trim();
  if (!input.producedCandidate && reason === "") throw new MissingNoCandidateReason();

  db.prepare(
    `INSERT INTO case_closures
       (id, case_id, project_id, owner, resolution, produced_candidate, candidate_id, no_candidate_reason, created_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       resolution = excluded.resolution,
       produced_candidate = excluded.produced_candidate,
       candidate_id = excluded.candidate_id,
       no_candidate_reason = excluded.no_candidate_reason,
       created_at = excluded.created_at`,
  ).run(
    `CC-${input.caseId}`,
    input.caseId,
    input.projectId,
    input.owner,
    input.resolution,
    input.producedCandidate ? 1 : 0,
    input.producedCandidate ? (input.candidateId ?? null) : null,
    input.producedCandidate ? "" : reason,
    input.now,
  );
}

export interface RevisionInflowSummary {
  /** 办结案例数 —— 分母。 */
  closures: number;
  /** 产出了候选知识的办结数 —— 分子。 */
  withCandidate: number;
  /** 修订回流率。分母为 0 时记 0 ——「还没办结过案例」不该显示成 100% 回流。 */
  inflowRate: number;
  /**
   * 「无候选」的理由清单(去重后按出现次数降序,最多 10 条)。
   * 看板必须把它显示出来:回流率低本身不是问题,理由清一色是「时间不够」才是问题,
   * 而只看那个百分比是分不出来的。
   */
  noCandidateReasons: { reason: string; count: number }[];
}

/** 看板口径。`sinceIso` 可选,用来切自然周。 */
export function revisionInflowSummary(db: NovaDb, sinceIso?: string): RevisionInflowSummary {
  const since = sinceIso ?? null;
  const row = queryAll<{ closures: number; withCandidate: number }>(
    db,
    `SELECT COUNT(*) AS closures,
            COALESCE(SUM(produced_candidate), 0) AS withCandidate
     FROM case_closures
     WHERE (? IS NULL OR created_at >= ?)`,
    since,
    since,
  )[0]!;

  const reasons = queryAll<{ reason: string; count: number }>(
    db,
    `SELECT no_candidate_reason AS reason, COUNT(*) AS count
     FROM case_closures
     WHERE produced_candidate = 0 AND no_candidate_reason <> ''
       AND (? IS NULL OR created_at >= ?)
     GROUP BY no_candidate_reason
     ORDER BY count DESC, reason
     LIMIT 10`,
    since,
    since,
  );

  return {
    ...row,
    inflowRate: row.closures === 0 ? 0 : row.withCandidate / row.closures,
    noCandidateReasons: reasons,
  };
}
