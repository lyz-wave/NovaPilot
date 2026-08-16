/**
 * aily 智能助手适配层 — 把 NovaPilot 的决策卡封装成飞书消息卡片,
 * 供 aily 技能 / 机器人 webhook 回传使用(凭证缺失时仍可离线构建卡片)。
 */
import type { DecisionCard } from "@/domain/consultation-journey";

/** Decision card → Feishu interactive message card (schema 2.0). */
export function decisionCardToFeishuCard(card: DecisionCard): Record<string, unknown> {
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      template: card.risk.level === "high" ? "red" : card.status === "formal" ? "blue" : "grey",
      title: { tag: "plain_text", content: card.title },
    },
    elements: [
      { tag: "div", text: { tag: "lark_md", content: card.executiveSummary } },
      ...card.recommendations.map((r) => ({
        tag: "div",
        text: {
          tag: "lark_md",
          content: "**" + r.title + "**\n" + r.rationale + "\n证据:" + r.evidenceIds.join(" / "),
        },
      })),
      ...card.alternatives.slice(0, 2).map((alt) => ({
        tag: "div",
        text: { tag: "lark_md", content: "备选:" + alt },
      })),
      { tag: "hr" },
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content:
              "状态 " + card.status + " · 风险 " + card.risk.level + " · 预算 " + (card.budgetRange ?? "—") + " · 周期 " + (card.timelineRange ?? "—"),
          },
        ],
      },
    ],
  };
}
