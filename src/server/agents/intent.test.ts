import { describe, it, expect } from "vitest";
import { classifyIntent } from "./intent";
import { chatReply } from "./chat-agent";

const OFF = { provider: "off" as const };

describe("意图判断 · classifyIntent", () => {
  it("招呼、闲聊、能力询问一律判为 chat（不出决策卡）", () => {
    for (const q of [
      "你好",
      "在吗",
      "hello",
      "你可以干啥",
      "你能做什么？",
      "谢谢",
      "今天天气怎么样",
      "介绍一下你自己",
    ]) {
      expect(classifyIntent(q)).toBe("chat");
    }
  });

  it("空白输入判为 chat", () => {
    expect(classifyIntent("")).toBe("chat");
    expect(classifyIntent("   ")).toBe("chat");
  });

  it("带领域信号的科研问题判为 research", () => {
    for (const q of [
      "24 份 FFPE 肿瘤样本做 RNA 差异表达，DV200 62%，怎么选建库路线？",
      "低质量 RNA 能不能直接建库？",
      "WGS 和 WES 有什么区别",
      "单细胞转录组测序的样本要求",
      "帮我看看这个甲基化数据的质控",
      "Which sequencing platform for a metagenomics amplicon study?",
    ]) {
      expect(classifyIntent(q)).toBe("research");
    }
  });

  it("SOP/文献冲突、专家转接、非标准样本等咨询流也判为 research", () => {
    expect(classifyIntent("请核对当前 SOP 与外部文献是否冲突。")).toBe("research");
    expect(classifyIntent("请转交人工专家复核。")).toBe("research");
    expect(classifyIntent("这是非标准特殊样本，请评估风险。")).toBe("research");
    expect(classifyIntent("The SOP contradicts the paper")).toBe("research");
  });
});

describe("闲聊回复 · chatReply（离线）", () => {
  it("离线时返回固定简短话术，且不含伪造文献/引用", async () => {
    const { reply, provider } = await chatReply({ question: "你好", locale: "zh" }, OFF);
    expect(provider).toBe("deterministic");
    expect(reply).toContain("NovaPilot");
    // canned reply must not fabricate a citation-style reference
    expect(reply).not.toMatch(/PMID|doi|参考文献|\[\d+\]/i);
    // it should invite a concrete research question
    expect(reply).toMatch(/FFPE|DV200|建库/);
  });

  it("英文/日文各有对应话术", async () => {
    expect((await chatReply({ question: "hello", locale: "en" }, OFF)).reply).toMatch(/NovaPilot/);
    expect((await chatReply({ question: "こんにちは", locale: "ja" }, OFF)).reply).toMatch(/NovaPilot/);
  });

  it("带多轮 history 也不报错，离线仍回退固定话术（no-op）", async () => {
    const history = [
      { role: "user" as const, content: "你好" },
      { role: "assistant" as const, content: "你好，有什么科研问题？" },
      { role: "user" as const, content: "你怎么只会这一句" },
    ];
    const { reply, provider } = await chatReply({ question: "在吗", locale: "zh", history }, OFF);
    expect(provider).toBe("deterministic");
    expect(reply).toContain("NovaPilot");
  });
});
