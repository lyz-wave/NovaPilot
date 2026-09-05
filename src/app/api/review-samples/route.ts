import { NextResponse } from "next/server";
import { z } from "zod";
import { requireBearer, requireWriteContext } from "../write-context";
import { getDb } from "@/server/db/client";
import {
  InvalidVerdict,
  listPendingExpertReview,
  reviewSampleSummary,
  setExpertVerdict,
} from "@/server/telemetry/review-samples";

// node:sqlite 只在 Node runtime 可用。
export const runtime = "nodejs";

/**
 * 埋点 B · 复核队列。
 *
 * 只暴露**专家终审**的写入口。judge 预审刻意没有 HTTP 入口,只能由离线脚本
 * (`npm run review:judge`)写 —— 指标体系 5.1 节的铁律是「judge 只做预筛不做
 * 终审」,而一个开放的 judge 写接口迟早会被某个「顺手自动化一下」的改动接到运行时
 * 链路上,那时候 judge 就变成了事实上的终审,而且这个变化在看板上看不出来。
 * 不给接口是把这条约束写进结构里,而不是写进注释里。
 */
const verdictSchema = z.object({
  id: z.string().min(1),
  verdict: z.enum(["should-pass", "should-block", "should-escalate", "should-not-escalate"]),
  note: z.string().max(1000).optional(),
});

/** GET /api/review-samples → { pending, summary }(bearer)。 */
export async function GET(request: Request) {
  const unauthorized = requireBearer(request);
  if (unauthorized) return unauthorized;
  const since = new URL(request.url).searchParams.get("since") ?? undefined;
  const db = getDb();
  return NextResponse.json({
    pending: listPendingExpertReview(db),
    summary: reviewSampleSummary(db, since),
  });
}

/** POST /api/review-samples(写契约)— 专家终审判定。 */
export async function POST(request: Request) {
  const write = requireWriteContext(request);
  if (write.error) return write.error;

  const parsed = verdictSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_VERDICT_INPUT" }, { status: 400 });
  }

  const headers = { "x-trace-id": write.context.traceId };
  try {
    const sample = setExpertVerdict(getDb(), {
      ...parsed.data,
      now: new Date().toISOString(),
    });
    if (!sample) return NextResponse.json({ error: "SAMPLE_NOT_FOUND" }, { status: 404 });
    return NextResponse.json({ sample }, { headers });
  } catch (err) {
    // 判定与样本类型不匹配(给「被拦」样本填 should-escalate)是调用方的错,
    // 不是服务端故障 —— 返回 400 而不是 500,并把原因带回去。
    if (err instanceof InvalidVerdict) {
      return NextResponse.json({ error: "VERDICT_KIND_MISMATCH", detail: err.message }, { status: 400 });
    }
    throw err;
  }
}
