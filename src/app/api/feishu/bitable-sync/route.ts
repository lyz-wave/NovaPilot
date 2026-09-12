/**
 * POST /api/feishu/bitable-sync
 *
 * 决策卡 -> 飞书多维表格正向同步 API。
 * 前端“同步到多维表格”按钮触发此接口：
 * 包含：项目 ID、物种、推荐方案、风险分级、引用的 SOP 文献编号、质检状态
 * 离线环境下自动落入 Mock 存储并返回成功。
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/server/db/client";
import { getLatestCard } from "@/server/db/repositories";
import { getMockBitableRecords, syncDecisionCard } from "@/server/feishu/bitable";
import type { DecisionCard, ProjectFacts } from "@/domain/consultation-journey";

export const runtime = "nodejs";

const bodySchema = z.object({
  projectId: z.string().optional(),
  card: z.any().optional(),
  facts: z.any().optional(),
});

export async function GET() {
  return NextResponse.json({
    ok: true,
    records: getMockBitableRecords(),
  });
}

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_BODY" }, { status: 400 });
  }

  const { projectId, card: inputCard, facts } = parsed.data;

  let card: DecisionCard | null = inputCard as DecisionCard;
  let pId = projectId;

  if (!card && pId) {
    card = getLatestCard(getDb(), pId);
  }

  if (!card) {
    return NextResponse.json(
      { error: "CARD_NOT_FOUND", message: "未找到可同步的决策卡" },
      { status: 404 },
    );
  }

  if (!pId) {
    pId = card.id.replace(/^CARD-/, "");
  }

  const result = await syncDecisionCard(card, pId, facts as ProjectFacts);

  return NextResponse.json({
    ok: result.success,
    mock: result.mock,
    recordId: result.recordId,
    tableId: result.tableId,
    projectId: pId,
    cardId: card.id,
    fields: result.fields,
    message: result.mock
      ? "已离线同步至飞书多维表格模拟存储"
      : "已成功同步至飞书多维表格",
  });
}
