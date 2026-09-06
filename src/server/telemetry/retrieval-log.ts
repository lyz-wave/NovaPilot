/**
 * 检索日志(指标体系 v1.1 第 6 节检索侧 + 第 11 节 P2 告警路径)。
 *
 * 这一张表补的不是「没埋点」,是「埋了但取不出来」:
 * 每轮检索的 `RetrievalDiagnostics` 本来就写进了 `checkpoints.state` 的 JSON,
 * 但 checkpoints 主键是 `(trace_id, node)` + ON CONFLICT DO UPDATE ——
 * 一次咨询最多三轮加深检索,第 2 轮把第 1 轮**原地覆盖**。而看板要的四项里
 * 有三项分母是**轮次**不是会话,靠聚合 checkpoints 结构上绕不过去。
 *
 * 一次点亮四项:
 *   短查询回退触发率   fallback_reason = 'short-query' 的轮次占比
 *   SOP 覆盖率         被检索命中过的 SOP 文档 / 库里 SOP 文档总数
 *   知识盲区主题数     末轮 verified = 0 的会话,按 scope_hint 归组
 *   单篇知识健康度     每篇文档的命中轮次数与最近命中时间
 *
 * ── 两处口径上的克制,都是为了不造假数 ──
 *
 * 1. **不设「分值过阈」判定。** rerank 的融合分在每次查询**内部**做了 max
 *    归一化(retrieval.ts:`bm = s.bm25 / maxBm`),最高命中的 bm 恒为 1.0,
 *    于是 top rerank 恒 ≥ 0.22,跟这次检索准不准无关。拿它设阈值,得到的是
 *    一个恒真的「检索质量良好」——比没有指标更糟。所以「知识盲区」改用真信号:
 *    该轮检索出的证据**有没有撑住核验**,由 review 节点回填。
 *
 * 2. **verified 为 NULL 时不当 0 用。** NULL 是「流程没走到 review 就断了」,
 *    0 是「走到了,一条都没通过」。把前者算成盲区,等于把系统异常记到知识
 *    质量的账上。所有聚合都显式排除 NULL。
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { queryAll, type NovaDb } from "../db/client";
import type {
  FallbackReason,
  RetrievalChannel,
  RetrievalDiagnostics,
  VectorSpace,
  VectorSpaceReason,
} from "../rag/retrieval";

export interface RetrievalRoundInput {
  traceId: string;
  projectId: string;
  /** 第几轮加深检索,从 0 开始。它进主键,所以三轮不会互相覆盖。 */
  round: number;
  query: string;
  /** 本轮的 appliesTo 提示 —— 知识盲区的归组维度。 */
  scopeHint?: string;
  topK: number;
  diagnostics: RetrievalDiagnostics;
  /** 本轮实际取回的证据块。只落文档 id(去重),正文不进日志表。 */
  hitDocumentIds: readonly string[];
  now: string;
}

/**
 * 写一行检索日志。
 *
 * 和埋点 A/B/D 一致吞异常:日志写失败不该让用户拿不到卡。这里额外重要 ——
 * 它挂在**每轮检索**上,是运行时链路上调用最频繁的一处埋点。
 */
export function recordRetrievalRound(db: NovaDb, input: RetrievalRoundInput): void {
  const d = input.diagnostics;
  try {
    db.prepare(
      `INSERT INTO retrieval_logs(
         id, trace_id, project_id, round, query, query_chars, scope_hint, top_k,
         channel, fallback_reason, vector_space, vector_space_reason,
         candidate_count, hit_count, hit_doc_ids, elapsed_ms, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         channel = excluded.channel, fallback_reason = excluded.fallback_reason,
         vector_space = excluded.vector_space,
         vector_space_reason = excluded.vector_space_reason,
         candidate_count = excluded.candidate_count, hit_count = excluded.hit_count,
         hit_doc_ids = excluded.hit_doc_ids, elapsed_ms = excluded.elapsed_ms,
         created_at = excluded.created_at`,
    ).run(
      roundId(input.traceId, input.round),
      input.traceId,
      input.projectId,
      input.round,
      input.query,
      // 字符数而不是 token 数:短查询回退的触发条件是 trigram 最短长度,
      // 那是按字符算的(retrieval.ts:TRIGRAM_MIN),口径必须对齐。
      [...input.query].length,
      input.scopeHint ?? "",
      input.topK,
      d.channel,
      d.fallbackReason,
      d.vectorSpace,
      d.vectorSpaceReason,
      d.candidateCount,
      input.hitDocumentIds.length,
      JSON.stringify([...new Set(input.hitDocumentIds)]),
      Math.max(0, Math.round(d.elapsedMs)),
      input.now,
    );
  } catch (err) {
    console.warn("[telemetry] retrieval log failed", err);
  }
}

/**
 * 回填本轮核验结果。review 节点调用。
 *
 * 用 UPDATE 而不是 upsert:没有对应的检索行说明检索那一步就没落库(已告警),
 * 这里凭空插一行会造出一条 query 为空的日志,把 SOP 覆盖率的分母搅乱。
 */
export function noteRoundVerified(
  db: NovaDb,
  traceId: string,
  round: number,
  verified: number,
): void {
  try {
    db.prepare("UPDATE retrieval_logs SET verified = ? WHERE id = ?").run(
      Math.max(0, Math.round(verified)),
      roundId(traceId, round),
    );
  } catch (err) {
    console.warn("[telemetry] retrieval verified backfill failed", err);
  }
}

function roundId(traceId: string, round: number): string {
  return `RL-${traceId}-${round}`;
}

// ── 聚合口径 ────────────────────────────────────────────────────────

/** 通道分布。分母是**轮次**。 */
export interface ChannelMix {
  rounds: number;
  fts: number;
  fallback: number;
  /** 各回退原因的轮次数(仅 fallback 轮)。 */
  fallbackReasons: Array<{ reason: Exclude<FallbackReason, null>; rounds: number }>;
  /** 短查询回退触发率。rounds = 0 时 null,不是 0。 */
  shortQueryRate: number | null;
}

/** 向量空间分布 —— 「语义模型有没有真的在用」的唯一可观测证据。 */
export interface VectorSpaceMix {
  rounds: number;
  semantic: number;
  hash: number;
  semanticRate: number | null;
  reasons: Array<{ reason: Exclude<VectorSpaceReason, null>; rounds: number }>;
}

/** 单篇知识健康度。 */
export interface DocHealth {
  documentId: string;
  title: string;
  source: string;
  /** 命中轮次数。0 表示这篇知识从没被任何一次检索取回过。 */
  hitRounds: number;
  /** 最近一次被命中的时间;从未命中为 null。 */
  lastHitAt: string | null;
}

/** 知识盲区:末轮检索出的证据一条都没撑住核验的会话,按主题归组。 */
export interface BlindSpot {
  /** scope hint;空串归到 `(无提示)`。 */
  topic: string;
  /** 该主题下末轮 verified = 0 的会话数。 */
  sessions: number;
  /** 样例问题(最新一条),给运营看「到底是什么问题答不了」。 */
  sampleQuery: string;
  lastAt: string;
}

/** 一个语义聚类簇（由 scripts/blindspot-clusters.ts 生成后存 data/blindspot-report.json）。 */
export interface BlindspotCluster {
  cluster: number;
  size: number;
  weeksUnhit: number;
  sampleQueries: string[];
}

export interface RetrievalBoard {
  channels: ChannelMix;
  vectorSpaces: VectorSpaceMix;
  /** 单轮检索耗时分位。口径是检索段,**不是端到端** —— 那个在 latency.ts。 */
  elapsed: { rounds: number; p50: number | null; p95: number | null; max: number | null };
  /** SOP 覆盖率:被命中过的 SOP 文档数 / SOP 文档总数。库里没有 SOP 时 null。 */
  sopCoverage: { total: number; covered: number; rate: number | null };
  /** 从没被命中过的文档(covered 的补集),含种子知识。 */
  neverHit: DocHealth[];
  blindSpots: BlindSpot[];
  /**
   * 语义聚类盲区（由 `npm run blindspot:clusters` 生成）。
   * 文件不存在时为空数组 —— 看板上盲区格仍显示 scope_hint 口径的 blindSpots。
   */
  blindspotClusters: BlindspotCluster[];
}

interface RoundRow {
  channel: string;
  fallbackReason: string | null;
  vectorSpace: string;
  vectorSpaceReason: string | null;
  elapsedMs: number;
}

function windowClause(alias: string): string {
  return `(? IS NULL OR ${alias}.created_at >= ?)`;
}

function tally<T extends string>(rows: Array<T | null>): Array<{ reason: T; rounds: number }> {
  const counts = new Map<T, number>();
  for (const r of rows) {
    if (r == null) continue;
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, rounds]) => ({ reason, rounds }))
    .sort((a, b) => b.rounds - a.rounds);
}

/** 最近邻分位,与 latency.ts 同口径(不插值)。 */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

export function channelMix(db: NovaDb, since: string | null): ChannelMix {
  const rows = queryAll<RoundRow>(
    db,
    `SELECT channel, fallback_reason AS fallbackReason, vector_space AS vectorSpace,
            vector_space_reason AS vectorSpaceReason, elapsed_ms AS elapsedMs
     FROM retrieval_logs r WHERE ${windowClause("r")}`,
    since,
    since,
  );
  const rounds = rows.length;
  const fallback = rows.filter((r) => r.channel === "fallback").length;
  const short = rows.filter((r) => r.fallbackReason === "short-query").length;
  return {
    rounds,
    fts: rounds - fallback,
    fallback,
    fallbackReasons: tally(
      rows.map((r) => r.fallbackReason as Exclude<FallbackReason, null> | null),
    ),
    shortQueryRate: rounds === 0 ? null : short / rounds,
  };
}

export function vectorSpaceMix(db: NovaDb, since: string | null): VectorSpaceMix {
  const rows = queryAll<{ vectorSpace: string; vectorSpaceReason: string | null }>(
    db,
    `SELECT vector_space AS vectorSpace, vector_space_reason AS vectorSpaceReason
     FROM retrieval_logs r WHERE ${windowClause("r")}`,
    since,
    since,
  );
  const rounds = rows.length;
  const semantic = rows.filter((r) => r.vectorSpace === "semantic").length;
  return {
    rounds,
    semantic,
    hash: rounds - semantic,
    semanticRate: rounds === 0 ? null : semantic / rounds,
    reasons: tally(
      rows.map((r) => r.vectorSpaceReason as Exclude<VectorSpaceReason, null> | null),
    ),
  };
}

/**
 * 单篇知识健康度。
 *
 * 用 LEFT JOIN + json_each 展开 hit_doc_ids —— 左连接不可省:从没被命中过的
 * 文档正是这个指标最要看的那一类,内连接会把它们悄悄丢掉,于是看板上「每篇
 * 知识都健康」。(json_each 已实测在 node:sqlite 的内置 SQLite 里可用。)
 */
export function documentHealth(db: NovaDb, since: string | null): DocHealth[] {
  return queryAll<DocHealth>(
    db,
    `SELECT d.id AS documentId, d.title, d.source,
            COUNT(h.value) AS hitRounds,
            MAX(r.created_at) AS lastHitAt
     FROM documents d
     LEFT JOIN retrieval_logs r ON ${windowClause("r")}
     LEFT JOIN json_each(r.hit_doc_ids) h ON h.value = d.id
     GROUP BY d.id, d.title, d.source
     ORDER BY hitRounds ASC, d.id ASC`,
    since,
    since,
  ).map((r) => ({ ...r, lastHitAt: r.hitRounds === 0 ? null : r.lastHitAt }));
}

/**
 * 知识盲区。
 *
 * 「末轮」= 该 trace 里 round 最大的那一行。只看末轮:前几轮检索不到是设计
 * 意图(所以才会加深),末轮还是零核验才叫盲区。
 */
export function blindSpots(db: NovaDb, since: string | null): BlindSpot[] {
  const rows = queryAll<{ topic: string; sessions: number; sampleQuery: string; lastAt: string }>(
    db,
    `WITH last_round AS (
       SELECT r.*,
              CASE WHEN r.scope_hint = '' THEN '(无提示)' ELSE r.scope_hint END AS topic
       FROM retrieval_logs r
       WHERE ${windowClause("r")}
         AND r.round = (SELECT MAX(r2.round) FROM retrieval_logs r2 WHERE r2.trace_id = r.trace_id)
         -- verified IS NULL 在这里被过滤掉:那是「流程没走到 review」,不是盲区。
         AND r.verified = 0
     )
     SELECT topic,
            COUNT(*) AS sessions,
            (SELECT l2.query FROM last_round l2
              WHERE l2.topic = last_round.topic
              ORDER BY l2.created_at DESC LIMIT 1) AS sampleQuery,
            MAX(created_at) AS lastAt
     FROM last_round
     GROUP BY topic
     ORDER BY sessions DESC, topic ASC`,
    since,
    since,
  );
  return rows;
}

/**
 * 检索侧看板。
 *
 * 每格独立 try/catch,与 guardrail-board 同策略:老库缺 retrieval_logs 表时
 * 运营页要能打开,缺的那格显示口径缺格而不是整页 500。
 */
export function retrievalBoard(db: NovaDb, sinceIso?: string): RetrievalBoard {
  const since = sinceIso ?? null;
  const safe = <T>(label: string, fn: () => T, fallbackValue: T): T => {
    try {
      return fn();
    } catch (err) {
      console.error(`[telemetry] 口径缺格 retrieval:${label}`, err);
      return fallbackValue;
    }
  };

  const channels = safe("channels", () => channelMix(db, since), {
    rounds: 0,
    fts: 0,
    fallback: 0,
    fallbackReasons: [],
    shortQueryRate: null,
  });
  const health = safe("documentHealth", () => documentHealth(db, since), []);
  const sop = health.filter((h) => h.source === "SOP");
  const covered = sop.filter((h) => h.hitRounds > 0).length;
  const elapsedValues = safe(
    "elapsed",
    () =>
      queryAll<{ elapsedMs: number }>(
        db,
        `SELECT elapsed_ms AS elapsedMs FROM retrieval_logs r WHERE ${windowClause("r")}`,
        since,
        since,
      ).map((r) => r.elapsedMs),
    [],
  );
  const sorted = elapsedValues.slice().sort((a, b) => a - b);

  return {
    channels,
    vectorSpaces: safe("vectorSpaces", () => vectorSpaceMix(db, since), {
      rounds: 0,
      semantic: 0,
      hash: 0,
      semanticRate: null,
      reasons: [],
    }),
    elapsed: {
      rounds: sorted.length,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      max: sorted.length === 0 ? null : sorted[sorted.length - 1]!,
    },
    sopCoverage: {
      total: sop.length,
      covered,
      rate: sop.length === 0 ? null : covered / sop.length,
    },
    neverHit: health.filter((h) => h.hitRounds === 0),
    blindSpots: safe("blindSpots", () => blindSpots(db, since), []),
    blindspotClusters: loadBlindspotClusters(),
  };
}

/** 从 data/blindspot-report.json 读取语义聚类结果（文件不存在时返回 []）。 */
function loadBlindspotClusters(): BlindspotCluster[] {
  try {
    const reportPath = resolve(process.cwd(), "data", "blindspot-report.json");
    if (!existsSync(reportPath)) return [];
    const raw = JSON.parse(readFileSync(reportPath, "utf-8")) as {
      clusters?: BlindspotCluster[];
    };
    return raw.clusters ?? [];
  } catch {
    return [];
  }
}

/**
 * P2 告警(指标体系第 11 节)。
 *
 * P2 是「一周内处理」级别 —— 不阻断发布,但必须有人认领。阈值都取自第 11 节;
 * **样本不足时一律不报**:小样本上的 100% 回退率是统计噪声,报出来只会训练
 * 运营忽略 P2 告警,那比没有告警更贵。
 */
export const P2_THRESHOLDS = {
  /** 短查询回退触发率超过它 → 检索召回结构性变差(trigram 最短长度打不住)。 */
  shortQueryFallback: 0.3,
  /** SOP 覆盖率低于它 → 知识库里大半篇目从没被取回过,要么冗余要么检索偏窄。 */
  sopCoverage: 0.5,
  /** 触发告警所需的最小轮次样本量。 */
  minRounds: 20,
} as const;

export function p2Breaches(board: RetrievalBoard): string[] {
  const out: string[] = [];
  const { channels, sopCoverage, blindSpots: spots } = board;
  if (channels.rounds >= P2_THRESHOLDS.minRounds && channels.shortQueryRate != null) {
    if (channels.shortQueryRate > P2_THRESHOLDS.shortQueryFallback) {
      out.push(
        `短查询回退触发率 ${(channels.shortQueryRate * 100).toFixed(1)}% 超过 ${
          P2_THRESHOLDS.shortQueryFallback * 100
        }%`,
      );
    }
  }
  if (
    channels.rounds >= P2_THRESHOLDS.minRounds &&
    sopCoverage.rate != null &&
    sopCoverage.rate < P2_THRESHOLDS.sopCoverage
  ) {
    out.push(
      `SOP 覆盖率 ${(sopCoverage.rate * 100).toFixed(1)}% 低于 ${
        P2_THRESHOLDS.sopCoverage * 100
      }%(${sopCoverage.total - sopCoverage.covered} 篇从未被检索命中)`,
    );
  }
  if (spots.length > 0) {
    out.push(`知识盲区 ${spots.length} 个主题:${spots.map((s) => s.topic).join("、")}`);
  }
  return out;
}
