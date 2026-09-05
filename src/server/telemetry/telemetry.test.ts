/**
 * 埋点 B(抽样复核队列)+ 埋点 C(专家办结的候选知识标记)单测。
 *
 * 这两处的测试重点是**指标的可信性边界**,不只是算术:
 *
 *  - 埋点 B:judge 的判定一条都不许进误拦截率/该转未转率(5.1 节铁律:judge 只做
 *    预筛不做终审);抽样必须确定性(离线可复现);率的分母为 0 时必须能和「复核了
 *    都对」区分开。
 *  - 埋点 C:未产出候选时不填理由必须**抛错**,而不是静默记一行 —— 这是四处埋点里
 *    唯一一个刻意不吞异常的地方。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createDb, queryAll, type NovaDb } from "../db/client";
import {
  DEFAULT_SAMPLE_RATES,
  InvalidVerdict,
  enqueueReviewSample,
  getReviewSample,
  listPendingExpertReview,
  listPendingJudge,
  reviewSampleSummary,
  setExpertVerdict,
  setJudgeVerdict,
  verdictAllowed,
  type ReviewKind,
} from "./review-samples";
import {
  MissingNoCandidateReason,
  recordCaseClosure,
  revisionInflowSummary,
} from "./case-closure";

const NOW = "2026-09-01T00:00:00.000Z";

function enqueue(
  db: NovaDb,
  traceId: string,
  kind: ReviewKind = "not-escalated",
  now = NOW,
): boolean {
  return enqueueReviewSample(db, {
    kind,
    projectId: `P-${traceId}`,
    traceId,
    systemAction: kind === "intercepted" ? "expert-review · 强制升级" : "formal · 3 条建议",
    context: { question: `问题 ${traceId}`, riskSignals: ["DV200 偏低"] },
    now,
    // 抽样率在业务代码里对两类样本不同,测试要的是队列语义而不是抽样,所以显式传 1。
    sampleRate: 1,
  });
}

describe("埋点 B · 入队与抽样", () => {
  let db: NovaDb;
  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("入队后可读回,agreement 初始为 pending", () => {
    expect(enqueue(db, "t1", "intercepted")).toBe(true);
    const s = getReviewSample(db, "RS-t1")!;
    expect(s).toMatchObject({
      kind: "intercepted",
      projectId: "P-t1",
      traceId: "t1",
      agreement: "pending",
      judgeVerdict: null,
      expertVerdict: null,
    });
    expect(s.context.question).toBe("问题 t1");
  });

  it("同 traceId 重放是 upsert,不会在分母里多出一条", () => {
    enqueue(db, "t1");
    enqueue(db, "t1");
    expect(queryAll(db, "SELECT id FROM review_samples")).toHaveLength(1);
  });

  it("抽样是确定性的 —— 同一 traceId 反复判定结果恒定", () => {
    // 离线确定性约束:同一输入重放必须得到同一结果,包括落库行数。
    const decisions = new Set<boolean>();
    for (let i = 0; i < 20; i++) {
      const fresh = createDb(":memory:");
      decisions.add(
        enqueueReviewSample(fresh, {
          kind: "intercepted",
          projectId: "P-x",
          traceId: "trace-fixed-abc",
          systemAction: "expert-review",
          context: {},
          now: NOW,
          sampleRate: 0.2,
        }),
      );
    }
    expect(decisions.size).toBe(1);
  });

  it("抽样率 1 必抽、0 必不抽", () => {
    expect(enqueueReviewSample(db, { kind: "intercepted", projectId: "P", traceId: "a", systemAction: "x", context: {}, now: NOW, sampleRate: 1 })).toBe(true);
    expect(enqueueReviewSample(db, { kind: "intercepted", projectId: "P", traceId: "b", systemAction: "x", context: {}, now: NOW, sampleRate: 0 })).toBe(false);
  });

  it("未转样本的默认抽样率高于被拦样本", () => {
    // 被拦错了用户当场会抱怨(有自然反馈通路);该转未转错了没人会来报错,
    // 只能靠抽样捞 —— 给同一个率等于把复核人力平均分给不等价的两类问题。
    expect(DEFAULT_SAMPLE_RATES["not-escalated"]).toBeGreaterThan(
      DEFAULT_SAMPLE_RATES.intercepted,
    );
  });

  it("写入失败只告警不抛", () => {
    const broken = createDb(":memory:");
    broken.exec("DROP TABLE review_samples");
    expect(() => enqueue(broken, "t1")).not.toThrow();
    expect(enqueue(broken, "t1")).toBe(false);
  });
});

describe("埋点 B · 判定与一致率", () => {
  let db: NovaDb;
  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("判定必须与样本类型匹配", () => {
    expect(verdictAllowed("intercepted", "should-pass")).toBe(true);
    expect(verdictAllowed("intercepted", "should-escalate")).toBe(false);
    expect(verdictAllowed("not-escalated", "should-escalate")).toBe(true);
    expect(verdictAllowed("not-escalated", "should-block")).toBe(false);
    enqueue(db, "t1", "intercepted");
    expect(() =>
      setExpertVerdict(db, { id: "RS-t1", verdict: "should-escalate", now: NOW }),
    ).toThrow(InvalidVerdict);
  });

  it("只有 judge 判定时 agreement 仍是 pending —— 不许让 judge 自评", () => {
    enqueue(db, "t1", "intercepted");
    const s = setJudgeVerdict(db, {
      id: "RS-t1",
      verdict: "should-block",
      confidence: 0.9,
      model: "test-model",
      now: NOW,
    })!;
    expect(s.agreement).toBe("pending");
    expect(reviewSampleSummary(db).judgeAgreement).toMatchObject({ compared: 0, rate: null });
  });

  it("两侧都有判定后才算 agree / disagree,顺序无关", () => {
    // judge 先、专家后
    enqueue(db, "t1", "intercepted");
    setJudgeVerdict(db, { id: "RS-t1", verdict: "should-block", confidence: 0.8, model: "m", now: NOW });
    expect(setExpertVerdict(db, { id: "RS-t1", verdict: "should-block", now: NOW })!.agreement).toBe("agree");
    // 专家先、judge 后(离线预审补跑的情况)
    enqueue(db, "t2", "intercepted");
    setExpertVerdict(db, { id: "RS-t2", verdict: "should-pass", now: NOW });
    expect(
      setJudgeVerdict(db, { id: "RS-t2", verdict: "should-block", confidence: 0.6, model: "m", now: NOW })!
        .agreement,
    ).toBe("disagree");
    expect(reviewSampleSummary(db).judgeAgreement).toMatchObject({
      compared: 2,
      agreed: 1,
      rate: 0.5,
    });
  });

  it("judge 判定不进误拦截率 —— 分母只数有专家判定的样本", () => {
    // 三条被拦样本,judge 全判「误拦」,但一条专家都没审。
    for (const t of ["a", "b", "c"]) {
      enqueue(db, t, "intercepted");
      setJudgeVerdict(db, { id: `RS-${t}`, verdict: "should-pass", confidence: 0.95, model: "m", now: NOW });
    }
    const s = reviewSampleSummary(db);
    // 若 judge 判定进了率,这里会是 100% 误拦截率 —— 一个模型自己宣布的数字。
    expect(s.falseInterception).toMatchObject({ reviewed: 0, wrong: 0, rate: null, pending: 3 });
  });

  it("误拦截率与该转未转率各自只统计自己那一类样本", () => {
    enqueue(db, "i1", "intercepted");
    enqueue(db, "i2", "intercepted");
    enqueue(db, "n1", "not-escalated");
    enqueue(db, "n2", "not-escalated");
    setExpertVerdict(db, { id: "RS-i1", verdict: "should-pass", now: NOW }); // 误拦
    setExpertVerdict(db, { id: "RS-i2", verdict: "should-block", now: NOW });
    setExpertVerdict(db, { id: "RS-n1", verdict: "should-escalate", now: NOW }); // 漏转
    setExpertVerdict(db, { id: "RS-n2", verdict: "should-not-escalate", now: NOW });
    const s = reviewSampleSummary(db);
    expect(s.falseInterception).toMatchObject({ reviewed: 2, wrong: 1, rate: 0.5, pending: 0 });
    expect(s.missedEscalation).toMatchObject({ reviewed: 2, wrong: 1, rate: 0.5, pending: 0 });
  });

  it("没有任何复核时率是 null 而不是 0 —— 空队列不能显示成「已验证无误拦」", () => {
    enqueue(db, "i1", "intercepted");
    const s = reviewSampleSummary(db);
    expect(s.falseInterception.rate).toBeNull();
    expect(s.falseInterception.pending).toBe(1);
    // 复核了且都对,才是真正的 0%。
    setExpertVerdict(db, { id: "RS-i1", verdict: "should-block", now: NOW });
    expect(reviewSampleSummary(db).falseInterception.rate).toBe(0);
  });

  it("待复核队列排除已有专家判定的样本;待预审队列排除已有 judge 判定的", () => {
    enqueue(db, "t1", "intercepted");
    enqueue(db, "t2", "intercepted");
    setExpertVerdict(db, { id: "RS-t1", verdict: "should-block", now: NOW });
    setJudgeVerdict(db, { id: "RS-t2", verdict: "should-block", confidence: 0.7, model: "m", now: NOW });
    expect(listPendingExpertReview(db).map((s) => s.id)).toEqual(["RS-t2"]);
    expect(listPendingJudge(db).map((s) => s.id)).toEqual(["RS-t1"]);
  });

  it("不存在的样本返回 null,不抛", () => {
    expect(setExpertVerdict(db, { id: "RS-nope", verdict: "should-block", now: NOW })).toBeNull();
    expect(setJudgeVerdict(db, { id: "RS-nope", verdict: "should-block", confidence: 1, model: "m", now: NOW })).toBeNull();
  });

  it("sinceIso 切时间窗", () => {
    enqueue(db, "old", "intercepted", "2026-08-01T00:00:00.000Z");
    enqueue(db, "new", "intercepted", "2026-09-01T00:00:00.000Z");
    setExpertVerdict(db, { id: "RS-old", verdict: "should-pass", now: NOW });
    setExpertVerdict(db, { id: "RS-new", verdict: "should-block", now: NOW });
    expect(reviewSampleSummary(db).falseInterception).toMatchObject({ reviewed: 2, wrong: 1 });
    expect(reviewSampleSummary(db, "2026-08-25T00:00:00.000Z").falseInterception).toMatchObject({
      reviewed: 1,
      wrong: 0,
      rate: 0,
    });
  });

  it("context 是坏 JSON 时退化成空对象,不让整个队列页挂掉", () => {
    enqueue(db, "t1", "intercepted");
    db.prepare("UPDATE review_samples SET context = '{不是 JSON' WHERE id = ?").run("RS-t1");
    const s = getReviewSample(db, "RS-t1")!;
    expect(s.context).toEqual({});
    // systemAction 和 traceId 还在 —— 复核人至少能去查原始 trace。
    expect(s.systemAction).toBe("expert-review · 强制升级");
  });
});

describe("埋点 C · 专家办结与修订回流率", () => {
  let db: NovaDb;
  beforeEach(() => {
    db = createDb(":memory:");
  });

  function close(
    caseId: string,
    producedCandidate: boolean,
    extra: { reason?: string; candidateId?: string; now?: string } = {},
  ) {
    recordCaseClosure(db, {
      caseId,
      projectId: `P-${caseId}`,
      owner: "expert-desk",
      resolution: "修订正文",
      producedCandidate,
      candidateId: extra.candidateId ?? null,
      noCandidateReason: extra.reason,
      now: extra.now ?? NOW,
    });
  }

  it("产出候选时落一行,candidate_id 指向候选", () => {
    close("C1", true, { candidateId: "CK-001" });
    const rows = queryAll<{ produced_candidate: number; candidate_id: string | null; no_candidate_reason: string }>(
      db,
      "SELECT produced_candidate, candidate_id, no_candidate_reason FROM case_closures",
    );
    expect(rows[0]).toMatchObject({
      produced_candidate: 1,
      candidate_id: "CK-001",
      no_candidate_reason: "",
    });
  });

  it("未产出候选且没写理由 → 抛错,不落库", () => {
    // 四处埋点里唯一刻意不吞异常的地方:静默放过等于让回流率永久失真。
    expect(() => close("C1", false)).toThrow(MissingNoCandidateReason);
    expect(() => close("C1", false, { reason: "   " })).toThrow(MissingNoCandidateReason);
    expect(queryAll(db, "SELECT id FROM case_closures")).toHaveLength(0);
  });

  it("未产出候选写了理由 → 正常落库,candidate_id 置空", () => {
    close("C1", false, { reason: "本单是样本类型填报错误，无可复用的方法学结论", candidateId: "CK-should-be-ignored" });
    const rows = queryAll<{ produced_candidate: number; candidate_id: string | null; no_candidate_reason: string }>(
      db,
      "SELECT produced_candidate, candidate_id, no_candidate_reason FROM case_closures",
    );
    expect(rows[0]!.produced_candidate).toBe(0);
    // 「没产出候选」和「候选 id 有值」是互相矛盾的两个事实,后者必须被清掉。
    expect(rows[0]!.candidate_id).toBeNull();
    expect(rows[0]!.no_candidate_reason).toContain("样本类型填报错误");
  });

  it("同一案例重复办结是 upsert —— 改措辞重提不该在分母里多一个案例", () => {
    close("C1", true, { candidateId: "CK-001" });
    close("C1", false, { reason: "复议后认为不足以沉淀" });
    const rows = queryAll<{ produced_candidate: number }>(
      db,
      "SELECT produced_candidate FROM case_closures",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.produced_candidate).toBe(0);
  });

  it("回流率 = 产出候选的办结数 / 办结总数", () => {
    close("C1", true, { candidateId: "CK-1" });
    close("C2", true, { candidateId: "CK-2" });
    close("C3", false, { reason: "客户撤单" });
    close("C4", false, { reason: "客户撤单" });
    const s = revisionInflowSummary(db);
    expect(s).toMatchObject({ closures: 4, withCandidate: 2, inflowRate: 0.5 });
  });

  it("没办结过案例时回流率记 0 而不是 1", () => {
    expect(revisionInflowSummary(db)).toMatchObject({ closures: 0, withCandidate: 0, inflowRate: 0 });
  });

  it("「无候选」理由按出现次数聚合 —— 光看百分比分不出「真没有」和「嫌麻烦」", () => {
    close("C1", false, { reason: "太忙了" });
    close("C2", false, { reason: "太忙了" });
    close("C3", false, { reason: "客户撤单" });
    close("C4", true, { candidateId: "CK-1" });
    const s = revisionInflowSummary(db);
    expect(s.noCandidateReasons).toEqual([
      { reason: "太忙了", count: 2 },
      { reason: "客户撤单", count: 1 },
    ]);
  });

  it("sinceIso 切时间窗", () => {
    close("OLD", true, { candidateId: "CK-1", now: "2026-08-01T00:00:00.000Z" });
    close("N1", false, { reason: "客户撤单", now: "2026-09-01T00:00:00.000Z" });
    close("N2", true, { candidateId: "CK-2", now: "2026-09-01T00:00:00.000Z" });
    expect(revisionInflowSummary(db)).toMatchObject({ closures: 3, withCandidate: 2 });
    expect(revisionInflowSummary(db, "2026-08-25T00:00:00.000Z")).toMatchObject({
      closures: 2,
      withCandidate: 1,
      inflowRate: 0.5,
    });
  });
});
