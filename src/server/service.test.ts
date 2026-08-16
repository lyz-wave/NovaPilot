import { describe, it, expect } from "vitest";
import { createDb } from "./db/client";
import { consult, ensureSeeded } from "./service";

const OFF = { provider: "off" as const };

describe("Stage 5 · service layer (live backend)", () => {
  it("ensureSeeded loads the knowledge base once and is idempotent", () => {
    const db = createDb(":memory:");
    ensureSeeded(db);
    ensureSeeded(db);
    const n = (db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
    expect(n).toBeGreaterThan(5);
  });

  it("consult runs the full graph and returns a persisted decision card", async () => {
    const db = createDb(":memory:");
    const r = await consult(
      {
        question: "24份FFPE肿瘤样本如何开展RNA差异表达研究",
        locale: "zh",
        facts: { sampleCount: 24, dv200: 62, rnaInputNg: 25, material: "FFPE RNA" },
        tenantId: "novapilot-demo",
        traceId: "svc-trace-1",
      },
      OFF,
      db,
    );
    expect(r.card.status).toBe("formal");
    expect(r.card.recommendations.length).toBeGreaterThan(0);

    // card was persisted
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM decision_cards WHERE trace_id = ?")
      .get("svc-trace-1") as { n: number };
    expect(row.n).toBeGreaterThan(0);
  });

  it("consult persists checkpoints for streaming replay", async () => {
    const db = createDb(":memory:");
    await consult(
      {
        question: "缺少DV200的FFPE样本怎么办",
        locale: "zh",
        facts: { sampleCount: 12, material: "FFPE RNA", rnaInputNg: 20 },
        tenantId: "novapilot-demo",
        traceId: "svc-trace-2",
      },
      OFF,
      db,
    );
    const n = (
      db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE trace_id = ?").get("svc-trace-2") as {
        n: number;
      }
    ).n;
    expect(n).toBeGreaterThan(3);
  });
});
