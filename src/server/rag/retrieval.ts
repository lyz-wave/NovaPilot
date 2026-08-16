/**
 * Hybrid retrieval engine (OpenSearch replacement).
 *
 * Pipeline: BM25 lexical score  +  dense-vector cosine  →  fused score  →
 * cross-encoder-style rerank (term-overlap + applicability boost).
 *
 * Everything runs locally over the SQLite `documents`/`chunks` tables so the
 * "evidence-bound" guarantee is real: every retrieved passage carries its
 * source document's citation, version, applicability and validity.
 */
import { queryAll, type NovaDb } from "../db/client";
import { tokenize, embed, cosine } from "./text";
import { SEED_DOCS } from "./seed-knowledge";

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

/** Index a single document + its passages into the DB (upsert). */
export function indexDocument(
  db: NovaDb,
  doc: {
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
  },
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
    `INSERT INTO chunks(id, document_id, ordinal, text, tokens, embedding)
     VALUES(?, ?, ?, ?, ?, ?)`,
  );
  doc.passages.forEach((text, i) => {
    insChunk.run(
      `${doc.id}#${i}`, doc.id, i, text,
      JSON.stringify(tokenize(text)), JSON.stringify(embed(text)),
    );
  });
  return doc.passages.length;
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

export function chunkCount(db: NovaDb): number {
  return queryAll<{ n: number }>(db, "SELECT COUNT(*) AS n FROM chunks")[0]!.n;
}

interface ChunkRow {
  chunkId: string;
  documentId: string;
  text: string;
  tokens: string;
  embedding: string;
  source: string;
  title: string;
  citation: string;
  version: string;
  appliesTo: string;
  validUntil: string;
  validation: string;
}

/**
 * Hybrid search. Returns top-k reranked chunks.
 * @param appliesToHint optional applicability string (e.g. "FFPE RNA") that
 *        boosts chunks whose document applies to the current sample.
 */
export function search(
  db: NovaDb,
  query: string,
  opts: { topK?: number; appliesToHint?: string } = {},
): RetrievedChunk[] {
  const topK = opts.topK ?? 5;
  const rows = queryAll<ChunkRow>(
    db,
    `SELECT c.id AS chunkId, c.document_id AS documentId, c.text, c.tokens, c.embedding,
            d.source, d.title, d.citation, d.version,
            d.applies_to AS appliesTo, d.valid_until AS validUntil, d.validation
     FROM chunks c JOIN documents d ON d.id = c.document_id`,
  );
  if (rows.length === 0) return [];

  const qTerms = tokenize(query);
  const qSet = new Set(qTerms);
  const qVec = embed(query);

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

    // dense vector cosine
    const vector = cosine(qVec, JSON.parse(r.embedding) as number[]);

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

  return fused.sort((a, b) => b.rerank - a.rerank).slice(0, topK);
}
