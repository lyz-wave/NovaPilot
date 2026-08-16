import { describe, it, expect } from "vitest";
import { createDb, type NovaDb } from "./db/client";
import { respond, type ConsultInput } from "./service";
import { listConversation } from "./db/repositories";

const OFF = { provider: "off" as const };

function input(overrides: Partial<ConsultInput> & { traceId: string }): ConsultInput {
  return {
    question: "你好",
    locale: "zh",
    facts: { sampleCount: 24, dv200: 62, rnaInputNg: 20, material: "FFPE RNA" },
    tenantId: "novapilot-demo",
    ...overrides,
  };
}

function cardCount(db: NovaDb): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM decision_cards").get() as { n: number }).n;
}

describe("Stage 5 · respond()（意图门 + 对话落库）", () => {
  it("闲聊意图返回 kind:chat、不生成决策卡、落 2 条消息", async () => {
    const db = createDb(":memory:");
    const out = await respond(input({ question: "你可以干啥", traceId: "chat-1" }), OFF, db);

    expect(out.kind).toBe("chat");
    if (out.kind !== "chat") throw new Error("unreachable");
    expect(out.provider).toBe("deterministic");
    expect(out.reply).toContain("NovaPilot");

    // no decision card was created for chit-chat
    expect(cardCount(db)).toBe(0);

    // exactly the user turn + assistant chat turn were persisted
    const turns = listConversation(db, "novapilot-demo");
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ role: "user", kind: "chat", text: "你可以干啥" });
    expect(turns[1]).toMatchObject({ role: "assistant", kind: "chat" });
    expect(turns[1].result).toBeNull();
  });

  it("科研意图返回 kind:card 且落一条 card 消息", async () => {
    const db = createDb(":memory:");
    const out = await respond(
      input({
        question: "24 份 FFPE 肿瘤样本做 RNA 差异表达，DV200 62%，怎么选建库路线和测序平台？",
        traceId: "card-1",
      }),
      OFF,
      db,
    );

    expect(out.kind).toBe("card");
    if (out.kind !== "card") throw new Error("unreachable");
    expect(out.card.status).toBe("formal");
    expect(cardCount(db)).toBeGreaterThan(0);

    const turns = listConversation(db, "novapilot-demo");
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ role: "user", kind: "chat" });
    expect(turns[1]).toMatchObject({ role: "assistant", kind: "card" });
    // the card turn round-trips its ConsultationResult payload
    expect(turns[1].result?.card.status).toBe("formal");
  });

  it("同一会话内多轮消息按时间顺序累积", async () => {
    const db = createDb(":memory:");
    await respond(input({ question: "你好", traceId: "t1" }), OFF, db);
    await respond(input({ question: "谢谢", traceId: "t2" }), OFF, db);
    const turns = listConversation(db, "novapilot-demo");
    expect(turns).toHaveLength(4);
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });
});
