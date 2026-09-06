/**
 * W4 验收测试：token 级流式架构 + first_token_ms 埋点。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createDb, type NovaDb } from "../db/client";
import { runConsultationGraph } from "../orchestration/graph";
import { streamText } from "../agents/model-gateway";
import { recordLatencySample, latencySummary } from "../telemetry/latency";

const OFF = { provider: "off" as const };
const T0 = "2026-09-01T00:00:00.000Z";

function makeInput(projectId: string, overrides: object = {}) {
  return {
    projectId,
    tenantId: "novapilot-demo",
    question: "FFPE RNA DV200 35%，能做转录组吗",
    locale: "zh" as const,
    facts: { sampleCount: 6, dv200: 35, rnaInputNg: 20, material: "FFPE RNA" },
    now: T0,
    traceId: `trace-${projectId}`,
    ...overrides,
  };
}

describe("W4 · streamText 离线路径", () => {
  it("deterministic provider 调用 onToken 并返回 firstTokenMs", async () => {
    const tokens: string[] = [];
    const result = await streamText(
      { messages: [{ role: "user", content: "hello" }] },
      { provider: "off" },
      (delta) => tokens.push(delta),
    );
    expect(result.firstTokenMs).toBeGreaterThanOrEqual(0);
    expect(result.provider).toBe("deterministic");
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.join("")).toBe(result.text);
  });

  it("onToken 不抛时 streamText 正常完成", async () => {
    const result = await streamText(
      { messages: [{ role: "user", content: "test" }] },
      { provider: "off" },
      () => { throw new Error("onToken threw"); },
    );
    // Should not propagate the onToken error
    expect(result.text).toBeTruthy();
    expect(result.firstTokenMs).toBeGreaterThanOrEqual(0);
  });
});

describe("W4 · onToken 接地循环联动", () => {
  let db: NovaDb;
  beforeEach(() => { db = createDb(":memory:"); });
  afterEach(() => { db.close(); });

  it("runConsultationGraph 传 onToken 不影响结果 + NP_STREAM_TOKENS=true 时有 firstTokenMs", async () => {
    const savedEnv = process.env.NP_STREAM_TOKENS;
    process.env.NP_STREAM_TOKENS = "true";
    try {
      const tokens: string[] = [];
      const r = await runConsultationGraph(
        db,
        { ...makeInput("TEST-STREAM-1"), onToken: (d) => tokens.push(d) },
        OFF,
      );
      // Core result unchanged
      expect(r.card).toBeDefined();
      expect(r.provider).toBe("deterministic");
      // When NP_STREAM_TOKENS=true, firstTokenMs must be set
      expect(r.firstTokenMs).toBeGreaterThanOrEqual(0);
      // onToken was called at least once (offline path fires once with full text)
      expect(tokens.length).toBeGreaterThan(0);
    } finally {
      if (savedEnv === undefined) delete process.env.NP_STREAM_TOKENS;
      else process.env.NP_STREAM_TOKENS = savedEnv;
    }
  }, 60_000);
});

describe("W4 · first_token_ms schema v11 + latency 埋点", () => {
  let db: NovaDb;
  beforeEach(() => { db = createDb(":memory:"); });
  afterEach(() => { db.close(); });

  it("recordLatencySample 接受 firstTokenMs + provider 并可由 latencySummary 读回", () => {
    recordLatencySample(db, {
      traceId: "T-W4-1",
      route: "consultations:stream",
      kind: "card",
      cardStatus: "formal",
      durationMs: 3000,
      outcome: "completed",
      firstTokenMs: 120,
      provider: "anthropic",
      now: T0,
    });
    const summary = latencySummary(db);
    expect(summary.firstToken.length).toBe(1);
    expect(summary.firstToken[0]!.provider).toBe("anthropic");
    expect(summary.firstToken[0]!.stats.p95).toBe(120);
  });

  it("firstToken 按 provider 分组", () => {
    const base = { route: "consultations:stream", kind: "card" as const, cardStatus: "formal", durationMs: 1000, outcome: "completed" as const, now: T0 };
    recordLatencySample(db, { ...base, traceId: "T1", firstTokenMs: 100, provider: "anthropic" });
    recordLatencySample(db, { ...base, traceId: "T2", firstTokenMs: 200, provider: "anthropic" });
    recordLatencySample(db, { ...base, traceId: "T3", firstTokenMs: 50, provider: "deterministic" });
    const summary = latencySummary(db);
    const providers = summary.firstToken.map((g) => g.provider).sort();
    expect(providers).toContain("anthropic");
    expect(providers).toContain("deterministic");
    const anthropic = summary.firstToken.find((g) => g.provider === "anthropic")!;
    expect(anthropic.stats.p95).toBe(200); // nearest-rank p95 of [100, 200]
  });

  it("无 firstTokenMs 行时 firstToken 数组为空", () => {
    recordLatencySample(db, {
      traceId: "T-NOFT",
      route: "consultations",
      kind: "card",
      cardStatus: "formal",
      durationMs: 2000,
      now: T0,
    });
    const summary = latencySummary(db);
    expect(summary.firstToken).toEqual([]);
  });
});
