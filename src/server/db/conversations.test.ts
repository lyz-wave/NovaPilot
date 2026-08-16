import { describe, it, expect, beforeEach } from "vitest";
import { createDb, type NovaDb } from "./client";
import {
  appendMessage,
  createConversation,
  deleteConversation,
  deriveConversationTitle,
  getConversation,
  listConversation,
  listConversations,
  renameConversation,
  titleFromFirstMessage,
  touchConversation,
  DEFAULT_CONVERSATION_TITLE,
} from "./repositories";

const TENANT = "novapilot-demo";
const T0 = "2026-08-13T00:00:00.000Z";
const T1 = "2026-08-13T00:01:00.000Z";
const T2 = "2026-08-13T00:02:00.000Z";

describe("多会话索引 · conversations 仓储", () => {
  let db: NovaDb;
  beforeEach(() => {
    db = createDb(":memory:");
  });

  it("create/list：新建后可列出，默认标题，消息数为 0", () => {
    createConversation(db, { id: "c1", tenantId: TENANT, now: T0 });
    const list = listConversations(db, TENANT);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "c1", title: DEFAULT_CONVERSATION_TITLE, messageCount: 0 });
    expect(list[0].lastMessageAt).toBeNull();
  });

  it("create 幂等：相同 id 不重复插入、不覆盖已有标题", () => {
    createConversation(db, { id: "c1", tenantId: TENANT, title: "原标题", now: T0 });
    createConversation(db, { id: "c1", tenantId: TENANT, title: "覆盖?", now: T1 });
    const list = listConversations(db, TENANT);
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe("原标题");
  });

  it("messageCount / lastMessageAt 随消息更新", () => {
    createConversation(db, { id: "c1", tenantId: TENANT, now: T0 });
    appendMessage(db, { id: "m1", conversationId: "c1", role: "user", kind: "chat", text: "你好", now: "2026-08-13T00:00:05.000Z" });
    appendMessage(db, { id: "m2", conversationId: "c1", role: "assistant", kind: "chat", text: "在", now: "2026-08-13T00:00:06.000Z" });
    const meta = listConversations(db, TENANT)[0];
    expect(meta.messageCount).toBe(2);
    expect(meta.lastMessageAt).toBe("2026-08-13T00:00:06.000Z");
  });

  it("rename 更新标题；tenant 不匹配时不生效", () => {
    createConversation(db, { id: "c1", tenantId: TENANT, now: T0 });
    renameConversation(db, { id: "c1", tenantId: "other", title: "越权", now: T1 });
    expect(listConversations(db, TENANT)[0].title).toBe(DEFAULT_CONVERSATION_TITLE);
    renameConversation(db, { id: "c1", tenantId: TENANT, title: "我的会话", now: T1 });
    expect(listConversations(db, TENANT)[0].title).toBe("我的会话");
  });

  it("delete 删除会话及其消息，其它会话不受影响", () => {
    createConversation(db, { id: "c1", tenantId: TENANT, now: T0 });
    createConversation(db, { id: "c2", tenantId: TENANT, now: T0 });
    appendMessage(db, { id: "m1", conversationId: "c1", role: "user", kind: "chat", text: "hi", now: T0 });
    deleteConversation(db, { id: "c1", tenantId: TENANT });
    expect(listConversations(db, TENANT).map((c) => c.id)).toEqual(["c2"]);
    expect(listConversation(db, "c1")).toHaveLength(0);
  });

  it("列表按活动时间排序：touch 让会话浮到顶部", () => {
    createConversation(db, { id: "c1", tenantId: TENANT, now: T0 });
    createConversation(db, { id: "c2", tenantId: TENANT, now: T1 });
    expect(listConversations(db, TENANT).map((c) => c.id)).toEqual(["c2", "c1"]);
    touchConversation(db, { id: "c1", now: T2 });
    expect(listConversations(db, TENANT).map((c) => c.id)).toEqual(["c1", "c2"]);
  });

  it("titleFromFirstMessage 只在默认标题时命名，之后不覆盖", () => {
    createConversation(db, { id: "c1", tenantId: TENANT, now: T0 });
    titleFromFirstMessage(db, { id: "c1", text: "24 份 FFPE 样本 RNA 差异表达怎么做？", now: T1 });
    const named = listConversations(db, TENANT)[0].title;
    expect(named).not.toBe(DEFAULT_CONVERSATION_TITLE);
    titleFromFirstMessage(db, { id: "c1", text: "后续追问不应改名", now: T2 });
    expect(listConversations(db, TENANT)[0].title).toBe(named);
  });

  it("deriveConversationTitle：折叠空白、超长截断加省略号、空串回退默认", () => {
    expect(deriveConversationTitle("  多   空格  ")).toBe("多 空格");
    const long = "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十";
    const title = deriveConversationTitle(long);
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBe(25); // 24 chars + ellipsis
    expect(deriveConversationTitle("   ")).toBe(DEFAULT_CONVERSATION_TITLE);
  });

  it("getConversation 做租户归属校验", () => {
    createConversation(db, { id: "c1", tenantId: TENANT, now: T0 });
    expect(getConversation(db, { id: "c1", tenantId: TENANT })?.id).toBe("c1");
    expect(getConversation(db, { id: "c1", tenantId: "other" })).toBeNull();
  });
});
