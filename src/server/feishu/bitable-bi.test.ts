import { describe, expect, it, beforeEach } from "vitest";
import { createDb } from "../db/client";
import {
  getExpertCaseRecord,
  getLatestCard,
  listCardVersions,
  saveDecisionCard,
  saveExpertCase,
  upsertProject,
} from "../db/repositories";
import {
  clearMockBitableRecords,
  getMockBitableRecords,
  syncDecisionCard,
} from "./bitable";
import { POST as cardActionRoute } from "@/app/api/feishu/card-action/route";
import { POST as bitableSyncRoute } from "@/app/api/feishu/bitable-sync/route";
import { POST as bitableWebhookRoute } from "@/app/api/feishu/bitable-webhook/route";
import type { DecisionCard, ExpertCase } from "@/domain/consultation-journey";

const baseCard: DecisionCard = {
  id: "CARD-PROJ-888",
  version: 1,
  status: "provisional",
  title: "小鼠肝脏低起始量 RNA-Seq 方案",
  customerGoal: "转录组差异分析",
  confirmedConditions: [
    {
      field: "species",
      value: "Mus musculus (小鼠)",
      source: "customer",
      extractedAt: "2026-09-10T10:00:00Z",
      confidence: 1,
      confirmation: "confirmed",
      version: 1,
      visibility: "project-members",
    },
  ],
  budgetRange: "3-5万",
  timelineRange: "10-15天",
  pendingItems: [],
  expertStatus: "awaiting-claim",
  executiveSummary: "采用超低起始量建库方案。",
  recommendations: [
    {
      id: "r1",
      title: "SMARTer-Seq 超微量建库方案 (SOP-088)",
      rationale: "适配 5ng 极低起始量",
      evidenceIds: ["E-SOP-088", "PMID-24637835"],
      boundary: "RNA >= 2ng",
    },
  ],
  alternatives: [],
  risk: {
    level: "medium",
    score: 45,
    mandatoryEscalation: false,
    signals: ["起始量偏低"],
  },
  prohibitedCtas: [],
  serviceFit: null,
};

const baseCase: ExpertCase = {
  id: "CASE-PROJ-888",
  status: "awaiting-claim",
  sla: { claimMinutes: 15, substantiveResponseHours: 4 },
  handoff: {
    objective: "小鼠肝脏低起始量方案争议",
    confirmedFacts: { species: "小鼠", sampleCount: 8 },
    attemptedAction: "检索匹配",
    riskLevel: "medium",
    reason: "客户期望加急且样本珍贵",
    evidenceConflict: false,
    decisionsNeeded: [],
    defenseTrail: [],
  },
};

describe("飞书生态双向协同 · 多维表格双向同步与交互式卡片认领", () => {
  beforeEach(async () => {
    clearMockBitableRecords();
    const { getDb } = await import("../db/client");
    const db = getDb();
    db.prepare("DELETE FROM expert_cases WHERE project_id = ?").run("PROJ-888");
    db.prepare("DELETE FROM decision_cards WHERE project_id = ?").run("PROJ-888");
    db.prepare("DELETE FROM projects WHERE id = ?").run("PROJ-888");
  });

  it("正向同步：决策卡同步到多维表格包含物种、推荐方案、风险分级与初始待质检状态", async () => {
    const res = await syncDecisionCard(baseCard, "PROJ-888", {
      species: "Mus musculus (小鼠)",
    });

    expect(res.success).toBe(true);
    expect(res.mock).toBe(true);

    const records = getMockBitableRecords();
    expect(records).toHaveLength(1);

    const fields = records[0].fields;
    expect(fields["卡片ID"]).toBe("CARD-PROJ-888");
    expect(fields["项目ID"]).toBe("PROJ-888");
    expect(fields["物种"]).toBe("Mus musculus (小鼠)");
    expect(fields["推荐方案"]).toContain("SMARTer-Seq 超微量建库方案 (SOP-088)");
    expect(fields["风险分级"]).toBe("medium");
    expect(fields["引用的SOP"]).toContain("SOP-088");
    expect(fields["质检状态"]).toBe("待质检");
  });

  it("飞书卡片认领回调：响应 Challenge 并支持专家在飞书群内一键认领", async () => {
    // 1. 验证 Challenge 握手
    const challengeReq = new Request("http://localhost/api/feishu/card-action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challenge: "test_challenge_token_999" }),
    });
    const challengeRes = await cardActionRoute(challengeReq);
    const challengeData = (await challengeRes.json()) as { challenge?: string };
    expect(challengeData.challenge).toBe("test_challenge_token_999");

    // 2. 准备工单数据
    const { getDb } = await import("../db/client");
    const db = getDb();
    const now = new Date().toISOString();
    upsertProject(db, { id: "PROJ-888", tenantId: "tenant-test", name: "测试项目", locale: "zh", now });
    saveExpertCase(db, "PROJ-888", baseCase, now);

    // 3. 模拟群内专家点击 [ 🙋 认领此案例 ] 回调
    const claimReq = new Request("http://localhost/api/feishu/card-action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        open_id: "ou_expert_123456",
        action: {
          value: {
            action: "claim",
            caseId: "CASE-PROJ-888",
          },
        },
      }),
    });
    const claimRes = await cardActionRoute(claimReq);
    expect(claimRes.status).toBe(200);

    const claimData = (await claimRes.json()) as {
      toast?: { type: string; content: string };
      card?: Record<string, unknown>;
    };
    expect(claimData.toast?.type).toBe("success");
    expect(claimData.toast?.content).toContain("认领成功");

    // 验证数据库内工单状态已变为 claimed 并记录 claimed_at
    const updatedCase = getExpertCaseRecord(db, "CASE-PROJ-888");
    expect(updatedCase?.expertCase.status).toBe("claimed");
    expect(updatedCase?.expertCase.claimedAt).toBeTruthy();
  });

  it("反向质检 Webhook：质检合格触发 NovaPilot 自动固化新版本决策卡 (v2.0)", async () => {
    const { getDb } = await import("../db/client");
    const db = getDb();
    const now = new Date().toISOString();
    upsertProject(db, { id: "PROJ-888", tenantId: "tenant-test", name: "测试项目", locale: "zh", now });
    saveDecisionCard(db, "PROJ-888", baseCard, "init-trace", now);

    // 模拟飞书多维表格推送：质检合格
    const webhookReq = new Request("http://localhost/api/feishu/bitable-webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "PROJ-888",
        qcStatus: "质检合格",
        qcNote: "文库峰型单一，浓度 12 ng/uL，满足 PE150 上机条件",
      }),
    });

    const res = await bitableWebhookRoute(webhookReq);
    expect(res.status).toBe(200);

    const data = (await res.json()) as {
      ok: boolean;
      previousVersion: number;
      newVersion: number;
    };
    expect(data.ok).toBe(true);
    expect(data.previousVersion).toBe(1);
    expect(data.newVersion).toBe(2);

    // 检查数据库中版本历史已成功固化两条记录
    const versions = listCardVersions(db, "PROJ-888");
    expect(versions).toHaveLength(2);
    expect(versions[0].version).toBe(2);
    expect(versions[1].version).toBe(1);

    const latest = getLatestCard(db, "PROJ-888");
    expect(latest?.version).toBe(2);
    expect(latest?.title).toContain("质检合格");
    expect(latest?.executiveSummary).toContain("文库质量满足上机门禁");
  });

  it("反向质检 Webhook：质检不合格触发 P0 风险拦截与应急处理方案并升级为 v3.0", async () => {
    const { getDb } = await import("../db/client");
    const db = getDb();
    const now = new Date().toISOString();
    upsertProject(db, { id: "PROJ-888", tenantId: "tenant-test", name: "测试项目", locale: "zh", now });
    // 先保存 v1 与 v2，模拟进入 v3 的流程
    saveDecisionCard(db, "PROJ-888", baseCard, "trace-v1", now);
    saveDecisionCard(db, "PROJ-888", { ...baseCard, version: 2, title: "小鼠肝脏低起始量 RNA-Seq 方案 · 质检合格" }, "trace-v2", now);

    // 模拟飞书多维表格推送：质检不合格
    const webhookReq = new Request("http://localhost/api/feishu/bitable-webhook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "PROJ-888",
        qcStatus: "质检不合格",
        qcNote: "引物二聚体严重超标，主峰缺失",
      }),
    });

    const res = await bitableWebhookRoute(webhookReq);
    expect(res.status).toBe(200);

    const data = (await res.json()) as {
      ok: boolean;
      newVersion: number;
    };
    expect(data.ok).toBe(true);
    expect(data.newVersion).toBe(3);

    const latest = getLatestCard(db, "PROJ-888");
    expect(latest?.version).toBe(3);
    expect(latest?.status).toBe("provisional");
    expect(latest?.risk.level).toBe("high");
    expect(latest?.risk.score).toBeGreaterThanOrEqual(88);
    expect(latest?.risk.mandatoryEscalation).toBe(true);
    expect(latest?.recommendations[0].title).toContain("质检不合格对策");
  });
});
