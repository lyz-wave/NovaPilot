/**
 * 埋点 A(引用号反查审计)+ 埋点 D(采纳动作)单测。
 *
 * 这两个埋点一个是生命线指标、一个是明确不许进核心链的对冲指标,所以测的重点
 * 不只是「数算得对」,还有两条边界:
 *
 *  - 埋点 A:绑定率 < 100% 必须**同时**触发 P0 质量事件(指标体系第 11 节),
 *    而不是只让看板上的数字变小 —— 否则这个「硬性指标」没有闭环;
 *  - 埋点 D:率必须按**卡片**去重。按事件计数会让一个反复复制的人单方面把采纳率
 *    拉高,那正是 4.4 节要防的可游戏化。
 *
 * 另外两个埋点都刻意包了 try/catch(埋点坏了不许拖垮主链路),这条也得测 ——
 * 一段「永远不抛」的代码如果实际上会抛,是在静默丢数据。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createDb, queryAll, type NovaDb } from "../db/client";
import type { DecisionCard, Evidence, Recommendation } from "@/domain/consultation-journey";
import { auditCitations, bindingRateSummary, recordCitationAudit } from "./citation-audit";
import { adoptionSummary, recordAdoptionEvent } from "../telemetry/adoption";

const TODAY = "2026-09-01";

function ev(id: string, over: Partial<Evidence> = {}): Evidence {
  return {
    id,
    source: "SOP",
    title: `证据 ${id}`,
    citation: `NV-${id}`,
    version: "1.0",
    appliesTo: "FFPE RNA",
    validUntil: "2027-12-31",
    validation: "verified",
    ...over,
  };
}

function rec(id: string, evidenceIds: string[]): Recommendation {
  return {
    id,
    title: `建议 ${id}`,
    rationale: "理由",
    evidenceIds,
    boundary: "边界",
  };
}

function card(recommendations: Recommendation[]): Pick<DecisionCard, "recommendations"> {
  return { recommendations };
}

describe("埋点 A · auditCitations", () => {
  it("全部命中、已核验、未过期 → 绑定率 100%", () => {
    const a = auditCitations(card([rec("R1", ["E1", "E2"])]), [ev("E1"), ev("E2")], TODAY);
    expect(a).toMatchObject({ total: 2, bound: 2, bindingRate: 1 });
    expect(a.violations).toEqual([]);
  });

  it("引用号不在本轮检索结果里 → not-retrieved", () => {
    const a = auditCitations(card([rec("R1", ["E1", "E9"])]), [ev("E1")], TODAY);
    expect(a).toMatchObject({ total: 2, bound: 1, bindingRate: 0.5 });
    expect(a.violations).toEqual([
      { recommendationId: "R1", citation: "E9", reason: "not-retrieved" },
    ]);
  });

  it("命中但状态是 conflict → not-verified", () => {
    const a = auditCitations(
      card([rec("R1", ["E1"])]),
      [ev("E1", { validation: "conflict" })],
      TODAY,
    );
    expect(a.violations[0]).toMatchObject({ citation: "E1", reason: "not-verified" });
  });

  it("命中且已核验但过期 → expired", () => {
    const a = auditCitations(
      card([rec("R1", ["E1"])]),
      [ev("E1", { validUntil: "2026-08-31" })],
      TODAY,
    );
    expect(a.violations[0]).toMatchObject({ citation: "E1", reason: "expired" });
    // 边界:validUntil === today 当天仍然有效(有效「至」当日)。
    const same = auditCitations(card([rec("R1", ["E1"])]), [ev("E1", { validUntil: TODAY })], TODAY);
    expect(same.bindingRate).toBe(1);
  });

  it("同一条证据被两个建议引用,按出现次数计两次", () => {
    const a = auditCitations(card([rec("R1", ["E1"]), rec("R2", ["E1"])]), [ev("E1")], TODAY);
    expect(a.total).toBe(2);
    expect(a.bound).toBe(2);
  });

  it("没有任何引用的卡记 100%,而不是 0% —— 分母为零不该污染指标", () => {
    expect(auditCitations(card([]), [], TODAY)).toMatchObject({
      total: 0,
      bound: 0,
      bindingRate: 1,
    });
    // 有建议但建议本身不带引用号,同样不算违规(「该引用却没引用」由 Critic 判)。
    expect(auditCitations(card([rec("R1", [])]), [ev("E1")], TODAY).bindingRate).toBe(1);
  });

  it("多种违规同时出现时逐条列出,顺序跟随建议与引用号顺序", () => {
    const a = auditCitations(
      card([rec("R1", ["E9", "E2"]), rec("R2", ["E3"])]),
      [ev("E2", { validation: "conflict" }), ev("E3", { validUntil: "2020-01-01" })],
      TODAY,
    );
    expect(a.violations.map((v) => v.reason)).toEqual(["not-retrieved", "not-verified", "expired"]);
    expect(a).toMatchObject({ total: 3, bound: 0, bindingRate: 0 });
  });
});

describe("埋点 A · recordCitationAudit / bindingRateSummary", () => {
  let db: NovaDb;
  beforeEach(() => {
    db = createDb(":memory:");
  });

  function write(traceId: string, recs: Recommendation[], evidence: Evidence[], now: string) {
    const audit = auditCitations(card(recs), evidence, now.slice(0, 10));
    recordCitationAudit(db, {
      projectId: `P-${traceId}`,
      traceId,
      cardStatus: "formal",
      audit,
      now,
    });
    return audit;
  }

  it("落一行审计记录,再次同 traceId 写入是 upsert 不是新增", () => {
    write("t1", [rec("R1", ["E1"])], [ev("E1")], "2026-09-01T00:00:00.000Z");
    write("t1", [rec("R1", ["E1", "E2"])], [ev("E1"), ev("E2")], "2026-09-01T01:00:00.000Z");
    const rows = queryAll<{ id: string; total: number; binding_rate: number }>(
      db,
      "SELECT id, total, binding_rate FROM citation_audits",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: "CA-t1", total: 2, binding_rate: 1 });
  });

  it("绑定率 < 100% 时同时开一条 P0 质量事件 —— 硬性指标必须有闭环", () => {
    write("t2", [rec("R1", ["E9"])], [ev("E1")], "2026-09-01T00:00:00.000Z");
    const events = queryAll<{ id: string; status: string; reason: string }>(
      db,
      "SELECT id, status, reason FROM quality_events",
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe("QE-CA-t2");
    expect(events[0]!.status).toBe("open");
    expect(events[0]!.reason).toContain("P0");
    expect(events[0]!.reason).toContain("R1:E9(not-retrieved)");
  });

  it("绑定率 100% 时不开质量事件 —— 正常出卡不该刷告警", () => {
    write("t3", [rec("R1", ["E1"])], [ev("E1")], "2026-09-01T00:00:00.000Z");
    expect(queryAll(db, "SELECT id FROM quality_events")).toHaveLength(0);
  });

  it("写入失败只告警不抛 —— 埋点坏了不许让出卡跟着失败", () => {
    const broken = createDb(":memory:");
    broken.exec("DROP TABLE citation_audits");
    expect(() =>
      recordCitationAudit(broken, {
        projectId: "P-X",
        traceId: "tx",
        cardStatus: "formal",
        audit: auditCitations(card([rec("R1", ["E1"])]), [ev("E1")], TODAY),
        now: "2026-09-01T00:00:00.000Z",
      }),
    ).not.toThrow();
  });

  it("汇总按引用号加权,不是各卡绑定率的平均", () => {
    // 卡一:10 个引用全中(100%);卡二:1 个引用没中(0%)。
    const many = Array.from({ length: 10 }, (_, i) => `E${i}`);
    write("w1", [rec("R1", many)], many.map((id) => ev(id)), "2026-09-01T00:00:00.000Z");
    write("w2", [rec("R1", ["EX"])], [], "2026-09-01T00:00:00.000Z");
    const s = bindingRateSummary(db);
    expect(s).toMatchObject({ cards: 2, citations: 11, bound: 10, violatingCards: 1 });
    // 加权 = 10/11 ≈ 0.909;若按卡平均会得到 0.5 —— 让只有一个引用的卡权重虚高。
    expect(s.bindingRate).toBeCloseTo(10 / 11, 6);
  });

  it("sinceIso 切时间窗;不传则统计全部", () => {
    write("old", [rec("R1", ["E9"])], [ev("E1")], "2026-08-01T00:00:00.000Z");
    write("new", [rec("R1", ["E1"])], [ev("E1")], "2026-09-01T00:00:00.000Z");
    expect(bindingRateSummary(db).cards).toBe(2);
    const week = bindingRateSummary(db, "2026-08-25T00:00:00.000Z");
    expect(week).toMatchObject({ cards: 1, citations: 1, bound: 1, violatingCards: 0 });
    expect(week.bindingRate).toBe(1);
  });

  it("空表记 100%,不记 0% —— 还没出过卡不等于绑定失败", () => {
    expect(bindingRateSummary(db)).toMatchObject({ cards: 0, citations: 0, bindingRate: 1 });
  });
});

describe("埋点 D · 采纳动作", () => {
  let db: NovaDb;
  beforeEach(() => {
    db = createDb(":memory:");
  });

  /** 造一张出过的卡(采纳率的分母来自 decision_cards)。 */
  function emitCard(id: string, now: string) {
    db.prepare(
      `INSERT INTO projects(id, tenant_id, name, locale, created_at, updated_at)
       VALUES(?, 'novapilot-demo', ?, 'zh', ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(`P-${id}`, `项目 ${id}`, now, now);
    db.prepare(
      `INSERT INTO decision_cards(id, version, project_id, status, title, risk_level, payload, trace_id, created_at)
       VALUES(?, 1, ?, 'formal', ?, 'low', '{}', ?, ?)`,
    ).run(id, `P-${id}`, `卡 ${id}`, `tr-${id}`, now);
  }

  function adopt(id: string, action: "copy" | "export" | "sync", now: string) {
    recordAdoptionEvent(db, { projectId: `P-${id}`, cardId: id, action, surface: "test", now });
  }

  it("逐条落库,同一张卡的多次动作都留痕", () => {
    emitCard("C1", "2026-09-01T00:00:00.000Z");
    adopt("C1", "copy", "2026-09-01T01:00:00.000Z");
    adopt("C1", "copy", "2026-09-01T02:00:00.000Z");
    adopt("C1", "export", "2026-09-01T03:00:00.000Z");
    const rows = queryAll<{ action: string; surface: string }>(
      db,
      "SELECT action, surface FROM adoption_events ORDER BY created_at",
    );
    expect(rows.map((r) => r.action)).toEqual(["copy", "copy", "export"]);
    expect(rows.every((r) => r.surface === "test")).toBe(true);
  });

  it("率按卡片去重:同一张卡复制三次仍只算一张卡被采纳", () => {
    emitCard("C1", "2026-09-01T00:00:00.000Z");
    emitCard("C2", "2026-09-01T00:00:00.000Z");
    adopt("C1", "copy", "2026-09-01T01:00:00.000Z");
    adopt("C1", "copy", "2026-09-01T01:10:00.000Z");
    adopt("C1", "export", "2026-09-01T01:20:00.000Z");
    const s = adoptionSummary(db);
    // 事件 3 条,但采纳的卡只有 1 张 / 出卡 2 张 = 50%。按事件计会得到 150%。
    expect(s).toMatchObject({ cards: 2, adoptedCards: 1, events: 3, adoptionRate: 0.5 });
  });

  it("byAction 三个 key 恒定存在,没有的记 0", () => {
    emitCard("C1", "2026-09-01T00:00:00.000Z");
    adopt("C1", "copy", "2026-09-01T01:00:00.000Z");
    expect(adoptionSummary(db).byAction).toEqual({ copy: 1, export: 0, sync: 0 });
  });

  it("还没出过卡时率记 0,不记 1", () => {
    expect(adoptionSummary(db)).toMatchObject({ cards: 0, adoptedCards: 0, adoptionRate: 0 });
  });

  it("窗口前出的卡在窗口内被导出时率夹到 1,不出现 117% 这种数", () => {
    emitCard("OLD", "2026-08-01T00:00:00.000Z");
    emitCard("NEW", "2026-09-01T00:00:00.000Z");
    adopt("OLD", "export", "2026-09-02T00:00:00.000Z");
    adopt("NEW", "export", "2026-09-02T00:00:00.000Z");
    const week = adoptionSummary(db, "2026-08-25T00:00:00.000Z");
    // 窗口内出卡 1 张,窗口内被采纳的卡 2 张 → 未夹取会是 200%。
    expect(week.cards).toBe(1);
    expect(week.adoptedCards).toBe(2);
    expect(week.adoptionRate).toBe(1);
  });

  it("sinceIso 同时切分子和分母", () => {
    emitCard("OLD", "2026-08-01T00:00:00.000Z");
    emitCard("N1", "2026-09-01T00:00:00.000Z");
    emitCard("N2", "2026-09-01T00:00:00.000Z");
    adopt("OLD", "export", "2026-08-02T00:00:00.000Z");
    adopt("N1", "sync", "2026-09-02T00:00:00.000Z");
    const week = adoptionSummary(db, "2026-08-25T00:00:00.000Z");
    expect(week).toMatchObject({ cards: 2, adoptedCards: 1, events: 1, adoptionRate: 0.5 });
    expect(week.byAction).toEqual({ copy: 0, export: 0, sync: 1 });
  });

  it("写入失败只告警不抛 —— 复制/导出动作本身不能因为埋点失败", () => {
    const broken = createDb(":memory:");
    broken.exec("DROP TABLE adoption_events");
    expect(() =>
      recordAdoptionEvent(broken, {
        projectId: "P-X",
        cardId: "CX",
        action: "copy",
        now: "2026-09-01T00:00:00.000Z",
      }),
    ).not.toThrow();
  });
});
