import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type NovaDb } from "../db/client";
import { tokenize, embed, cosine } from "./text";
import { seedKnowledgeBase, chunkCount, search } from "./retrieval";

describe("Stage 2 · text processing", () => {
  it("tokenizes mixed zh/en and drops stopwords", () => {
    const t = tokenize("FFPE RNA 的 DV200 建库");
    expect(t).toContain("ffpe");
    expect(t).toContain("rna");
    expect(t).toContain("dv200");
    expect(t).toContain("建"); // CJK unigram
    expect(t).toContain("建库"); // CJK bigram
    expect(t).not.toContain("的"); // stopword
  });

  it("embeddings are deterministic and L2-normalized", () => {
    const a = embed("stranded total RNA sequencing");
    const b = embed("stranded total RNA sequencing");
    expect(a).toEqual(b);
    expect(cosine(a, a)).toBeCloseTo(1, 5);
  });

  it("similar text scores higher than unrelated text", () => {
    const q = embed("FFPE RNA library preparation DV200");
    const near = embed("FFPE RNA 建库 DV200 质控");
    const far = embed("unrelated topic about weather and cooking");
    expect(cosine(q, near)).toBeGreaterThan(cosine(q, far));
  });
});

describe("Stage 2 · hybrid retrieval", () => {
  let db: NovaDb;
  beforeEach(() => {
    db = createDb(":memory:");
    seedKnowledgeBase(db);
  });

  it("seeds the knowledge base with retrievable chunks", () => {
    expect(chunkCount(db)).toBeGreaterThan(5);
  });

  it("retrieves the DV200 threshold SOP for a DV200 query", () => {
    const hits = search(db, "DV200 门槛 建库 投入量", { appliesToHint: "FFPE RNA" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].source).toBe("SOP");
    expect(hits[0].text).toMatch(/DV200/);
  });

  it("retrieves platform guidance for a sequencing depth query", () => {
    const hits = search(db, "PE150 50M reads 测序深度 平台");
    const joined = hits.map((h) => h.text).join(" ");
    expect(joined).toMatch(/PE150/);
  });

  it("every retrieved chunk carries citable evidence metadata", () => {
    const hits = search(db, "stranded total RNA degraded FFPE");
    for (const h of hits) {
      expect(h.citation).toBeTruthy();
      expect(h.version).toBeTruthy();
      expect(h.validUntil).toBeTruthy();
      expect(["SOP", "SCI"]).toContain(h.source);
    }
  });

  it("applicability hint boosts matching-scope documents", () => {
    const withHint = search(db, "总 RNA 文库 差异表达", { appliesToHint: "FFPE RNA" });
    // top result should be scoped to FFPE RNA
    expect(withHint[0].appliesTo.toLowerCase()).toContain("ffpe");
  });

  it("cross-lingual: english query retrieves the matching english SCI passage", () => {
    const hits = search(db, "poly(A) selection intact tails degraded material");
    expect(hits[0].citation).toMatch(/PMID|DOI/);
  });
});
