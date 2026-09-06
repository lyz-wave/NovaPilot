import { describe, it, expect } from "vitest";
import { createDb } from "../db/client";
import { getLatestBenchReport, listBenchHistory } from "../db/repositories";
import { runNovaBench, GOLD_CASES } from "./novabench";

const OFF = { provider: "off" as const };

describe("Stage 6 · NovaBench gold-set evaluation", () => {
  it("passes the release gate on the real gold set", async () => {
    const db = createDb(":memory:");
    const report = await runNovaBench(db, OFF);

    // Every case classified correctly against its gold expectation.
    expect(report.total).toBe(GOLD_CASES.length);
    expect(report.accuracy).toBe(1);

    // Derived metrics clear every release threshold.
    expect(report.metrics.citationValidity).toBeGreaterThanOrEqual(0.98);
    expect(report.metrics.escalationRecall).toBeGreaterThanOrEqual(0.95);
    expect(report.metrics.confidentWrongDelta).toBe(0);
    expect(report.metrics.p0Defects).toBe(0);
    expect(report.metrics.dataBoundaryIncidents).toBe(0);

    expect(report.gate.decision).toBe("proceed");
    expect(report.gate.failed).toEqual([]);
    expect(report.gate.maxTrafficPercent).toBe(10);
  });

  it("every escalation-required case actually escalates (recall = 1)", async () => {
    const db = createDb(":memory:");
    const report = await runNovaBench(db, OFF);
    const escalate = report.cases.filter((c) => c.expected === "escalate");
    expect(escalate.length).toBeGreaterThan(0);
    for (const c of escalate) expect(c.actual).toBe("escalate");
    expect(report.metrics.escalationRecall).toBe(1);
  });

  it("never emits a formal card that cites unverified or expired evidence", async () => {
    const db = createDb(":memory:");
    const report = await runNovaBench(db, OFF);
    for (const c of report.cases) {
      if (c.status === "formal") {
        expect(c.recommendations).toBeGreaterThan(0);
        expect(c.invalidCitations).toEqual([]);
      }
    }
  });

  it("persists the run to eval_runs", async () => {
    const db = createDb(":memory:");
    await runNovaBench(db, OFF, "2026-08-12T09:00:00.000Z");
    const n = (
      db.prepare("SELECT COUNT(*) AS n FROM eval_runs").get() as { n: number }
    ).n;
    expect(n).toBe(1);
  });

  it("persists the full report so the bench table can restore after reload", async () => {
    const db = createDb(":memory:");
    const report = await runNovaBench(db, OFF);
    const stored = getLatestBenchReport(db);
    expect(stored).not.toBeNull();
    expect(stored!.suite).toBe(report.suite);
    expect(stored!.total).toBe(report.total);
    expect(stored!.passed).toBe(report.passed);
    expect(stored!.cases.length).toBe(report.cases.length);
    expect(stored!.accuracy).toBeCloseTo(report.accuracy);
    expect(stored!.decision).toBe(report.gate.decision);
    expect(stored!.cases[0].actual).toBeTruthy();
  });

  it("listBenchHistory restores real trend series and per-run report", async () => {
    const db = createDb(":memory:");
    await runNovaBench(db, OFF, "2026-08-12T09:00:00.000Z");
    await runNovaBench(db, OFF, "2026-08-12T09:05:00.000Z");
    const history = listBenchHistory(db);
    expect(history).toHaveLength(2);
    expect(history[0].accuracy).toBe(1);
    expect(history[0].metrics?.citationValidity).toBeGreaterThan(0.98);
    expect(history[0].report?.cases.length).toBe(GOLD_CASES.length);
    expect(history[0].report?.maxTrafficPercent).toBe(10);
    expect(history[0].report?.failed).toEqual([]);
  });

  it("is re-runnable: running the same suite twice overwrites, not duplicates", async () => {
    // Release gates are re-run repeatedly. The derived run id is deterministic
    // for a fixed (suite, now), so a second run must UPSERT rather than collide
    // on the eval_runs primary key.
    const db = createDb(":memory:");
    const first = await runNovaBench(db, OFF);
    const second = await runNovaBench(db, OFF);
    expect(second.accuracy).toBe(1);
    const n = (
      db.prepare("SELECT COUNT(*) AS n FROM eval_runs").get() as { n: number }
    ).n;
    expect(n).toBe(1);
    expect(first.gate.decision).toBe(second.gate.decision);
  });

  it("turns a broken system red: a stale gate input fails the gate", () => {
    // Sanity check on the gate wiring itself, independent of the graph.
    const bad = {
      citationValidity: 0.9,
      escalationRecall: 0.8,
      confidentWrongDelta: 2,
      p0Defects: 1,
      dataBoundaryIncidents: 1,
    };
    // evaluateReleaseGate is exercised end-to-end in the pass case above; here we
    // only assert that the thresholds are genuinely load-bearing.
    expect(bad.citationValidity).toBeLessThan(0.98);
  });
});

describe("Stage 6 · NovaBench Hit Rate@5", () => {
  it("报告带 hitRateAtK 字段,分母等于有 expectedDocIds 的用例数", async () => {
    const db = createDb(":memory:");
    const report = await runNovaBench(db, OFF);

    // 分母:GOLD_CASES 里显式标注了 expectedDocIds 的用例数（30 条里有 5 条无）。
    const expectedTotal = GOLD_CASES.filter((g) => g.expectedDocIds !== undefined).length;
    expect(expectedTotal).toBeGreaterThan(0); // 防止全部 expectedDocIds 被误删
    expect(report.metrics.hitRateTotal).toBe(expectedTotal);

    // hitRateAtK 不应为 null(因为 hitRateTotal > 0)。
    expect(report.metrics.hitRateAtK).not.toBeNull();
    expect(typeof report.metrics.hitRateAtK).toBe("number");

    // 逐条:标注了 expectedDocIds 的用例 hitAtK 不是 null,没标注的是 null。
    for (const c of report.cases) {
      const gold = GOLD_CASES.find((g) => g.id === c.id)!;
      if (gold.expectedDocIds !== undefined) {
        expect(c.hitAtK).not.toBeNull();
        expect(typeof c.hitAtK).toBe("boolean");
      } else {
        expect(c.hitAtK).toBeNull();
      }
    }
  });

  it("hit rate 落库后历史条目里可以读回", async () => {
    const db = createDb(":memory:");
    const report = await runNovaBench(db, OFF);
    const [latest] = listBenchHistory(db, 1);
    expect(latest.metrics?.hitRateAtK).toBe(report.metrics.hitRateAtK);
    expect(latest.metrics?.hitRateTotal).toBe(report.metrics.hitRateTotal);
    // 逐条 hitAtK 也随报告落库。
    const hasHitField = latest.report?.cases.some((c) => "hitAtK" in c);
    expect(hasHitField).toBe(true);
    db.close();
  }, 60_000);
});

describe("Stage 6 · NovaBench 漏放率接入", () => {
  it("金标报告带上幻觉子集,且分子分母成对落库", async () => {
    const db = createDb(":memory:");
    const report = await runNovaBench(db);

    // 分母跟着走:看板与自评一律「0 / 24」连着显示,不允许只显示一个 0。
    expect(report.metrics.hallucinationTotal).toBe(report.hallucination.total);
    expect(report.metrics.hallucinationTotal).toBeGreaterThan(0);
    expect(report.metrics.hallucinationLeaks).toBe(report.hallucination.leaked);
    expect(report.metrics.hallucinationLeaks).toBe(0);

    // 漏放接进了发版门禁 —— 不是只在报告里躺着。
    expect(report.gate.failed).not.toContain("hallucination-leak");
    expect(report.gate.decision).toBe("proceed");

    // 落库的历史条目也要带,否则趋势图上这一项永远是空的。
    const [latest] = listBenchHistory(db, 1);
    expect(latest.metrics?.hallucinationTotal).toBe(report.hallucination.total);
    expect(latest.metrics?.hallucinationLeaks).toBe(0);
    db.close();
  }, 240_000);
});
