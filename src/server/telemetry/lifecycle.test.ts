/**
 * §6 专家协同 / §7 知识演化 周期口径单测。
 *
 * 这一组测的核心是**防刷**。周期类指标最容易被刷,因为「时刻」是可写的:
 *
 *  1. 办结时刻只写一次 —— 退回重办不能重置 4 小时时钟。
 *  2. 首次发布时刻只写一次 —— 回滚不清空(那次发布真实发生过)。
 *  3. 灰度窗口左端每次重置 —— 上一轮的质量事件不能算进这一轮。
 *  4. SLA 阈值取自案子自己的 sla,不是全局常量。
 *  5. 未办结的案子既不进分子也不进分母。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type NovaDb } from "../db/client";
import { expertSlaBoard, knowledgeLifecycle, lifecycleBoard } from "./lifecycle";
import { saveCandidate, saveExpertCase, updateExpertCase } from "../db/repositories";
import type { CandidateKnowledge, ExpertCase } from "@/domain/consultation-journey";

const T0 = "2026-09-02T00:00:00.000Z";
const at = (minutes: number) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

let db: NovaDb;
beforeEach(() => {
  db = createDb(":memory:");
});

function expertCase(overrides: Partial<ExpertCase> = {}): ExpertCase {
  return {
    id: "EC-1",
    status: "awaiting-claim",
    sla: { claimMinutes: 30, substantiveResponseHours: 4 },
    handoff: {
      objective: "目标",
      attemptedAction: "已尝试",
      blockingUnknowns: [],
      reason: "越出适用范围",
    },
    ...overrides,
  } as ExpertCase;
}

function candidate(overrides: Partial<CandidateKnowledge> = {}): CandidateKnowledge {
  return {
    id: "CAND-1",
    sourceCaseId: "EC-1",
    statement: "结论",
    evidenceIds: ["KB-1"],
    scope: "FFPE",
    counterexample: "反例",
    owner: "王工",
    version: 1,
    validUntil: "2027-01-01",
    status: "candidate",
    productionEligible: false,
    auditTrail: [],
    rollbackVersion: null,
    ...overrides,
  };
}

describe("§6 专家 SLA 达标率", () => {
  it("认领与办结分别按各自的 SLA 判定", () => {
    // 20 分钟认领(≤30 ✅),3 小时办结(≤4h ✅)
    saveExpertCase(db, "P1", expertCase({ id: "EC-fast" }), T0);
    updateExpertCase(db, { id: "EC-fast", status: "claimed", claimedAt: at(20), now: at(20) });
    updateExpertCase(db, { id: "EC-fast", status: "resolved", now: at(180) });

    const board = expertSlaBoard(db);
    expect(board.claim.measured).toBe(1);
    expect(board.claim.met).toBe(1);
    expect(board.substantive.measured).toBe(1);
    expect(board.substantive.met).toBe(1);
    expect(board.substantive.rate).toBe(1);
  });

  it("超时的案子进分母不进分子", () => {
    saveExpertCase(db, "P1", expertCase({ id: "EC-slow" }), T0);
    updateExpertCase(db, { id: "EC-slow", status: "claimed", claimedAt: at(45), now: at(45) });
    updateExpertCase(db, { id: "EC-slow", status: "resolved", now: at(400) });

    const board = expertSlaBoard(db);
    expect(board.claim.measured).toBe(1);
    expect(board.claim.met).toBe(0);
    expect(board.claim.rate).toBe(0);
    expect(board.substantive.met).toBe(0);
  });

  it("阈值取自案子自己的 sla,不是全局常量", () => {
    // 这一单谈好的是 2 小时实质响应;3 小时办结对它是违约,对默认 4 小时是达标。
    saveExpertCase(
      db,
      "P1",
      expertCase({ id: "EC-tight", sla: { claimMinutes: 10, substantiveResponseHours: 2 } }),
      T0,
    );
    updateExpertCase(db, { id: "EC-tight", status: "claimed", claimedAt: at(20), now: at(20) });
    updateExpertCase(db, { id: "EC-tight", status: "resolved", now: at(180) });

    const board = expertSlaBoard(db);
    expect(board.claim.met).toBe(0); // 20 > 10
    expect(board.substantive.met).toBe(0); // 180 分钟 > 2 小时
  });

  it("未认领 / 未办结的案子既不进分子也不进分母,单独计入 pending", () => {
    saveExpertCase(db, "P1", expertCase({ id: "EC-queued" }), T0);

    const board = expertSlaBoard(db);
    expect(board.cases).toBe(1);
    expect(board.claim.measured).toBe(0);
    expect(board.claim.pending).toBe(1);
    // 没有已认领案子时达标率是 null,不是 0 也不是 1 ——
    // 「还没人认领」不是「认领全部超时」,也不是「认领全部达标」。
    expect(board.claim.rate).toBeNull();
    expect(board.substantive.pending).toBe(1);
  });

  it("办结时刻只写一次:退回重办不能重置 4 小时时钟", () => {
    saveExpertCase(db, "P1", expertCase({ id: "EC-retry" }), T0);
    updateExpertCase(db, { id: "EC-retry", status: "claimed", claimedAt: at(5), now: at(5) });
    // 第一次办结就已经超时了(400 分钟 > 4 小时)。
    updateExpertCase(db, { id: "EC-retry", status: "resolved", now: at(400) });
    expect(expertSlaBoard(db).substantive.met).toBe(0);

    // 退回队列再重办 —— 如果 resolved_at 被后来的时刻覆盖,这里就会把违约洗成达标。
    updateExpertCase(db, { id: "EC-retry", status: "claimed", now: at(410) });
    updateExpertCase(db, { id: "EC-retry", status: "resolved", now: at(420) });

    const board = expertSlaBoard(db);
    expect(board.substantive.met).toBe(0);
    // 时长仍然按第一次办结算,不是 20 分钟。
    expect(board.substantive.duration.p50).toBeGreaterThan(240);
  });

  it("时钟回拨造出的负时长被丢弃,不算成「达标」", () => {
    saveExpertCase(db, "P1", expertCase({ id: "EC-skew" }), at(100));
    // 认领时刻早于建单时刻:手工补数据或时钟回拨。
    updateExpertCase(db, { id: "EC-skew", status: "claimed", claimedAt: T0, now: T0 });

    const board = expertSlaBoard(db);
    // 负时长一定 ≤30,不丢弃的话它会白送一个达标。
    expect(board.claim.measured).toBe(0);
    expect(board.claim.pending).toBe(1);
  });

  it("payload 里没有 sla 字段时退回默认 SLA,不丢样本", () => {
    db.prepare(
      `INSERT INTO expert_cases(id, project_id, status, payload, created_at, claimed_at)
       VALUES('EC-legacy', 'P1', 'claimed', '{bad json', ?, ?)`,
    ).run(T0, at(20));
    const board = expertSlaBoard(db);
    expect(board.claim.measured).toBe(1);
    expect(board.claim.met).toBe(1); // 20 ≤ 默认 30
  });

  it("时长用分位不用平均:一条拖了三天的案子不该带走整格", () => {
    for (let i = 0; i < 9; i++) {
      saveExpertCase(db, "P1", expertCase({ id: `EC-n${i}` }), T0);
      updateExpertCase(db, { id: `EC-n${i}`, status: "claimed", claimedAt: at(10), now: at(10) });
    }
    saveExpertCase(db, "P1", expertCase({ id: "EC-outlier" }), T0);
    updateExpertCase(db, {
      id: "EC-outlier",
      status: "claimed",
      claimedAt: at(3 * 24 * 60),
      now: at(3 * 24 * 60),
    });

    const board = expertSlaBoard(db);
    expect(board.claim.duration.p50).toBe(10);
    // 均值被那一条拉到了 400 分钟以上 —— 这正是不拿它当主口径的理由。
    expect(board.claim.duration.mean!).toBeGreaterThan(400);
    expect(board.claim.rate).toBeCloseTo(0.9);
  });
});

describe("§7 候选 → 灰度生效周期", () => {
  it("上线时刻落在首次 gray-active,周期从建候选算起", () => {
    saveCandidate(db, candidate(), T0);
    saveCandidate(db, candidate({ status: "gray-active", productionEligible: true }), at(120));

    const k = knowledgeLifecycle(db);
    expect(k.candidates).toBe(1);
    expect(k.published).toBe(1);
    expect(k.grayActive).toBe(1);
    expect(k.timeToPublishHours.p50).toBeCloseTo(2);
    expect(k.publishRate).toBe(1);
  });

  it("回滚不清空首次发布时刻 —— 那次发布真实发生过", () => {
    saveCandidate(db, candidate(), T0);
    saveCandidate(db, candidate({ status: "gray-active", productionEligible: true }), at(120));
    // 回滚:退回 owner-approved,退出灰度。
    saveCandidate(db, candidate({ status: "owner-approved", productionEligible: false }), at(300));

    const k = knowledgeLifecycle(db);
    // 分子不减:抹掉一次真实发生过的发布等于篡改历史。
    expect(k.published).toBe(1);
    // 但它已经不在灰度里了,并且被计成一次回滚。
    expect(k.grayActive).toBe(0);
    expect(k.rolledBack).toBe(1);
    // 周期仍按首次上线算,不是第二次。
    expect(k.timeToPublishHours.p50).toBeCloseTo(2);
  });

  it("二次发布不覆盖首次时刻:周期问的是「多久才第一次上线」", () => {
    saveCandidate(db, candidate(), T0);
    saveCandidate(db, candidate({ status: "gray-active", productionEligible: true }), at(60));
    saveCandidate(db, candidate({ status: "owner-approved" }), at(200));
    saveCandidate(db, candidate({ status: "gray-active", productionEligible: true }), at(600));

    const k = knowledgeLifecycle(db);
    expect(k.timeToPublishHours.p50).toBeCloseTo(1);
    expect(k.published).toBe(1);
    // 重新进灰度了,所以不再算回滚状态。
    expect(k.rolledBack).toBe(0);
    expect(k.grayActive).toBe(1);
  });

  it("灰度窗口每次重置:上一轮的质量事件不算进这一轮", () => {
    saveCandidate(db, candidate({ status: "gray-active", productionEligible: true }), T0);
    // 第一轮灰度期间的问题。
    db.prepare(
      `INSERT INTO quality_events(id, project_id, status, owner, reason, created_at)
       VALUES('QE-old', 'P1', 'open', '王工', '第一轮灰度问题', ?)`,
    ).run(at(30));
    expect(knowledgeLifecycle(db).grayWindowIncidents).toBe(1);

    // 回滚下线,再重新进灰度 —— 窗口左端右移到 at(600)。
    saveCandidate(db, candidate({ status: "owner-approved" }), at(300));
    saveCandidate(db, candidate({ status: "gray-active", productionEligible: true }), at(600));

    // 旧事件落在新窗口之外:不该再被算进这一轮的灰度期问题率。
    expect(knowledgeLifecycle(db).grayWindowIncidents).toBe(0);
  });

  it("候选回滚与入库门禁整批回滚是两件事,分列不合并", () => {
    saveCandidate(db, candidate({ status: "gray-active", productionEligible: true }), T0);
    saveCandidate(db, candidate({ status: "owner-approved" }), at(100));
    db.prepare(
      `INSERT INTO ingest_runs(id, source_dir, doc_count, chunk_count, docs, gate, outcome, detail, created_at)
       VALUES('IR-1', 'data/knowledge', 3, 30, '[]', '{}', 'rolled-back', '门禁拦下', ?)`,
    ).run(at(50));

    const k = knowledgeLifecycle(db);
    expect(k.rolledBack).toBe(1);
    expect(k.ingestRollbacks).toBe(1);
  });

  it("从未上线的候选进分母不进分子", () => {
    saveCandidate(db, candidate({ id: "CAND-a" }), T0);
    saveCandidate(db, candidate({ id: "CAND-b", status: "rejected" }), T0);

    const k = knowledgeLifecycle(db);
    expect(k.candidates).toBe(2);
    expect(k.published).toBe(0);
    expect(k.publishRate).toBe(0);
    expect(k.timeToPublishHours.samples).toBe(0);
    expect(k.timeToPublishHours.p50).toBeNull();
  });

  it("无候选时上线率是 null,不是 0", () => {
    expect(knowledgeLifecycle(db).publishRate).toBeNull();
  });
});

describe("lifecycleBoard 兜底与切窗", () => {
  it("空库不抛,所有率为 null", () => {
    const board = lifecycleBoard(db, T0);
    expect(board.expert.cases).toBe(0);
    expect(board.expert.claim.rate).toBeNull();
    expect(board.expert.substantive.rate).toBeNull();
    expect(board.knowledge.publishRate).toBeNull();
  });

  it("切窗按建单/建候选时刻,窗口外的不进这一周", () => {
    saveExpertCase(db, "P1", expertCase({ id: "EC-old" }), "2026-08-01T00:00:00.000Z");
    saveExpertCase(db, "P1", expertCase({ id: "EC-now" }), at(10));
    expect(lifecycleBoard(db, T0).expert.cases).toBe(1);
    expect(lifecycleBoard(db).expert.cases).toBe(2);
  });

  it("队列现状按状态分档给出", () => {
    saveExpertCase(db, "P1", expertCase({ id: "EC-q" }), T0);
    saveExpertCase(db, "P1", expertCase({ id: "EC-c", status: "claimed" }), T0);
    const byStatus = expertSlaBoard(db).byStatus;
    expect(byStatus.find((s) => s.status === "awaiting-claim")?.count).toBe(1);
    expect(byStatus.find((s) => s.status === "claimed")?.count).toBe(1);
  });
});
