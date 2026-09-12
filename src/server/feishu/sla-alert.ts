/**
 * 飞书交互式卡片 SLA 紧急呼叫 (Webhook Push + 专家认领回调)
 *
 * 场景：当转接队列中有 P0 级别争议（如证据严重冲突、或转接后 SLA 剩余时间不足 15 分钟）时，
 * 服务端向飞书科研协作群发送富文本交互卡片，专家可在群内一键点击 [ 🙋 认领此案例 ]。
 * 凭证缺失时保存至内存/日志并优雅回退，保持离线确定性。
 */
import type { DecisionCard, ExpertCase } from "@/domain/consultation-journey";

export interface SlaAlertRecord {
  caseId: string;
  projectId: string;
  sentAt: string;
  card: Record<string, unknown>;
  mock: boolean;
}

const recentAlerts: SlaAlertRecord[] = [];

/** 获取最近发送的 SLA 紧急告警（供离线演示与测试断言） */
export function getRecentSlaAlerts(): readonly SlaAlertRecord[] {
  return [...recentAlerts];
}

/** 清理告警记录（测试用） */
export function clearSlaAlerts(): void {
  recentAlerts.length = 0;
}

/**
 * 构造飞书 Schema 2.0 交互式工单卡片
 */
export function buildSlaAlertCard(
  expertCase: ExpertCase,
  card: DecisionCard,
  actionUrl?: string,
): Record<string, unknown> {
  const host = process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || "http://localhost:3210";
  const defaultUrl = `${host}/expert?claim=${encodeURIComponent(expertCase.id)}`;
  const targetUrl = actionUrl || defaultUrl;
  const facts = expertCase.handoff.confirmedFacts;
  const factsSummary = [
    facts.species ? `物种: ${facts.species}` : null,
    facts.sampleCount ? `样本: ${facts.sampleCount}例` : null,
    facts.dv200 !== undefined ? `DV200: ${facts.dv200}%` : null,
    facts.rnaInputNg !== undefined ? `RNA: ${facts.rnaInputNg}ng` : null,
  ]
    .filter(Boolean)
    .join(" · ") || "基础事实已初步提取";

  return {
    config: {
      wide_screen_mode: true,
      enable_forward: true,
    },
    header: {
      template: "red",
      title: {
        tag: "plain_text",
        content: `🚨【紧急科研工单转接】${card.title} 方案争议`,
      },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            `**工单编号**：\`${expertCase.id}\``,
            `**风险指数**：**${card.risk.score}/100**（${card.risk.level.toUpperCase()} 风险）· 必选人工转接`,
            `**提取事实**：${factsSummary}`,
            `**争议/拦截原因**：${expertCase.handoff.reason}`,
            `**SLA 承诺**：认领时限 **${expertCase.sla.claimMinutes} 分钟** · 实质响应 **${expertCase.sla.substantiveResponseHours} 小时**`,
          ].join("\n"),
        },
      },
      { tag: "hr" },
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: `**方案现状**：${card.executiveSummary.slice(0, 140)}...`,
        },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: {
              tag: "plain_text",
              content: "🙋 认领此案例",
            },
            type: "primary",
            multi_url: {
              url: targetUrl,
              pc_url: targetUrl,
              ios_url: targetUrl,
              android_url: targetUrl,
            },
            value: {
              action: "claim",
              caseId: expertCase.id,
              projectId: card.id,
            },
          },
        ],
      },
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content: "💡 专家点击认领后将自动回传 NovaPilot 专家工作台，并启动 SLA 倒计时",
          },
        ],
      },
    ],
  };
}

/**
 * 构造认领成功的通知更新卡片（飞书交互卡片原地刷新）
 */
export function buildClaimedNoticeCard(
  expertCase: ExpertCase,
  claimedBy: string = "飞书科研专家",
): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: "green",
      title: {
        tag: "plain_text",
        content: `✅【工单已认领】${expertCase.handoff.objective}`,
      },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            `**工单编号**：\`${expertCase.id}\``,
            `**认领状态**：已由 **${claimedBy}** 认领并接入处理`,
            `**认领时间**：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
            `**SLA 时钟**：已正式启动，请在 ${expertCase.sla.substantiveResponseHours} 小时内给出专家复核决策。`,
          ].join("\n"),
        },
      },
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content: "NovaPilot 专家工作台状态已同步更新为「处理中 (claimed)」。",
          },
        ],
      },
    ],
  };
}

/**
 * 向飞书发送 SLA 紧急交互卡片
 * - 有 FEISHU_BOT_WEBHOOK_URL 时发送真实 Webhook
 * - 无凭证时记入 recentAlerts 供离线演示与单测
 */
export async function sendSlaAlertCard(
  expertCase: ExpertCase,
  card: DecisionCard,
  actionUrl?: string,
): Promise<{ sent: boolean; mock: boolean; card: Record<string, unknown> }> {
  const feishuCard = buildSlaAlertCard(expertCase, card, actionUrl);
  const webhookUrl = process.env.FEISHU_BOT_WEBHOOK_URL;

  if (!webhookUrl) {
    const alertRecord: SlaAlertRecord = {
      caseId: expertCase.id,
      projectId: card.id,
      sentAt: new Date().toISOString(),
      card: feishuCard,
      mock: true,
    };
    recentAlerts.unshift(alertRecord);
    if (recentAlerts.length > 50) recentAlerts.pop();
    return { sent: true, mock: true, card: feishuCard };
  }

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        msg_type: "interactive",
        card: feishuCard,
      }),
      signal: AbortSignal.timeout(8000),
    });
    const sent = res.ok;
    const alertRecord: SlaAlertRecord = {
      caseId: expertCase.id,
      projectId: card.id,
      sentAt: new Date().toISOString(),
      card: feishuCard,
      mock: false,
    };
    recentAlerts.unshift(alertRecord);
    if (recentAlerts.length > 50) recentAlerts.pop();
    return { sent, mock: false, card: feishuCard };
  } catch {
    return { sent: false, mock: false, card: feishuCard };
  }
}
