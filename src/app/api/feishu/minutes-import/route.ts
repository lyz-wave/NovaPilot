/**
 * POST /api/feishu/minutes-import — 拉取飞书智能纪要文本并抽取项目事实。
 * 未配置飞书凭证时返回 409 NOT_CONFIGURED;成功返回 transcript + facts,
 * 前端可把 suggestedQuestion 送入常规咨询流。
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { extractFactsFromText, fetchMinutes } from "@/server/feishu/minutes";

export const runtime = "nodejs";

const bodySchema = z.object({
  minuteToken: z.string().min(1),
});

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_MINUTE_TOKEN" }, { status: 400 });
  }
  const minutes = await fetchMinutes(parsed.data.minuteToken);
  if (!minutes) {
    return NextResponse.json(
      { error: "NOT_CONFIGURED_OR_FETCH_FAILED" },
      { status: 409 },
    );
  }
  const facts = extractFactsFromText(minutes.text);
  return NextResponse.json({ minutes, facts });
}
