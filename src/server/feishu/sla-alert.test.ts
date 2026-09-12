import { describe, expect, it, beforeEach } from "vitest";
import {
  buildClaimedNoticeCard,
  buildSlaAlertCard,
  clearSlaAlerts,
  getRecentSlaAlerts,
  sendSlaAlertCard,
} from "./sla-alert";
import type { DecisionCard, ExpertCase } from "@/domain/consultation-journey";

const dummyCard: DecisionCard = {
  id: "CARD-P-042",
  version: 1,
  status: "provisional",
  title: "FFPE-RNA-042 样本建库方案争议",
  customerGoal: "高深度转录组测序",
  confirmedConditions: [],
  budgetRange: "5-8万",
  timelineRange: "15-20天",
  pendingItems: ["DV200 复测", "起始量核实"],
  expertStatus: "awaiting-claim",
  executiveSummary: "DV200 为 28%，接近临界阈值，官方 SOP 建议加倍文库投入量。",
  recommendations: [
    {
      id: "r1",
      title: "针对重度降解 FFPE 实施超低起始量建库 (SOP-042)",
      rationale: "依据 SOP 建议补充 50% 纯化磁珠",
      evidenceIds: ["E-SOP-042#0"],
      boundary: "DV200 >= 25%",
    },
  ],
  alternatives: ["常规建库"],
  risk: {
    level: "high",
    score: 85,
    mandatoryEscalation: true,
    signals: ["DV200 低于标准基线 (30%)", "证据适用边界存在争议"],
  },
  prohibitedCtas: [],
  serviceFit: null,
};

const dummyCase: ExpertCase = {
  id: "CASE-P-042",
  status: "awaiting-claim",
  sla: {
    claimMinutes: 15,
    substantiveResponseHours: 4,
  },
  handoff: {
    objective: "FFPE-RNA-042 样本方案争议",
    confirmedFacts: {
      species: "人 (Homo sapiens)",
      sampleCount: 12,
      dv200: 28,
      rnaInputNg: 15,
    },
    attemptedAction: "完成3轮混合检索与论证核验",
    riskLevel: "high",
    reason: "证据严重冲突且 DV200 处于临界边界",
    evidenceConflict: true,
    decisionsNeeded: ["是否豁免起始量门禁"],
    defenseTrail: [],
  },
};

describe("飞书交互式卡片 SLA 紧急呼叫", () => {
  beforeEach(() => {
    clearSlaAlerts();
    delete process.env.FEISHU_BOT_WEBHOOK_URL;
  });

  it("构造的交互卡片符合飞书 Schema 2.0 规范并携带争议核心要素与认领按钮", () => {
    const card = buildSlaAlertCard(dummyCase, dummyCard);

    const header = card.header as { template: string; title: { content: string } };
    expect(header.template).toBe("red");
    expect(header.title.content).toContain("🚨【紧急科研工单转接】");
    expect(header.title.content).toContain("FFPE-RNA-042 样本建库方案争议");

    const elements = card.elements as Array<{
      tag: string;
      text?: { content: string };
      actions?: Array<{ tag: string; text: { content: string }; value: Record<string, unknown> }>;
    }>;

    // 验证包含事实与 SLA 时限
    const summaryElem = elements.find((e) => e.text?.content.includes("工单编号"));
    expect(summaryElem).toBeDefined();
    expect(summaryElem?.text?.content).toContain("CASE-P-042");
    expect(summaryElem?.text?.content).toContain("85/100");
    expect(summaryElem?.text?.content).toContain("物种: 人 (Homo sapiens)");
    expect(summaryElem?.text?.content).toContain("认领时限 **15 分钟**");

    // 验证包含 [ 🙋 认领此案例 ] 交互按钮
    const actionElem = elements.find((e) => e.tag === "action");
    expect(actionElem).toBeDefined();
    const btn = actionElem?.actions?.[0];
    expect(btn?.tag).toBe("button");
    expect(btn?.text.content).toBe("🙋 认领此案例");
    expect(btn?.value).toEqual({
      action: "claim",
      caseId: "CASE-P-042",
      projectId: "CARD-P-042",
    });
    expect((btn as any)?.multi_url?.url).toContain("/expert?claim=CASE-P-042");
  });

  it("无 Webhook 凭证时优雅降级为 Mock 记录，保持离线确定性", async () => {
    const res = await sendSlaAlertCard(dummyCase, dummyCard);
    expect(res.sent).toBe(true);
    expect(res.mock).toBe(true);

    const alerts = getRecentSlaAlerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0].caseId).toBe("CASE-P-042");
    expect(alerts[0].mock).toBe(true);
  });

  it("认领通知卡片更新为绿色并展示认领专家与 SLA 实质响应倒计时", () => {
    const claimedCard = buildClaimedNoticeCard(dummyCase, "王建国研究员");

    const header = claimedCard.header as { template: string; title: { content: string } };
    expect(header.template).toBe("green");
    expect(header.title.content).toContain("✅【工单已认领】");

    const elements = claimedCard.elements as Array<{ text?: { content: string } }>;
    const content = elements[0]?.text?.content ?? "";
    expect(content).toContain("王建国研究员");
    expect(content).toContain("4 小时");
  });
});
