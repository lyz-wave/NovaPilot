/**
 * 护栏对看板口径 + 延迟采样单测(指标体系 v1.1 第 10/11 节)。
 *
 * 这里测的不是算术,是**口径**。四件事各有一条专门的测试钉住:
 *
 *  1. 分母是会话数,不是卡版本数 —— 反复改事实重出版的用户不该冲低解决率。
 *  2. 可信解决率的分子只认独立审计(citation_audits),不认 Critic 放行。
 *  3. 没有样本时率是 null,不是 0 —— 「没验证过」不能显示成「验证通过无问题」。
 *  4. P1 判定在 rate 为 null 时不报警,也不把 null 当 0 判成健康。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type NovaDb } from "../db/client";
import {
  P1_THRESHOLDS,
  guardrailBoard,
  p0Breaches,
  p1Breaches,
  pendingReviewLoad,
  telemetryRowCounts,
  weekStart,
} from "./guardrail-board";
import { latencySummary, recordLatencySample } from "./latency";
import { recordCitationAudit } from "../guards/citation-audit";
import { enqueueReviewSample, setExpertVerdict } from "./review-samples";
import { recordCaseClosure } from "./case-closure";

const NOW = "2026-09-02T00:00:00.000Z";

function project(db: NovaDb, id: string) {
  db.prepare(
    `INSERT OR IGNORE INTO projects(id, tenant_id, name, locale, created_at, updated_at)
     VALUES(?, 'novapilot-demo', ?, 'zh', ?, ?)`,
  ).run(id, id, NOW, NOW);
}

function card(
  db: NovaDb,
  opts: { project: string; version?: number; status: string; traceId: string | null; now?: string },
) {
  project(db, opts.project);
  db.prepare(
    `INSERT INTO decision_cards(id, version, project_id, status, title, risk_level, payload, trace_id, created_at)
     VALUES(?, ?, ?, ?, '卡', 'medium', '{}', ?, ?)`,
  ).run(
    `CARD-${opts.project}`,
    opts.version ?? 1,
    opts.project,
    opts.status,
    opts.traceId,
    opts.now ?? NOW,
  );
}

function audit(db: NovaDb, traceId: string, bindingRate: number, projectId = "P1") {
  recordCitationAudit(db, {
    projectId,
    traceId,
    cardStatus: "formal",
    audit: {
      total: 2,
      bound: Math.round(bindingRate * 2),
      bindingRate,
      violations:
        bindingRate >= 1
          ? []
          : [{ recommendationId: "R1", citation: "E9", reason: "not-retrieved" as const }],
    },
    now: NOW,
  });
}

describe("护栏对看板 · 分母口径", () => {
  let db: NovaDb;
  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("分母按 trace_id 去重 —— 同一咨询改事实重出版不冲大分母", () => {
    card(db, { project: "P1", version: 1, status: "needs-conditions", traceId: "t1" });
    card(db, { project: "P1", version: 2, status: "formal", traceId: "t1" });
    const b = guardrailBoard(db);
    // 两行、一个 trace:会话数是 1。若按行数算,直接解决率会变成 50%。
    expect(b.sessions.sessions).toBe(1);
    expect(b.directResolutionRate).toBe(1);
  });

  it("trace_id 为空的历史行退回 id+version,不被静默丢弃", () => {
    card(db, { project: "P1", status: "formal", traceId: null });
    card(db, { project: "P2", status: "expert-review", traceId: null });
    const b = guardrailBoard(db);
    expect(b.sessions.sessions).toBe(2);
    expect(b.directResolutionRate).toBe(0.5);
    expect(b.interceptionRate).toBe(0.5);
  });

  it("没有任何会话时三个率是 null 而不是 0", () => {
    const b = guardrailBoard(db);
    expect(b.directResolutionRate).toBeNull();
    expect(b.interceptionRate).toBeNull();
    expect(b.trustedResolutionRate).toBeNull();
  });

  it("处置分布相加不超过会话数,未知状态归入 other", () => {
    card(db, { project: "P1", status: "formal", traceId: "t1" });
    card(db, { project: "P2", status: "expert-review", traceId: "t2" });
    card(db, { project: "P3", status: "needs-conditions", traceId: "t3" });
    card(db, { project: "P4", status: "draft", traceId: "t4" });
    const s = guardrailBoard(db).sessions;
    expect(s).toMatchObject({ sessions: 4, formal: 1, expertReview: 1, needsConditions: 1, other: 1 });
  });
});

describe("护栏对看板 · 可信解决率只认独立审计", () => {
  let db: NovaDb;
  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("formal 且审计判定全绑定才进分子", () => {
    card(db, { project: "P1", status: "formal", traceId: "t1" });
    audit(db, "t1", 1);
    expect(guardrailBoard(db).trustedResolutionRate).toBe(1);
  });

  it("没有审计记录的 formal 卡不进分子 —— 「没审过」≠「审过且合格」", () => {
    card(db, { project: "P1", status: "formal", traceId: "t1" });
    const b = guardrailBoard(db);
    expect(b.directResolutionRate).toBe(1); // 直接解决率照记
    expect(b.trustedResolutionRate).toBe(0); // 可信解决率不给
  });

  it("绑定率破口的 formal 卡不进分子,且触发 P0", () => {
    card(db, { project: "P1", status: "formal", traceId: "t1" });
    audit(db, "t1", 0.5);
    const b = guardrailBoard(db);
    expect(b.trustedResolutionRate).toBe(0);
    const p0 = p0Breaches(b);
    expect(p0.length).toBeGreaterThan(0);
    expect(p0.join(" ")).toContain("绑定率");
  });

  it("全绑定时不报 P0", () => {
    card(db, { project: "P1", status: "formal", traceId: "t1" });
    audit(db, "t1", 1);
    expect(p0Breaches(guardrailBoard(db))).toEqual([]);
  });
});

describe("护栏对看板 · P1 判定与欠复核", () => {
  let db: NovaDb;
  beforeEach(() => {
    db = createDb(":memory:");
  });

  function sample(traceId: string, kind: "intercepted" | "not-escalated") {
    enqueueReviewSample(db, {
      kind,
      projectId: "P1",
      traceId,
      systemAction: "x",
      context: {},
      now: NOW,
      sampleRate: 1,
    });
  }

  it("没有复核样本时不报 P1 —— null 既不算超阈也不算健康", () => {
    sample("i1", "intercepted");
    const b = guardrailBoard(db);
    expect(b.review.falseInterception.rate).toBeNull();
    expect(p1Breaches(b)).toEqual([]);
    // 但欠复核量要显示出来:这些率现在还不可信。
    expect(pendingReviewLoad(b)).toBe(1);
  });

  it("误拦截率超阈报 P1", () => {
    sample("i1", "intercepted");
    sample("i2", "intercepted");
    setExpertVerdict(db, { id: "RS-i1", verdict: "should-pass", now: NOW });
    setExpertVerdict(db, { id: "RS-i2", verdict: "should-block", now: NOW });
    const reasons = p1Breaches(guardrailBoard(db));
    expect(reasons.join(" ")).toContain("误拦截率");
  });

  it("复核了且都对 → 0%,不报 P1", () => {
    sample("i1", "intercepted");
    setExpertVerdict(db, { id: "RS-i1", verdict: "should-block", now: NOW });
    const b = guardrailBoard(db);
    expect(b.review.falseInterception.rate).toBe(0);
    expect(p1Breaches(b)).toEqual([]);
  });

  it("阈值取自第 11 节:该转未转比误拦更严", () => {
    // 该转未转是安全事故方向,误拦只是体验损耗 —— 两者不该同阈。
    expect(P1_THRESHOLDS.missedEscalation).toBeLessThan(P1_THRESHOLDS.falseInterception);
    expect(P1_THRESHOLDS.judgeAgreement).toBe(0.85);
  });
});

describe("护栏对看板 · 负反馈与采纳率成对", () => {
  let db: NovaDb;
  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("负反馈率按 score ≤ 2 计,与前端同阈值", () => {
    for (const [i, score] of [1, 2, 3, 5].entries()) {
      db.prepare(
        "INSERT INTO feedback(id, project_id, score, reason, created_at) VALUES(?, 'P1', ?, '', ?)",
      ).run(`F${i}`, score, NOW);
    }
    expect(guardrailBoard(db).feedback).toMatchObject({ total: 4, negative: 2, negativeRate: 0.5 });
  });

  it("没有反馈时负反馈率是 null —— 沉默不等于满意,也不等于不满", () => {
    expect(guardrailBoard(db).feedback.negativeRate).toBeNull();
  });

  it("采纳率与可信解决率相互独立 —— 4.4 节要求它不进可信计算链", () => {
    card(db, { project: "P1", status: "formal", traceId: "t1" });
    audit(db, "t1", 1);
    const before = guardrailBoard(db).trustedResolutionRate;
    db.prepare(
      "INSERT INTO adoption_events(id, project_id, card_id, action, surface, created_at) VALUES('A1','P1','CARD-P1','copy','',?)",
    ).run(NOW);
    const after = guardrailBoard(db);
    // 记了一次采纳,可信解决率必须一动不动。
    expect(after.trustedResolutionRate).toBe(before);
    expect(after.adoption.adoptionRate).toBeGreaterThan(0);
  });
});

/**
 * 每个子查询都要有一条测试**真的读到非零值**。
 *
 * 这一组是补的:guardrailBoard 里每格都包着 try/catch(老库缺表时不让整页 500),
 * 而一个写错的列名会被它吞成「这一格是 0」—— 0 在看板上和真实的 0 长得一模一样。
 * 第一版 knowledgeVolume 就是这样静默返回全 0 的(查了 documents.created_at,
 * 而那张表根本没有时间戳)。所以下面每条都断言一个 > 0 的值,只断言 0 的测试
 * 对这类错误完全免疫。
 */
describe("护栏对看板 · 每格都必须真的读到数", () => {
  let db: NovaDb;
  beforeEach(() => {
    db = createDb(":memory:");
  });

  function ingestRun(
    id: string,
    opts: { docs: number; chunks: number; outcome: string; now?: string },
  ) {
    db.prepare(
      `INSERT INTO ingest_runs(id, source_dir, doc_count, chunk_count, docs, parse_errors, gate, outcome, detail, created_at)
       VALUES(?, 'data/knowledge', ?, ?, '[]', '[]', 'null', ?, '', ?)`,
    ).run(id, opts.docs, opts.chunks, opts.outcome, opts.now ?? NOW);
  }

  it("知识入库量读 ingest_runs 的提交批次,不读 documents(那张表没有时间戳)", () => {
    ingestRun("IR-1", { docs: 3, chunks: 12, outcome: "committed" });
    ingestRun("IR-2", { docs: 9, chunks: 40, outcome: "rolled-back" });
    const k = guardrailBoard(db).knowledge;
    // 回滚批次不进入库量 —— 它们的内容根本没落库。
    expect(k.documents).toBe(3);
    expect(k.chunks).toBe(12);
    // 但回滚数本身要出数:那是「灌水入库」这条游戏化路径的直接观测量。
    expect(k.rolledBackRuns).toBe(1);
  });

  it("全库累计文档 / 切片数不切窗 —— 种子库没有 ingest_run,只出现在累计数里", () => {
    db.prepare(
      `INSERT INTO documents(id, source, title, citation, version, applies_to, valid_until)
       VALUES('D1','SOP','标题','引用','v1','FFPE','2030-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO chunks(id, document_id, ordinal, text, tokens, embedding)
       VALUES('CH1','D1',0,'正文','[]','[]')`,
    ).run();
    const k = guardrailBoard(db, "2030-01-01T00:00:00.000Z").knowledge;
    expect(k.documents).toBe(0); // 窗口内没有入库批次
    expect(k.documentsTotal).toBe(1); // 但库里确实有一篇
    expect(k.chunksTotal).toBe(1);
  });

  it("候选知识按状态分桶,rejected 既不算已批也不算待审", () => {
    const insert = (id: string, status: string) =>
      db
        .prepare(
          `INSERT INTO candidates(id, source_case_id, statement, evidence_ids, scope, counterexample,
             owner, version, valid_until, status, production_eligible, audit_trail, created_at)
           VALUES(?, 'EC-1', '结论', '[]', '范围', '反例', 'expert', 1, '2030-01-01', ?, 0, '[]', ?)`,
        )
        .run(id, status, NOW);
    insert("CK-1", "approved");
    insert("CK-2", "pending");
    insert("CK-3", "rejected");
    const k = guardrailBoard(db).knowledge;
    expect(k.candidatesApproved).toBe(1);
    expect(k.candidatesPending).toBe(1);
  });

  it("六格数据源全部真的读到非零值 —— 没有一格是被 catch 吞成 0 的", () => {
    card(db, { project: "P1", status: "formal", traceId: "t1" });
    audit(db, "t1", 1);
    ingestRun("IR-1", { docs: 2, chunks: 8, outcome: "committed" });
    db.prepare(
      "INSERT INTO feedback(id, project_id, score, reason, created_at) VALUES('F1','P1',1,'',?)",
    ).run(NOW);
    db.prepare(
      "INSERT INTO adoption_events(id, project_id, card_id, action, surface, created_at) VALUES('A1','P1','CARD-P1','copy','',?)",
    ).run(NOW);
    enqueueReviewSample(db, {
      kind: "intercepted",
      projectId: "P1",
      traceId: "t1",
      systemAction: "x",
      context: {},
      now: NOW,
      sampleRate: 1,
    });
    setExpertVerdict(db, { id: "RS-t1", verdict: "should-pass", now: NOW });
    recordCaseClosure(db, {
      caseId: "EC-1",
      projectId: "P1",
      owner: "expert-desk",
      resolution: "修订",
      producedCandidate: true,
      candidateId: "CK-1",
      now: NOW,
    });
    recordLatencySample(db, {
      traceId: "t1",
      route: "consultations",
      kind: "card",
      cardStatus: "formal",
      durationMs: 420,
      now: NOW,
    });

    const b = guardrailBoard(db);
    expect(b.sessions.sessions).toBeGreaterThan(0);
    expect(b.directResolutionRate).toBeGreaterThan(0);
    expect(b.trustedResolutionRate).toBeGreaterThan(0);
    expect(b.binding.citations).toBeGreaterThan(0);
    expect(b.review.falseInterception.reviewed).toBeGreaterThan(0);
    expect(b.inflow.closures).toBeGreaterThan(0);
    expect(b.adoption.events).toBeGreaterThan(0);
    expect(b.latency.overall.p95).toBeGreaterThan(0);
    expect(b.knowledge.documents).toBeGreaterThan(0);
    expect(b.knowledge.documentsTotal).toBeGreaterThanOrEqual(0);
    expect(b.feedback.negativeRate).toBeGreaterThan(0);
  });
});

describe("护栏对看板 · 切窗与容错", () => {  let db: NovaDb;
  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("sinceIso 同时切所有六对 —— 护栏和激励不能来自两个时间窗", () => {
    card(db, { project: "OLD", status: "formal", traceId: "old", now: "2026-08-01T00:00:00.000Z" });
    card(db, { project: "NEW", status: "expert-review", traceId: "new", now: "2026-09-02T00:00:00.000Z" });
    expect(guardrailBoard(db).sessions.sessions).toBe(2);
    const w = guardrailBoard(db, "2026-08-25T00:00:00.000Z");
    expect(w.sessions.sessions).toBe(1);
    expect(w.directResolutionRate).toBe(0);
    expect(w.interceptionRate).toBe(1);
  });

  it("单张表被删也只降级那一格,不让整页 500", () => {
    card(db, { project: "P1", status: "formal", traceId: "t1" });
    db.exec("DROP TABLE review_samples");
    const b = guardrailBoard(db);
    expect(b.directResolutionRate).toBe(1); // 还有数的格子照常
    expect(b.review.falseInterception.rate).toBeNull();
  });

  it("weekStart 落在周一 00:00 UTC", () => {
    // 2026-09-02 是周三 → 周一是 08-31;2026-08-31 本身是周一 → 返回自己。
    expect(weekStart("2026-09-02T13:20:00.000Z")).toBe("2026-08-31T00:00:00.000Z");
    expect(weekStart("2026-08-31T00:00:00.000Z")).toBe("2026-08-31T00:00:00.000Z");
    // 周日要回退 6 天,不是前进 1 天。
    expect(weekStart("2026-09-06T23:59:00.000Z")).toBe("2026-08-31T00:00:00.000Z");
  });

  it("telemetryRowCounts 覆盖五张埋点表", () => {
    const counts = telemetryRowCounts(db);
    expect(Object.keys(counts).sort()).toEqual([
      "adoption_events",
      "case_closures",
      "citation_audits",
      "latency_samples",
      "review_samples",
    ]);
  });
});

describe("延迟采样", () => {
  let db: NovaDb;
  beforeEach(() => {
    db = createDb(":memory:");
  });

  function sample(traceId: string, ms: number, status = "formal", now = NOW) {
    recordLatencySample(db, {
      traceId,
      route: "consultations",
      kind: "card",
      cardStatus: status,
      durationMs: ms,
      now,
    });
  }

  it("没有样本时 p50/p95 是 null 而不是 0", () => {
    expect(latencySummary(db).overall).toMatchObject({ samples: 0, p50: null, p95: null });
  });

  it("P95 取最近邻真实样本,不做插值", () => {
    // 1..20:P95 的 rank = ceil(0.95*20) = 19 → 第 19 个 = 19。
    for (let i = 1; i <= 20; i++) sample(`t${i}`, i * 100);
    const s = latencySummary(db).overall;
    expect(s.samples).toBe(20);
    expect(s.p95).toBe(1900);
    expect(s.p50).toBe(1000);
    expect(s.max).toBe(2000);
  });

  it("单条样本时 p50 = p95 = 那一条 —— 不造一个没人经历过的数", () => {
    sample("t1", 777);
    expect(latencySummary(db).overall).toMatchObject({ samples: 1, p50: 777, p95: 777 });
  });

  it("按处置状态分组 —— 全局 P95 分不出「变快了」和「少走了防线」", () => {
    sample("f1", 100, "formal");
    sample("f2", 200, "formal");
    sample("e1", 900, "expert-review");
    const byStatus = latencySummary(db).byStatus;
    const formal = byStatus.find((g) => g.status === "formal")!;
    const expert = byStatus.find((g) => g.status === "expert-review")!;
    expect(formal.stats.samples).toBe(2);
    expect(expert.stats.p95).toBe(900);
    // 分组按样本量降序,方便看板先展示主干路径。
    expect(byStatus[0]!.status).toBe("formal");
  });

  it("闲聊轮归入 chat 分组,不混进研究型延迟", () => {
    recordLatencySample(db, {
      traceId: "c1",
      route: "consultations",
      kind: "chat",
      durationMs: 30,
      now: NOW,
    });
    sample("f1", 1500, "formal");
    const byStatus = latencySummary(db).byStatus;
    expect(byStatus.map((g) => g.status).sort()).toEqual(["chat", "formal"]);
    expect(byStatus.find((g) => g.status === "chat")!.stats.p95).toBe(30);
  });

  it("同 trace + 同 route 重放是 upsert,负数与小数被规整", () => {
    sample("t1", 120.7);
    sample("t1", -5);
    const s = latencySummary(db).overall;
    expect(s.samples).toBe(1);
    expect(s.p95).toBe(0);
  });

  it("sinceIso 切时间窗", () => {
    sample("old", 5000, "formal", "2026-08-01T00:00:00.000Z");
    sample("new", 100, "formal", "2026-09-02T00:00:00.000Z");
    expect(latencySummary(db).overall.max).toBe(5000);
    expect(latencySummary(db, "2026-08-25T00:00:00.000Z").overall.max).toBe(100);
  });

  it("表被删时只告警不抛 —— 采样挂掉不该让咨询失败", () => {
    db.exec("DROP TABLE latency_samples");
    expect(() => sample("t1", 100)).not.toThrow();
    expect(latencySummary(db).overall.samples).toBe(0);
  });
});
