/**
 * POST /api/feishu/aily-webhook — aily 技能/机器人入口。
 * 请求 { question, facts?, locale? } → 跑完整咨询管线 → 回传
 * 决策摘要 + 飞书消息卡片(可直接用于 aily 回复/消息卡片推送)。
 * 离线时管线确定性运行,卡片同样可用。
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { decisionCardToFeishuCard } from "@/server/feishu/aily";
import { consult } from "@/server/service";

export const runtime = "nodejs";

const bodySchema = z.object({
  question: z.string().min(1),
  facts: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  locale: z.enum(["zh", "en", "ja"]).optional(),
});

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_AILY_INPUT" }, { status: 400 });
  }
  const body = parsed.data;
  const traceId = "aily-" + Date.now().toString(36);
  const result = await consult({
    question: body.question,
    locale: body.locale ?? "zh",
    facts: (body.facts ?? {}) as import("@/domain/consultation-journey").ProjectFacts,
    tenantId: "feishu-aily",
    traceId,
    projectId: "AILY-" + traceId,
  });
  const card = result.card;
  return NextResponse.json({
    reply: card.executiveSummary,
    status: card.status,
    card: decisionCardToFeishuCard(card),
    decisionCardId: card.id,
  });
}
