import { describe, expect, it } from "vitest";
import { createDb } from "../db/client";
import { getActiveProfileId, listModelProfiles } from "../db/repositories";
import { bitableConfig } from "./bitable";
import { feishuEnabled } from "./client";
import { applyDoubaoEnvProfile } from "./doubao";
import { decisionCardToFeishuCard } from "./aily";
import { extractFactsFromText, fetchMinutes } from "./minutes";
import type { DecisionCard } from "@/domain/consultation-journey";

describe("飞书五合一集成 · 凭证缺失时优雅禁用(离线不变式)", () => {
  it("无凭证时 feishuEnabled=false 且 fetchMinutes 返回 null", async () => {
    expect(feishuEnabled()).toBe(false);
    expect(await fetchMinutes("any-token")).toBeNull();
  });

  it("bitable 配置默认表名", () => {
    const cfg = bitableConfig();
    expect(cfg.appToken).toBeNull();
    expect(cfg.cardsTable).toBe("决策卡");
    expect(cfg.eventsTable).toBe("质量事件");
  });

  it("纪要文本事实抽取:提取 DV200/样本数/投入量/物种/目标", () => {
    const facts = extractFactsFromText(
      "张老师:这批 FFPE 样本 DV200 是 37%,共 24 份样本,RNA 投入量 20 ng,想做人的转录组差异表达分析",
    );
    expect(facts.dv200).toBe(37);
    expect(facts.sampleCount).toBe(24);
    expect(facts.rnaInputNg).toBe(20);
    expect(facts.material).toBe("FFPE RNA");
    expect(facts.species).toContain("人");
    expect(facts.goal).toBeTruthy();
    expect(facts.suggestedQuestion.length).toBeGreaterThan(0);
  });

  it("决策卡 → 飞书消息卡片(schema 2.0)结构完整", () => {
    const card = {
      id: "CARD-1",
      version: 1,
      status: "formal",
      title: "方案卡",
      customerGoal: "目标",
      confirmedConditions: [],
      budgetRange: "10 万",
      timelineRange: "18 天",
      pendingItems: [],
      expertStatus: "not-required",
      executiveSummary: "摘要",
      recommendations: [
        { id: "r1", title: "路线A", rationale: "理由", evidenceIds: ["E-SOP-042#0"], boundary: "FFPE" },
      ],
      alternatives: ["备选B"],
      risk: { level: "low", score: 1, mandatoryEscalation: false, signals: [] },
      prohibitedCtas: [],
      serviceFit: null,
    } as DecisionCard;
    const feishuCard = decisionCardToFeishuCard(card) as {
      schema?: string;
      elements?: unknown[];
    };
    expect(feishuCard.schema).toBe("2.0");
    expect(feishuCard.elements?.length).toBeGreaterThan(2);
  });

  it("豆包 profile:无 key 时 no-op,有 key 时自动注册并激活", () => {
    const db = createDb(":memory:");
    applyDoubaoEnvProfile(db);
    expect(listModelProfiles(db)).toHaveLength(0);

    process.env.FEISHU_DOUBAO_API_KEY = "test-key";
    applyDoubaoEnvProfile(db);
    const profiles = listModelProfiles(db);
    expect(profiles).toHaveLength(1);
    expect(profiles[0].baseUrl).toContain("volces");
    expect(profiles[0].provider).toBe("openai");
    expect(getActiveProfileId(db)).toBe("doubao-env");
    delete process.env.FEISHU_DOUBAO_API_KEY;
  });
});
