/**
 * §5 三层防线各层通过率单测。
 *
 * 核心那几条钉的是**分母不能记错层**：规则层全拦的那一轮，语义层没有
 * 分母（不是「语义层 0% 通过」）；NovaGuard 把「正确转专家」也算通过
 * （见 novaguard.ts），所以这一层的分母是「答案数」不是「未转专家数」。
 * 最后一条用真实的 runConsultationGraph 跑一遍，钉住聚合读的 JSON 形状
 * 与线上落库的形状没有脱节。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type NovaDb } from "../db/client";
import { seedKnowledgeBase } from "../rag/retrieval";
import { runConsultationGraph } from "../orchestration/graph";
import { defenseLayerBoard } from "./defense-layers";

const NOW = "2026-09-06T00:00:00.000Z";

function checkpoint(db: NovaDb, traceId: string, node: string, state: unknown, createdAt = NOW) {
  db.prepare(
    `INSERT INTO checkpoints(trace_id, node, state, created_at) VALUES(?, ?, ?, ?)`,
  ).run(traceId, node, JSON.stringify(state), createdAt);
}

function finding(over: Partial<{ citationValid: boolean; inScope: boolean }> = {}) {
  return { recommendationId: "R-1", citationValid: true, inScope: true, issues: [], ...over };
}

let db: NovaDb;
beforeEach(() => {
  db = createDb(":memory:");
});

describe("§5 三层防线各层通过率", () => {
  it("空库三层都是 0/0，读作「没有样本」而不是 0%", () => {
    const board = defenseLayerBoard(db);
    expect(board.traces).toBe(0);
    for (const row of board.layers) {
      expect(row.measured).toBe(0);
      expect(row.rate).toBeNull();
    }
  });

  it("规则层：分母是 findings 条数，分子是引用有效且在范围内的那些", () => {
    checkpoint(db, "T-1", "review", {
      findings: [finding(), finding({ citationValid: false }), finding({ inScope: false })],
      loopTrace: [{ dropped: 0 }],
    });
    const rule = defenseLayerBoard(db).layers.find((l) => l.layer === "规则校验")!;
    expect(rule.measured).toBe(3);
    expect(rule.passed).toBe(1);
    expect(rule.rate).toBeCloseTo(1 / 3);
  });

  it("规则层全拦(0 条通过)：语义层没有分母，不记为 0%", () => {
    checkpoint(db, "T-1", "review", {
      findings: [finding({ citationValid: false })],
      loopTrace: [{ dropped: 0 }],
    });
    const s = defenseLayerBoard(db);
    const semantic = s.layers.find((l) => l.layer === "语义复核")!;
    expect(semantic.measured).toBe(0);
    expect(semantic.rate).toBeNull();
    // 规则层本身要如实记下这一次全拦。
    const rule = s.layers.find((l) => l.layer === "规则校验")!;
    expect(rule.measured).toBe(1);
    expect(rule.passed).toBe(0);
  });

  it("语义层：分母是规则层放行数，分子按 loopTrace 末轮 dropped 折算", () => {
    checkpoint(db, "T-1", "review", {
      findings: [finding(), finding(), finding()], // 规则层 3 条全过
      loopTrace: [
        { dropped: 2 }, // 第一轮(会被覆盖，只是确认 checkpoints 是 upsert 到末轮)
        { dropped: 1 }, // 末轮：3 条里丢了 1 条
      ],
    });
    const semantic = defenseLayerBoard(db).layers.find((l) => l.layer === "语义复核")!;
    expect(semantic.measured).toBe(3);
    expect(semantic.passed).toBe(2);
    expect(semantic.rate).toBeCloseTo(2 / 3);
  });

  it("这一轮没有建议可审(findings 为空)：规则层与语义层都没有分母", () => {
    checkpoint(db, "T-1", "review", { findings: [], loopTrace: [{ dropped: 0 }] });
    const board = defenseLayerBoard(db);
    for (const key of ["规则校验", "语义复核"] as const) {
      const row = board.layers.find((l) => l.layer === key)!;
      expect(row.measured).toBe(0);
      expect(row.rate).toBeNull();
    }
    // 但这次咨询确实跑到了 review 节点，trace 计数要如实反映。
    expect(board.traces).toBe(1);
  });

  it("NovaGuard：四项 checks 全过才计入分子，任意一项没过就不计", () => {
    checkpoint(db, "T-1", "review", { findings: [finding()], loopTrace: [{ dropped: 0 }] });
    checkpoint(db, "T-1", "risk-gate", {
      checks: [
        { id: "evidence-bound", passed: true },
        { id: "risk-tier-approval", passed: true },
        { id: "scope-contract", passed: true },
        { id: "write-contract", passed: true },
      ],
    });
    checkpoint(db, "T-2", "review", { findings: [finding()], loopTrace: [{ dropped: 0 }] });
    checkpoint(db, "T-2", "risk-gate", {
      checks: [
        { id: "evidence-bound", passed: false },
        { id: "risk-tier-approval", passed: true },
        { id: "scope-contract", passed: true },
        { id: "write-contract", passed: true },
      ],
    });
    const guard = defenseLayerBoard(db).layers.find((l) => l.layer === "NovaGuard")!;
    expect(guard.measured).toBe(2);
    expect(guard.passed).toBe(1);
    expect(guard.rate).toBeCloseTo(0.5);
  });

  it("NovaGuard 把「正确转专家」也算通过 —— 转专家不等于这一层没过", () => {
    // risk-tier-approval / scope-contract 在 novaguard.ts 里对「正确识别风险
    // 并转专家」同样记 passed:true；这里直接照抄那个真实形状。
    checkpoint(db, "T-1", "review", { findings: [], loopTrace: [{ dropped: 0 }] });
    checkpoint(db, "T-1", "risk-gate", {
      checks: [
        { id: "evidence-bound", passed: true },
        { id: "risk-tier-approval", passed: true }, // 强制转专家，仍是 passed
        { id: "scope-contract", passed: true },
        { id: "write-contract", passed: true },
      ],
    });
    const guard = defenseLayerBoard(db).layers.find((l) => l.layer === "NovaGuard")!;
    expect(guard.rate).toBe(1);
  });

  it("按 created_at 切窗", () => {
    checkpoint(db, "T-old", "review", { findings: [finding()], loopTrace: [{ dropped: 0 }] }, "2026-08-01T00:00:00.000Z");
    checkpoint(db, "T-new", "review", { findings: [finding()], loopTrace: [{ dropped: 0 }] }, NOW);
    expect(defenseLayerBoard(db).traces).toBe(2);
    expect(defenseLayerBoard(db, "2026-08-25T00:00:00.000Z").traces).toBe(1);
  });

  it("state 不是合法 JSON 时该行安全跳过，不拖垮整块聚合", () => {
    db.prepare(
      `INSERT INTO checkpoints(trace_id, node, state, created_at) VALUES(?, ?, ?, ?)`,
    ).run("T-bad", "review", "{not json", NOW);
    checkpoint(db, "T-ok", "review", { findings: [finding()], loopTrace: [{ dropped: 0 }] });
    expect(() => defenseLayerBoard(db)).not.toThrow();
    const board = defenseLayerBoard(db);
    expect(board.traces).toBe(2); // 两行都算「有 review 检查点」
    const rule = board.layers.find((l) => l.layer === "规则校验")!;
    expect(rule.measured).toBe(1); // 但坏的那行没有可解析的 findings，不进分母
  });

  it("checkpoints 表被删时只降级不抛 —— 埋点缺失不该让运营页 500", () => {
    db.exec("DROP TABLE checkpoints");
    expect(() => defenseLayerBoard(db)).not.toThrow();
    const board = defenseLayerBoard(db);
    expect(board.traces).toBe(0);
    for (const row of board.layers) expect(row.rate).toBeNull();
  });

  it("真实跑一遍 runConsultationGraph：标准全量场景三层应全通过", async () => {
    seedKnowledgeBase(db);
    const r = await runConsultationGraph(
      db,
      {
        projectId: "NP-DL1",
        tenantId: "novapilot-demo",
        question: "24份FFPE肿瘤样本如何开展RNA差异表达研究",
        locale: "zh",
        facts: { sampleCount: 24, dv200: 62, rnaInputNg: 25, material: "FFPE RNA" },
        now: NOW,
        traceId: "trace-dl1",
      },
      { provider: "off" },
    );
    expect(r.card.status).toBe("formal");

    const board = defenseLayerBoard(db);
    expect(board.traces).toBe(1);
    const rule = board.layers.find((l) => l.layer === "规则校验")!;
    const guard = board.layers.find((l) => l.layer === "NovaGuard")!;
    expect(rule.measured).toBeGreaterThan(0);
    expect(rule.rate).toBe(1); // 全量场景的建议应当全部引用有效、范围内
    expect(guard.measured).toBe(1);
    expect(guard.rate).toBe(1);
  });
});
