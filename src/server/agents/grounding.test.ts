import { describe, it, expect } from "vitest";
import { createDb } from "../db/client";
import { seedKnowledgeBase, search } from "../rag/retrieval";
import {
  deriveScopeHint,
  broadenHint,
  verifyGrounding,
  runActor,
  runCritic,
} from "./actor-critic";

const OFF = { provider: "off" as const };
const NOW = "2026-08-12T00:00:00.000Z";
const Q = "24份FFPE肿瘤样本如何开展RNA差异表达研究";

describe("grounding loop · building blocks", () => {
  describe("deriveScopeHint", () => {
    it("builds 'FFPE RNA' from FFPE material", () => {
      expect(deriveScopeHint("standard", { material: "FFPE" })).toBe("FFPE RNA");
      expect(deriveScopeHint("standard", { material: "FFPE RNA" })).toBe("FFPE RNA");
    });
    it("falls back to the domain modality when material is unknown", () => {
      expect(deriveScopeHint("standard", {})).toBe("RNA");
    });
    it("uses the leading token of a non-FFPE material", () => {
      expect(deriveScopeHint("non-standard", { material: "plasma cfDNA" })).toBe("plasma RNA");
    });
  });

  describe("broadenHint", () => {
    it("relaxes the hint each round, then drops it entirely", () => {
      expect(broadenHint("FFPE RNA", 0)).toBe("FFPE RNA");
      expect(broadenHint("FFPE RNA", 1)).toBe("RNA");
      expect(broadenHint("FFPE RNA", 2)).toBeUndefined();
      expect(broadenHint("FFPE RNA", 3)).toBeUndefined();
    });
    it("a single-token hint drops after round 0", () => {
      expect(broadenHint("RNA", 0)).toBe("RNA");
      expect(broadenHint("RNA", 1)).toBeUndefined();
    });
  });

  describe("verifyGrounding (offline)", () => {
    it("is a no-op with no model: keeps every recommendation and drops none", async () => {
      const db = createDb(":memory:");
      seedKnowledgeBase(db);
      const chunks = search(db, Q, { appliesToHint: "FFPE RNA", topK: 5 });
      const actor = await runActor(
        { question: Q, locale: "zh", chunks, appliesToHint: "FFPE RNA" },
        OFF,
      );
      const critic = runCritic({
        recommendations: actor.recommendations,
        chunks,
        appliesToHint: "FFPE RNA",
        now: NOW,
      });
      expect(critic.verified.length).toBeGreaterThan(0);

      const grounding = await verifyGrounding(
        { recommendations: critic.verified, chunks, question: Q, locale: "zh" },
        OFF,
      );
      expect(grounding.provider).toBe("skipped");
      expect(grounding.dropped).toHaveLength(0);
      expect(grounding.verified.map((r) => r.id)).toEqual(critic.verified.map((r) => r.id));
    });

    it("returns an empty, skipped result when there is nothing to check", async () => {
      const grounding = await verifyGrounding(
        { recommendations: [], chunks: [], question: Q, locale: "zh" },
        OFF,
      );
      expect(grounding.provider).toBe("skipped");
      expect(grounding.verified).toHaveLength(0);
      expect(grounding.dropped).toHaveLength(0);
    });
  });
});
