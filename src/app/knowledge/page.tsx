import { KnowledgeEvolution } from "@/components/knowledge-evolution";
import { createCandidateKnowledge } from "@/domain/consultation-journey";
import { getDb } from "@/server/db/client";
import { getLatestBenchReport, listCandidates, saveCandidate } from "@/server/db/repositories";

// Node runtime (node:sqlite) + fresh read so a candidate promoted by an expert
// (or advanced through the gates here) reflects its real persisted status.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function KnowledgePage() {
  const db = getDb();
  let candidates = listCandidates(db);
  if (candidates.length === 0) {
    // No expert-generated candidate yet — persist the demo candidate so the
    // page always shows a real, promotable row (offline-safe, pure SQLite).
    const seed = createCandidateKnowledge({
      sourceCaseId: "CASE-2407",
      expertModification: "DV200 30–40% 时先进行两份代表样本试建库。",
      evidenceIds: ["E-SOP-042", "E-PMID-35361992"],
    });
    saveCandidate(db, seed, new Date().toISOString());
    candidates = [seed];
  }
  // 传入全部候选:专家多次修订会生成多个候选,页面内可直接切换。
  // 最近一次 NovaBench 报告随 run 落库:刷新后「候选影响面」仍可恢复切片。
  const initialBench = getLatestBenchReport(db);
  return <KnowledgeEvolution initial={candidates[0]} all={candidates} initialBench={initialBench} />;
}
