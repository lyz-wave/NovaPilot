/**
 * POST /api/feishu/minutes-import — 拉取飞书智能纪要文本并抽取项目事实。
 * 未配置飞书凭证时返回 409 NOT_CONFIGURED;成功返回 transcript + facts,
 * 前端可把 suggestedQuestion 送入常规咨询流。
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireBearer } from "@/app/api/write-context";
import { extractFactsFromText, fetchMinutes } from "@/server/feishu/minutes";

export const runtime = "nodejs";

const bodySchema = z.object({
  // 该 token 会拼进带 tenant access token 的飞书请求路径,格式在此收紧。
  minuteToken: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
});

export async function POST(request: Request) {
  // 该入口用应用凭证代表本企业调用飞书,不能匿名访问。
  const unauthorized = requireBearer(request);
  if (unauthorized) return unauthorized;
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
