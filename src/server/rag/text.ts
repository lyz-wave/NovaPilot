/**
 * Text processing for hybrid retrieval — tokenization + a deterministic local
 * embedding.
 *
 * The proposal specifies OpenSearch (BM25 + dense vectors) with an external
 * embedding model. For a locally-runnable, offline-capable end-to-end we use:
 *   - a CJK-aware tokenizer (Latin words + individual CJK chars & bigrams)
 *   - a deterministic hashed bag-of-terms embedding (no network, reproducible)
 *
 * The embedding is intentionally deterministic so tests are stable and the
 * system works with zero API keys. When `EMBEDDING_PROVIDER` is configured the
 * gateway (Stage 3) can swap in a real model without touching retrieval code.
 */

const STOPWORDS = new Set([
  "the", "a", "an", "of", "for", "and", "or", "to", "in", "on", "is", "are",
  "with", "as", "at", "by", "be", "this", "that", "it", "从", "的", "了", "和",
  "与", "在", "是", "对", "する", "した", "の", "は", "を", "に", "が",
]);

/**
 * Tokenize mixed zh/en/ja text into normalized terms.
 * Latin runs → lowercased words; CJK runs → unigrams + bigrams (cheap n-gram
 * indexing that gives usable recall without a segmentation model).
 */
export function tokenize(text: string): string[] {
  const terms: string[] = [];
  const cleaned = text.toLowerCase();
  // Latin / digit words
  const latin = cleaned.match(/[a-z0-9]+(?:[-_.][a-z0-9]+)*/g) ?? [];
  for (const w of latin) {
    if (!STOPWORDS.has(w) && w.length > 1) terms.push(w);
  }
  // CJK characters → unigrams + bigrams
  const cjk = cleaned.match(/[぀-ヿ㐀-鿿]/g) ?? [];
  for (let i = 0; i < cjk.length; i++) {
    if (!STOPWORDS.has(cjk[i])) terms.push(cjk[i]);
    if (i + 1 < cjk.length) terms.push(cjk[i] + cjk[i + 1]);
  }
  return terms;
}

/**
 * Estimate the number of model tokens in a piece of text — the numerator of the
 * context-usage ring when no provider usage is available (offline / first turn).
 *
 * Heuristic, not a real tokenizer: CJK characters map to ≈1 token each, while
 * Latin/whitespace/punctuation runs map at ≈4 chars/token (the rule of thumb for
 * BPE tokenizers on Latin text). Deliberately NOT `tokenize()` — that drops
 * stopwords and emits bigrams, so its count bears no relation to real tokens.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[぀-ヿ㐀-鿿가-힣]/g) ?? []).length;
  const rest = text.length - cjk;
  return cjk + Math.ceil(rest / 4);
}

export const EMBEDDING_DIM = 256;

/**
 * Deterministic hashed embedding: project term frequencies into a fixed-size
 * L2-normalized vector. Two texts that share terms get high cosine similarity.
 */
export function embed(text: string): number[] {
  const vec = new Float64Array(EMBEDDING_DIM);
  const terms = tokenize(text);
  for (const term of terms) {
    const h = hash(term);
    const idx = h % EMBEDDING_DIM;
    const sign = (h >> 16) & 1 ? 1 : -1; // signed hashing reduces collisions
    vec[idx] += sign;
  }
  // L2 normalize
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  const out = new Array<number>(EMBEDDING_DIM);
  for (let i = 0; i < EMBEDDING_DIM; i++) out[i] = vec[i] / norm;
  return out;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot; // both vectors are already L2-normalized
}

/** FNV-1a 32-bit hash. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
