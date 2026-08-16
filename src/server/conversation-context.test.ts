import { describe, it, expect } from "vitest";
import { createDb, type NovaDb } from "./db/client";
import { appendMessage, createConversation, readCompactState } from "./db/repositories";
import { compactConversation, conversationContext } from "./service";
import { estimateTokens } from "./rag/text";
import { contextWindowFor } from "./agents/model-gateway";

const OFF = { provider: "off" as const };
const TENANT = "novapilot-demo";

/** Seed a conversation with `count` alternating turns carrying long CJK text. */
function seedTurns(db: NovaDb, id: string, count: number) {
  createConversation(db, { id, tenantId: TENANT, now: "2026-08-13T00:00:00.000Z" });
  for (let i = 1; i <= count; i++) {
    appendMessage(db, {
      id: `${id}-m${i}`,
      conversationId: id,
      role: i % 2 === 1 ? "user" : "assistant",
      kind: "chat",
      text: `第 ${i} 轮：这是一段用于测试上下文占用与压缩的较长中文内容，重复若干次以拉高 token 估算数值。`,
      now: `2026-08-13T00:00:${String(i).padStart(2, "0")}.000Z`,
    });
  }
}

describe("estimateTokens · 本地 token 估算", () => {
  it("空串为 0", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("中日韩字符约 1 token/字", () => {
    expect(estimateTokens("你好世界")).toBe(4);
  });

  it("拉丁字符约 chars/4", () => {
    expect(estimateTokens("hello")).toBe(Math.ceil(5 / 4));
  });

  it("混合文本相加", () => {
    // 2 CJK + ceil(5/4)=2
    expect(estimateTokens("你好world")).toBe(4);
  });

  it("更长文本估算更大（单调）", () => {
    expect(estimateTokens("研究研究研究")).toBeGreaterThan(estimateTokens("研究"));
  });
});

describe("contextWindowFor · 模型上下文窗口映射", () => {
  it("glm* → 200000", () => {
    expect(contextWindowFor("glm-4.6")).toBe(200000);
  });
  it("claude* → 200000", () => {
    expect(contextWindowFor("claude-opus-4-8")).toBe(200000);
  });
  it("gpt-4o* → 128000", () => {
    expect(contextWindowFor("gpt-4o-mini")).toBe(128000);
  });
  it("未知/缺省 → 128000", () => {
    expect(contextWindowFor(undefined)).toBe(128000);
    expect(contextWindowFor("novapilot-deterministic-v1")).toBe(128000);
  });
});

describe("conversationContext · 上下文占用（离线确定性）", () => {
  it("空会话给出固定开销、比例在 0..1、离线 provider", () => {
    const db = createDb(":memory:");
    createConversation(db, { id: "e1", tenantId: TENANT, now: "2026-08-13T00:00:00.000Z" });
    const usage = conversationContext(db, "e1");
    expect(usage.contextTokens).toBeGreaterThan(0);
    expect(usage.ratio).toBeGreaterThanOrEqual(0);
    expect(usage.ratio).toBeLessThanOrEqual(1);
    expect(usage.provider).toBe("deterministic");
    expect(usage.model).toContain("deterministic");
    expect(usage.compacted).toBe(false);
    expect(usage.contextWindow).toBe(128000);
  });

  it("追加消息后占用增加", () => {
    const db = createDb(":memory:");
    const before = conversationContext(db, "c1");
    seedTurns(db, "c1", 3);
    const after = conversationContext(db, "c1");
    expect(after.contextTokens).toBeGreaterThan(before.contextTokens);
  });
});

describe("compactConversation · CC 式压缩（离线确定性）", () => {
  it("轮次不足时不压缩", async () => {
    const db = createDb(":memory:");
    seedTurns(db, "short", 3); // < KEEP_RECENT(4)+1
    const res = await compactConversation({ conversationId: "short" }, OFF, db);
    expect(res.compacted).toBe(false);
    expect(readCompactState(db, "short")).toBeNull();
  });

  it("折叠早期轮次为摘要，占用下降，原始消息保留", async () => {
    const db = createDb(":memory:");
    seedTurns(db, "c1", 10);
    const before = conversationContext(db, "c1");

    const res = await compactConversation({ conversationId: "c1" }, OFF, db);
    expect(res.compacted).toBe(true);
    expect(res.usage.compacted).toBe(true);
    expect(res.usage.contextTokens).toBeLessThan(before.contextTokens);

    const state = readCompactState(db, "c1");
    expect(state).not.toBeNull();
    expect(state!.summary.length).toBeGreaterThan(0);
    // KEEP_RECENT=4, so fold covers turns 1..6 → throughMessageId is c1-m6.
    expect(state!.throughMessageId).toBe("c1-m6");
  });

  it("已压缩到尾部后再次调用不再压缩", async () => {
    const db = createDb(":memory:");
    seedTurns(db, "c1", 10);
    const first = await compactConversation({ conversationId: "c1" }, OFF, db);
    expect(first.compacted).toBe(true);
    const second = await compactConversation({ conversationId: "c1" }, OFF, db);
    expect(second.compacted).toBe(false);
  });
});
