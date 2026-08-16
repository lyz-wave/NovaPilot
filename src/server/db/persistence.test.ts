import { describe, it, expect, beforeEach } from "vitest";
import { createDb, migrate, type NovaDb } from "./client";
import {
  upsertProject,
  getProject,
  bumpProjectVersion,
  saveFacts,
  listFacts,
  saveDecisionCard,
  getLatestCard,
  checkIdempotency,
  appendMessage,
  listConversation,
  clearConversation,
  VersionConflictError,
} from "./repositories";
import { runConsultationJourney } from "@/domain/consultation-journey";

const NOW = "2026-08-12T00:00:00.000Z";

describe("Stage 1 · persistence layer (SQLite)", () => {
  let db: NovaDb;
  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("migrate is idempotent and stamps schema version", () => {
    migrate(db);
    migrate(db);
    const row = db
      .prepare("SELECT value FROM schema_meta WHERE key='schema_version'")
      .get() as { value: string };
    expect(row.value).toBe("1");
  });

  it("creates and reads back a project", () => {
    upsertProject(db, {
      id: "NP-1",
      tenantId: "novapilot-demo",
      name: "FFPE RNA",
      locale: "zh",
      now: NOW,
    });
    const p = getProject(db, "NP-1");
    expect(p).not.toBeNull();
    expect(p!.version).toBe(1);
    expect(p!.locale).toBe("zh");
  });

  it("enforces optimistic version locking", () => {
    upsertProject(db, {
      id: "NP-2",
      tenantId: "novapilot-demo",
      name: "x",
      locale: "en",
      now: NOW,
    });
    const v2 = bumpProjectVersion(db, "NP-2", 1, NOW);
    expect(v2).toBe(2);
    expect(() => bumpProjectVersion(db, "NP-2", 1, NOW)).toThrow(VersionConflictError);
  });

  it("persists domain fact records and coerces numeric values", () => {
    upsertProject(db, {
      id: "NP-3",
      tenantId: "novapilot-demo",
      name: "x",
      locale: "zh",
      now: NOW,
    });
    const result = runConsultationJourney({
      scenario: "standard",
      locale: "zh",
      facts: { dv200: 60, rnaInputNg: 25, material: "FFPE RNA", sampleCount: 24 },
    });
    saveFacts(db, "NP-3", result.project.factRecords);
    const facts = listFacts(db, "NP-3");
    const dv200 = facts.find((f) => f.field === "dv200");
    expect(dv200?.value).toBe(60); // number, not "60"
    const material = facts.find((f) => f.field === "material");
    expect(material?.value).toBe("FFPE RNA"); // stays string
  });

  it("upserting facts increments the fact version", () => {
    upsertProject(db, {
      id: "NP-4",
      tenantId: "novapilot-demo",
      name: "x",
      locale: "zh",
      now: NOW,
    });
    const rec = runConsultationJourney({
      scenario: "standard",
      locale: "zh",
      facts: { dv200: 60, rnaInputNg: 25, material: "FFPE RNA", sampleCount: 24 },
    }).project.factRecords;
    saveFacts(db, "NP-4", rec);
    saveFacts(db, "NP-4", rec);
    const dv200 = listFacts(db, "NP-4").find((f) => f.field === "dv200");
    expect(dv200!.version).toBe(2);
  });

  it("stores a decision card and returns the latest version", () => {
    upsertProject(db, {
      id: "NP-5",
      tenantId: "novapilot-demo",
      name: "x",
      locale: "zh",
      now: NOW,
    });
    const r = runConsultationJourney({
      scenario: "standard",
      locale: "zh",
      facts: { dv200: 60, rnaInputNg: 25, material: "FFPE RNA", sampleCount: 24 },
    });
    saveDecisionCard(db, "NP-5", r.card, r.traceId, NOW);
    const stored = getLatestCard(db, "NP-5");
    expect(stored?.status).toBe("formal");
    expect(stored?.recommendations.length).toBeGreaterThan(0);
  });

  it("idempotency: fresh, replay, then conflict", () => {
    expect(checkIdempotency(db, "k1", "fp-a", NOW).state).toBe("fresh");
    expect(checkIdempotency(db, "k1", "fp-a", NOW).state).toBe("replay");
    expect(checkIdempotency(db, "k1", "fp-b", NOW).state).toBe("conflict");
  });

  it("对话消息 append/list/clear 往返（含 card 载荷）", () => {
    const conv = "novapilot-demo";
    appendMessage(db, {
      id: "m1",
      conversationId: conv,
      role: "user",
      kind: "chat",
      text: "你好",
      now: "2026-08-12T00:00:00.000Z",
    });
    appendMessage(db, {
      id: "m2",
      conversationId: conv,
      role: "assistant",
      kind: "chat",
      text: "你好，我是 NovaPilot。",
      now: "2026-08-12T00:00:01.000Z",
    });

    const result = runConsultationJourney({
      scenario: "standard",
      locale: "zh",
      facts: { dv200: 62, rnaInputNg: 25, material: "FFPE RNA", sampleCount: 24 },
    });
    appendMessage(db, {
      id: "m3",
      conversationId: conv,
      role: "assistant",
      kind: "card",
      result,
      traceId: result.traceId,
      now: "2026-08-12T00:00:02.000Z",
    });

    // isolation: a different conversation is untouched
    appendMessage(db, {
      id: "x1",
      conversationId: "other-tenant",
      role: "user",
      kind: "chat",
      text: "hi",
      now: "2026-08-12T00:00:03.000Z",
    });

    const turns = listConversation(db, conv);
    expect(turns).toHaveLength(3);
    expect(turns.map((t) => t.id)).toEqual(["m1", "m2", "m3"]);
    expect(turns[0].result).toBeNull();
    // the card payload round-trips through JSON
    expect(turns[2].kind).toBe("card");
    expect(turns[2].result?.card.status).toBe("formal");
    expect(turns[2].result?.card.recommendations.length).toBeGreaterThan(0);

    clearConversation(db, conv);
    expect(listConversation(db, conv)).toHaveLength(0);
    // clearing one conversation leaves the other intact
    expect(listConversation(db, "other-tenant")).toHaveLength(1);
  });
});
