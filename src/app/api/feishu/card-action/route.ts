/**
 * POST /api/feishu/card-action
 *
 * 飞书卡片交互回调入口（认领按钮点击）。
 * 1. 响应飞书平台安全 Challenge 校验；
 * 2. 接收群内专家点击 [ 🙋 认领此案例 ] 的交互回调；
 * 3. 将 SQLite 中对应工单状态原子流转为 "claimed" 并记录 claimed_at；
 * 4. 原地返回飞书 Schema 2.0 更新卡片与 Toast 提示。
 */
import { NextResponse } from "next/server";
import { getDb } from "@/server/db/client";
import { getExpertCaseRecord, updateExpertCase } from "@/server/db/repositories";
import { buildClaimedNoticeCard, getRecentSlaAlerts } from "@/server/feishu/sla-alert";

export const runtime = "nodejs";

interface FeishuCardActionBody {
  challenge?: string;
  type?: string;
  open_id?: string;
  user_id?: string;
  action?: {
    value?: {
      action?: string;
      caseId?: string;
      projectId?: string;
    };
    tag?: string;
  } | string;
  caseId?: string;
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    alerts: getRecentSlaAlerts(),
  });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as FeishuCardActionBody;

  // 1. 飞书开放平台 URL 校验 Challenge 响应
  if (body.challenge) {
    return NextResponse.json({ challenge: body.challenge });
  }

  // 2. 解析点击行为参数（兼顾飞书官方回调结构与直接 API 调用）
  let actionName: string | undefined;
  let caseId: string | undefined;

  if (typeof body.action === "object" && body.action?.value) {
    actionName = body.action.value.action;
    caseId = body.action.value.caseId;
  } else if (typeof body.action === "string") {
    actionName = body.action;
    caseId = body.caseId;
  } else if (body.caseId) {
    actionName = "claim";
    caseId = body.caseId;
  }

  if (actionName !== "claim" || !caseId) {
    return NextResponse.json(
      { error: "INVALID_ACTION", message: "仅支持 claim 认领操作" },
      { status: 400 },
    );
  }

  const db = getDb();
  const existing = getExpertCaseRecord(db, caseId);
  if (!existing) {
    return NextResponse.json(
      { error: "CASE_NOT_FOUND", message: `工单 ${caseId} 不存在` },
      { status: 404 },
    );
  }

  const now = new Date().toISOString();
  const claimedBy = body.open_id ? `专家 (${body.open_id.slice(-6)})` : "飞书科研专家";

  // 原子更新工单状态
  const updatedRecord = updateExpertCase(db, {
    id: caseId,
    status: "claimed",
    claimedAt: now,
    now,
  });

  if (!updatedRecord) {
    return NextResponse.json(
      { error: "UPDATE_FAILED", message: "工单状态更新失败" },
      { status: 500 },
    );
  }

  // 3. 返回飞书交互卡片原地更新协议响应
  const updatedCard = buildClaimedNoticeCard(updatedRecord.expertCase, claimedBy);

  return NextResponse.json({
    toast: {
      type: "success",
      content: `工单 ${caseId} 认领成功！SLA 倒计时已正式启动。`,
    },
    card: updatedCard,
    case: updatedRecord,
  });
}
