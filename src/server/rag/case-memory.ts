/**
 * Resolved-case memory + similar-case retrieval.
 *
 * A grounded consultation is written back as a compact memory so a later, similar
 * consultation can retrieve it as precedent. This is subject to one hard
 * constraint: NovaPilot's answers must stay *evidence-bound*. So a retrieved past
 * case is fed to the Actor as **context only** — it can shape the prose and
 * surface precedent, but it is never a citation. Citations remain the exclusive
 * province of verified SOP/SCI chunks (see the Critic).
 *
 * Retrieval is the same offline-deterministic hybrid the KB uses: BM25 lexical
 * score fused with dense-vector cosine over the local `case_memory` table.
 */
import { queryAll, type NovaDb } from "../db/client";
import { tokenize, embed, cosine } from "./text";
import type { ProjectFacts, Scenario } from "@/domain/consultation-journey";

export interface SimilarCase {
  projectId: string;
  question: string;
  scenario: string;
  factsDigest: string;
  status: string;
  outcome: string;
  score: number;
}

/** Compact one-line digest of the confirmed facts (for the memory + prompt). */
export function factsDigest(facts: ProjectFacts): string {
  const parts: string[] = [];
  if (facts.material) parts.push(`材料 ${facts.material}`);
  if (facts.sampleCount != null) parts.push(`样本 ${facts.sampleCount}`);
  if (facts.dv200 != null) parts.push(`DV200 ${facts.dv200}`);
  if (facts.rnaInputNg != null) parts.push(`RNA ${facts.rnaInputNg}ng`);
  return parts.join(" · ") || "(无量化事实)";
}

/**
 * Persist a resolved consultation as a retrievable memory (upsert by project).
 * The retrieval surface is `question + facts digest + outcome`, so a future
 * consultation with a similar sample/goal can recall it.
 */
export function recordCaseMemory(
  db: NovaDb,
  m: {
    projectId: string;
    tenantId: string;
    question: string;
    scenario: Scenario;
    facts: ProjectFacts;
    status: string;
    outcome: string;
    now: string;
  },
): void {
  const surface = `${m.question} ${factsDigest(m.facts)} ${m.outcome}`;
  db.prepare(
    `INSERT INTO case_memory(id, project_id, tenant_id, question, scenario, facts_digest, status, outcome, tokens, embedding, created_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       question = excluded.question, scenario = excluded.scenario,
       facts_digest = excluded.facts_digest, status = excluded.status,
       outcome = excluded.outcome, tokens = excluded.tokens,
       embedding = excluded.embedding, created_at = excluded.created_at`,
  ).run(
    m.projectId,
    m.projectId,
    m.tenantId,
    m.question,
    m.scenario,
    factsDigest(m.facts),
    m.status,
    m.outcome,
    JSON.stringify(tokenize(surface)),
    JSON.stringify(embed(surface)),
    m.now,
  );
}

interface CaseRow {
  projectId: string;
  question: string;
  scenario: string;
  factsDigest: string;
  status: string;
  outcome: string;
  tokens: string;
  embedding: string;
}

/**
 * Retrieve the most similar resolved cases (hybrid BM25 + cosine). Excludes the
 * current project so a re-run of the same consultation never "recalls itself".
 * Returns [] when the memory is empty (the common case in tests / eval), so the
 * whole layer is a safe no-op there.
 */
export function searchSimilarCases(
  db: NovaDb,
  input: {
    tenantId: string;
    question: string;
    facts: ProjectFacts;
    excludeProjectId?: string;
    topK?: number;
    minScore?: number;
  },
): SimilarCase[] {
  const topK = input.topK ?? 3;
  const minScore = input.minScore ?? 0.12;
  const rows = queryAll<CaseRow>(
    db,
    `SELECT project_id AS projectId, question, scenario, facts_digest AS factsDigest,
            status, outcome, tokens, embedding
     FROM case_memory
     WHERE tenant_id = ? AND status IN ('formal', 'provisional')`,
    input.tenantId,
  ).filter((r) => r.projectId !== input.excludeProjectId);
  if (rows.length === 0) return [];

  const query = `${input.question} ${factsDigest(input.facts)}`;
  const qTerms = tokenize(query);
  const qSet = new Set(qTerms);
  const qVec = embed(query);

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
    const terms = docTerms[i]!;
    const len = terms.length || 1;
    const tf = new Map<string, number>();
    for (const t of terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    let bm25 = 0;
    for (const qt of qSet) {
      const f = tf.get(qt);
      if (!f) continue;
      const n = df.get(qt) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      bm25 += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (len / avgLen))));
    }
    const vector = cosine(qVec, JSON.parse(r.embedding) as number[]);
    return { r, bm25, vector };
  });

  const maxBm = Math.max(1e-9, ...scored.map((s) => s.bm25));
  const maxVec = Math.max(1e-9, ...scored.map((s) => s.vector));

  return scored
    .map((s) => ({
      projectId: s.r.projectId,
      question: s.r.question,
      scenario: s.r.scenario,
      factsDigest: s.r.factsDigest,
      status: s.r.status,
      outcome: s.r.outcome,
      score: 0.5 * (s.bm25 / maxBm) + 0.5 * (s.vector / maxVec),
    }))
    .filter((c) => c.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
