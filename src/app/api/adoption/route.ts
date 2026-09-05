import { NextResponse } from "next/server";
import { z } from "zod";
import { requireBearer } from "../write-context";
import { getDb } from "@/server/db/client";
import { adoptionSummary, recordAdoptionEvent } from "@/server/telemetry/adoption";

// node:sqlite 只在 Node runtime 可用。
export const runtime = "nodejs";

/**
 * 埋点 D · 采纳动作上报。
 *
 * 用 `requireBearer` 而不是完整写上下文(If-Match / 幂等键):这是一条纯观测写入,
 * 不改变任何业务状态、不参与版本并发控制。要求前端在每次复制卡片时先拿版本号、
 * 造幂等键,只会让埋点在 428 上失败 —— 那样这一格看板就永远是 0,反而看不出真相。
 * 但也不允许匿名:否则任何人都能往采纳率里灌数。
 */
const bodySchema = z.object({
  projectId: z.string().min(1),
  cardId: z.string().min(1),
  action: z.enum(["copy", "export", "sync"]),
  surface: z.string().max(64).optional(),
});

/** POST /api/adoption — 记录一次复制/导出/同步。 */
export async function POST(request: Request) {
  const unauthorized = requireBearer(request);
  if (unauthorized) return unauthorized;

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_ADOPTION_EVENT" }, { status: 400 });
  }

  recordAdoptionEvent(getDb(), { ...parsed.data, now: new Date().toISOString() });
  return NextResponse.json({ ok: true });
}

/** GET /api/adoption → 看板口径汇总。`?since=<ISO>` 可切时间窗。 */
export async function GET(request: Request) {
  const unauthorized = requireBearer(request);
  if (unauthorized) return unauthorized;
  const since = new URL(request.url).searchParams.get("since") ?? undefined;
  return NextResponse.json({
    summary: adoptionSummary(getDb(), since),
    // 看板必须把这句话印在这一格旁边(指标体系 4.4 节),否则它迟早会被当成
    // 「有多少人认可我们」拿去汇报,进而变成一个被优化的目标。
    boundary: "只做体验对冲指标,不进可信解决率计算链",
  });
}
