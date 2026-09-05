/**
 * 检索日志口径单测(指标体系 v1.1 第 6 节检索侧 + 第 11 节 P2)。
 *
 * 这一组测的核心是**这张表存在的理由**:三轮加深检索必须各留一行。
 * checkpoints 的主键是 (trace_id, node),第 2 轮把第 1 轮覆盖掉,所以
 * 「轮次口径」的回退率在那边结构上就算不出来 —— 第一条测试就钉这个。
 *
 * 其余三条钉的是三个容易悄悄出错的地方:
 *   · 从未被命中的文档必须出现在健康度里(LEFT JOIN 不能退化成 INNER)。
 *   · verified 为 NULL(流程中断)不能被当成 0 算进知识盲区。
 *   · 样本不足时 P2 不报警 —— 小样本上的 100% 回退率是噪声。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type NovaDb } from "../db/client";
import {
  P2_THRESHOLDS,
  blindSpots,
  channelMix,
  documentHealth,
  noteRoundVerified,
  p2Breaches,
  recordRetrievalRound,
  retrievalBoard,
  vectorSpaceMix,
} from "./retrieval-log";
import type { RetrievalDiagnostics } from "../rag/retrieval";

const NOW = "2026-09-06T00:00:00.000Z";

function diag(over: Partial<RetrievalDiagnostics> = {}): RetrievalDiagnostics {
  return {
    channel: "fts",
    fallbackReason: null,
    candidateCount: 30,
    vectorSpace: "semantic",
    vectorSpaceReason: null,
    elapsedMs: 12,
    ...over,
  };
}

function doc(db: NovaDb, id: string, source: "SOP" | "SCI" = "SOP") {
  db.prepare(
    `INSERT OR IGNORE INTO documents(id, source, title, citation, version, applies_to, valid_until)
     VALUES(?, ?, ?, ?, 'v1', 'FFPE', '2027-01-01')`,
  ).run(id, source, `${id} 标题`, `[${id}]`);
}

function round(
  db: NovaDb,
  over: {
    traceId: string;
    round: number;
    query?: string;
    scopeHint?: string;
    diagnostics?: RetrievalDiagnostics;
    hits?: string[];
    now?: string;
  },
) {
  recordRetrievalRound(db, {
    traceId: over.traceId,
    projectId: "P-1",
    round: over.round,
    query: over.query ?? "FFPE 样本 DV200 偏低还能建库吗",
    scopeHint: over.scopeHint ?? "FFPE",
    topK: 5 * 2 ** over.round,
    diagnostics: over.diagnostics ?? diag(),
    hitDocumentIds: over.hits ?? ["D-1"],
    now: over.now ?? NOW,
  });
}

describe("检索日志", () => {
  let db: NovaDb;
  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("同一 trace 的三轮各留一行 —— 这正是 checkpoints 做不到的事", () => {
    round(db, { traceId: "T-1", round: 0 });
    round(db, { traceId: "T-1", round: 1 });
    round(db, { traceId: "T-1", round: 2 });
    expect(channelMix(db, null).rounds).toBe(3);

    // 对照:同一 traceId 在 checkpoints 里只会剩最后一轮。
    for (const r of [0, 1, 2]) {
      db.prepare(
        `INSERT INTO checkpoints(trace_id, node, state, created_at) VALUES('T-1','retrieve',?,?)
         ON CONFLICT(trace_id, node) DO UPDATE SET state = excluded.state`,
      ).run(JSON.stringify({ round: r }), NOW);
    }
    const cp = db
      .prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE trace_id = 'T-1' AND node = 'retrieve'")
      .all() as Array<{ n: number }>;
    expect(cp[0]!.n).toBe(1);
  });

  it("短查询回退触发率按轮次算,且分母为 0 时是 null 不是 0", () => {
    expect(channelMix(db, null).shortQueryRate).toBeNull();

    round(db, { traceId: "T-1", round: 0, diagnostics: diag() });
    round(db, {
      traceId: "T-2",
      round: 0,
      diagnostics: diag({ channel: "fallback", fallbackReason: "short-query" }),
    });
    round(db, {
      traceId: "T-3",
      round: 0,
      diagnostics: diag({ channel: "fallback", fallbackReason: "insufficient-candidates" }),
    });

    const mix = channelMix(db, null);
    expect(mix).toMatchObject({ rounds: 3, fts: 1, fallback: 2 });
    expect(mix.shortQueryRate).toBeCloseTo(1 / 3);
    // 回退原因要分开计数 —— 「候选不足」和「查询太短」是两种病,合并就没法治。
    expect(mix.fallbackReasons).toEqual([
      { reason: "short-query", rounds: 1 },
      { reason: "insufficient-candidates", rounds: 1 },
    ]);
  });

  it("向量空间占比落库 —— 语义模型有没有真的在用只有这里能看出来", () => {
    round(db, { traceId: "T-1", round: 0, diagnostics: diag() });
    round(db, {
      traceId: "T-2",
      round: 0,
      diagnostics: diag({ vectorSpace: "hash", vectorSpaceReason: "no-query-vector" }),
    });
    const mix = vectorSpaceMix(db, null);
    expect(mix).toMatchObject({ rounds: 2, semantic: 1, hash: 1 });
    expect(mix.semanticRate).toBe(0.5);
    expect(mix.reasons).toEqual([{ reason: "no-query-vector", rounds: 1 }]);
  });

  it("从未被命中的文档必须出现在健康度里(LEFT JOIN 不能退化成 INNER)", () => {
    doc(db, "D-1");
    doc(db, "D-2");
    doc(db, "D-3", "SCI");
    round(db, { traceId: "T-1", round: 0, hits: ["D-1", "D-1", "D-3"] });

    const health = documentHealth(db, null);
    expect(health).toHaveLength(3);
    const byId = Object.fromEntries(health.map((h) => [h.documentId, h]));
    // 同一轮内重复命中同一篇算一次 —— 落库前已按文档去重。
    expect(byId["D-1"]!.hitRounds).toBe(1);
    expect(byId["D-1"]!.lastHitAt).toBe(NOW);
    expect(byId["D-2"]!.hitRounds).toBe(0);
    expect(byId["D-2"]!.lastHitAt).toBeNull();

    const board = retrievalBoard(db);
    // SOP 覆盖率只看 SOP:D-3 是 SCI,不进分母。
    expect(board.sopCoverage).toEqual({ total: 2, covered: 1, rate: 0.5 });
    expect(board.neverHit.map((h) => h.documentId)).toEqual(["D-2"]);
  });

  it("知识盲区只认末轮,且 verified 为 NULL 时不当 0", () => {
    // T-1:三轮全跑完,末轮零核验 → 真盲区。
    round(db, { traceId: "T-1", round: 0, scopeHint: "FFPE" });
    round(db, { traceId: "T-1", round: 1, scopeHint: "FFPE" });
    round(db, { traceId: "T-1", round: 2, scopeHint: "FFPE", query: "灰区样本怎么办" });
    noteRoundVerified(db, "T-1", 0, 0);
    noteRoundVerified(db, "T-1", 1, 0);
    noteRoundVerified(db, "T-1", 2, 0);

    // T-2:前两轮零核验,末轮撑住了 → 这是设计意图(加深检索生效),不是盲区。
    round(db, { traceId: "T-2", round: 0, scopeHint: "单细胞" });
    round(db, { traceId: "T-2", round: 1, scopeHint: "单细胞" });
    noteRoundVerified(db, "T-2", 0, 0);
    noteRoundVerified(db, "T-2", 1, 2);

    // T-3:检索完流程就断了,verified 从没回填 → 是系统异常,不能记到知识账上。
    round(db, { traceId: "T-3", round: 0, scopeHint: "空间转录组" });

    const spots = blindSpots(db, null);
    expect(spots).toHaveLength(1);
    expect(spots[0]).toMatchObject({ topic: "FFPE", sessions: 1, sampleQuery: "灰区样本怎么办" });
  });

  it("样本不足时不报 P2 —— 小样本上的 100% 回退率是噪声", () => {
    doc(db, "D-1");
    doc(db, "D-2");
    doc(db, "D-3");
    // 全部回退、3 篇 SOP 只命中 1 篇(覆盖率 33%),但只有 3 轮样本。
    for (const t of ["T-1", "T-2", "T-3"]) {
      round(db, {
        traceId: t,
        round: 0,
        diagnostics: diag({ channel: "fallback", fallbackReason: "short-query" }),
      });
    }
    expect(retrievalBoard(db).channels.shortQueryRate).toBe(1);
    expect(p2Breaches(retrievalBoard(db))).toEqual([]);

    // 补到阈值样本量后才报,且两条都报。
    for (let i = 0; i < P2_THRESHOLDS.minRounds; i++) {
      round(db, {
        traceId: `S-${i}`,
        round: 0,
        diagnostics: diag({ channel: "fallback", fallbackReason: "short-query" }),
      });
    }
    const breaches = p2Breaches(retrievalBoard(db));
    expect(breaches.some((b) => b.includes("短查询回退触发率"))).toBe(true);
    expect(breaches.some((b) => b.includes("SOP 覆盖率"))).toBe(true);
  });

  it("检索耗时分位取最近邻,且与端到端延迟分开口径", () => {
    for (const [i, ms] of [10, 20, 30, 400].entries()) {
      round(db, { traceId: `T-${i}`, round: 0, diagnostics: diag({ elapsedMs: ms }) });
    }
    const e = retrievalBoard(db).elapsed;
    // 4 个样本的 P95 = ceil(0.95*4)=4 → 第 4 个,即真实存在的 400,不是插值。
    expect(e).toEqual({ rounds: 4, p50: 20, p95: 400, max: 400 });
  });

  it("老库缺表时看板降级出格,不整页 500", () => {
    const bare = createDb(":memory:");
    bare.prepare("DROP TABLE retrieval_logs").run();
    const board = retrievalBoard(bare);
    expect(board.channels.rounds).toBe(0);
    expect(board.channels.shortQueryRate).toBeNull();
    expect(board.blindSpots).toEqual([]);
  });
});
