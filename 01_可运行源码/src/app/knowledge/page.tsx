import { KnowledgeEvolution } from "@/components/knowledge-evolution";
import { createCandidateKnowledge } from "@/domain/consultation-journey";

export default function KnowledgePage() {
  const candidate = createCandidateKnowledge({
    sourceCaseId: "CASE-2407",
    expertModification: "DV200 30–40% 时先进行两份代表样本试建库。",
    evidenceIds: ["E-SOP-042", "E-PMID-35361992"],
  });

  return <KnowledgeEvolution initial={candidate} />;
}
