import { NextResponse } from "next/server";
import { z } from "zod";
import { evaluateReleaseGate } from "@/domain/consultation-journey";
import { requireWriteContext } from "../write-context";
import { getDb } from "@/server/db/client";
import { runNovaBench } from "@/server/eval/novabench";

// Node runtime required for node:sqlite (not available on the edge runtime).
export const runtime = "nodejs";

// Manual path: caller supplies pre-computed metrics.
const gateSchema = z.object({
  citationValidity: z.number().min(0).max(1),
  escalationRecall: z.number().min(0).max(1),
  confidentWrongDelta: z.number(),
  p0Defects: z.number().int().min(0),
  dataBoundaryIncidents: z.number().int().min(0),
});

// Live path: run the real NovaBench gold set and gate on its derived metrics.
const liveSchema = z.object({ mode: z.literal("novabench") });

export async function POST(request: Request) {
  const write = requireWriteContext(request);
  if (write.error) return write.error;

  const body = await request.json().catch(() => ({}));

  // Live evaluation: derive the gate from a real NovaBench run.
  const live = liveSchema.safeParse(body);
  if (live.success) {
    // 真实时间戳 → 每次运行独立落库,运营页历史/趋势与知识页共用记录。
    const report = await runNovaBench(
      getDb(),
      { provider: "off" },
      new Date().toISOString(),
    );
    return NextResponse.json(
      {
        mode: "novabench",
        suite: report.suite,
        accuracy: report.accuracy,
        passed: report.passed,
        total: report.total,
        metrics: report.metrics,
        decision: report.gate.decision,
        failed: report.gate.failed,
        maxTrafficPercent: report.gate.maxTrafficPercent,
        cases: report.cases,
      },
      { headers: { "x-trace-id": write.context.traceId } },
    );
  }

  // Manual evaluation: gate on supplied metrics.
  const parsed = gateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "INVALID_GATE_INPUT" }, { status: 400 });
  }
  return NextResponse.json(evaluateReleaseGate(parsed.data), {
    headers: { "x-trace-id": write.context.traceId },
  });
}
