import { NextResponse } from "next/server";
import { z } from "zod";
import { requireWriteContext } from "../write-context";
import { respond, conversationContext } from "@/server/service";
import { getDb } from "@/server/db/client";
import { getCheckpoints } from "@/server/orchestration/graph";
import { recordLatencySample, markLatencyOutcome } from "@/server/telemetry/latency";

// Node runtime required for node:sqlite (not available on the edge runtime).
export const runtime = "nodejs";

const requestSchema = z.object({
  question: z.string().min(1).max(4000),
  locale: z.enum(["zh", "en", "ja"]),
  facts: z.object({
    sampleCount: z.number().int().positive().optional(),
    dv200: z.number().min(0).max(100).optional(),
    rnaInputNg: z.number().positive().optional(),
    material: z.string().min(1).optional(),
    species: z.string().min(1).max(80).optional(),
    goal: z.string().min(1).max(120).optional(),
  }),
  stream: z.boolean().optional(),
  // Which conversation thread this turn belongs to. Carried in the body (never
  // the tenant header) so the write contract is untouched; omitted ⇒ tenantId.
  conversationId: z.string().min(1).max(200).optional(),
  // 咨询者视角(第 3 节角色分布)。此前只活在前端 useState 里,从未落库 ——
  // 于是「四角色各自会话占比」连原始数据都不存在。枚举与 ClientRole 一致。
  role: z.enum(["pi", "postdoc", "student", "rnd"]).optional(),
});

export async function POST(request: Request) {
  const write = requireWriteContext(request);
  if (write.error) return write.error;
  const parsed = requestSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "INVALID_CONSULTATION", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const { question, locale, facts, stream, conversationId, role } = parsed.data;

  // ── Streaming (SSE): emit each orchestration checkpoint as it is reached ──
  if (stream) {
    return streamConsultation({
      question,
      locale,
      facts,
      tenantId: write.context.tenantId,
      traceId: write.context.traceId,
      conversationId,
      role,
    });
  }

  const startedAt = performance.now();
  const outcome = await respond({
    question,
    locale,
    facts,
    tenantId: write.context.tenantId,
    traceId: write.context.traceId,
    conversationId,
    role,
  });

  // 延迟采样带处置状态:护栏要验证的是「延迟下降不是靠少走防线换来的」,
  // 一个不分状态的全局 P95 分不出这两种情况(见 telemetry/latency.ts)。
  recordLatencySample(getDb(), {
    traceId: write.context.traceId,
    route: "consultations",
    kind: outcome.kind === "chat" ? "chat" : "card",
    cardStatus: outcome.kind === "chat" ? "" : outcome.card.status,
    durationMs: performance.now() - startedAt,
    now: new Date().toISOString(),
  });

  const contextUsage = conversationContext(
    getDb(),
    conversationId ?? write.context.tenantId,
  );

  return NextResponse.json(
    { ...outcome, contextUsage },
    {
      headers: {
        "x-trace-id": write.context.traceId,
        "x-tenant-id": write.context.tenantId,
      },
    },
  );
}

function streamConsultation(input: {
  question: string;
  locale: "zh" | "en" | "ja";
  facts: z.infer<typeof requestSchema>["facts"];
  tenantId: string;
  traceId: string;
  conversationId?: string;
  role?: "pi" | "postdoc" | "student" | "rnd";
}): Response {
  const encoder = new TextEncoder();
  const ROUTE = "consultations:stream";
  // 开流即落一行 started。这一行就是流式成功率的**分母** —— 改造前采样写在
  // respond() 之后,中断的流一行都不落,于是「成功率」由成功的样本自己算出来,
  // 恒等于 100%。先落分母,再由收场改写 outcome,这个指标才有意义。
  recordLatencySample(getDb(), {
    traceId: input.traceId,
    route: ROUTE,
    kind: "card",
    durationMs: 0,
    outcome: "started",
    now: new Date().toISOString(),
  });
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };
      try {
        send("start", { traceId: input.traceId });
        // Classify + run. Chat turns skip the graph entirely (no checkpoints);
        // research turns run the graph and we replay its persisted checkpoints.
        const startedAt = performance.now();
        const outcome = await respond(input);
        // 量到 respond 返回,不含后续 SSE 帧的推送时间 —— 那部分取决于客户端读取
        // 速度,把它算进服务端延迟会让同一次咨询在不同网络下出不同的 P95。
        recordLatencySample(getDb(), {
          traceId: input.traceId,
          route: ROUTE,
          kind: outcome.kind === "chat" ? "chat" : "card",
          cardStatus: outcome.kind === "chat" ? "" : outcome.card.status,
          durationMs: performance.now() - startedAt,
          // 还没收尾:帧全部推完(finally)才算 completed。
          outcome: "started",
          now: new Date().toISOString(),
        });
        const contextUsage = conversationContext(
          getDb(),
          input.conversationId ?? input.tenantId,
        );
        if (outcome.kind === "chat") {
          send("node", { node: "chat", state: null });
          send("result", { ...outcome, contextUsage });
        } else {
          const trail = getCheckpoints(getDb(), input.traceId);
          for (const step of trail) {
            send("node", { node: step.node, state: step.state });
          }
          send("result", { ...outcome, contextUsage });
        }
        send("done", { traceId: input.traceId });
        markLatencyOutcome(getDb(), { traceId: input.traceId, route: ROUTE, outcome: "completed" });
      } catch (err) {
        // 原始异常文本可能带上 SQLite 语句、文件路径或上游模型返回体,不下发给浏览器;
        // traceId 已随 start 帧给出,足以在服务端日志里定位这一次失败。
        console.error(`[consultations] trace=${input.traceId}`, err);
        markLatencyOutcome(getDb(), { traceId: input.traceId, route: ROUTE, outcome: "failed" });
        send("error", { message: "咨询处理失败，请稍后重试。", traceId: input.traceId });
      } finally {
        controller.close();
      }
    },
    // 消费端主动断开(关标签页、点取消、导航走)。markLatencyOutcome 只改
    // 还停在 started 的行,所以已经 completed 的流不会被这里改成 aborted。
    cancel() {
      markLatencyOutcome(getDb(), { traceId: input.traceId, route: ROUTE, outcome: "aborted" });
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-trace-id": input.traceId,
    },
  });
}
