import { describe, it, expect, vi, afterEach } from "vitest";
import { createDb } from "../db/client";
import { seedKnowledgeBase, search } from "../rag/retrieval";
import { complete } from "./model-gateway";
import { runActor, runCritic, type DraftRecommendation } from "./actor-critic";

const NOW = "2026-08-12T00:00:00.000Z";

/** Simulate a live OpenAI-compatible model replying with the given content. */
function stubModel(content: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}
const ONLINE = { provider: "openai" as const, apiKey: "sk-test" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Stage 3 · model gateway", () => {
  it("falls back to deterministic output with no api key", async () => {
    const r = await complete(
      { messages: [{ role: "user", content: "hello world" }], sensitive: false },
      { provider: "off" },
    );
    expect(r.provider).toBe("deterministic");
    expect(r.text).toContain("hello world");
  });

  it("routes sensitive payloads to the private model", async () => {
    const r = await complete(
      { messages: [{ role: "user", content: "patient RNA" }], sensitive: true },
      { provider: "off" },
    );
    expect(r.route).toBe("private-model");
  });

  it("uses an injected fallback generator", async () => {
    const r = await complete(
      { messages: [{ role: "user", content: "x" }] },
      { provider: "off", fallback: () => "CUSTOM" },
    );
    expect(r.text).toBe("CUSTOM");
  });
});

describe("Stage 3 · Actor–Critic dual agent", () => {
  const db = createDb(":memory:");
  seedKnowledgeBase(db);

  it("Actor drafts recommendations grounded in retrieved evidence", async () => {
    const chunks = search(db, "FFPE RNA 建库 DV200 门槛", { appliesToHint: "FFPE RNA" });
    const actor = await runActor(
      { question: "24份FFPE样本如何建库", locale: "zh", chunks },
      { provider: "off" },
    );
    expect(actor.recommendations.length).toBeGreaterThan(0);
    for (const rec of actor.recommendations) {
      expect(rec.evidenceIds.length).toBeGreaterThan(0); // every rec cites evidence
    }
  });

  it("Critic approves recommendations with valid, in-scope, unexpired citations", async () => {
    const chunks = search(db, "FFPE RNA 建库 DV200 门槛", { appliesToHint: "FFPE RNA" });
    const actor = await runActor(
      { question: "建库方案", locale: "zh", chunks },
      { provider: "off" },
    );
    const critic = runCritic({
      recommendations: actor.recommendations,
      chunks,
      appliesToHint: "FFPE RNA",
      now: NOW,
    });
    expect(critic.verified.length).toBeGreaterThan(0);
    expect(critic.findings.every((f) => f.citationValid)).toBe(true);
  });

  it("Critic rejects a fabricated citation", () => {
    const chunks = search(db, "FFPE RNA 建库", { appliesToHint: "FFPE RNA" });
    const fabricated: DraftRecommendation = {
      id: "REC-FAKE",
      title: "编造方案",
      rationale: "no basis",
      evidenceIds: ["PMID: 99999999"], // not in retrieved set
      boundary: "FFPE RNA",
    };
    const critic = runCritic({
      recommendations: [fabricated],
      chunks,
      appliesToHint: "FFPE RNA",
      now: NOW,
    });
    expect(critic.approved).toBe(false);
    expect(critic.verified.length).toBe(0);
    expect(critic.findings[0].issues.join(" ")).toMatch(/not found/);
  });

  it("Critic flags expired citations", () => {
    const chunks = search(db, "FFPE RNA 建库", { appliesToHint: "FFPE RNA" });
    const rec: DraftRecommendation = {
      id: "REC-OLD",
      title: "x",
      rationale: "x",
      evidenceIds: [chunks[0].citation],
      boundary: chunks[0].appliesTo,
    };
    // evaluate as if it were far in the future → everything expired
    const critic = runCritic({
      recommendations: [rec],
      chunks,
      appliesToHint: "FFPE RNA",
      now: "2099-01-01T00:00:00.000Z",
    });
    expect(critic.findings[0].notExpired).toBe(false);
  });
});

describe("P0 · online Actor structured output + citation whitelist", () => {
  const db = createDb(":memory:");
  seedKnowledgeBase(db);
  const Q = "24份FFPE肿瘤样本如何开展RNA差异表达研究";

  it("accepts valid structured JSON: model prose ships, citations whitelisted", async () => {
    const chunks = search(db, Q, { appliesToHint: "FFPE RNA" });
    const [c1, c2] = chunks;
    stubModel(
      JSON.stringify({
        summary: "建议采用链特异性总 RNA 文库路线。",
        recommendations: [
          {
            title: "链特异性总 RNA 文库",
            rationale: "降解样本应采用链特异性建库策略。",
            evidenceIds: [c1.citation, c2.citation],
          },
        ],
      }),
    );
    const actor = await runActor({ question: Q, locale: "zh", chunks }, ONLINE);
    expect(actor.provider).toBe("openai");
    expect(actor.summary).toBe("建议采用链特异性总 RNA 文库路线。");
    expect(actor.recommendations).toHaveLength(1);
    expect(actor.recommendations[0].rationale).toBe("降解样本应采用链特异性建库策略。");
    expect(actor.recommendations[0].evidenceIds).toContain(c1.citation);

    // The downstream Critic must still approve the model-shaped output.
    const critic = runCritic({
      recommendations: actor.recommendations,
      chunks,
      appliesToHint: "FFPE RNA",
      now: NOW,
    });
    expect(critic.verified.length).toBeGreaterThan(0);
  });

  it("drops a recommendation whose evidenceIds are all fabricated and keeps valid ones", async () => {
    const chunks = search(db, Q, { appliesToHint: "FFPE RNA" });
    stubModel(
      JSON.stringify({
        summary: "综述",
        recommendations: [
          { title: "伪造建议", rationale: "无依据", evidenceIds: ["PMID: 99999999"] },
          { title: "真实建议", rationale: "有依据", evidenceIds: [chunks[0].citation] },
        ],
      }),
    );
    const actor = await runActor({ question: Q, locale: "zh", chunks }, ONLINE);
    expect(actor.recommendations).toHaveLength(1);
    expect(actor.recommendations[0].title).toBe("真实建议");
    expect(actor.recommendations[0].evidenceIds).toEqual([chunks[0].citation]);
  });

  it("rejects a recommendation whose rationale smuggles a fabricated DOI", async () => {
    const chunks = search(db, Q, { appliesToHint: "FFPE RNA" });
    stubModel(
      JSON.stringify({
        summary: "综述",
        recommendations: [
          {
            title: "可疑建议",
            rationale: "见文献 DOI: 10.9999/fake.123 的结论。",
            evidenceIds: [chunks[0].citation],
          },
        ],
      }),
    );
    // The single recommendation is untrusted → rule-derived fallback, model text discarded.
    const actor = await runActor({ question: Q, locale: "zh", chunks }, ONLINE);
    expect(actor.recommendations[0].id).toBe("REC-PRIMARY");
    expect(actor.summary).not.toContain("10.9999");
  });

  it("falls back to rule-derived output when the model replies with free prose", async () => {
    const chunks = search(db, Q, { appliesToHint: "FFPE RNA" });
    stubModel("根据证据，建议采用链特异性总 RNA 文库路线，引用 NV-SOP-RNA-042。");
    const actor = await runActor({ question: Q, locale: "zh", chunks }, ONLINE);
    expect(actor.provider).toBe("openai"); // the model DID run…
    expect(actor.recommendations[0].id).toBe("REC-PRIMARY"); // …but its prose is not trusted
    expect(actor.summary).not.toContain("链特异性总 RNA 文库路线，引用");
  });

  it("rejects a summary that smuggles a fabricated PMID (never reaches the customer)", async () => {
    const chunks = search(db, Q, { appliesToHint: "FFPE RNA" });
    stubModel(
      JSON.stringify({
        summary: "推荐该路线（PMID: 12345678）。",
        recommendations: [{ title: "t", rationale: "r", evidenceIds: [chunks[0].citation] }],
      }),
    );
    const actor = await runActor({ question: Q, locale: "zh", chunks }, ONLINE);
    expect(actor.summary).not.toContain("12345678");
    expect(actor.recommendations[0].id).toBe("REC-PRIMARY");
  });

  it("normalizes doc-id style evidenceIds (E-SOP-042) to canonical citations", async () => {
    const chunks = search(db, Q, { appliesToHint: "FFPE RNA" });
    const sop = chunks.find((c) => c.source === "SOP");
    expect(sop).toBeTruthy();
    stubModel(
      JSON.stringify({
        summary: "综述",
        recommendations: [
          { title: "建议", rationale: "依据", evidenceIds: [sop!.documentId] }, // "E-SOP-042" style
        ],
      }),
    );
    const actor = await runActor({ question: Q, locale: "zh", chunks }, ONLINE);
    expect(actor.recommendations).toHaveLength(1);
    expect(actor.recommendations[0].evidenceIds).toContain(sop!.citation);
  });
});
