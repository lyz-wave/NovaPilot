/**
 * POST /api/feishu/bitable-webhook
 *
 * 飞书多维表格反向监听 Webhook。
 * 场景：质检工程师在飞书多维表格中将样本记录的「质检状态」标记为“质检合格”或“质检不合格”时，
 * NovaPilot 自动生成并固化对应版本（如 v2.0 / v3.0）的新决策卡至历史版本列表。
 */
import { NextResponse } from "next/server";
import { getDb } from "@/server/db/client";
import { getLatestCard, saveDecisionCard } from "@/server/db/repositories";
import { getMockBitableRecords } from "@/server/feishu/bitable";
import type { DecisionCard, Recommendation } from "@/domain/consultation-journey";

export const runtime = "nodejs";

interface BitableWebhookBody {
  challenge?: string;
  type?: string;
  event?: {
    table_id?: string;
    record_id?: string;
    fields?: Record<string, unknown>;
  };
  projectId?: string;
  qcStatus?: string;
  qcNote?: string;
  recordId?: string;
}

export async function GET() {
  return NextResponse.json({
    ok: true,
    message: "飞书多维表格反向质检 Webhook 端点运行正常",
  });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as BitableWebhookBody;

  // 1. 响应飞书开放平台 URL 校验 Challenge
  if (body.challenge) {
    return NextResponse.json({ challenge: body.challenge });
  }

  // 2. 解析事件中的关键字段（兼顾飞书官方 Webhook 结构与直接 API 模拟测试）
  let projectId = body.projectId;
  let qcStatus = body.qcStatus;
  let qcNote = body.qcNote;

  if (body.event?.fields) {
    const fields = body.event.fields;
    projectId = (fields["项目ID"] ?? fields["projectId"] ?? projectId) as string;
    qcStatus = (fields["质检状态"] ?? fields["qcStatus"] ?? qcStatus) as string;
    qcNote = (fields["质检备注"] ?? fields["qcNote"] ?? qcNote) as string;
  }

  // 若只有 record_id，尝试从 Mock 存储中反查项目 ID
  if (!projectId && (body.recordId || body.event?.record_id)) {
    const rId = body.recordId || body.event?.record_id;
    const match = getMockBitableRecords().find((r) => r.recordId === rId);
    if (match) {
      projectId = match.fields["项目ID"] as string;
      if (!qcStatus) qcStatus = match.fields["质检状态"] as string;
    }
  }

  if (!projectId || !qcStatus) {
    return NextResponse.json(
      {
        error: "MISSING_REQUIRED_FIELDS",
        message: "必须提供 projectId 与 qcStatus（例如：质检合格 / 质检不合格）",
      },
      { status: 400 },
    );
  }

  const isPass = qcStatus.includes("合格") && !qcStatus.includes("不合格");
  const isFail = qcStatus.includes("不合格");

  if (!isPass && !isFail) {
    return NextResponse.json(
      { error: "INVALID_QC_STATUS", message: "质检状态仅支持「质检合格」或「质检不合格」" },
      { status: 400 },
    );
  }

  const db = getDb();
  const currentCard = getLatestCard(db, projectId);

  if (!currentCard) {
    return NextResponse.json(
      { error: "PROJECT_NOT_FOUND", message: `未找到项目 ${projectId} 的已有决策卡` },
      { status: 404 },
    );
  }

  const now = new Date().toISOString();
  const nextVersion = currentCard.version + 1;
  const traceId = `bitable-qc-v${nextVersion}-${Date.now().toString(36)}`;

  // 3. 根据质检结论衍生新版决策卡
  const baseTitle = currentCard.title.replace(/\s*·\s*质检.*$/, "");
  const newTitle = `${baseTitle} · 质检${isPass ? "合格" : "不合格预警"}`;

  const qcSuffix = isPass
    ? `\n\n【飞书多维表格质检协同·合格】：质检工程师已在飞书多维表格中标记质检合格${qcNote ? "（" + qcNote + "）" : ""}。文库质量满足上机门禁，推荐推进标准测序建库流程。`
    : `\n\n【飞书多维表格质检协同·不合格预警】：质检工程师已在飞书多维表格中标记质检不合格${qcNote ? "（" + qcNote + "）" : ""}。样本质量未达标，建议立即启动样本复查、纯化或补提方案。`;

  const nextRecommendations: Recommendation[] = [...currentCard.recommendations];

  if (isFail) {
    nextRecommendations.unshift({
      id: `REC-QC-FAIL-${Date.now().toString(36)}`,
      title: "【质检不合格对策】启动样本纯化重提或补送样本",
      rationale:
        "飞书多维表格回传质检不合格，根据 SOP 规范暂缓上机测序，防止产生无效测序费用。",
      evidenceIds: ["E-SOP-042"],
      boundary: "FFPE 样本质检拦截",
    });
  }

  const nextCard: DecisionCard = {
    ...currentCard,
    version: nextVersion,
    title: newTitle,
    executiveSummary: currentCard.executiveSummary + qcSuffix,
    status: isPass ? "formal" : "provisional",
    recommendations: nextRecommendations,
    risk: isPass
      ? {
          ...currentCard.risk,
          level: currentCard.risk.level === "high" ? "medium" : currentCard.risk.level,
          score: Math.min(currentCard.risk.score, 30),
          signals: [
            ...currentCard.risk.signals.filter((s) => !s.includes("质检")),
            "飞书多维表格质检核验通过",
          ],
        }
      : {
          ...currentCard.risk,
          level: "high",
          score: Math.max(88, currentCard.risk.score),
          mandatoryEscalation: true,
          signals: [...currentCard.risk.signals, "飞书多维表格质检不合格拦截 (P0)"],
        },
    confirmedConditions: [
      ...currentCard.confirmedConditions,
      {
        field: "species" as const, // placeholder for typed fact
        value: `[质检结论: ${isPass ? "质检合格" : "质检不合格"}${qcNote ? " - " + qcNote : ""}]`,
        source: "expert",
        extractedAt: now,
        confidence: 1.0,
        confirmation: "confirmed",
        version: nextVersion,
        visibility: "project-members",
      },
    ],
  };

  // 4. 固化新版本决策卡入库
  saveDecisionCard(db, projectId, nextCard, traceId, now);

  return NextResponse.json({
    ok: true,
    projectId,
    previousVersion: currentCard.version,
    newVersion: nextVersion,
    cardId: nextCard.id,
    title: nextCard.title,
    status: nextCard.status,
    message: `已根据飞书多维表格质检状态自动生成并固化新版本 v${nextVersion}.0`,
  });
}
