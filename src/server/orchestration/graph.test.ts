import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type NovaDb } from "../db/client";
import { seedKnowledgeBase } from "../rag/retrieval";
import { runConsultationGraph, getCheckpoints } from "./graph";

const NOW = "2026-08-12T00:00:00.000Z";
const OFF = { provider: "off" as const };

function base(overrides: Partial<Parameters<typeof runConsultationGraph>[1]> = {}) {
  return {
    projectId: "NP-G1",
    tenantId: "novapilot-demo",
    question: "24份FFPE肿瘤样本如何开展RNA差异表达研究",
    locale: "zh" as const,
    facts: { sampleCount: 24, dv200: 62, rnaInputNg: 25, material: "FFPE RNA" },
    now: NOW,
    traceId: "trace-g1",
    ...overrides,
  };
}

describe("Stage 4 · consultation orchestration graph", () => {
  let db: NovaDb;
  beforeEach(() => {
    db = createDb(":memory:");
    seedKnowledgeBase(db);
  });

  it("standard, fully-specified case reaches a formal card via finalize", async () => {
    const r = await runConsultationGraph(db, base(), OFF);
    expect(r.scenario).toBe("standard");
    expect(r.card.status).toBe("formal");
    expect(r.path).toContain("finalize");
    expect(r.path).not.toContain("escalate");
    expect(r.card.recommendations.length).toBeGreaterThan(0);
  });

  it("every formal recommendation resolves to real retrieved evidence", async () => {
    const r = await runConsultationGraph(db, base(), OFF);
    const evidenceIds = new Set(r.evidence.map((e) => e.id));
    for (const rec of r.card.recommendations) {
      expect(rec.evidenceIds.length).toBeGreaterThan(0);
      for (const id of rec.evidenceIds) expect(evidenceIds.has(id)).toBe(true);
    }
  });

  it("missing DV200 produces blocking clarifying questions, not a formal card", async () => {
    const r = await runConsultationGraph(
      db,
      base({ projectId: "NP-G2", traceId: "t2", facts: { sampleCount: 24, material: "FFPE RNA", rnaInputNg: 25 } }),
      OFF,
    );
    expect(r.scenario).toBe("missing-dv200");
    expect(r.clarifyingQuestions.some((q) => q.field === "dv200")).toBe(true);
    expect(r.card.status).not.toBe("formal");
    expect(r.path).toContain("clarify");
  });

  it("evidence-conflict forces mandatory escalation with an expert case", async () => {
    const r = await runConsultationGraph(
      db,
      base({ projectId: "NP-G3", traceId: "t3", question: "SOP与文献冲突，如何处理FFPE RNA样本" }),
      OFF,
    );
    expect(r.scenario).toBe("evidence-conflict");
    expect(r.card.status).toBe("expert-review");
    expect(r.expertCase).not.toBeNull();
    expect(r.expertCase!.handoff.evidenceConflict).toBe(true);
    expect(r.path).toContain("escalate");
  });

  it("customer request for a human escalates", async () => {
    const r = await runConsultationGraph(
      db,
      base({ projectId: "NP-G4", traceId: "t4", question: "我想直接找专家/人工确认方案" }),
      OFF,
    );
    expect(r.scenario).toBe("manual-escalation");
    expect(r.expertCase).not.toBeNull();
  });

  it("non-FFPE material is blocked from the FFPE plan", async () => {
    const r = await runConsultationGraph(
      db,
      base({ projectId: "NP-G5", traceId: "t5", facts: { sampleCount: 10, dv200: 70, rnaInputNg: 30, material: "新鲜冷冻组织 DNA" } }),
      OFF,
    );
    expect(r.card.status).toBe("expert-review");
    expect(r.card.recommendations.length).toBe(0);
  });

  it("persists an ordered checkpoint trail for the run", async () => {
    await runConsultationGraph(db, base({ projectId: "NP-G6", traceId: "t6" }), OFF);
    const trail = getCheckpoints(db, "t6");
    const nodes = trail.map((t) => t.node);
    expect(nodes[0]).toBe("ingest");
    expect(nodes).toContain("retrieve");
    expect(nodes).toContain("review");
    // 处置节点必须是 finalize / escalate 二者之一,且是最后一个**处置**节点。
    // 尾部的 citation-audit / review-sample 是埋点检查点(指标体系第 12 节),
    // 它们落在处置之后 —— 断言改成「最后一个非埋点节点」而不是「最后一个节点」,
    // 否则每加一个埋点都要来改这一行,而这一行想钉住的其实是处置分支的收口。
    const TELEMETRY: string[] = ["citation-audit", "review-sample"];
    const decisions = nodes.filter((n) => !TELEMETRY.includes(n));
    expect(decisions[decisions.length - 1]).toMatch(/finalize|escalate/);
    // 埋点 A 对每一条会话都要出数(转专家的卡也要审引用),所以它一定在。
    expect(nodes).toContain("citation-audit");
  });

  it("prohibits execution CTAs unless the card is formal", async () => {
    const r = await runConsultationGraph(
      db,
      base({ projectId: "NP-G7", traceId: "t7", facts: { sampleCount: 24, material: "FFPE RNA", rnaInputNg: 25 } }),
      OFF,
    );
    expect(r.card.prohibitedCtas.length).toBeGreaterThan(0);
    expect(r.card.serviceFit).toBeNull();
  });

  it("grounds at round 0 for the standard case — the loop short-circuits, no deepening", async () => {
    const r = await runConsultationGraph(db, base({ projectId: "NP-G8", traceId: "t8" }), OFF);
    expect(r.card.status).toBe("formal");
    // retrieve ran exactly once: the loop stopped as soon as a recommendation grounded.
    expect(r.path.filter((n) => n === "retrieve")).toHaveLength(1);

    // The review checkpoint records a single-round grounding trace for auditability.
    const review = getCheckpoints(db, "t8").find((s) => s.node === "review");
    const loopTrace = (review?.state as { loopTrace?: Array<{ round: number; verified: number }> })
      .loopTrace;
    expect(loopTrace).toHaveLength(1);
    expect(loopTrace![0].round).toBe(0);
    expect(loopTrace![0].verified).toBeGreaterThan(0);
  });

  it("a formal card carries hypothesis-driven confirmations derived from the route boundary", async () => {
    const r = await runConsultationGraph(db, base({ projectId: "CONF-1", traceId: "conf-1" }), OFF);
    expect(r.card.status).toBe("formal");
    const confirmations = r.card.advisoryConfirmations ?? [];
    // Derived from the SOP boundary "FFPE RNA; DV200 ≥ 50%; 10–100 ng".
    expect(confirmations.length).toBeGreaterThan(0);
    expect(confirmations.some((c) => /DV200/.test(c))).toBe(true);
  });

  it("a non-formal card has no hypothesis-driven confirmations", async () => {
    const r = await runConsultationGraph(
      db,
      base({ projectId: "CONF-2", traceId: "conf-2", facts: { sampleCount: 24, material: "FFPE RNA", rnaInputNg: 25 } }),
      OFF,
    );
    expect(r.card.status).not.toBe("formal");
    expect(r.card.advisoryConfirmations).toBeUndefined();
  });

  it("records a grounded case and recalls it on a later similar consultation", async () => {
    await runConsultationGraph(db, base({ projectId: "MEM-A", traceId: "mem-a", recordMemory: true }), OFF);
    const stored = (db.prepare("SELECT COUNT(*) AS n FROM case_memory").get() as { n: number }).n;
    expect(stored).toBe(1);

    await runConsultationGraph(db, base({ projectId: "MEM-B", traceId: "mem-b", recordMemory: true }), OFF);
    const retrieve = getCheckpoints(db, "mem-b").find((s) => s.node === "retrieve");
    const recalled = (retrieve?.state as { similarCases?: string[] }).similarCases ?? [];
    expect(recalled).toContain("MEM-A");
  });

  it("does not record case memory unless explicitly opted in (eval stays clean)", async () => {
    await runConsultationGraph(db, base({ projectId: "NOMEM", traceId: "nomem" }), OFF);
    const stored = (db.prepare("SELECT COUNT(*) AS n FROM case_memory").get() as { n: number }).n;
    expect(stored).toBe(0);
  });

  /**
   * 检索日志按轮次落库,并由 review 节点回填核验数。
   *
   * 钉的是「日志行数 = 实际检索轮数」而不是「= 1」—— checkpoints 里
   * (trace_id, node) 主键会把三轮压成一行,那正是单开这张表的理由。
   */
  it("每轮检索各落一行日志,且 verified 被回填(不是 NULL)", async () => {
    const r = await runConsultationGraph(db, base({ projectId: "RL-1", traceId: "rl-1" }), OFF);
    const rows = db
      .prepare(
        `SELECT round, channel, vector_space AS vectorSpace, hit_count AS hitCount,
                hit_doc_ids AS hitDocIds, verified
         FROM retrieval_logs WHERE trace_id = 'rl-1' ORDER BY round`,
      )
      .all() as Array<{
      round: number;
      channel: string;
      vectorSpace: string;
      hitCount: number;
      hitDocIds: string;
      verified: number | null;
    }>;

    // 这一例一轮就接地,所以恰好一行;轮次与 loopTrace 长度必须一致。
    const rounds = (getCheckpoints(db, "rl-1").find((s) => s.node === "review")!.state as {
      loopTrace: unknown[];
    }).loopTrace.length;
    expect(rows).toHaveLength(rounds);
    expect(rows[0]!.round).toBe(0);
    expect(rows[0]!.hitCount).toBeGreaterThan(0);
    // 文档 id 去重后落库:命中数 ≥ 去重文档数。
    expect(JSON.parse(rows[0]!.hitDocIds).length).toBeGreaterThan(0);
    // 回填过 —— NULL 表示流程断在 review 之前,不能当 0 用。
    expect(rows[0]!.verified).not.toBeNull();
    expect(rows[0]!.verified).toBe(r.card.recommendations.length);
  });
});

describe("适用范围契约在编排图里的落点", () => {
  let db: NovaDb;
  beforeEach(() => {
    db = createDb(":memory:");
    seedKnowledgeBase(db);
  });

  it("越界请求转专家,并在卡面上说清越界在哪", async () => {
    const r = await runConsultationGraph(
      db,
      base({
        projectId: "NP-SCOPE-1",
        traceId: "trace-scope-1",
        question: "这批犬类FFPE肿瘤样本做转录组，参考基因组按哪套执行",
      }),
      OFF,
    );
    expect(r.card.status).toBe("expert-review");
    expect(r.card.recommendations).toEqual([]);
    // 一句「已转专家」没有信息量:客户得知道是因为物种不在适用范围内。
    expect(r.card.executiveSummary).toContain("犬");
    expect(r.card.executiveSummary).toContain("适用范围");
    // 待决项是「要不要受理」,不是追问 DV200 —— 事实齐了也不改变越界这件事。
    expect(r.card.pendingItems.join("")).toContain("是否受理");
    expect(r.expertCase?.handoff.reason).toContain("越出适用范围");
  });

  it("越界时留下 scope-contract 检查点,未越界时不留", async () => {
    const bad = await runConsultationGraph(
      db,
      base({ projectId: "NP-SCOPE-2", traceId: "trace-scope-2", question: "单样本报价多少元，含税吗" }),
      OFF,
    );
    expect(bad.path).toContain("scope-contract");
    const trace = getCheckpoints(db, "trace-scope-2").find((s) => s.node === "risk-gate")!.state as {
      outOfScope: boolean;
      scopeViolations: string[];
    };
    expect(trace.outOfScope).toBe(true);
    expect(trace.scopeViolations).toContain("capability:报价与折扣");

    const ok = await runConsultationGraph(
      db,
      base({ projectId: "NP-SCOPE-3", traceId: "trace-scope-3" }),
      OFF,
    );
    expect(ok.path).not.toContain("scope-contract");
    expect(ok.card.status).toBe("formal");
  });

  it("越界不复用「三轮耗尽」的措辞 —— 两种交接语境必须分得开", async () => {
    const r = await runConsultationGraph(
      db,
      base({
        projectId: "NP-SCOPE-4",
        traceId: "trace-scope-4",
        question: "这批FFPE样本改做单细胞转录组，细胞捕获率要求是多少",
      }),
      OFF,
    );
    expect(r.card.status).toBe("expert-review");
    expect(r.card.executiveSummary).not.toContain("多轮加深检索");
    expect(r.expertCase?.handoff.attemptedAction).toContain("未进入证据检索");
  });
});
