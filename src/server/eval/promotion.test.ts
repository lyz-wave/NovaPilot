import { describe, it, expect } from "vitest";
import { createDb } from "../db/client";
import { seedKnowledgeBase, search } from "../rag/retrieval";
import { createCandidateKnowledge } from "@/domain/consultation-journey";
import { promoteCandidateToKnowledge, candidateDocumentId } from "./promotion";

const NOW = "2026-08-12T00:00:00.000Z";

function candidate() {
  return createCandidateKnowledge({
    sourceCaseId: "CASE-NP-GREY-001",
    expertModification:
      "对于 DV200 处于 30–40% 的 FFPE RNA 样本，可在提高起始投入量并完成一次试建库质控后，进入链特异性总 RNA 文库路线。",
    evidenceIds: ["E-SOP-042#1", "E-PMID-35361992#0"],
  });
}

describe("Stage 6 · governed knowledge promotion", () => {
  it("fully-approved candidate becomes retrievable, citable knowledge", () => {
    const db = createDb(":memory:");
    seedKnowledgeBase(db);

    const before = search(db, "DV200 30 40 FFPE 试建库 链特异性", { topK: 5 });
    expect(before.some((c) => c.citation === "CK-260719-017")).toBe(false);

    const result = promoteCandidateToKnowledge(
      db,
      candidate(),
      {
        ownerApproved: true,
        novaBenchPassed: true,
        grayValidationPassed: true,
        humanApproved: true,
      },
      NOW,
    );

    expect(result.published).toBe(true);
    expect(result.candidate.status).toBe("gray-active");
    expect(result.candidate.productionEligible).toBe(true);
    expect(result.documentId).toBe(candidateDocumentId(result.candidate.id));

    // The promoted statement is now retrievable and carries the candidate id as
    // its citation, so a recommendation can ground on it.
    const after = search(db, "DV200 30 40 FFPE 试建库 链特异性", { topK: 5 });
    const hit = after.find((c) => c.citation === "CK-260719-017");
    expect(hit).toBeDefined();
    expect(hit!.validation).toBe("verified");
  });

  it("does not publish when a promotion gate fails", () => {
    const db = createDb(":memory:");
    seedKnowledgeBase(db);

    const result = promoteCandidateToKnowledge(
      db,
      candidate(),
      {
        ownerApproved: true,
        novaBenchPassed: false, // NovaBench did not pass → not production-eligible
        grayValidationPassed: true,
        humanApproved: true,
      },
      NOW,
    );

    expect(result.published).toBe(false);
    expect(result.candidate.status).toBe("owner-approved");
    expect(result.candidate.productionEligible).toBe(false);
    expect(result.documentId).toBeNull();

    const after = search(db, "DV200 30 40 FFPE 试建库 链特异性", { topK: 5 });
    expect(after.some((c) => c.citation === "CK-260719-017")).toBe(false);
  });

  it("persists the candidate row for audit", () => {
    const db = createDb(":memory:");
    seedKnowledgeBase(db);
    promoteCandidateToKnowledge(
      db,
      candidate(),
      { ownerApproved: true, novaBenchPassed: true, grayValidationPassed: true, humanApproved: true },
      NOW,
    );
    const row = db
      .prepare("SELECT status, production_eligible FROM candidates WHERE id = ?")
      .get("CK-260719-017") as { status: string; production_eligible: number };
    expect(row.status).toBe("gray-active");
    expect(row.production_eligible).toBe(1);
  });
});
