/**
 * LangGraph 编排对拍测试。
 *
 * 这一组的目的不是「LangGraph 能跑」,是**换编排器不改变答案**。所以每条测试
 * 都是两条路径跑同一个输入、逐字段比对 —— 只要有一天有人在 langgraph-adapter
 * 里顺手改了业务逻辑,这里立刻红。
 *
 * 三件事各有一条钉:
 *  1. 一轮就接地的普通用例:卡、建议、证据、path 全等。
 *  2. **多轮**用例:环真的转起来了,轮数与 loopTrace 长度两边一致 ——
 *     这是 LangGraph 那条 conditional edge 的唯一验证点。
 *  3. loopTrace 不重复:LangGraph 的数组 channel 惯例是配追加 reducer,而节点
 *     返回的已经是完整数组,叠加会让轨迹每轮翻倍。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDb, type NovaDb } from "../db/client";
import { seedKnowledgeBase } from "../rag/retrieval";
import { runConsultationGraph, type GraphResult } from "./graph";
import { MAX_ROUNDS } from "./grounding-loop";

const NOW = "2026-09-06T00:00:00.000Z";
const OFF = { provider: "off" as const };

function base(overrides: Partial<Parameters<typeof runConsultationGraph>[1]> = {}) {
  return {
    projectId: "LG-1",
    tenantId: "novapilot-demo",
    question: "24份FFPE肿瘤样本如何开展RNA差异表达研究",
    locale: "zh" as const,
    facts: { sampleCount: 24, dv200: 62, rnaInputNg: 25, material: "FFPE RNA" },
    now: NOW,
    traceId: "lg-1",
    ...overrides,
  };
}

/**
 * 强制多轮的输入:把「现在」推到所有种子知识的 validUntil 之后。
 *
 * 证据全部过期 → Critic 逐轮否决 → 三轮预算耗尽转专家。用过期而不是「问一个
 * 库里没有的问题」来构造:检索在候选不足时会回退全量扫描,冷门问题照样能捞回
 * 一堆勉强相关的 chunk 并接地,那样测不到那条 conditional edge。
 */
const EXPIRED = { now: "2030-01-01T00:00:00.000Z" };

/** 只比对「答案」本身,不比对 traceId / projectId 这类输入回声。 */
function answerOf(r: GraphResult) {
  return {
    status: r.card.status,
    path: r.path,
    scenario: r.scenario,
    criticApproved: r.criticApproved,
    recommendations: r.card.recommendations.map((x) => ({
      id: x.id,
      title: x.title,
      evidenceIds: x.evidenceIds,
      boundary: x.boundary,
    })),
    evidence: r.evidence.map((e) => e.id),
    pendingItems: r.card.pendingItems,
  };
}

function loopTraceOf(db: NovaDb, traceId: string) {
  const row = db
    .prepare("SELECT state FROM checkpoints WHERE trace_id = ? AND node = 'review'")
    .get(traceId) as { state: string } | undefined;
  if (!row) return [];
  return (JSON.parse(row.state) as { loopTrace: Array<{ round: number }> }).loopTrace;
}

describe("LangGraph 编排适配器 · 与原生实现对拍", () => {
  let db: NovaDb;
  const previous = process.env.NP_ORCHESTRATOR;

  beforeEach(() => {
    db = createDb(":memory:");
    seedKnowledgeBase(db);
  });
  afterEach(() => {
    if (previous == null) delete process.env.NP_ORCHESTRATOR;
    else process.env.NP_ORCHESTRATOR = previous;
  });

  async function both(overrides: Partial<Parameters<typeof runConsultationGraph>[1]> = {}) {
    delete process.env.NP_ORCHESTRATOR;
    const native = await runConsultationGraph(
      db,
      base({ ...overrides, projectId: "NAT", traceId: "nat" }),
      OFF,
    );
    process.env.NP_ORCHESTRATOR = "langgraph";
    const lg = await runConsultationGraph(
      db,
      base({ ...overrides, projectId: "LGX", traceId: "lgx" }),
      OFF,
    );
    return { native, lg };
  }

  it("普通用例:两条编排路径产出完全相同的卡与证据", async () => {
    const { native, lg } = await both();
    expect(native.card.status).toBe("formal");
    expect(answerOf(lg)).toEqual(answerOf(native));
  });

  it("多轮用例:环真的转起来了,轮数与轨迹两边一致", async () => {
    const { native, lg } = await both(EXPIRED);
    const natTrace = loopTraceOf(db, "nat");
    const lgTrace = loopTraceOf(db, "lgx");

    // 至少转了两轮,否则这条测试没有验证到那条 conditional edge。
    expect(natTrace.length).toBeGreaterThan(1);
    expect(natTrace.length).toBeLessThanOrEqual(MAX_ROUNDS);
    expect(lgTrace.length).toBe(natTrace.length);
    expect(lgTrace.map((x) => x.round)).toEqual(natTrace.map((x) => x.round));
    expect(answerOf(lg)).toEqual(answerOf(native));
  });

  it("loopTrace 不被追加型 reducer 翻倍:轮次严格递增且无重复", async () => {
    await both(EXPIRED);
    const rounds = loopTraceOf(db, "lgx").map((x) => x.round);
    expect(rounds).toEqual([...new Set(rounds)]);
    expect(rounds).toEqual(rounds.slice().sort((a, b) => a - b));
  });

  it("每轮检索日志两边行数相同 —— 埋点不因编排器而变", async () => {
    await both(EXPIRED);
    const count = (t: string) =>
      (db.prepare("SELECT COUNT(*) AS n FROM retrieval_logs WHERE trace_id = ?").get(t) as {
        n: number;
      }).n;
    expect(count("lgx")).toBe(count("nat"));
    expect(count("lgx")).toBeGreaterThan(1);
  });

  it("未知的 NP_ORCHESTRATOR 值走原生实现,不报错", async () => {
    process.env.NP_ORCHESTRATOR = "something-else";
    const r = await runConsultationGraph(db, base({ projectId: "UNK", traceId: "unk" }), OFF);
    expect(r.card.status).toBe("formal");
  });
});
