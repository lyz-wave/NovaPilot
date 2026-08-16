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
    expect(nodes[nodes.length - 1]).toMatch(/finalize|escalate/);
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
});
