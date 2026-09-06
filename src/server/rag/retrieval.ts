/**
 * Hybrid retrieval engine (OpenSearch replacement).
 *
 * Pipeline: FTS5 candidate generation  →  BM25 lexical score  +  dense-vector
 * cosine  →  fused score  →  cross-encoder-style rerank (term-overlap +
 * applicability boost).
 *
 * 稠密通道有两个向量空间:B2 的真实语义向量(bge-small-zh-v1.5,512 维,见
 * `semantic.ts`)和确定性哈希向量(256 维,见 `text.ts`)。模型可用时走前者,
 * 缺失时整体降级到后者 —— 两者绝不混算(维度和量纲都不同)。
 *
 * Everything runs locally over the SQLite `documents`/`chunks` tables so the
 * "evidence-bound" guarantee is real: every retrieved passage carries its
 * source document's citation, version, applicability and validity.
 */
import { queryAll, type NovaDb } from "../db/client";
import { tokenize, embed, cosine } from "./text";
import { embedSemantic } from "./semantic";
import { SEED_DOCS } from "./seed-knowledge";
import { recordDegradeTrigger } from "../telemetry/degrade-matrix";

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  text: string;
  source: "SOP" | "SCI";
  title: string;
  citation: string;
  version: string;
  appliesTo: string;
  validUntil: string;
  validation: string;
  bm25: number;
  vector: number;
  fused: number;
  rerank: number;
}

export interface IndexableDocument {
  id: string;
  source: string;
  title: string;
  citation: string;
  version: string;
  appliesTo: string;
  validUntil: string;
  lang: string;
  validation: string;
  passages: string[];
}

/**
 * Index a single document + its passages into the DB (upsert).
 *
 * 同步版本:只写确定性哈希向量,`embedding_semantic` 留空。需要语义向量的
 * 入库走 `indexDocumentSemantic()`(异步,要跑模型推理)。保留同步入口是因为
 * 全部既有调用方(种子库、测试、图谱构建)都在同步上下文里,而语义向量对
 * 「入库成功」不是必需的 —— 缺了只是检索降级。
 */
export function indexDocument(
  db: NovaDb,
  doc: IndexableDocument,
  /** 与 `doc.passages` 一一对应的语义向量;缺省或元素为 null 时该列写 NULL。 */
  semanticVectors?: ReadonlyArray<number[] | null>,
): number {
  db.prepare(
    `INSERT INTO documents(id, source, title, citation, version, applies_to, valid_until, lang, validation)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       source = excluded.source, title = excluded.title, citation = excluded.citation,
       version = excluded.version, applies_to = excluded.applies_to,
       valid_until = excluded.valid_until, lang = excluded.lang, validation = excluded.validation`,
  ).run(
    doc.id, doc.source, doc.title, doc.citation, doc.version,
    doc.appliesTo, doc.validUntil, doc.lang, doc.validation,
  );
  // Replace this document's chunks so re-indexing is idempotent.
  db.prepare("DELETE FROM chunks WHERE document_id = ?").run(doc.id);
  const insChunk = db.prepare(
    `INSERT INTO chunks(id, document_id, ordinal, text, tokens, embedding, embedding_semantic)
     VALUES(?, ?, ?, ?, ?, ?, ?)`,
  );
  doc.passages.forEach((text, i) => {
    const semantic = semanticVectors?.[i];
    insChunk.run(
      `${doc.id}#${i}`, doc.id, i, text,
      JSON.stringify(tokenize(text)), JSON.stringify(embed(text)),
      semantic ? JSON.stringify(semantic) : null,
    );
  });
  return doc.passages.length;
}

/**
 * 入库并写入真实语义向量。模型不可用时 `embedSemantic` 返回 null,该列留空,
 * 入库照样成功 —— 这正是方案 5.2 要求的「优雅降级,检索链路不中断」。
 */
export async function indexDocumentSemantic(db: NovaDb, doc: IndexableDocument): Promise<number> {
  const vectors = await Promise.all(doc.passages.map((p) => embedSemantic(p)));
  return indexDocument(db, doc, vectors);
}

/**
 * Remove a document and all its chunks from the index. Backs the
 * governed-knowledge one-click rollback: the candidate's production index
 * entry must disappear the moment it stops being production knowledge.
 */
export function removeDocument(db: NovaDb, id: string): boolean {
  db.prepare("DELETE FROM chunks WHERE document_id = ?").run(id);
  const result = db.prepare("DELETE FROM documents WHERE id = ?").run(id);
  return result.changes > 0;
}

/** Index the seed corpus into the DB. Idempotent (clears + reloads). */
export function seedKnowledgeBase(db: NovaDb): number {
  db.exec("DELETE FROM chunks; DELETE FROM documents;");
  let count = 0;
  for (const doc of SEED_DOCS) count += indexDocument(db, doc);
  return count;
}

/**
 * 种子库入库 + 语义向量。应用启动路径用这个;测试里多数用同步版本(不需要
 * 每个用例都付 24MB 模型的加载与推理成本)。
 */
export async function seedKnowledgeBaseSemantic(db: NovaDb): Promise<number> {
  db.exec("DELETE FROM chunks; DELETE FROM documents;");
  let count = 0;
  for (const doc of SEED_DOCS) count += await indexDocumentSemantic(db, doc);
  return count;
}

/**
 * 给已入库但缺 `embedding_semantic` 的 chunk 补算语义向量(B2-2 回填)。
 * 幂等,可反复跑;模型不可用时返回 0 并且不改动任何行。
 */
export async function backfillSemanticVectors(
  db: NovaDb,
  opts: { batch?: number } = {},
): Promise<{ scanned: number; written: number }> {
  const rows = queryAll<{ id: string; text: string }>(
    db,
    "SELECT id, text FROM chunks WHERE embedding_semantic IS NULL ORDER BY id" +
      (opts.batch ? ` LIMIT ${Number(opts.batch)}` : ""),
  );
  const upd = db.prepare("UPDATE chunks SET embedding_semantic = ? WHERE id = ?");
  let written = 0;
  for (const row of rows) {
    const vec = await embedSemantic(row.text);
    if (!vec) break; // 模型不可用 —— 继续跑只是白烧 CPU
    upd.run(JSON.stringify(vec), row.id);
    written++;
  }
  return { scanned: rows.length, written };
}

export function chunkCount(db: NovaDb): number {
  return queryAll<{ n: number }>(db, "SELECT COUNT(*) AS n FROM chunks")[0]!.n;
}

interface ChunkRow {
  chunkId: string;
  documentId: string;
  text: string;
  tokens: string;
  embedding: string;
  embeddingSemantic: string | null;
  source: string;
  title: string;
  citation: string;
  version: string;
  appliesTo: string;
  validUntil: string;
  validation: string;
}

// ── 候选生成层 (FTS5) ────────────────────────────────────────────

/** trigram 分词器的最短可索引长度。低于此长度的词元查不到任何东西。 */
const TRIGRAM_MIN = 3;
/** 候选数低于此值就放弃预筛、改走全量扫描,避免预筛把召回面切得过窄。 */
const MIN_CANDIDATES = 20;
/** 单次 FTS 预筛的取回上限。 */
const FTS_LIMIT = 50;
/** 单个查询最多取多少个词元进 MATCH,防止超长输入构造出病态查询。 */
const MAX_FTS_TERMS = 32;

const SELECT_CHUNK_COLS = `c.id AS chunkId, c.document_id AS documentId, c.text, c.tokens, c.embedding,
            c.embedding_semantic AS embeddingSemantic,
            d.source, d.title, d.citation, d.version,
            d.applies_to AS appliesTo, d.valid_until AS validUntil, d.validation`;

/**
 * 把任意用户输入转成安全的 FTS5 MATCH 表达式。
 *
 * 两件事:
 *  1. **只保留字母/数字/汉字连续段**,其余字符(引号、星号、冒号、括号、连字符…)
 *     全部丢弃 —— 它们在 FTS5 查询语法里有特殊含义,原样拼进 MATCH 会抛
 *     "fts5: syntax error"，把一次正常检索变成 500。
 *  2. **每个词元用双引号包起来**,这样 `NEAR` / `AND` / `OR` / `NOT` 这些 FTS5
 *     关键字被当成普通字符串而不是运算符,用户问「AND 门控怎么设」不会炸。
 *
 * 词元间用 OR 连接:这一层的目标是**召回**,交集留给后面的融合打分去做。
 * 短于 trigram 最短长度的词元(如「建库」「PE」)在 trigram 索引里查不到,
 * 直接丢弃;若全部词元都过短则返回空串,调用方据此走全量回退。
 */
export function sanitizeFtsQuery(query: string): string {
  const runs = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const run of runs) {
    const term = run.toLowerCase();
    if (term.length < TRIGRAM_MIN) continue;
    if (seen.has(term)) continue;
    seen.add(term);
    // 词元里已不可能含双引号(上面的字符类排除了),doubling 仅作纵深防御。
    terms.push(`"${term.replace(/"/g, '""')}"`);
    if (terms.length >= MAX_FTS_TERMS) break;
  }
  return terms.join(" OR ");
}

/** 本次检索走了哪条通道 —— 服务量化指标里的「短查询回退触发率」与 P95 耗时。 */
export type RetrievalChannel = "fts" | "fallback";
export type FallbackReason =
  | "disabled"
  | "short-query"
  | "insufficient-candidates"
  | "fts-error"
  | null;

/**
 * 稠密通道实际用的向量空间。
 * `semantic` = bge-small-zh-v1.5 真实语义向量;`hash` = 确定性哈希向量。
 */
export type VectorSpace = "semantic" | "hash";
export type VectorSpaceReason =
  /** 模型不可用 / 被 NP_DISABLE_SEMANTIC 关掉 —— 查询侧就没有语义向量。 */
  | "no-query-vector"
  /** 有候选 chunk 还没回填语义向量,混算会得到无意义的相似度,整体退回哈希。 */
  | "candidates-not-backfilled"
  | null;

export interface RetrievalDiagnostics {
  channel: RetrievalChannel;
  /** channel === "fts" 时为 null。 */
  fallbackReason: FallbackReason;
  /** 进入打分环节的候选数。 */
  candidateCount: number;
  vectorSpace: VectorSpace;
  /** vectorSpace === "semantic" 时为 null。 */
  vectorSpaceReason: VectorSpaceReason;
  elapsedMs: number;
}

/** 逃生开关:FTS 预筛出问题时用 `NP_DISABLE_FTS=1` 立刻切回全量路径。 */
function ftsDisabled(): boolean {
  return process.env.NP_DISABLE_FTS === "1";
}

function fullScan(db: NovaDb): ChunkRow[] {
  return queryAll<ChunkRow>(
    db,
    `SELECT ${SELECT_CHUNK_COLS}
     FROM chunks c JOIN documents d ON d.id = c.document_id`,
  );
}

/**
 * FTS5 预筛。返回 null 表示这条查询不适用预筛(被禁用 / 词元全过短 / FTS 报错),
 * 调用方应走全量回退。
 */
function ftsCandidates(
  db: NovaDb,
  query: string,
): { rows: ChunkRow[]; reason: FallbackReason } {
  if (ftsDisabled()) {
    try {
      recordDegradeTrigger(db, {
        gateKey: "fts-disabled",
        label: "FTS 逃生开关已打开",
        source: "runtime",
        deduped: false,
        now: new Date().toISOString(),
      });
    } catch {}
    return { rows: [], reason: "disabled" };
  }
  const match = sanitizeFtsQuery(query);
  if (!match) return { rows: [], reason: "short-query" };
  try {
    const rows = queryAll<ChunkRow>(
      db,
      `SELECT ${SELECT_CHUNK_COLS}
       FROM chunks_fts f
       JOIN chunks c ON c.id = f.chunk_id
       JOIN documents d ON d.id = c.document_id
       WHERE chunks_fts MATCH ?
       ORDER BY rank
       LIMIT ${FTS_LIMIT}`,
      match,
    );
    return { rows, reason: null };
  } catch {
    // sanitizeFtsQuery 之后仍然报错属于意外(例如老库缺 chunks_fts 表)。
    // 检索链路不能因此中断 —— 静默降级到全量扫描。
    return { rows: [], reason: "fts-error" };
  }
}

/**
 * Hybrid search. Returns top-k reranked chunks.
 * @param appliesToHint optional applicability string (e.g. "FFPE RNA") that
 *        boosts chunks whose document applies to the current sample.
 *
 * 同步入口 —— 稠密通道用确定性哈希向量,除非调用方通过
 * `opts.semanticQueryVector` 把语义向量传进来。要真实语义检索请用
 * `searchSemantic()`(异步,内部会算查询侧向量)。
 */
export function search(
  db: NovaDb,
  query: string,
  opts: SearchOptions = {},
): RetrievedChunk[] {
  return searchWithDiagnostics(db, query, opts).hits;
}

export interface SearchOptions {
  topK?: number;
  appliesToHint?: string;
  /**
   * 查询侧的语义向量。传了并且候选全部已回填时,稠密通道走语义空间;
   * 否则整体退回哈希空间(两个空间维度不同,混算无意义)。
   */
  semanticQueryVector?: number[] | null;
}

/**
 * 真实语义检索。先算查询侧的语义向量(模型不可用时为 null),再走同一条同步
 * 打分链路。这是应用运行时应该调的入口。
 */
export async function searchSemantic(
  db: NovaDb,
  query: string,
  opts: Omit<SearchOptions, "semanticQueryVector"> = {},
): Promise<{ hits: RetrievedChunk[]; diagnostics: RetrievalDiagnostics }> {
  const semanticQueryVector = await embedSemantic(query);
  return searchWithDiagnostics(db, query, { ...opts, semanticQueryVector });
}

/**
 * 与 `search()` 同一条链路,额外返回通道诊断信息。
 *
 * 两段式:FTS5 生成候选 → 候选不足则回退全量。之后的 BM25 + 向量融合 + rerank
 * 完全不变,证据绑定打分体系零回归。
 *
 * 注意:BM25 的 idf 统计量在预筛生效时是按**候选集**而非全库算的 —— 这是两段式
 * 检索的固有取舍(要按全库算就得把全库 tokens 读出来,预筛就白做了)。候选集
 * 小于 MIN_CANDIDATES 时会回退全量,所以小型知识库上打分与改造前逐位一致。
 */
export function searchWithDiagnostics(
  db: NovaDb,
  query: string,
  opts: SearchOptions = {},
): { hits: RetrievedChunk[]; diagnostics: RetrievalDiagnostics } {
  const topK = opts.topK ?? 5;
  const startedAt = performance.now();

  const fts = ftsCandidates(db, query);
  let rows = fts.rows;
  let channel: RetrievalChannel = "fts";
  let fallbackReason: FallbackReason = fts.reason;
  if (rows.length < MIN_CANDIDATES) {
    if (fallbackReason === null) fallbackReason = "insufficient-candidates";
    rows = fullScan(db);
    channel = "fallback";
  } else {
    fallbackReason = null;
  }

  // ── 稠密通道的空间裁决 ──
  // 全有或全无:只要有一个候选没回填语义向量,整批就退回哈希空间。给缺失的
  // 候选补 0 会凭空压低它们的分,按维度分别归一化又会把两个不可比的量纲混进
  // 同一个排序 —— 都是静默的排序污染。宁可整体降级,行为可解释、可回滚。
  const semanticQ = opts.semanticQueryVector ?? null;
  let vectorSpace: VectorSpace = "hash";
  let vectorSpaceReason: VectorSpaceReason = "no-query-vector";
  if (semanticQ) {
    if (rows.every((r) => r.embeddingSemantic !== null)) {
      vectorSpace = "semantic";
      vectorSpaceReason = null;
    } else {
      vectorSpaceReason = "candidates-not-backfilled";
      try {
        recordDegradeTrigger(db, {
          gateKey: "semantic-hash-fallback",
          label: "语义向量未回填，降级至哈希空间",
          source: "runtime",
          deduped: false,
          now: new Date().toISOString(),
        });
      } catch {}
    }
  }

  const diagnostics = (): RetrievalDiagnostics => ({
    channel,
    fallbackReason: channel === "fts" ? null : fallbackReason,
    candidateCount: rows.length,
    vectorSpace,
    vectorSpaceReason,
    elapsedMs: performance.now() - startedAt,
  });

  if (rows.length === 0) return { hits: [], diagnostics: diagnostics() };

  const qTerms = tokenize(query);
  const qSet = new Set(qTerms);
  const qVec = vectorSpace === "semantic" ? semanticQ! : embed(query);

  // ── BM25 corpus statistics ──
  const N = rows.length;
  const docTerms = rows.map((r) => JSON.parse(r.tokens) as string[]);
  const avgLen = docTerms.reduce((s, t) => s + t.length, 0) / N;
  const df = new Map<string, number>();
  for (const terms of docTerms) {
    for (const t of new Set(terms)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const k1 = 1.5;
  const b = 0.75;

  const scored = rows.map((r, i) => {
    const terms = docTerms[i];
    const len = terms.length || 1;
    const tf = new Map<string, number>();
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);

    // BM25
    let bm25 = 0;
    for (const qt of qSet) {
      const f = tf.get(qt);
      if (!f) continue;
      const n = df.get(qt) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      bm25 += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (len / avgLen))));
    }

    // dense vector cosine（空间由上面的裁决统一决定，两侧维度必然一致）
    const vector = cosine(
      qVec,
      JSON.parse(vectorSpace === "semantic" ? r.embeddingSemantic! : r.embedding) as number[],
    );

    return { r, terms, bm25, vector };
  });

  // normalize each channel to [0,1] before fusing
  const maxBm = Math.max(1e-9, ...scored.map((s) => s.bm25));
  const maxVec = Math.max(1e-9, ...scored.map((s) => s.vector));

  const fused: RetrievedChunk[] = scored.map((s) => {
    const bm = s.bm25 / maxBm;
    const vec = s.vector / maxVec;
    const fusedScore = 0.6 * bm + 0.4 * vec; // lexical-leaning fusion

    // rerank: exact term overlap + applicability boost + freshness/validity
    const overlap =
      s.terms.filter((t) => qSet.has(t)).length / (qSet.size || 1);
    const applies =
      opts.appliesToHint &&
      s.r.appliesTo.toLowerCase().includes(opts.appliesToHint.toLowerCase())
        ? 0.15
        : 0;
    const validityPenalty = s.r.validation === "verified" ? 0 : -0.2;
    const rerank = 0.7 * fusedScore + 0.3 * overlap + applies + validityPenalty;

    return {
      chunkId: s.r.chunkId,
      documentId: s.r.documentId,
      text: s.r.text,
      source: s.r.source as "SOP" | "SCI",
      title: s.r.title,
      citation: s.r.citation,
      version: s.r.version,
      appliesTo: s.r.appliesTo,
      validUntil: s.r.validUntil,
      validation: s.r.validation,
      bm25: bm,
      vector: vec,
      fused: fusedScore,
      rerank,
    };
  });

  return {
    hits: fused.sort((a, b) => b.rerank - a.rerank).slice(0, topK),
    diagnostics: diagnostics(),
  };
}
