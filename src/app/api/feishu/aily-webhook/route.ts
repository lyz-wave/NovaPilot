/**
 * POST /api/feishu/aily-webhook — aily 技能/机器人入口。
 * 请求 { question, facts?, locale? } → 跑完整咨询管线 → 回传
 * 决策摘要 + 飞书消息卡片(可直接用于 aily 回复/消息卡片推送)。
 * 离线时管线确定性运行,卡片同样可用。
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireBearer } from "@/app/api/write-context";
import { decisionCardToFeishuCard } from "@/server/feishu/aily";
import { consult } from "@/server/service";

export const runtime = "nodejs";

/** 只接受 ProjectFacts 里真实存在的字段,避免任意键被原样写入事实表。 */
const factsSchema = z
  .object({
    sampleCount: z.number().optional(),
    dv200: z.number().optional(),
    rnaInputNg: z.number().optional(),
    material: z.string().max(200).optional(),
    species: z.string().max(200).optional(),
    goal: z.string().max(400).optional(),
  })
  .strict();

const bodySchema = z.object({
  question: z.string().min(1).max(4000),
  facts: factsSchema.optional(),
  locale: z.enum(["zh", "en", "ja"]).optional(),
});

export async function POST(request: Request) {
  // 该入口会跑完整咨询管线并落库(可能还要计费调用模型),不能匿名访问。
  const unauthorized = requireBearer(request);
  if (unauthorized) return unauthorized;
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_AILY_INPUT" }, { status: 400 });
  }
  const body = parsed.data;
  const traceId = "aily-" + Date.now().toString(36);
  const result = await consult({
    question: body.question,
    locale: body.locale ?? "zh",
    facts: body.facts ?? {},
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
